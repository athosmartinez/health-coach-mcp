package healthdata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// All values below are synthetic.

var sp = func() *time.Location {
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		panic(err)
	}
	return loc
}()

// now is 2026-10-16 10:00 local: days up to 2026-10-13 are settled.
var now = time.Date(2026, 10, 16, 10, 0, 0, 0, sp)

func at(day string, hh, mm int) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", fmt.Sprintf("%s %02d:%02d", day, hh, mm), sp)
	if err != nil {
		panic(err)
	}
	return t
}

type sleepOpt struct {
	platform     string
	nap          bool
	classic      bool
	unprocessed  bool
	asleep, deep int
}

func sleepRec(start, end time.Time, o sleepOpt) json.RawMessage {
	if o.platform == "" {
		o.platform = "FITBIT"
	}
	inBed := int(end.Sub(start).Minutes())
	if o.asleep == 0 {
		o.asleep = max(inBed-40, inBed/2)
	}
	stages := []map[string]any{
		{"type": "LIGHT", "minutes": "250", "count": "20"},
		{"type": "REM", "minutes": "90", "count": "5"},
		{"type": "AWAKE", "minutes": "40", "count": "12"},
	}
	if o.deep != 0 { // proto3 JSON leaves a zero out
		stages = append(stages, map[string]any{"type": "DEEP", "minutes": fmt.Sprint(o.deep), "count": "4"})
	}
	meta := map[string]any{"processed": !o.unprocessed, "stagesStatus": "SUCCEEDED", "mainSleep": true}
	if o.nap {
		meta["nap"] = true
	}
	sl := map[string]any{
		"type":     "STAGES",
		"interval": map[string]any{"startTime": start.UTC().Format(time.RFC3339), "endTime": end.UTC().Format(time.RFC3339)},
		"metadata": meta,
		"summary": map[string]any{
			"minutesAsleep": fmt.Sprint(o.asleep), "minutesAwake": "40", "minutesInSleepPeriod": fmt.Sprint(inBed),
			"stagesSummary": stages,
		},
	}
	if o.classic {
		sl["type"] = "CLASSIC"
		delete(meta, "stagesStatus")
	}
	return mustJSON(map[string]any{
		"name":       "users/me/dataTypes/sleep/dataPoints/synthetic",
		"dataSource": map[string]any{"platform": o.platform, "device": map[string]any{"displayName": "Synthetic Band"}},
		"sleep":      sl,
	})
}

func hrvRec(t time.Time, rmssd float64, platform string) json.RawMessage {
	return mustJSON(map[string]any{
		"dataSource": map[string]any{"platform": platform, "device": map[string]any{"displayName": "Synthetic Band"}},
		"heartRateVariability": map[string]any{
			"sampleTime": map[string]any{"physicalTime": t.UTC().Format(time.RFC3339)},
			"rootMeanSquareOfSuccessiveDifferencesMilliseconds": rmssd,
		},
	})
}

// hrvNight is one sample every 5 minutes over [start, end], all equal to v.
func hrvNight(start, end time.Time, v float64) []json.RawMessage {
	var out []json.RawMessage
	for t := start; !t.After(end); t = t.Add(5 * time.Minute) {
		out = append(out, hrvRec(t, v, "FITBIT"))
	}
	return out
}

func restingRec(day string, bpm int, method, platform string) json.RawMessage {
	var y, m, d int
	if _, err := fmt.Sscanf(day, "%d-%d-%d", &y, &m, &d); err != nil {
		panic(err)
	}
	r := map[string]any{"beatsPerMinute": fmt.Sprint(bpm), "date": map[string]any{"year": y, "month": m, "day": d}}
	if method != "" {
		r["dailyRestingHeartRateMetadata"] = map[string]any{"calculationMethod": method}
	}
	return mustJSON(map[string]any{
		"dataSource":            map[string]any{"platform": platform, "device": map[string]any{"displayName": "Synthetic Band"}},
		"dailyRestingHeartRate": r,
	})
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// fakeAPI serves records and filters them by local day, as the API does.
type fakeAPI struct {
	mu      sync.Mutex
	records map[googlehealth.DataType][]json.RawMessage
	calls   []string
	err     error
}

func (f *fakeAPI) add(dt googlehealth.DataType, recs ...json.RawMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.records == nil {
		f.records = map[googlehealth.DataType][]json.RawMessage{}
	}
	f.records[dt] = append(f.records[dt], recs...)
}

func (f *fakeAPI) List(_ context.Context, dt googlehealth.DataType, from, to coach.LocalDate) ([]json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fmt.Sprintf("%s %s..%s", dt, from, to))
	if f.err != nil {
		return nil, f.err
	}
	var out []json.RawMessage
	for _, raw := range f.records[dt] {
		day := recordDay(dt, raw)
		if day == "" || (day >= from && day <= to) { // records without a readable day always come back
			out = append(out, raw)
		}
	}
	return out, nil
}

