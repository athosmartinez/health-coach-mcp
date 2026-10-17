package healthdata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// Daily activity and body keys (CAPABILITY §5.3).
const (
	KeySteps         = "steps"
	KeyAZM           = "azm_min"
	KeyTotalCalories = "total_calories_kcal"
	KeyWeight        = "weight_kg"
	KeyBodyFat       = "body_fat_pct"
)

var activityKeys = []string{KeySteps, KeyAZM, KeyTotalCalories}

// rollupSource labels values taken from the API's daily rollup, which merges
// the band's and the phone's records into one total per day (CAPABILITY I2).
const rollupSource = "Google Health daily total"

// ActivityDay is one local day's totals; nil is a day without data.
type ActivityDay struct {
	Steps *float64
	// AZM is Active Zone Minutes (fat burn counts 1 per minute, cardio and
	// peak 2): 0 on a day the band recorded without any zone minutes.
	AZM       *float64
	TotalKcal *float64
	// Partial: today, so the totals can still grow. Baselines leave it out.
	Partial bool
}

// Activity holds the daily totals of [From, To].
type Activity struct {
	From, To coach.LocalDate
	Days     map[coach.LocalDate]ActivityDay
	Skipped  int // rollup rows that could not be read
}

// Series returns one point per day for key (KeySteps, KeyAZM or
// KeyTotalCalories), nil where the value is missing.
func (a Activity) Series(key string) ([]metrics.Point, error) { return a.series(key, false) }

// BaselineSeries is Series without partial days.
func (a Activity) BaselineSeries(key string) ([]metrics.Point, error) { return a.series(key, true) }

func (a Activity) series(key string, baseline bool) ([]metrics.Point, error) {
	var get func(ActivityDay) *float64
	switch key {
	case KeySteps:
		get = func(d ActivityDay) *float64 { return d.Steps }
	case KeyAZM:
		get = func(d ActivityDay) *float64 { return d.AZM }
	case KeyTotalCalories:
		get = func(d ActivityDay) *float64 { return d.TotalKcal }
	default:
		return nil, fmt.Errorf("healthdata: no activity series %q", key)
	}
	return points(a.From, a.To, func(day coach.LocalDate) *float64 {
		if v, ok := a.Days[day]; ok && !(baseline && v.Partial) {
			return get(v)
		}
		return nil
	})
}

// points builds one metrics.Point per day of [from, to].
func points(from, to coach.LocalDate, get func(coach.LocalDate) *float64) ([]metrics.Point, error) {
	days, err := dayList(from, to)
	if err != nil {
		return nil, err
	}
	out := make([]metrics.Point, len(days))
	for i, d := range days {
		out[i] = metrics.Point{Date: d, Value: get(d)}
	}
	return out, nil
}

// Activity returns steps, Active Zone Minutes and total calories for each day
// of [from, to], from the API's daily rollups. Settled days come from the
// cache when all three are there.
func (d *Data) Activity(ctx context.Context, from, to coach.LocalDate) (Activity, error) {
	days, err := dayList(from, to)
	if err != nil {
		return Activity{}, err
	}
	today := coach.Today(d.now(), d.loc)
	settled, err := today.AddDays(-settleDays)
	if err != nil {
		return Activity{}, err
	}
	a := Activity{From: from, To: to, Days: map[coach.LocalDate]ActivityDay{}}
	cached, err := d.readCache(ctx, from, min(to, settled), activityKeys...)
	if err != nil {
		return Activity{}, err
	}
	var need []coach.LocalDate
	for _, day := range days {
		s, okS := cached[KeySteps][day]
		z, okZ := cached[KeyAZM][day]
		k, okK := cached[KeyTotalCalories][day]
		if okS && okZ && okK {
			a.Days[day] = ActivityDay{Steps: ptr(s.Value), AZM: ptr(z.Value), TotalKcal: ptr(k.Value)}
			continue
		}
		need = append(need, day)
	}
	for _, run := range runs(need) {
		if err := d.fetchActivity(ctx, run[0], run[1], today, settled, &a); err != nil {
			return Activity{}, err
		}
	}
	return a, nil
}

