package healthdata

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// All values below are synthetic, in the API's raw shapes.

func civil(day string) map[string]any {
	var y, m, d int
	if _, err := fmt.Sscanf(day, "%d-%d-%d", &y, &m, &d); err != nil {
		panic(err)
	}
	return map[string]any{"date": map[string]any{"year": y, "month": m, "day": d}}
}

func rollupRow(day string, key string, value map[string]any) json.RawMessage {
	next, _ := coach.LocalDate(day).AddDays(1)
	return mustJSON(map[string]any{"civilStartTime": civil(day), "civilEndTime": civil(string(next)), key: value})
}

func stepsRollup(day string, n int) json.RawMessage {
	return rollupRow(day, "steps", map[string]any{"countSum": fmt.Sprint(n)})
}

// azmRollup leaves out zero zones, as proto3 JSON does.
func azmRollup(day string, fat, cardio, peak int) json.RawMessage {
	v := map[string]any{}
	for k, n := range map[string]int{"sumInFatBurnHeartZone": fat, "sumInCardioHeartZone": cardio, "sumInPeakHeartZone": peak} {
		if n != 0 {
			v[k] = fmt.Sprint(n)
		}
	}
	return rollupRow(day, "activeZoneMinutes", v)
}

func kcalRollup(day string, kcal float64) json.RawMessage {
	return rollupRow(day, "totalCalories", map[string]any{"kcalSum": kcal})
}

// stepRec is one raw steps record, enough for the "band worn" check.
func stepRec(day, platform string) json.RawMessage {
	return mustJSON(map[string]any{
		"dataSource": map[string]any{"platform": platform},
		"steps":      map[string]any{"count": "120", "interval": map[string]any{"civilStartTime": civil(day)}},
	})
}

func activityWeek(api *fakeAPI) {
	for i := 7; i <= 16; i++ {
		d := fmt.Sprintf("2026-10-%02d", i)
		api.addRollup(googlehealth.Steps, stepsRollup(d, 8000+i))
		api.addRollup(googlehealth.ActiveZoneMinutes, azmRollup(d, 20, 5, i%2))
		api.addRollup(googlehealth.TotalCalories, kcalRollup(d, 2400.5))
	}
}

func TestActivityDays(t *testing.T) {
	api := &fakeAPI{}
	activityWeek(api)
	d, _ := newData(t, api)
	a, err := d.Activity(ctx, day("2026-10-14"), day("2026-10-16"))
	if err != nil {
		t.Fatal(err)
	}
	got := a.Days[day("2026-10-15")]
	// Active Zone Minutes are the zone sums as reported: cardio and peak
	// already count double.
	// Zone minutes come from the band: the day was worn without a steps list.
	if *got.Steps != 8015 || *got.AZM != 26 || *got.TotalKcal != 2400.5 || got.Partial || !got.Worn {
		t.Errorf("10-15 = %+v", got)
	}
	if !a.Days[day("2026-10-16")].Partial || a.Days[day("2026-10-14")].Partial {
		t.Error("only today is partial")
	}
	s, _ := a.Series(KeySteps)
	b, _ := a.BaselineSeries(KeySteps)
	if render(s) != "2026-10-14=8014 2026-10-15=8015 2026-10-16=8016 " || render(b) != "2026-10-14=8014 2026-10-15=8015 2026-10-16=nil " {
		t.Errorf("series %s, baseline %s", render(s), render(b))
	}
	for _, k := range []string{KeyAZM, KeyTotalCalories} {
		if _, err := a.Series(k); err != nil {
			t.Error(err)
		}
	}
	if _, err := a.Series("weight_kg"); err == nil {
		t.Error("unknown series accepted")
	}
	// All zones present on every day: no extra request for worn days.
	for _, c := range api.takeCalls() {
		if !strings.HasPrefix(c, "rollup ") {
			t.Errorf("unexpected call %s", c)
		}
	}
}

func TestAZMOnADayWithoutZoneMinutes(t *testing.T) {
	api := &fakeAPI{}
	for _, d := range []string{"2026-10-10", "2026-10-11", "2026-10-12"} {
		api.addRollup(googlehealth.Steps, stepsRollup(d, 5000))
	}
	api.addRollup(googlehealth.ActiveZoneMinutes, azmRollup("2026-10-10", 12, 0, 0))
	// 10-11: the band recorded steps but no zone minutes. 10-12: only the phone.
	api.add(googlehealth.Steps, stepRec("2026-10-11", "FITBIT"), stepRec("2026-10-12", "HEALTH_KIT"))
	d, _ := newData(t, api)
	a, err := d.Activity(ctx, day("2026-10-10"), day("2026-10-12"))
	if err != nil {
		t.Fatal(err)
	}
	if *a.Days[day("2026-10-10")].AZM != 12 || *a.Days[day("2026-10-11")].AZM != 0 || a.Days[day("2026-10-12")].AZM != nil {
		t.Errorf("AZM = %v %v %v", a.Days[day("2026-10-10")].AZM, a.Days[day("2026-10-11")].AZM, a.Days[day("2026-10-12")].AZM)
	}
	if a.Days[day("2026-10-12")].Steps == nil || a.Days[day("2026-10-11")].TotalKcal != nil {
		t.Errorf("days = %+v", a.Days)
	}
}