func recordDay(dt googlehealth.DataType, raw json.RawMessage) coach.LocalDate {
	var r struct {
		Sleep *struct {
			Interval struct{ EndTime time.Time } `json:"interval"`
		} `json:"sleep"`
		HRV *struct {
			SampleTime struct{ PhysicalTime time.Time } `json:"sampleTime"`
		} `json:"heartRateVariability"`
		RHR *struct {
			Date struct{ Year, Month, Day int } `json:"date"`
		} `json:"dailyRestingHeartRate"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return ""
	}
	switch {
	case dt == googlehealth.Sleep && r.Sleep != nil && !r.Sleep.Interval.EndTime.IsZero():
		return coach.DateOf(r.Sleep.Interval.EndTime, sp)
	case dt == googlehealth.HeartRateVariability && r.HRV != nil && !r.HRV.SampleTime.PhysicalTime.IsZero():
		return coach.DateOf(r.HRV.SampleTime.PhysicalTime, sp)
	case dt == googlehealth.DailyRestingHeartRate && r.RHR != nil:
		return coach.LocalDate(fmt.Sprintf("%04d-%02d-%02d", r.RHR.Date.Year, r.RHR.Date.Month, r.RHR.Date.Day))
	}
	return ""
}

func (f *fakeAPI) takeCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.calls
	f.calls = nil
	return c
}

func newData(t *testing.T, api *fakeAPI) (*Data, *store.Store) {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "coach.db"), func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	d, err := New(api, st, sp, func() time.Time { return now }, nil)
	if err != nil {
		t.Fatal(err)
	}
	return d, st
}

func day(s string) coach.LocalDate { return coach.LocalDate(s) }

func TestNightBelongsToTheDayItEnds(t *testing.T) {
	api := &fakeAPI{}
	api.add(googlehealth.Sleep,
		sleepRec(at("2026-10-09", 23, 10), at("2026-10-10", 7, 40), sleepOpt{deep: 70}),
		sleepRec(at("2026-10-10", 14, 0), at("2026-10-10", 14, 20), sleepOpt{nap: true}),
		// A longer copy from the phone is not the band's night.
		sleepRec(at("2026-10-09", 22, 0), at("2026-10-10", 8, 0), sleepOpt{platform: "HEALTH_KIT", deep: 10}),
	)
	// The 23:30 samples belong to the night that ends the next morning.
	api.add(googlehealth.HeartRateVariability, hrvNight(at("2026-10-09", 23, 30), at("2026-10-10", 7, 30), 42)...)
	api.add(googlehealth.HeartRateVariability, hrvRec(at("2026-10-10", 14, 10), 99, "FITBIT")) // during the nap
	d, _ := newData(t, api)
	r, err := d.Recovery(context.Background(), day("2026-10-09"), day("2026-10-10"))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := r.Nights[day("2026-10-09")]; ok {
		t.Error("the night was counted on the day it started")
	}
	n, ok := r.Nights[day("2026-10-10")]
	if !ok {
		t.Fatalf("no night on the end day: %+v", r.Nights)
	}
	if n.InBedMin != 510 || n.AsleepMin != 470 || n.StartMinOfDay != 23*60+10 || *n.DeepMin != 70 || *n.REMMin != 90 ||
		n.Source != "Synthetic Band" || n.Provisional {
		t.Errorf("night = %+v", n)
	}
	if n.HRV == nil || *n.HRV != 42 || n.HRVSamples != 97 {
		t.Errorf("HRV = %v from %d samples", n.HRV, n.HRVSamples)
	}
	if fmt.Sprint(r.Sources) != "[Synthetic Band]" || r.Skipped != 0 {
		t.Errorf("sources %v, skipped %d", r.Sources, r.Skipped)
	}
}

func TestLongestSessionIsTheNight(t *testing.T) {
	api := &fakeAPI{}
	// An unflagged short session and the real night end the same day.
	api.add(googlehealth.Sleep,
		sleepRec(at("2026-10-10", 5, 0), at("2026-10-10", 6, 30), sleepOpt{deep: 5}),
		sleepRec(at("2026-10-09", 22, 0), at("2026-10-10", 4, 30), sleepOpt{deep: 50}),
	)
	d, _ := newData(t, api)
	r, err := d.Recovery(context.Background(), day("2026-10-10"), day("2026-10-10"))
	if n := r.Nights[day("2026-10-10")]; err != nil || n.InBedMin != 390 || *n.DeepMin != 50 {
		t.Errorf("night = %+v, %v", n, err)
	}
}

func TestOnlyANapIsNoNight(t *testing.T) {
	api := &fakeAPI{}
	api.add(googlehealth.Sleep, sleepRec(at("2026-10-10", 14, 0), at("2026-10-10", 14, 20), sleepOpt{nap: true}))
	d, st := newData(t, api)
	r, err := d.Recovery(context.Background(), day("2026-10-10"), day("2026-10-10"))
	if err != nil || len(r.Nights) != 0 {
		t.Fatalf("nights = %+v, %v", r.Nights, err)
	}
	// A missing value is never cached: the next call asks again.
	if ms, _ := st.MetricRange(context.Background(), KeyAsleep, day("2026-10-10"), day("2026-10-10"), metrics.AlgoVersion); len(ms) != 0 {
		t.Errorf("cached a missing night: %+v", ms)
	}
	api.takeCalls()
	if _, err := d.Recovery(context.Background(), day("2026-10-10"), day("2026-10-10")); err != nil || len(api.takeCalls()) != 3 {
		t.Error("a missing night was not fetched again")
	}
}

// week is 2026-10-07..2026-10-15: a full night and resting HR on each day.
func week(api *fakeAPI) {
	for i := 7; i <= 15; i++ {
		end, startDay := fmt.Sprintf("2026-10-%02d", i), fmt.Sprintf("2026-10-%02d", i-1)
		api.add(googlehealth.Sleep, sleepRec(at(startDay, 23, 0), at(end, 7, 0), sleepOpt{deep: 60 + i}))
		api.add(googlehealth.HeartRateVariability, hrvNight(at(startDay, 23, 0), at(end, 7, 0), float64(40+i))...)
		api.add(googlehealth.DailyRestingHeartRate, restingRec(end, 50+i, "WITH_SLEEP", "FITBIT"))
	}
}

func TestSettledDaysComeFromTheCache(t *testing.T) {
	api := &fakeAPI{}
	week(api)
	d, _ := newData(t, api)
	ctx := context.Background()
	first, err := d.Recovery(ctx, day("2026-10-07"), day("2026-10-15"))
	if err != nil {
		t.Fatal(err)
	}
	if got := api.takeCalls(); len(got) != 3 {
		t.Fatalf("first call: %v", got)
	}
	second, err := d.Recovery(ctx, day("2026-10-07"), day("2026-10-15"))
	if err != nil {
		t.Fatal(err)
	}
	// D-3 (10-13) and older come from the cache; D-2 onward is fetched live.
	want := []string{
		"sleep 2026-10-13..2026-10-16",
		"heart-rate-variability 2026-10-13..2026-10-15",
		"daily-resting-heart-rate 2026-10-14..2026-10-15",
	}
	if got := api.takeCalls(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("second call fetched %v\nwant %v", got, want)
	}
	assertSame(t, first, second)
	if n := second.Nights[day("2026-10-10")]; n.HRVSamples != 97 || *n.HRV != 50 || n.Source != "Synthetic Band" {
		t.Errorf("cached night = %+v", n)
	}
}

func assertSame(t *testing.T, a, b Recovery) {
	t.Helper()
	for _, k := range append(append([]string{}, sleepKeys...), KeyHRV, KeyRestingHR) {
		sa, _ := a.Series(k)
		sb, _ := b.Series(k)
		if render(sa) != render(sb) {
			t.Errorf("%s differs:\n%s\n%s", k, render(sa), render(sb))
		}
	}
	if fmt.Sprint(a.Sources) != fmt.Sprint(b.Sources) {
		t.Errorf("sources %v vs %v", a.Sources, b.Sources)
	}
}

func render(ps []metrics.Point) string {
	var b strings.Builder
	for _, p := range ps {
		if p.Value == nil {
			fmt.Fprintf(&b, "%s=nil ", p.Date)
		} else {
			fmt.Fprintf(&b, "%s=%g ", p.Date, *p.Value)
		}
	}
	return b.String()
}

func TestDeletingTheCacheChangesNothing(t *testing.T) {
	api := &fakeAPI{}
	week(api)
	d, st := newData(t, api)
	ctx := context.Background()
	warm, _ := d.Recovery(ctx, day("2026-10-07"), day("2026-10-15"))
	cached, _ := d.Recovery(ctx, day("2026-10-07"), day("2026-10-15"))
	if err := st.ClearMetrics(ctx); err != nil {
		t.Fatal(err)
	}
	cold, err := d.Recovery(ctx, day("2026-10-07"), day("2026-10-15"))
	if err != nil {
		t.Fatal(err)
	}
	assertSame(t, warm, cached)
	assertSame(t, warm, cold)
}

func TestAnotherAlgoVersionIsAMiss(t *testing.T) {
	api := &fakeAPI{}
	week(api)
	d, st := newData(t, api)
	ctx := context.Background()
	// A row from another derivation of the same day.
	if err := st.PutMetric(ctx, store.Metric{Date: day("2026-10-10"), Key: KeyRestingHR, Value: 99, AlgoVersion: metrics.AlgoVersion + 1}); err != nil {
		t.Fatal(err)
	}
	r, err := d.Recovery(ctx, day("2026-10-10"), day("2026-10-10"))
	if err != nil || r.RestingHR[day("2026-10-10")] != 60 {
		t.Errorf("resting HR = %v, %v; want the live value", r.RestingHR, err)
	}
}

func TestOnlyTheGapIsFetched(t *testing.T) {
	api := &fakeAPI{}
	week(api)
	d, st := newData(t, api)
	ctx := context.Background()
	// Cache every settled day of 10-07..10-12 except 10-09.
	for _, dd := range []string{"2026-10-07", "2026-10-08", "2026-10-10", "2026-10-11", "2026-10-12"} {
		if _, err := d.Recovery(ctx, day(dd), day(dd)); err != nil {
			t.Fatal(err)
		}
	}
	api.takeCalls()
	if _, err := d.Recovery(ctx, day("2026-10-07"), day("2026-10-12")); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"sleep 2026-10-08..2026-10-10",
		"heart-rate-variability 2026-10-08..2026-10-09",
		"daily-resting-heart-rate 2026-10-09..2026-10-09",
	}
	if got := api.takeCalls(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("fetched %v\nwant %v", got, want)
	}
	_ = st
}

func TestWhatIsNeverCached(t *testing.T) {
	ctx := context.Background()
	cachedKeys := func(st *store.Store, dd string) []string {
		var keys []string
		for _, k := range append(append([]string{}, sleepKeys...), KeyHRV, KeyRestingHR) {
			if ms, _ := st.MetricRange(ctx, k, day(dd), day(dd), metrics.AlgoVersion); len(ms) > 0 {
				keys = append(keys, k)
			}
		}
		return keys
	}
	night := func(api *fakeAPI, o sleepOpt) {
		api.add(googlehealth.Sleep, sleepRec(at("2026-10-09", 23, 0), at("2026-10-10", 7, 0), o))
	}
	t.Run("unprocessed night", func(t *testing.T) {
		api := &fakeAPI{}
		night(api, sleepOpt{deep: 60, unprocessed: true})
		d, st := newData(t, api)
		r, _ := d.Recovery(ctx, day("2026-10-10"), day("2026-10-10"))
		if !r.Nights[day("2026-10-10")].Provisional || len(cachedKeys(st, "2026-10-10")) != 0 {
			t.Errorf("provisional %v, cached %v", r.Nights[day("2026-10-10")].Provisional, cachedKeys(st, "2026-10-10"))
		}
	})
	t.Run("night without stages", func(t *testing.T) {
		api := &fakeAPI{}
		night(api, sleepOpt{classic: true})
		d, st := newData(t, api)
		r, _ := d.Recovery(ctx, day("2026-10-10"), day("2026-10-10"))
		if n := r.Nights[day("2026-10-10")]; n.DeepMin != nil || n.AsleepMin == 0 || len(cachedKeys(st, "2026-10-10")) != 0 {
			t.Errorf("night %+v, cached %v", n, cachedKeys(st, "2026-10-10"))
		}
	})
	t.Run("a stage of zero minutes", func(t *testing.T) {
		api := &fakeAPI{}
		night(api, sleepOpt{}) // no DEEP entry: the API omits zero
		d, _ := newData(t, api)
		r, _ := d.Recovery(ctx, day("2026-10-10"), day("2026-10-10"))
		if n := r.Nights[day("2026-10-10")]; n.DeepMin == nil || *n.DeepMin != 0 {
			t.Errorf("night %+v", n)
		}
	})
	t.Run("HRV sample threshold", func(t *testing.T) {
		api := &fakeAPI{}
		night(api, sleepOpt{deep: 60})
		api.add(googlehealth.HeartRateVariability, hrvNight(at("2026-10-10", 6, 0), at("2026-10-10", 6, 55), 50)...) // 12 samples
		api.add(googlehealth.HeartRateVariability, hrvNight(at("2026-10-09", 6, 0), at("2026-10-09", 6, 50), 80)...) // before the night
		d, st := newData(t, api)
		r, _ := d.Recovery(ctx, day("2026-10-10"), day("2026-10-10"))
		if n := r.Nights[day("2026-10-10")]; n.HRV == nil || *n.HRV != 50 || n.HRVSamples != minHRVSamples {
			t.Errorf("12 samples: %+v", n)
		}
		if got := cachedKeys(st, "2026-10-10"); len(got) != len(sleepKeys)+1 {
			t.Errorf("cached %v", got)
		}
		api2 := &fakeAPI{}
		night(api2, sleepOpt{deep: 60})
		api2.add(googlehealth.HeartRateVariability, hrvNight(at("2026-10-10", 6, 0), at("2026-10-10", 6, 50), 50)...) // 11 samples
		d2, st2 := newData(t, api2)
		r2, _ := d2.Recovery(ctx, day("2026-10-10"), day("2026-10-10"))
		if n := r2.Nights[day("2026-10-10")]; n.HRV != nil || n.HRVSamples != minHRVSamples-1 {
			t.Errorf("11 samples: %+v", n)
		}
		// The night is cached without HRV, so it stays a miss and is fetched again.
		if got := cachedKeys(st2, "2026-10-10"); len(got) != len(sleepKeys) {
			t.Errorf("cached %v", got)
		}
	})
	t.Run("unreadable record in the fetch", func(t *testing.T) {
		api := &fakeAPI{}
		night(api, sleepOpt{deep: 60})
		api.add(googlehealth.Sleep, json.RawMessage(`{"dataSource":{"platform":"FITBIT"},"sleep":{"summary":{"minutesAsleep":"x"}}}`))
		api.add(googlehealth.HeartRateVariability, hrvNight(at("2026-10-09", 23, 0), at("2026-10-10", 7, 0), 50)...)
		api.add(googlehealth.DailyRestingHeartRate, restingRec("2026-10-10", 55, "", "FITBIT"),
			json.RawMessage(`{"dataSource":{"platform":"FITBIT"},"dailyRestingHeartRate":{"beatsPerMinute":"9000","date":{"year":2026,"month":10,"day":10}}}`))
		d, st := newData(t, api)
		r, err := d.Recovery(ctx, day("2026-10-10"), day("2026-10-10"))
		if err != nil || r.Skipped != 2 || r.Nights[day("2026-10-10")].AsleepMin == 0 || r.RestingHR[day("2026-10-10")] != 55 {
			t.Errorf("recovery = %+v, %v", r, err)
		}
		if got := cachedKeys(st, "2026-10-10"); len(got) != 0 {
			t.Errorf("cached %v from a fetch with an unreadable record", got)
		}
	})
	t.Run("live days", func(t *testing.T) {
		api := &fakeAPI{}
		week(api)
		d, st := newData(t, api)
		if _, err := d.Recovery(ctx, day("2026-10-13"), day("2026-10-15")); err != nil {
			t.Fatal(err)
		}
		if len(cachedKeys(st, "2026-10-13")) == 0 || len(cachedKeys(st, "2026-10-14")) != 0 || len(cachedKeys(st, "2026-10-15")) != 0 {
			t.Errorf("D-3 %v, D-2 %v, D-1 %v", cachedKeys(st, "2026-10-13"), cachedKeys(st, "2026-10-14"), cachedKeys(st, "2026-10-15"))
		}
	})
}

func TestRestingHeartRateSources(t *testing.T) {
	api := &fakeAPI{}
	api.add(googlehealth.DailyRestingHeartRate,
		restingRec("2026-10-08", 54, "WITH_SLEEP", "FITBIT"),
		restingRec("2026-10-08", 49, "", "HEALTH_KIT"), // the phone's copy is ignored
		restingRec("2026-10-09", 52, "", "FITBIT"),
		restingRec("2026-10-09", 56, "WITH_SLEEP", "FITBIT"), // the band's standard method wins
		restingRec("2026-10-30", 70, "WITH_SLEEP", "FITBIT"), // outside the range
	)
	d, st := newData(t, api)
	ctx := context.Background()
	r, err := d.Recovery(ctx, day("2026-10-08"), day("2026-10-10"))
	if err != nil || fmt.Sprint(r.RestingHR) != "map[2026-10-08:54 2026-10-09:56]" {
		t.Fatalf("resting HR = %v, %v", r.RestingHR, err)
	}
	series, _ := r.Series(KeyRestingHR)
	if render(series) != "2026-10-08=54 2026-10-09=56 2026-10-10=nil " {
		t.Errorf("series = %s", render(series))
	}
	// Two band values for one day: not cached, so a later fetch can settle it.
	if ms, _ := st.MetricRange(ctx, KeyRestingHR, day("2026-10-08"), day("2026-10-09"), metrics.AlgoVersion); len(ms) != 1 || ms[0].Date != day("2026-10-08") {
		t.Errorf("cached %+v", ms)
	}
}

func TestSeriesCoversEveryDay(t *testing.T) {
	r := Recovery{From: day("2026-10-01"), To: day("2026-10-03"), Nights: map[coach.LocalDate]Night{
		day("2026-10-02"): {AsleepMin: 400, StartMinOfDay: 1380},
	}}
	for key, want := range map[string]string{
		KeyAsleep:     "2026-10-01=nil 2026-10-02=400 2026-10-03=nil ",
		KeySleepStart: "2026-10-01=nil 2026-10-02=1380 2026-10-03=nil ",
		KeyDeep:       "2026-10-01=nil 2026-10-02=nil 2026-10-03=nil ",
		KeyHRV:        "2026-10-01=nil 2026-10-02=nil 2026-10-03=nil ",
		KeyRestingHR:  "2026-10-01=nil 2026-10-02=nil 2026-10-03=nil ",
	} {
		s, err := r.Series(key)
		if err != nil || render(s) != want {
			t.Errorf("%s = %s, %v", key, render(s), err)
		}
		// metrics.Baseline accepts it: one point per day, no duplicates.
		if _, err := metrics.Baseline(s, day("2026-10-04"), 3); err != nil {
			t.Errorf("%s: %v", key, err)
		}
	}
	if _, err := r.Series("steps"); err == nil {
		t.Error("unknown series accepted")
	}
}

func TestRangeAndErrors(t *testing.T) {
	api := &fakeAPI{}
	d, _ := newData(t, api)
	ctx := context.Background()
	for name, rng := range map[string][2]string{
		"reversed": {"2026-10-10", "2026-10-09"},
		"invalid":  {"2026-10-32", "2026-10-09"},
		"too long": {"2026-01-01", "2026-12-31"},
		"bad to":   {"2026-10-01", "x"},
	} {
		if _, err := d.Recovery(ctx, day(rng[0]), day(rng[1])); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	if len(api.takeCalls()) != 0 {
		t.Error("an invalid range reached the API")
	}
	want := coach.ToolError{Code: coach.CodeAuthExpired, Message: "not signed in"}
	api.err = want
	if _, err := d.Recovery(ctx, day("2026-10-10"), day("2026-10-10")); !errors.Is(err, want) {
		t.Errorf("err = %v, want the API error unchanged", err)
	}
	if _, err := New(nil, nil, sp, time.Now, nil); err == nil {
		t.Error("New accepted nil dependencies")
	}
}

func TestParsersRejectBadRecords(t *testing.T) {
	for _, raw := range []string{
		`not json`,
		`{"dataSource":{"platform":"FITBIT"}}`,
		`{"dataSource":{"platform":"FITBIT"},"sleep":{"interval":{"startTime":"2026-10-10T07:00:00Z","endTime":"2026-10-10T06:00:00Z"},"summary":{"minutesInSleepPeriod":"60"}}}`,
		`{"dataSource":{"platform":"FITBIT"},"sleep":{"interval":{"startTime":"2026-10-10T01:00:00Z","endTime":"2026-10-10T06:00:00Z"},"summary":{"minutesAsleep":"400","minutesInSleepPeriod":"300"}}}`,
	} {
		if _, _, err := parseSleep(json.RawMessage(raw)); err == nil {
			t.Errorf("sleep accepted %s", raw)
		}
	}
	for _, raw := range []string{
		`[]`,
		`{"dataSource":{"platform":"FITBIT"},"heartRateVariability":{}}`,
		`{"dataSource":{"platform":"FITBIT"},"heartRateVariability":{"sampleTime":{"physicalTime":"2026-10-10T06:00:00Z"},"rootMeanSquareOfSuccessiveDifferencesMilliseconds":-1}}`,
	} {
		if _, _, err := parseHRV(json.RawMessage(raw)); err == nil {
			t.Errorf("HRV accepted %s", raw)
		}
	}
	// An HRV sample without rMSSD is left out, not an error.
	if _, ok, err := parseHRV(json.RawMessage(`{"dataSource":{"platform":"FITBIT"},"heartRateVariability":{"sampleTime":{"physicalTime":"2026-10-10T06:00:00Z"}}}`)); ok || err != nil {
		t.Errorf("sample without rMSSD: %v, %v", ok, err)
	}
	for _, raw := range []string{
		`{"dataSource":{"platform":"FITBIT"}}`,
		`{"dataSource":{"platform":"FITBIT"},"dailyRestingHeartRate":{"beatsPerMinute":"55","date":{"year":2026,"month":2,"day":30}}}`,
		`{"dataSource":{"platform":"FITBIT"},"dailyRestingHeartRate":{"beatsPerMinute":"fifty","date":{"year":2026,"month":2,"day":3}}}`,
	} {
		if _, _, err := parseResting(json.RawMessage(raw)); err == nil {
			t.Errorf("resting HR accepted %s", raw)
		}
	}
}

func TestErrorsNeverQuoteRecords(t *testing.T) {
	raw := json.RawMessage(`{"dataSource":{"platform":"FITBIT"},"sleep":{"summary":{"minutesAsleep":"417 secret"}}}`)
	if _, _, err := parseSleep(raw); err == nil || strings.Contains(err.Error(), "417") || strings.Contains(err.Error(), "secret") {
		t.Errorf("err = %v", err)
	}
}

func TestMedian(t *testing.T) {
	for _, tc := range []struct {
		in   []float64
		want float64
	}{{[]float64{1}, 1}, {[]float64{3, 1, 2}, 2}, {[]float64{4, 1, 3, 2}, 2.5}} {
		if got := median(tc.in); got != tc.want {
			t.Errorf("median(%v) = %v", tc.in, got)
		}
	}
}