func (d *Data) fetchActivity(ctx context.Context, a, b, today, settled coach.LocalDate, act *Activity) error {
	steps, err := d.rollup(ctx, googlehealth.Steps, a, b, act, func(raw json.RawMessage) (float64, error) {
		var r struct {
			Steps *struct {
				CountSum int64s `json:"countSum"`
			} `json:"steps"`
		}
		if err := json.Unmarshal(raw, &r); err != nil || r.Steps == nil {
			return 0, errors.New("unreadable steps rollup")
		}
		return float64(r.Steps.CountSum), nil
	}, 0, 200_000)
	if err != nil {
		return err
	}
	azm, err := d.rollup(ctx, googlehealth.ActiveZoneMinutes, a, b, act, func(raw json.RawMessage) (float64, error) {
		var r struct {
			AZM *struct {
				FatBurn int64s `json:"sumInFatBurnHeartZone"`
				Cardio  int64s `json:"sumInCardioHeartZone"`
				Peak    int64s `json:"sumInPeakHeartZone"`
			} `json:"activeZoneMinutes"`
		}
		if err := json.Unmarshal(raw, &r); err != nil || r.AZM == nil {
			return 0, errors.New("unreadable active zone minutes rollup")
		}
		return float64(r.AZM.FatBurn + r.AZM.Cardio + r.AZM.Peak), nil
	}, 0, 2*24*60)
	if err != nil {
		return err
	}
	kcal, err := d.rollup(ctx, googlehealth.TotalCalories, a, b, act, func(raw json.RawMessage) (float64, error) {
		var r struct {
			TotalCalories *struct {
				KcalSum *float64 `json:"kcalSum"`
			} `json:"totalCalories"`
		}
		if err := json.Unmarshal(raw, &r); err != nil || r.TotalCalories == nil || r.TotalCalories.KcalSum == nil {
			return 0, errors.New("unreadable total calories rollup")
		}
		return *r.TotalCalories.KcalSum, nil
	}, 0, 20_000)
	if err != nil {
		return err
	}
	// The rollup leaves out a day without zone minutes. On a day the band
	// recorded steps that is 0 minutes; on a day it was not worn, no data.
	worn, err := d.wornDays(ctx, a, b, azm)
	if err != nil {
		return err
	}
	days, err := dayList(a, b)
	if err != nil {
		return err
	}
	for _, day := range days {
		v := ActivityDay{Steps: steps[day], AZM: azm[day], TotalKcal: kcal[day], Partial: day >= today}
		if v.AZM == nil && worn[day] {
			v.AZM = ptr(0)
		}
		if v.Steps == nil && v.AZM == nil && v.TotalKcal == nil {
			continue
		}
		act.Days[day] = v
		if day > settled {
			continue
		}
		for key, val := range map[string]*float64{KeySteps: v.Steps, KeyAZM: v.AZM, KeyTotalCalories: v.TotalKcal} {
			if val != nil {
				d.put(ctx, store.Metric{Date: day, Key: key, Value: *val, Source: rollupSource})
			}
		}
	}
	return nil
}

// rollup reads one daily rollup into values per local day; a row outside
// [lo, hi] or unreadable is skipped and counted.
func (d *Data) rollup(ctx context.Context, dt googlehealth.DataType, a, b coach.LocalDate, act *Activity,
	value func(json.RawMessage) (float64, error), lo, hi float64) (map[coach.LocalDate]*float64, error) {
	raws, err := d.api.DailyRollup(ctx, dt, a, b)
	if err != nil {
		return nil, err
	}
	out := map[coach.LocalDate]*float64{}
	skipped := 0
	for _, raw := range raws {
		var r struct {
			Start civilDate `json:"civilStartTime"`
		}
		day, derr := coach.LocalDate(""), json.Unmarshal(raw, &r)
		if derr == nil {
			day, derr = r.Start.day()
		}
		v, err := value(raw)
		if derr != nil || err != nil || math.IsNaN(v) || v < lo || v > hi || day < a || day > b {
			skipped++
			continue
		}
		out[day] = &v
	}
	if skipped > 0 {
		act.Skipped += skipped
		d.log.Warn("unreadable daily rollup rows", "data_type", string(dt), "from", string(a), "to", string(b), "skipped", skipped)
	}
	return out, nil
}