func TestActivityCache(t *testing.T) {
	api := &fakeAPI{}
	activityWeek(api)
	d, st := newData(t, api)
	first, err := d.Activity(ctx, day("2026-10-07"), day("2026-10-16"))
	if err != nil {
		t.Fatal(err)
	}
	api.takeCalls()
	second, err := d.Activity(ctx, day("2026-10-07"), day("2026-10-16"))
	if err != nil {
		t.Fatal(err)
	}
	// D-3 (10-13) and older from the cache; the rest live.
	want := []string{
		"rollup steps 2026-10-14..2026-10-16",
		"rollup active-zone-minutes 2026-10-14..2026-10-16",
		"rollup total-calories 2026-10-14..2026-10-16",
	}
	if got := api.takeCalls(); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("second call %v\nwant %v", got, want)
	}
	for _, k := range activityKeys {
		a, _ := first.Series(k)
		b, _ := second.Series(k)
		if render(a) != render(b) {
			t.Errorf("%s differs:\n%s\n%s", k, render(a), render(b))
		}
	}
	ms, _ := st.MetricRange(ctx, KeySteps, day("2026-10-07"), day("2026-10-16"), metrics.AlgoVersion)
	if len(ms) != 7 || ms[0].Source != rollupSource || ms[0].Zone != sp.String() {
		t.Errorf("cached %d rows: %+v", len(ms), ms)
	}
}

func TestActivityBadRows(t *testing.T) {
	api := &fakeAPI{loose: true}
	api.addRollup(googlehealth.Steps,
		stepsRollup("2026-10-10", 9000),
		stepsRollup("2026-10-11", 500_000),             // implausible
		stepsRollup("2026-10-20", 7000),                // outside the range
		json.RawMessage(`{"steps":{"countSum":"10"}}`), // no date
		rollupRow("2026-10-12", "steps", map[string]any{"countSum": "many"}),
	)
	api.addRollup(googlehealth.TotalCalories, rollupRow("2026-10-10", "totalCalories", map[string]any{}))
	api.addRollup(googlehealth.ActiveZoneMinutes, azmRollup("2026-10-10", 1, 0, 0), azmRollup("2026-10-11", 1, 0, 0), azmRollup("2026-10-12", 1, 0, 0))
	d, st := newData(t, api)
	a, err := d.Activity(ctx, day("2026-10-10"), day("2026-10-12"))
	if err != nil {
		t.Fatal(err)
	}
	// The row outside the range is ignored, not counted.
	if a.Skipped != 4 || *a.Days[day("2026-10-10")].Steps != 9000 || a.Days[day("2026-10-11")].Steps != nil || a.Days[day("2026-10-10")].TotalKcal != nil {
		t.Errorf("activity = %+v, skipped %d", a.Days, a.Skipped)
	}
	// A run with dropped rows is returned but not cached.
	for _, k := range activityKeys {
		if ms, _ := st.MetricRange(ctx, k, day("2026-10-10"), day("2026-10-12"), metrics.AlgoVersion); len(ms) != 0 {
			t.Errorf("cached %s %+v", k, ms)
		}
	}
	api.takeCalls()
	if _, err := d.Activity(ctx, day("2026-10-10"), day("2026-10-12")); err != nil || len(api.takeCalls()) == 0 {
		t.Errorf("an incomplete day came from the cache: %v", err)
	}
}

