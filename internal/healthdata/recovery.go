// Package healthdata turns Google Health records into the coach's daily
// values, through the daily_metrics cache. It decides what is cached; the API
// client fetches and the metrics package does the math.
package healthdata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// Daily value keys: the store's closed list (CAPABILITY §5.3).
const (
	KeyAsleep     = "sleep_asleep_min"
	KeyAwake      = "sleep_awake_min"
	KeyInBed      = "sleep_in_bed_min"
	KeyDeep       = "sleep_deep_min"
	KeyLight      = "sleep_light_min"
	KeyREM        = "sleep_rem_min"
	KeySleepStart = "sleep_start_min_of_day"
	KeyHRV        = "hrv_rmssd_ms"
	KeyRestingHR  = "resting_hr_bpm"
)

// sleepKeys are written together: a night is a cache hit only with all of
// them and KeyHRV.
var sleepKeys = []string{KeyAsleep, KeyAwake, KeyInBed, KeyDeep, KeyLight, KeyREM, KeySleepStart}

const (
	// settleDays: the band syncs late, so a day is cached only once it is
	// this many days old; the days after it are always fetched live.
	settleDays = 3
	// minHRVSamples is the fewest in-session rMSSD samples a nightly median
	// needs (about an hour at the band's 5-minute rate). Fewer means the band
	// was off for most of the night: no value, rather than a noisy one that
	// would sit in the baselines.
	minHRVSamples = 12
	// MaxRangeDays bounds one Recovery call (28-day baselines with slack).
	MaxRangeDays     = 120
	restingWithSleep = "WITH_SLEEP"
)

// Fetcher is the part of googlehealth.Client this package uses.
type Fetcher interface {
	List(ctx context.Context, dt googlehealth.DataType, from, to coach.LocalDate) ([]json.RawMessage, error)
}

// Cache is the part of store.Store this package uses.
type Cache interface {
	MetricRange(ctx context.Context, key string, from, to coach.LocalDate, algoVersion int) ([]store.Metric, error)
	PutMetric(ctx context.Context, m store.Metric) error
}

// Source is what the coach tools read.
type Source interface {
	Recovery(ctx context.Context, from, to coach.LocalDate) (Recovery, error)
}

// Night is the main sleep session that ends on a local day (CAPABILITY I4),
// with the median HRV inside it.
type Night struct {
	AsleepMin, AwakeMin, InBedMin float64
	DeepMin, LightMin, REMMin     *float64 // nil when the night has no stages
	StartMinOfDay                 int      // local start time, minutes after midnight
	HRV                           *float64 // median rMSSD (ms); nil below minHRVSamples
	HRVSamples                    int
	Source                        string
	// Provisional: Google has not finished processing the night, so its
	// values may still change.
	Provisional bool
}

// Recovery holds the nights and resting heart rates of [From, To].
type Recovery struct {
	From, To  coach.LocalDate
	Nights    map[coach.LocalDate]Night
	RestingHR map[coach.LocalDate]float64
	Sources   []string // device or platform labels, sorted
	// Skipped counts records that could not be read. Tools report it as a
	// data quality flag; a day fetched alongside one is never cached.
	Skipped int
}

// Series returns one point per day of [From, To] for key, nil where the value
// is missing, ready for the metrics package.
func (r Recovery) Series(key string) ([]metrics.Point, error) {
	night := func(f func(Night) *float64) func(coach.LocalDate) *float64 {
		return func(d coach.LocalDate) *float64 {
			if n, ok := r.Nights[d]; ok {
				return f(n)
			}
			return nil
		}
	}
	var get func(coach.LocalDate) *float64
	switch key {
	case KeyAsleep:
		get = night(func(n Night) *float64 { return &n.AsleepMin })
	case KeyAwake:
		get = night(func(n Night) *float64 { return &n.AwakeMin })
	case KeyInBed:
		get = night(func(n Night) *float64 { return &n.InBedMin })
	case KeyDeep:
		get = night(func(n Night) *float64 { return n.DeepMin })
	case KeyLight:
		get = night(func(n Night) *float64 { return n.LightMin })
	case KeyREM:
		get = night(func(n Night) *float64 { return n.REMMin })
	case KeySleepStart:
		get = night(func(n Night) *float64 { v := float64(n.StartMinOfDay); return &v })
	case KeyHRV:
		get = night(func(n Night) *float64 { return n.HRV })
	case KeyRestingHR:
		get = func(d coach.LocalDate) *float64 {
			if v, ok := r.RestingHR[d]; ok {
				return &v
			}
			return nil
		}
	default:
		return nil, fmt.Errorf("healthdata: no series %q", key)
	}
	days, err := dayList(r.From, r.To)
	if err != nil {
		return nil, err
	}
	out := make([]metrics.Point, len(days))
	for i, d := range days {
		out[i] = metrics.Point{Date: d, Value: get(d)}
	}
	return out, nil
}

