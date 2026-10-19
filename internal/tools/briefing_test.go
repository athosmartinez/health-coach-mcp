package tools

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
)

// night is a synthetic night ending on day at 07:00 after inBed minutes.
func night(t *testing.T, day coach.LocalDate, asleep, inBed float64, hrv *float64) healthdata.Night {
	t.Helper()
	midnight, _, err := day.Bounds(saoPaulo(t))
	if err != nil {
		t.Fatal(err)
	}
	wake := midnight.Add(7 * time.Hour)
	start := wake.Add(-time.Duration(inBed) * time.Minute)
	deep, rem := asleep/5, asleep/5
	light := asleep - deep - rem
	return healthdata.Night{
		AsleepMin: asleep, AwakeMin: inBed - asleep, InBedMin: inBed,
		DeepMin: &deep, LightMin: &light, REMMin: &rem,
		StartMinOfDay: start.Hour()*60 + start.Minute(), Start: start, End: wake,
		HRV: hrv, HRVCoverage: 1, Source: "Synthetic Band",
	}
}

// history has n nights before today: asleep 450 of 500 min in bed, HRV
// alternating 48/52 ms (mean 50, sd 2.04) and resting HR 58/62 (mean 60).
// Today's night is asleep 480 of 520 min with HRV 50 and resting HR 60.
func history(t *testing.T, n int) *fakeHealth {
	t.Helper()
	h := &fakeHealth{
		nights:   map[coach.LocalDate]healthdata.Night{},
		resting:  map[coach.LocalDate]healthdata.RestingHR{},
		activity: map[coach.LocalDate]healthdata.ActivityDay{},
		weight:   map[coach.LocalDate]healthdata.Reading{},
		recovery: healthdata.Recovery{Sources: []string{"Synthetic Band"}},
	}
	for i := 1; i <= n; i++ {
		d := addDays(t, coachToday, -i)
		h.nights[d] = night(t, d, 450, 500, f64(float64(48+4*(i%2))))
		h.resting[d] = healthdata.RestingHR{BPM: float64(58 + 4*(i%2)), Method: "WITH_SLEEP"}
	}
	h.nights[coachToday] = night(t, coachToday, 480, 520, f64(50))
	h.resting[coachToday] = healthdata.RestingHR{BPM: 60, Method: "WITH_SLEEP"}
	return h
}

func path(v any, p string) any {
	if p == "" {
		return v
	}
	return get(v, strings.Split(p, ".")...)
}

func TestBriefingReturnsExactlyTheContractFields(t *testing.T) {
	h := history(t, 28)
	yesterday := addDays(t, coachToday, -1)
	h.activity[yesterday] = healthdata.ActivityDay{Steps: f64(9000), AZM: f64(30), TotalKcal: f64(2500), Worn: true}
	h.weight[addDays(t, coachToday, -4)] = healthdata.Reading{Value: 80.2, Source: "Synthetic Scale"}
	out := coachSession(t, h, nil).ok("morning_briefing", nil)

	if got := keys(out); fmt.Sprint(got) != "[coverage data generated_at quality_flags sources]" {
		t.Errorf("envelope keys %v", got)
	}
	data := out["data"]
	for p, want := range map[string]string{
		"":                        "[body hrv readiness resting_hr sleep yesterday_load]",
		"sleep":                   "[asleep_min awake_min efficiency_pct end stages_min start vs_28d vs_7d]",
		"sleep.stages_min":        "[awake deep light rem]",
		"sleep.vs_7d":             "[asleep_min awake_min deep_min efficiency_pct light_min rem_min]",
		"sleep.vs_28d":            "[asleep_min awake_min deep_min efficiency_pct light_min rem_min]",
		"sleep.vs_28d.asleep_min": "[avg delta n_days]",
		"hrv":                     "[delta_pct_vs_28d median_ms z_score_vs_28d]",
		"resting_hr":              "[bpm delta_bpm_vs_28d]",
		"yesterday_load":          "[azm_min date exercises steps]",
		"readiness":               "[confidence level reasons]",
		"body":                    "[date weight_kg]",
	} {
		if got := fmt.Sprint(keys(path(data, p))); got != want {
			t.Errorf("%q keys = %s, want %s", p, got, want)
		}
	}
	for p, want := range map[string]any{
		"sleep.asleep_min": 480.0, "sleep.awake_min": 40.0, "sleep.efficiency_pct": 92.3,
		"sleep.stages_min.deep": 96.0, "sleep.stages_min.awake": 40.0,
		"sleep.start": "2026-10-15T22:20:00-03:00", "sleep.end": "2026-10-16T07:00:00-03:00",
		"sleep.vs_7d.asleep_min.avg": 450.0, "sleep.vs_7d.asleep_min.delta": 30.0, "sleep.vs_7d.asleep_min.n_days": 7.0,
		"sleep.vs_28d.efficiency_pct.avg": 90.0, "sleep.vs_28d.efficiency_pct.delta": 2.3,
		"hrv.median_ms": 50.0, "hrv.z_score_vs_28d": 0.0, "hrv.delta_pct_vs_28d": 0.0,
		"resting_hr.bpm": 60.0, "resting_hr.delta_bpm_vs_28d": 0.0,
		"yesterday_load.date": "2026-10-15", "yesterday_load.steps": 9000.0, "yesterday_load.azm_min": 30.0,
		"readiness.level": "green", "readiness.confidence": "high",
		"body.weight_kg": 80.2, "body.date": "2026-10-12",
	} {
		if got := path(data, p); got != want {
			t.Errorf("%s = %v, want %v", p, got, want)
		}
	}
	if get(out, "coverage", "n_days") != 28.0 || get(out, "coverage", "confidence") != "high" {
		t.Errorf("coverage %v", out["coverage"])
	}
	if fmt.Sprint(get(data, "readiness", "reasons")) != "[]" || fmt.Sprint(out["quality_flags"]) != "[]" {
		t.Errorf("reasons %v, flags %v", get(data, "readiness", "reasons"), out["quality_flags"])
	}
	if fmt.Sprint(out["sources"]) != "[Synthetic Band Synthetic Scale]" {
		t.Errorf("sources %v", out["sources"])
	}
	// One recovery call covers both baselines; the night judged is not in them.
	if want := []string{"recovery 2026-09-18..2026-10-16", "activity 2026-10-15..2026-10-15",
		"exercises 2026-10-15..2026-10-15 maxHR=false", "body 2026-07-19..2026-10-16"}; !slices.Equal(h.calls, want) {
		t.Errorf("calls %v\nwant %v", h.calls, want)
	}
}