func TestActivityErrors(t *testing.T) {
	api := &fakeAPI{}
	d, _ := newData(t, api)
	if _, err := d.Activity(ctx, day("2026-10-10"), day("2026-10-09")); err == nil {
		t.Error("reversed range accepted")
	}
	want := coach.ToolError{Code: coach.CodeUpstreamUnavailable, Message: "down"}
	api.err = want
	if _, err := d.Activity(ctx, day("2026-10-10"), day("2026-10-10")); !errors.Is(err, want) {
		t.Errorf("err = %v", err)
	}
	if _, err := d.Body(ctx, day("2026-10-10"), day("2026-10-10")); !errors.Is(err, want) {
		t.Errorf("body err = %v", err)
	}
	if _, err := d.Body(ctx, day("2026-10-10"), day("2026-10-09")); err == nil {
		t.Error("reversed body range accepted")
	}
	fc := &failingCache{read: true, Store: openStore(t)}
	d2, _ := New(api, fc, sp, func() time.Time { return now }, nil)
	if _, err := d2.Activity(ctx, day("2026-10-10"), day("2026-10-10")); !errors.Is(err, errDisk) {
		t.Errorf("cache read err = %v", err)
	}
	if _, err := d2.Body(ctx, day("2026-10-10"), day("2026-10-10")); !errors.Is(err, errDisk) {
		t.Errorf("body cache read err = %v", err)
	}
}

func weightRec(t time.Time, grams float64, platform string) json.RawMessage {
	return mustJSON(map[string]any{
		"dataSource": map[string]any{"platform": platform, "device": map[string]any{"displayName": "Synthetic Scale"}},
		"weight":     map[string]any{"sampleTime": map[string]any{"physicalTime": t.UTC().Format(time.RFC3339)}, "weightGrams": grams},
	})
}

func bodyFatRec(t time.Time, pct float64) json.RawMessage {
	return mustJSON(map[string]any{
		"dataSource": map[string]any{"platform": "FITBIT"},
		"bodyFat":    map[string]any{"sampleTime": map[string]any{"physicalTime": t.UTC().Format(time.RFC3339)}, "percentage": pct},
	})
}

func TestBody(t *testing.T) {
	api := &fakeAPI{}
	api.add(googlehealth.Weight,
		weightRec(at("2026-10-10", 7, 0), 80500, "FITBIT"),
		weightRec(at("2026-10-10", 21, 0), 81200, "FITBIT"),    // an evening reading the same day
		weightRec(at("2026-10-12", 8, 0), 80100, "HEALTH_KIT"), // a scale synced through the phone counts
		weightRec(at("2026-10-11", 8, 0), 5000, "FITBIT"),      // implausible
		json.RawMessage(`{"weight":{}}`),
	)
	api.add(googlehealth.BodyFat, bodyFatRec(at("2026-10-12", 8, 0), 18.5))
	d, st := newData(t, api)
	b, err := d.Body(ctx, day("2026-10-10"), day("2026-10-12"))
	if err != nil {
		t.Fatal(err)
	}
	// The day's first reading: the morning weigh-in.
	if w := b.Weight[day("2026-10-10")]; w.Value != 80.5 || w.Source != "Synthetic Scale" {
		t.Errorf("10-10 = %+v", w)
	}
	if b.Weight[day("2026-10-12")].Value != 80.1 || len(b.Weight) != 2 || b.Skipped != 2 || b.BodyFat[day("2026-10-12")].Value != 18.5 {
		t.Errorf("body = %+v", b)
	}
	if last, r, ok := Last(b.Weight); !ok || last != day("2026-10-12") || r.Value != 80.1 {
		t.Errorf("Last = %s %+v %v", last, r, ok)
	}
	if _, _, ok := Last(map[coach.LocalDate]Reading{}); ok {
		t.Error("Last of nothing found something")
	}
	s, _ := b.Series(KeyWeight)
	if render(s) != "2026-10-10=80.5 2026-10-11=nil 2026-10-12=80.1 " {
		t.Errorf("series %s", render(s))
	}
	if f, err := b.Series(KeyBodyFat); err != nil || render(f) != "2026-10-10=nil 2026-10-11=nil 2026-10-12=18.5 " {
		t.Errorf("body fat series %s, %v", render(f), err)
	}
	if _, err := b.Series("steps"); err == nil {
		t.Error("unknown body series accepted")
	}
	// The dropped readings may have been a day's first: nothing is cached.
	if ms, _ := st.MetricRange(ctx, KeyWeight, day("2026-10-10"), day("2026-10-12"), metrics.AlgoVersion); len(ms) != 0 {
		t.Errorf("cached %+v", ms)
	}
	// Body fat read cleanly: its settled day is cached.
	if ms, _ := st.MetricRange(ctx, KeyBodyFat, day("2026-10-12"), day("2026-10-12"), metrics.AlgoVersion); len(ms) != 1 {
		t.Errorf("cached body fat %+v", ms)
	}
}