// wornDays lists the days of [a, b] with band step records, fetched only
// when some day has no zone minutes row.
func (d *Data) wornDays(ctx context.Context, a, b coach.LocalDate, azm map[coach.LocalDate]*float64) (map[coach.LocalDate]bool, error) {
	days, err := dayList(a, b)
	if err != nil {
		return nil, err
	}
	if len(azm) == len(days) {
		return nil, nil
	}
	raws, err := d.api.List(ctx, googlehealth.Steps, a, b)
	if err != nil {
		return nil, err
	}
	worn := map[coach.LocalDate]bool{}
	for _, raw := range raws {
		var r struct {
			DataSource dataSource `json:"dataSource"`
			Steps      *struct {
				Interval struct {
					Start civilDate `json:"civilStartTime"`
				} `json:"interval"`
			} `json:"steps"`
		}
		if json.Unmarshal(raw, &r) != nil || r.Steps == nil || r.DataSource.Platform != primaryPlatform {
			continue
		}
		if day, err := r.Steps.Interval.Start.day(); err == nil {
			worn[day] = true
		}
	}
	return worn, nil
}

// civilDate is the date part of the API's CivilDateTime.
type civilDate struct {
	Date struct {
		Year  int `json:"year"`
		Month int `json:"month"`
		Day   int `json:"day"`
	} `json:"date"`
}

func (c civilDate) day() (coach.LocalDate, error) {
	t := time.Date(c.Date.Year, time.Month(c.Date.Month), c.Date.Day, 0, 0, 0, 0, time.UTC)
	if c.Date.Year == 0 || t.Year() != c.Date.Year || int(t.Month()) != c.Date.Month || t.Day() != c.Date.Day {
		return "", errors.New("invalid civil date")
	}
	return coach.LocalDate(t.Format(time.DateOnly)), nil
}

func ptr(v float64) *float64 { return &v }

// Reading is one body measurement.
type Reading struct {
	At     time.Time // zero when read from the cache
	Value  float64   // kg for weight, percent for body fat
	Source string
}

// Body holds the weight and body fat of [From, To]: the last reading of each
// local day. Every platform counts (a scale may sync through Apple Health).
type Body struct {
	From, To coach.LocalDate
	Weight   map[coach.LocalDate]Reading
	BodyFat  map[coach.LocalDate]Reading
	Skipped  int
}

// Series returns one point per day for KeyWeight or KeyBodyFat.
func (b Body) Series(key string) ([]metrics.Point, error) {
	var m map[coach.LocalDate]Reading
	switch key {
	case KeyWeight:
		m = b.Weight
	case KeyBodyFat:
		m = b.BodyFat
	default:
		return nil, fmt.Errorf("healthdata: no body series %q", key)
	}
	return points(b.From, b.To, func(day coach.LocalDate) *float64 {
		if r, ok := m[day]; ok {
			return ptr(r.Value)
		}
		return nil
	})
}

// Last returns the latest day's reading of m, if any.
func Last(m map[coach.LocalDate]Reading) (coach.LocalDate, Reading, bool) {
	var day coach.LocalDate
	for d := range m {
		day = max(day, d)
	}
	r, ok := m[day]
	return day, r, ok
}