func TestBriefingReadinessLevels(t *testing.T) {
	setHRV := func(v float64) func(*fakeHealth) {
		return func(h *fakeHealth) { n := h.nights[coachToday]; n.HRV = f64(v); h.nights[coachToday] = n }
	}
	for _, tc := range []struct {
		name    string
		tweak   func(h *fakeHealth)
		level   string
		reasons string
	}{
		{"green", func(*fakeHealth) {}, "green", "[]"},
		// z = (47 − 50) / 2.04 = −1.47: below −0.5, not below −1.5.
		{"hrv yellow", setHRV(47), "yellow", "[hrv_below_baseline]"},
		{"hrv red", setHRV(46), "red", "[hrv_well_below_baseline]"},
		{"resting hr red", func(h *fakeHealth) { h.resting[coachToday] = healthdata.RestingHR{BPM: 65, Method: "WITH_SLEEP"} }, "red", "[resting_hr_well_above_baseline]"},
		{"short sleep yellow", func(h *fakeHealth) { h.nights[coachToday] = night(t, coachToday, 400, 450, f64(50)) }, "yellow", "[sleep_short]"},
		{"missing signals", func(h *fakeHealth) {
			n := h.nights[coachToday]
			n.HRV = nil
			h.nights[coachToday] = n
			delete(h.resting, coachToday)
		}, "green", "[missing:hrv missing:resting_hr]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := history(t, 28)
			tc.tweak(h)
			data := coachSession(t, h, nil).ok("morning_briefing", nil)["data"]
			if got := get(data, "readiness", "level"); got != tc.level {
				t.Errorf("level %v, want %s", got, tc.level)
			}
			if got := fmt.Sprint(get(data, "readiness", "reasons")); got != tc.reasons {
				t.Errorf("reasons %s, want %s", got, tc.reasons)
			}
		})
	}
}

func TestBriefingWithAShortHistory(t *testing.T) {
	out := coachSession(t, history(t, 5), nil).ok("morning_briefing", nil)
	data := out["data"]
	// Five nights: no z-score and an unjudged resting-HR delta, both shown
	// or left null, never treated as green.
	if get(data, "readiness", "confidence") != "low" || get(out, "coverage", "confidence") != "low" || get(out, "coverage", "n_days") != 5.0 {
		t.Errorf("readiness %v, coverage %v", get(data, "readiness"), out["coverage"])
	}
	if get(data, "hrv", "z_score_vs_28d") != nil || get(data, "hrv", "median_ms") != 50.0 || get(data, "resting_hr", "delta_bpm_vs_28d") == nil {
		t.Errorf("hrv %v, resting hr %v", get(data, "hrv"), get(data, "resting_hr"))
	}
	if got := fmt.Sprint(get(data, "readiness", "reasons")); got != "[missing:hrv missing:resting_hr]" {
		t.Errorf("reasons %s", got)
	}
	if get(data, "sleep", "vs_28d", "asleep_min", "n_days") != 5.0 {
		t.Errorf("vs_28d %v", get(data, "sleep", "vs_28d"))
	}
}