func TestBodyCachesOnlySettledDays(t *testing.T) {
	api := &fakeAPI{}
	for _, dd := range []string{"2026-10-13", "2026-10-14", "2026-10-16"} {
		api.add(googlehealth.Weight, weightRec(at(dd, 7, 0), 80000, "FITBIT"))
	}
	d, st := newData(t, api)
	if _, err := d.Body(ctx, day("2026-10-13"), day("2026-10-16")); err != nil {
		t.Fatal(err)
	}
	// 10-13 is D-3, the last settled day; 10-14 and today stay live.
	ms, _ := st.MetricRange(ctx, KeyWeight, day("2026-10-13"), day("2026-10-16"), metrics.AlgoVersion)
	if len(ms) != 1 || ms[0].Date != day("2026-10-13") {
		t.Errorf("cached %+v", ms)
	}
}

func TestAZMKeepsRealValuesInARunWithAGap(t *testing.T) {
	api := &fakeAPI{}
	api.addRollup(googlehealth.Steps, stepsRollup("2026-10-10", 9000), stepsRollup("2026-10-11", 4000))
	api.addRollup(googlehealth.ActiveZoneMinutes, azmRollup("2026-10-10", 20, 5, 0))
	api.add(googlehealth.Steps, stepRec("2026-10-10", "FITBIT"), stepRec("2026-10-11", "FITBIT"))
	d, _ := newData(t, api)
	a, _ := d.Activity(ctx, day("2026-10-10"), day("2026-10-11"))
	if v := a.Days[day("2026-10-10")]; *v.AZM != 25 || !v.Worn {
		t.Errorf("10-10 = %+v", v)
	}
	if v := a.Days[day("2026-10-11")]; *v.AZM != 0 || !v.Worn {
		t.Errorf("10-11 = %+v", v)
	}
}

func TestDroppedAZMRowIsNotZero(t *testing.T) {
	api := &fakeAPI{}
	api.addRollup(googlehealth.Steps, stepsRollup("2026-10-10", 9000))
	api.addRollup(googlehealth.TotalCalories, kcalRollup("2026-10-10", 2500))
	api.addRollup(googlehealth.ActiveZoneMinutes, azmRollup("2026-10-10", 3000, 0, 0)) // implausible
	api.add(googlehealth.Steps, stepRec("2026-10-10", "FITBIT"))
	d, st := newData(t, api)
	a, _ := d.Activity(ctx, day("2026-10-10"), day("2026-10-10"))
	if v := a.Days[day("2026-10-10")]; v.AZM != nil || !v.Worn || a.Skipped != 1 {
		t.Errorf("10-10 = %+v, skipped %d", v, a.Skipped)
	}
	if ms, _ := st.MetricRange(ctx, KeySteps, day("2026-10-10"), day("2026-10-10"), metrics.AlgoVersion); len(ms) != 0 {
		t.Errorf("cached %+v", ms)
	}
}

func TestRenamedRollupFieldsAreNotZero(t *testing.T) {
	api := &fakeAPI{}
	api.addRollup(googlehealth.Steps, rollupRow("2026-10-10", "steps", map[string]any{"stepCount": "9000"}))
	api.addRollup(googlehealth.ActiveZoneMinutes, rollupRow("2026-10-10", "activeZoneMinutes", map[string]any{"fatBurn": "20"}))
	api.addRollup(googlehealth.TotalCalories, rollupRow("2026-10-10", "totalCalories", map[string]any{"kcal": 2400}))
	d, _ := newData(t, api)
	a, _ := d.Activity(ctx, day("2026-10-10"), day("2026-10-10"))
	if a.Skipped != 3 || len(a.Days) != 0 {
		t.Errorf("activity = %+v, skipped %d", a.Days, a.Skipped)
	}
}

func TestRollupBounds(t *testing.T) {
	for name, tc := range map[string]struct {
		row  json.RawMessage
		dt   googlehealth.DataType
		keep bool
	}{
		"0 steps":          {stepsRollup("2026-10-10", 0), googlehealth.Steps, true},
		"200000 steps":     {stepsRollup("2026-10-10", 200_000), googlehealth.Steps, true},
		"200001 steps":     {stepsRollup("2026-10-10", 200_001), googlehealth.Steps, false},
		"2880 AZM":         {azmRollup("2026-10-10", 2880, 0, 0), googlehealth.ActiveZoneMinutes, true},
		"2881 AZM":         {azmRollup("2026-10-10", 2881, 0, 0), googlehealth.ActiveZoneMinutes, false},
		"20000 kcal":       {kcalRollup("2026-10-10", 20_000), googlehealth.TotalCalories, true},
		"20001 kcal":       {kcalRollup("2026-10-10", 20_001), googlehealth.TotalCalories, false},
		"negative kcal":    {kcalRollup("2026-10-10", -1), googlehealth.TotalCalories, false},
		"before the range": {stepsRollup("2026-10-09", 10), googlehealth.Steps, false},
	} {
		api := &fakeAPI{loose: true}
		api.addRollup(tc.dt, tc.row)
		d, _ := newData(t, api)
		a, err := d.Activity(ctx, day("2026-10-10"), day("2026-10-10"))
		if err != nil {
			t.Fatal(err)
		}
		_, kept := a.Days[day("2026-10-10")]
		if kept != tc.keep {
			t.Errorf("%s: kept %v, days %+v", name, kept, a.Days)
		}
	}
}