// Data implements Source over the API client and the cache. It is safe for
// concurrent use when its Fetcher and Cache are.
type Data struct {
	api   Fetcher
	cache Cache
	loc   *time.Location
	now   func() time.Time
	log   *slog.Logger
}

// New wires the source. now is the clock that decides which days are settled.
func New(api Fetcher, cache Cache, loc *time.Location, now func() time.Time, log *slog.Logger) (*Data, error) {
	if api == nil || cache == nil || loc == nil || now == nil {
		return nil, errors.New("healthdata: api, cache, time zone and clock are required")
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Data{api: api, cache: cache, loc: loc, now: now, log: log}, nil
}

// Recovery returns the nights and resting heart rates of [from, to]. Settled
// days come from the cache when complete; the rest is fetched live, one API
// range per run of consecutive missing days.
func (d *Data) Recovery(ctx context.Context, from, to coach.LocalDate) (Recovery, error) {
	days, err := dayList(from, to)
	if err != nil {
		return Recovery{}, err
	}
	settled, err := coach.Today(d.now(), d.loc).AddDays(-settleDays)
	if err != nil {
		return Recovery{}, err
	}
	r := Recovery{From: from, To: to, Nights: map[coach.LocalDate]Night{}, RestingHR: map[coach.LocalDate]float64{}}
	sources := map[string]bool{}

	cached, err := d.readCache(ctx, from, min(to, settled))
	if err != nil {
		return Recovery{}, err
	}
	var needSleep, needResting []coach.LocalDate
	for _, day := range days {
		if n, ok := cached.night(day); ok {
			r.Nights[day] = n
			sources[n.Source] = true
		} else {
			needSleep = append(needSleep, day)
		}
		if m, ok := cached[KeyRestingHR][day]; ok {
			r.RestingHR[day] = m.Value
			sources[m.Source] = true
		} else {
			needResting = append(needResting, day)
		}
	}
	for _, run := range runs(needSleep) {
		if err := d.fetchNights(ctx, run[0], run[1], settled, &r, sources); err != nil {
			return Recovery{}, err
		}
	}
	for _, run := range runs(needResting) {
		if err := d.fetchResting(ctx, run[0], run[1], settled, &r, sources); err != nil {
			return Recovery{}, err
		}
	}
	delete(sources, "")
	for s := range sources {
		r.Sources = append(r.Sources, s)
	}
	sort.Strings(r.Sources)
	return r, nil
}

type cacheRows map[string]map[coach.LocalDate]store.Metric

func (c cacheRows) night(day coach.LocalDate) (Night, bool) {
	vals := map[string]store.Metric{}
	for _, k := range append(slices.Clone(sleepKeys), KeyHRV) {
		m, ok := c[k][day]
		if !ok {
			return Night{}, false
		}
		vals[k] = m
	}
	f := func(k string) *float64 { v := vals[k].Value; return &v }
	n := Night{
		AsleepMin: vals[KeyAsleep].Value, AwakeMin: vals[KeyAwake].Value, InBedMin: vals[KeyInBed].Value,
		DeepMin: f(KeyDeep), LightMin: f(KeyLight), REMMin: f(KeyREM),
		StartMinOfDay: int(vals[KeySleepStart].Value), HRV: f(KeyHRV),
		Source: vals[KeyAsleep].Source,
	}
	if ns := vals[KeyHRV].NSamples; ns != nil {
		n.HRVSamples = *ns
	}
	return n, true
}

// readCache loads every key for the settled days [from, to]; an empty range
// (to before from: nothing settled yet) reads nothing.
func (d *Data) readCache(ctx context.Context, from, to coach.LocalDate) (cacheRows, error) {
	rows := cacheRows{}
	if to < from {
		return rows, nil
	}
	for _, k := range append(slices.Clone(sleepKeys), KeyHRV, KeyRestingHR) {
		ms, err := d.cache.MetricRange(ctx, k, from, to, metrics.AlgoVersion)
		if err != nil {
			return nil, fmt.Errorf("healthdata: read cache: %w", err)
		}
		rows[k] = map[coach.LocalDate]store.Metric{}
		for _, m := range ms {
			rows[k][m.Date] = m
		}
	}
	return rows, nil
}

// fetchNights reads the sleep sessions and HRV samples of [a, b] and fills the
// nights. Sessions are fetched with a day of margin on each side: the API
// filters on the device's local end time, while a night belongs to the day it
// ends in the configured zone. HRV starts the day before, for a night that
// begins in the evening.
func (d *Data) fetchNights(ctx context.Context, a, b, settled coach.LocalDate, r *Recovery, sources map[string]bool) error {
	before, err := a.AddDays(-1)
	if err != nil {
		return err
	}
	after, err := b.AddDays(1)
	if err != nil {
		return err
	}
	rawSleep, err := d.api.List(ctx, googlehealth.Sleep, before, after)
	if err != nil {
		return err
	}
	rawHRV, err := d.api.List(ctx, googlehealth.HeartRateVariability, before, b)
	if err != nil {
		return err
	}
	skipped := 0
	main := map[coach.LocalDate]session{}
	for _, raw := range rawSleep {
		s, ok, err := parseSleep(raw)
		if err != nil {
			skipped++
			continue
		}
		if !ok || s.nap {
			continue
		}
		day := coach.SleepDay(s.end, d.loc)
		if day < a || day > b {
			continue
		}
		// The longest session is the night; a tie keeps the later end.
		if cur, ok := main[day]; !ok || longer(s, cur) {
			main[day] = s
		}
	}
	var samples []hrvSample
	for _, raw := range rawHRV {
		h, ok, err := parseHRV(raw)
		if err != nil {
			skipped++
			continue
		}
		if ok {
			samples = append(samples, h)
		}
	}
	r.Skipped += skipped
	if skipped > 0 {
		d.log.Warn("unreadable records in a recovery fetch", "from", string(a), "to", string(b), "skipped", skipped)
	}
	for day, s := range main {
		n := Night{
			AsleepMin: s.asleep, AwakeMin: s.awake, InBedMin: s.inBed,
			DeepMin: s.deep, LightMin: s.light, REMMin: s.rem,
			StartMinOfDay: minuteOfDay(s.start.In(d.loc)),
			Source:        s.source, Provisional: !s.settled,
		}
		var in []float64
		for _, h := range samples {
			if !h.at.Before(s.start) && !h.at.After(s.end) {
				in = append(in, h.rmssd)
			}
		}
		n.HRVSamples = len(in)
		if len(in) >= minHRVSamples {
			m := median(in)
			n.HRV = &m
		}
		r.Nights[day] = n
		sources[n.Source] = true
		// Only settled, complete nights from a clean fetch are cached.
		if day <= settled && skipped == 0 && s.settled && s.deep != nil {
			d.putNight(ctx, day, n)
		}
	}
	return nil
}

func longer(s, than session) bool {
	ds, dt := s.end.Sub(s.start), than.end.Sub(than.start)
	return ds > dt || (ds == dt && s.end.After(than.end))
}

func (d *Data) putNight(ctx context.Context, day coach.LocalDate, n Night) {
	vals := map[string]float64{
		KeyAsleep: n.AsleepMin, KeyAwake: n.AwakeMin, KeyInBed: n.InBedMin,
		KeyDeep: *n.DeepMin, KeyLight: *n.LightMin, KeyREM: *n.REMMin, KeySleepStart: float64(n.StartMinOfDay),
	}
	for _, k := range sleepKeys {
		d.put(ctx, store.Metric{Date: day, Key: k, Value: vals[k], Source: n.Source})
	}
	if n.HRV != nil {
		samples := n.HRVSamples
		d.put(ctx, store.Metric{Date: day, Key: KeyHRV, Value: *n.HRV, NSamples: &samples, Source: n.Source})
	}
}

// put writes one cache row. The cache is disposable, so a failed write is
// logged (key and day, never the value) and the live value is still returned.
func (d *Data) put(ctx context.Context, m store.Metric) {
	m.AlgoVersion = metrics.AlgoVersion
	m.FetchedAt = d.now()
	if err := d.cache.PutMetric(ctx, m); err != nil {
		d.log.Warn("cache write failed", "metric", m.Key, "date", string(m.Date), "err_type", fmt.Sprintf("%T", err))
	}
}

// fetchResting reads the daily resting heart rates of [a, b]. Two Fitbit
// values for one day keep the one computed with sleep (the band's standard
// method), then the lower; such a day is not cached, so a later fetch can
// settle it.
func (d *Data) fetchResting(ctx context.Context, a, b, settled coach.LocalDate, r *Recovery, sources map[string]bool) error {
	raws, err := d.api.List(ctx, googlehealth.DailyRestingHeartRate, a, b)
	if err != nil {
		return err
	}
	skipped := 0
	byDay := map[coach.LocalDate][]restingDay{}
	for _, raw := range raws {
		v, ok, err := parseResting(raw)
		if err != nil {
			skipped++
			continue
		}
		if ok && v.date >= a && v.date <= b {
			byDay[v.date] = append(byDay[v.date], v)
		}
	}
	r.Skipped += skipped
	if skipped > 0 {
		d.log.Warn("unreadable resting heart rate records", "from", string(a), "to", string(b), "skipped", skipped)
	}
	for day, vs := range byDay {
		sort.Slice(vs, func(i, j int) bool {
			if wi, wj := vs[i].method == restingWithSleep, vs[j].method == restingWithSleep; wi != wj {
				return wi
			}
			return vs[i].bpm < vs[j].bpm
		})
		v := vs[0]
		r.RestingHR[day] = v.bpm
		sources[v.source] = true
		if day <= settled && skipped == 0 && len(vs) == 1 {
			d.put(ctx, store.Metric{Date: day, Key: KeyRestingHR, Value: v.bpm, Source: v.source})
		}
	}
	return nil
}

func dayList(from, to coach.LocalDate) ([]coach.LocalDate, error) {
	if _, err := coach.ParseDate(string(from)); err != nil {
		return nil, fmt.Errorf("healthdata: from: %w", err)
	}
	if _, err := coach.ParseDate(string(to)); err != nil {
		return nil, fmt.Errorf("healthdata: to: %w", err)
	}
	if to < from {
		return nil, fmt.Errorf("healthdata: range ends (%s) before it starts (%s)", to, from)
	}
	var out []coach.LocalDate
	for d := from; d <= to; {
		if len(out) == MaxRangeDays {
			return nil, fmt.Errorf("healthdata: a range spans at most %d days", MaxRangeDays)
		}
		out = append(out, d)
		next, err := d.AddDays(1)
		if err != nil {
			return nil, err
		}
		d = next
	}
	return out, nil
}

// runs groups sorted days into [first, last] runs of consecutive days.
func runs(days []coach.LocalDate) [][2]coach.LocalDate {
	var out [][2]coach.LocalDate
	for _, d := range days {
		if n := len(out); n > 0 {
			if next, err := out[n-1][1].AddDays(1); err == nil && next == d {
				out[n-1][1] = d
				continue
			}
		}
		out = append(out, [2]coach.LocalDate{d, d})
	}
	return out
}

func minuteOfDay(t time.Time) int { return t.Hour()*60 + t.Minute() }

func median(v []float64) float64 {
	s := slices.Clone(v)
	slices.Sort(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