func TestBriefingWithNothingBeforeTheNight(t *testing.T) {
	h := history(t, 0)
	n := h.nights[coachToday]
	n.DeepMin, n.LightMin, n.REMMin, n.HRV, n.HRVCoverage = nil, nil, nil, nil, 0
	h.nights[coachToday] = n
	out := coachSession(t, h, nil).ok("morning_briefing", nil)
	data := out["data"]
	// Missing values stay null, never 0, and the output schema accepts them.
	for _, p := range []string{
		"sleep.vs_7d.asleep_min", "sleep.vs_28d.efficiency_pct", "sleep.stages_min.deep", "hrv.median_ms",
		"hrv.z_score_vs_28d", "hrv.delta_pct_vs_28d", "resting_hr.delta_bpm_vs_28d", "yesterday_load.steps",
		"yesterday_load.azm_min", "body.weight_kg", "body.date",
	} {
		if v := path(data, p); v != nil {
			t.Errorf("%s = %v, want null", p, v)
		}
	}
	if get(data, "sleep", "stages_min", "awake") != 40.0 || fmt.Sprint(get(data, "yesterday_load", "exercises")) != "[]" {
		t.Errorf("sleep %v, load %v", get(data, "sleep"), get(data, "yesterday_load"))
	}
	// No band data yesterday at all reads as not worn.
	if fmt.Sprint(out["quality_flags"]) != "[band_not_worn]" || get(out, "coverage", "n_days") != 0.0 {
		t.Errorf("flags %v, coverage %v", out["quality_flags"], out["coverage"])
	}
}

func TestBriefingBaselinesSkipProvisionalNights(t *testing.T) {
	h := history(t, 7)
	d := addDays(t, coachToday, -2)
	n := night(t, d, 200, 600, f64(10))
	n.Provisional = true
	h.nights[d] = n
	data := coachSession(t, h, nil).ok("morning_briefing", nil)["data"]
	if v := get(data, "sleep", "vs_7d", "asleep_min"); get(v, "avg") != 450.0 || get(v, "n_days") != 6.0 {
		t.Errorf("vs_7d %v", v)
	}
}

func TestBriefingQualityFlags(t *testing.T) {
	h := history(t, 28)
	n := h.nights[coachToday]
	n.Provisional, n.HRV, n.HRVCoverage = true, nil, 0.3
	h.nights[coachToday] = n
	h.resting[coachToday] = healthdata.RestingHR{BPM: 61, Method: "OTHER"}
	h.recovery.Skipped = 1
	yesterday := addDays(t, coachToday, -1)
	h.activity[yesterday] = healthdata.ActivityDay{Steps: f64(300), TotalKcal: f64(1700)}
	h.sessions = []healthdata.Exercise{{
		ID: "users/me/dataTypes/exercise/dataPoints/1", Day: yesterday, Type: "JIU_JITSU", Name: "Evening class",
		ActiveMin: 60, HR: &healthdata.ExerciseHR{AvgBPM: 81}, Flags: []string{"low_hr_for_activity"}, Source: "Synthetic Band",
	}}
	out := coachSession(t, h, nil).ok("morning_briefing", nil)
	want := "[provisional_sleep hrv_low_coverage non_standard_resting_hr band_not_worn unreadable_records low_hr_for_activity]"
	if got := fmt.Sprint(out["quality_flags"]); got != want {
		t.Errorf("flags %s\nwant  %s", got, want)
	}
	ex := get(out["data"], "yesterday_load", "exercises", "0")
	// The briefing carries the type, never the free-text name.
	if fmt.Sprint(keys(ex)) != "[avg_hr_bpm minutes quality_flags type]" || get(ex, "type") != "JIU_JITSU" || get(ex, "avg_hr_bpm") != 81.0 {
		t.Errorf("exercise %v", ex)
	}
	if get(out["data"], "resting_hr", "bpm") != 61.0 {
		t.Errorf("resting hr %v", get(out["data"], "resting_hr"))
	}
}

func TestBriefingErrors(t *testing.T) {
	t.Run("no sleep", func(t *testing.T) {
		h := history(t, 28)
		delete(h.nights, coachToday)
		te := coachSession(t, h, nil).fails("morning_briefing", nil)
		if te.Code != coach.CodeNoData || te.Hint == "" {
			t.Errorf("error %+v", te)
		}
	})
	t.Run("future date", func(t *testing.T) {
		te := coachSession(t, history(t, 1), nil).fails("morning_briefing", map[string]any{"date": "2026-10-17"})
		if te.Code != coach.CodeInvalidInput {
			t.Errorf("error %+v", te)
		}
	})
	for _, method := range []string{"recovery", "activity", "exercises", "body"} {
		t.Run(method+" error propagates", func(t *testing.T) {
			h := history(t, 28)
			h.errs = map[string]error{method: coach.ToolError{Code: coach.CodeAuthExpired, Message: "sign in again", Hint: "health-coach-mcp auth login"}}
			te := coachSession(t, h, nil).fails("morning_briefing", nil)
			if te.Code != coach.CodeAuthExpired || te.Hint != "health-coach-mcp auth login" {
				t.Errorf("error %+v", te)
			}
		})
	}
	t.Run("an earlier date", func(t *testing.T) {
		data := coachSession(t, history(t, 28), nil).ok("morning_briefing", map[string]any{"date": "2026-10-10"})["data"]
		if get(data, "sleep", "end") != "2026-10-10T07:00:00-03:00" || get(data, "yesterday_load", "date") != "2026-10-09" {
			t.Errorf("sleep %v, load %v", get(data, "sleep", "end"), get(data, "yesterday_load", "date"))
		}
	})
}