func TestNotWornDay(t *testing.T) {
	api := &fakeAPI{}
	api.addRollup(googlehealth.Steps, stepsRollup("2026-10-10", 3000))
	api.addRollup(googlehealth.TotalCalories, kcalRollup("2026-10-10", 1700)) // mostly the resting burn
	api.add(googlehealth.Steps, stepRec("2026-10-10", "HEALTH_KIT"))
	d, _ := newData(t, api)
	a, _ := d.Activity(ctx, day("2026-10-10"), day("2026-10-10"))
	if v := a.Days[day("2026-10-10")]; v.Worn || v.AZM != nil || v.TotalKcal == nil {
		t.Errorf("10-10 = %+v", v)
	}
	// A cached day had an AZM value, so the band recorded it.
	api2 := &fakeAPI{}
	activityWeek(api2)
	d2, _ := newData(t, api2)
	_, _ = d2.Activity(ctx, day("2026-10-10"), day("2026-10-10"))
	again, _ := d2.Activity(ctx, day("2026-10-10"), day("2026-10-10"))
	if !again.Days[day("2026-10-10")].Worn {
		t.Error("a cached day lost Worn")
	}
}

func TestBodyFromTheCache(t *testing.T) {
	api := &fakeAPI{}
	d, st := newData(t, api)
	for _, k := range []string{KeyWeight, KeyBodyFat} {
		for _, dd := range []string{"2026-10-09", "2026-10-10"} {
			if err := st.PutMetric(ctx, store.Metric{Date: day(dd), Key: k, Value: 50, Source: "Synthetic Scale", Zone: sp.String(), AlgoVersion: metrics.AlgoVersion}); err != nil {
				t.Fatal(err)
			}
		}
	}
	b, err := d.Body(ctx, day("2026-10-09"), day("2026-10-10"))
	if err != nil || len(api.takeCalls()) != 0 || b.Weight[day("2026-10-10")].Value != 50 || b.BodyFat[day("2026-10-09")].Source != "Synthetic Scale" {
		t.Errorf("body = %+v, %v", b, err)
	}
}

func TestParseBodyBounds(t *testing.T) {
	ts := at("2026-10-10", 8, 0)
	for raw, good := range map[string]bool{
		string(weightRec(ts, 20000, "FITBIT")):                              true,
		string(weightRec(ts, 400000, "FITBIT")):                             true,
		string(weightRec(ts, 19999, "FITBIT")):                              false,
		string(weightRec(ts, 400001, "FITBIT")):                             false,
		`{"weight":{"weightGrams":80000}}`:                                  false,
		`{"weight":{"sampleTime":{"physicalTime":"2026-10-10T10:00:00Z"}}}`: false,
		`[]`: false,
	} {
		if _, _, _, err := parseWeight(json.RawMessage(raw)); (err == nil) != good {
			t.Errorf("weight %s: %v", raw, err)
		}
	}
	for raw, good := range map[string]bool{
		string(bodyFatRec(ts, 2)):  true,
		string(bodyFatRec(ts, 75)): true,
		string(bodyFatRec(ts, 1)):  false,
		string(bodyFatRec(ts, 76)): false,
		`{"bodyFat":{}}`:           false,
		`{"bodyFat":{"sampleTime":{"physicalTime":"2026-10-10T10:00:00Z"}}}`: false,
		`{"bodyFat":{"percentage":20}}`:                                      false,
	} {
		if _, _, _, err := parseBodyFat(json.RawMessage(raw)); (err == nil) != good {
			t.Errorf("body fat %s: %v", raw, err)
		}
	}
}

func TestCivilDate(t *testing.T) {
	var c civilDate
	if err := json.Unmarshal(mustJSON(civil("2026-02-28")), &c); err != nil {
		t.Fatal(err)
	}
	if d, err := c.day(); err != nil || d != day("2026-02-28") {
		t.Errorf("day = %s, %v", d, err)
	}
	for _, bad := range []string{"2026-02-30", "0-01-01", "2026-13-01"} {
		var c civilDate
		_ = json.Unmarshal(mustJSON(civil(bad)), &c)
		if _, err := c.day(); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}