// Body returns the weight and body fat of [from, to].
func (d *Data) Body(ctx context.Context, from, to coach.LocalDate) (Body, error) {
	days, err := dayList(from, to)
	if err != nil {
		return Body{}, err
	}
	settled, err := coach.Today(d.now(), d.loc).AddDays(-settleDays)
	if err != nil {
		return Body{}, err
	}
	b := Body{From: from, To: to, Weight: map[coach.LocalDate]Reading{}, BodyFat: map[coach.LocalDate]Reading{}}
	for _, m := range []struct {
		key   string
		dt    googlehealth.DataType
		out   map[coach.LocalDate]Reading
		parse func(json.RawMessage) (time.Time, float64, dataSource, error)
	}{
		{KeyWeight, googlehealth.Weight, b.Weight, parseWeight},
		{KeyBodyFat, googlehealth.BodyFat, b.BodyFat, parseBodyFat},
	} {
		cached, err := d.readCache(ctx, from, min(to, settled), m.key)
		if err != nil {
			return Body{}, err
		}
		// A day without a reading is never cached, so the range is fetched
		// whenever a day is missing: readings are sparse and one list call
		// covers the whole range.
		if len(cached[m.key]) == len(days) {
			for day, row := range cached[m.key] {
				m.out[day] = Reading{Value: row.Value, Source: row.Source}
			}
			continue
		}
		raws, err := d.api.List(ctx, m.dt, from, to)
		if err != nil {
			return Body{}, err
		}
		for _, raw := range raws {
			at, v, src, err := m.parse(raw)
			if err != nil {
				b.Skipped++
				continue
			}
			day := coach.DateOf(at, d.loc)
			if day < from || day > to {
				continue
			}
			if cur, ok := m.out[day]; !ok || at.After(cur.At) {
				m.out[day] = Reading{At: at, Value: v, Source: src.label()}
			}
		}
		for day, r := range m.out {
			if day <= settled {
				d.put(ctx, store.Metric{Date: day, Key: m.key, Value: r.Value, Source: r.Source})
			}
		}
	}
	if b.Skipped > 0 {
		d.log.Warn("unreadable body records", "from", string(from), "to", string(to), "skipped", b.Skipped)
	}
	return b, nil
}

const (
	minWeightKg, maxWeightKg     = 20, 400
	minBodyFatPct, maxBodyFatPct = 2, 75
)

func parseWeight(raw json.RawMessage) (time.Time, float64, dataSource, error) {
	var r struct {
		DataSource dataSource `json:"dataSource"`
		Weight     *struct {
			SampleTime struct {
				PhysicalTime time.Time `json:"physicalTime"`
			} `json:"sampleTime"`
			Grams *float64 `json:"weightGrams"`
		} `json:"weight"`
	}
	if err := json.Unmarshal(raw, &r); err != nil || r.Weight == nil || r.Weight.Grams == nil || r.Weight.SampleTime.PhysicalTime.IsZero() {
		return time.Time{}, 0, dataSource{}, errors.New("unreadable weight record")
	}
	kg := *r.Weight.Grams / 1000
	if math.IsNaN(kg) || kg < minWeightKg || kg > maxWeightKg {
		return time.Time{}, 0, dataSource{}, errors.New("weight out of range")
	}
	return r.Weight.SampleTime.PhysicalTime, kg, r.DataSource, nil
}

func parseBodyFat(raw json.RawMessage) (time.Time, float64, dataSource, error) {
	var r struct {
		DataSource dataSource `json:"dataSource"`
		BodyFat    *struct {
			SampleTime struct {
				PhysicalTime time.Time `json:"physicalTime"`
			} `json:"sampleTime"`
			Percentage *float64 `json:"percentage"`
		} `json:"bodyFat"`
	}
	if err := json.Unmarshal(raw, &r); err != nil || r.BodyFat == nil || r.BodyFat.Percentage == nil || r.BodyFat.SampleTime.PhysicalTime.IsZero() {
		return time.Time{}, 0, dataSource{}, errors.New("unreadable body fat record")
	}
	p := *r.BodyFat.Percentage
	if math.IsNaN(p) || p < minBodyFatPct || p > maxBodyFatPct {
		return time.Time{}, 0, dataSource{}, errors.New("body fat out of range")
	}
	return r.BodyFat.SampleTime.PhysicalTime, p, r.DataSource, nil
}
