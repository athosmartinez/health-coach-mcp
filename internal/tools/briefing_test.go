package tools

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
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
		Stages:        &healthdata.Stages{DeepMin: deep, LightMin: light, REMMin: rem},
		StartMinOfDay: start.Hour()*60 + start.Minute(), Start: start, End: wake,
		HRV: healthdata.HRVNight{MedianMS: hrv, Coverage: 1}, Source: "Synthetic Band",
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
		"":                        "[body hrv notice readiness resting_hr sleep yesterday_load]",
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
	if notice, _ := get(data, "notice").(string); !strings.Contains(notice, readinessNotice) || !strings.Contains(notice, vendorNotice) {
		t.Errorf("notice %q", notice)
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
		return func(h *fakeHealth) { n := h.nights[coachToday]; n.HRV.MedianMS = f64(v); h.nights[coachToday] = n }
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
			n.HRV.MedianMS = nil
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
	n.Stages, n.HRV = nil, healthdata.HRVNight{}
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
	n.Provisional, n.HRV = true, healthdata.HRVNight{Coverage: 0.3}
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
	want := "[provisional_sleep hrv_low_coverage non_standard_resting_hr unreadable_records band_not_worn low_hr_for_activity]"
	if got := fmt.Sprint(out["quality_flags"]); got != want {
		t.Errorf("flags %s\nwant  %s", got, want)
	}
	ex := get(out["data"], "yesterday_load", "exercises", "0")
	// The briefing carries the type, never the free-text name.
	if fmt.Sprint(keys(ex)) != "[avg_hr_bpm minutes quality_flags type]" || get(ex, "type") != "JIU_JITSU" || get(ex, "avg_hr_bpm") != 81.0 {
		t.Errorf("exercise %v", ex)
	}
	// A resting HR from another method is shown, but neither compared with
	// the standard-method baseline nor judged.
	if get(out["data"], "resting_hr", "bpm") != 61.0 || get(out["data"], "resting_hr", "delta_bpm_vs_28d") != nil {
		t.Errorf("resting hr %v", get(out["data"], "resting_hr"))
	}
	// A provisional night may change after sync: readiness says so and
	// drops to low confidence.
	r := get(out["data"], "readiness")
	if fmt.Sprint(get(r, "reasons")) != "[missing:hrv missing:resting_hr provisional:sleep]" || get(r, "confidence") != "low" {
		t.Errorf("readiness %v", r)
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

func TestBriefingComparesEachWindow(t *testing.T) {
	h := history(t, 28)
	// The last 7 nights differ from the 21 before them, so each window and
	// each field gives its own average.
	for i := 1; i <= 28; i++ {
		d := addDays(t, coachToday, -i)
		hrv := h.nights[d].HRV.MedianMS
		if i <= 7 {
			h.nights[d] = night(t, d, 420, 480, hrv)
		} else {
			h.nights[d] = night(t, d, 480, 500, hrv)
		}
	}
	vs := get(coachSession(t, h, nil).ok("morning_briefing", nil)["data"], "sleep")
	// Tonight: asleep 480 of 520, awake 40, efficiency 92.3, deep and REM 96, light 288.
	for p, want := range map[string]float64{
		"vs_7d.asleep_min.avg": 420, "vs_7d.asleep_min.delta": 60,
		"vs_7d.awake_min.avg": 60, "vs_7d.awake_min.delta": -20,
		"vs_7d.efficiency_pct.avg": 87.5, "vs_7d.efficiency_pct.delta": 4.8,
		"vs_7d.deep_min.avg": 84, "vs_7d.deep_min.delta": 12,
		"vs_7d.light_min.avg": 252, "vs_7d.light_min.delta": 36,
		"vs_7d.rem_min.avg": 84, "vs_7d.rem_min.delta": 12, "vs_7d.rem_min.n_days": 7,
		"vs_28d.asleep_min.avg": 465, "vs_28d.asleep_min.delta": 15,
		"vs_28d.awake_min.avg": 30, "vs_28d.awake_min.delta": 10,
		"vs_28d.efficiency_pct.avg": 93.9, "vs_28d.efficiency_pct.delta": -1.6,
		"vs_28d.deep_min.avg": 93, "vs_28d.deep_min.delta": 3,
		"vs_28d.light_min.avg": 279, "vs_28d.light_min.delta": 9,
		"vs_28d.rem_min.avg": 93, "vs_28d.rem_min.delta": 3, "vs_28d.rem_min.n_days": 28,
	} {
		if got := path(vs, p); got != want {
			t.Errorf("%s = %v, want %v", p, got, want)
		}
	}
}

func TestBriefingSignalsUseTheirOwnBaselines(t *testing.T) {
	h := history(t, 28)
	// HRV on 10 nights, resting HR on 5: coverage is the smallest baseline,
	// and readiness judges HRV but not resting HR.
	for i := 11; i <= 28; i++ {
		d := addDays(t, coachToday, -i)
		n := h.nights[d]
		n.HRV = healthdata.HRVNight{}
		h.nights[d] = n
	}
	for i := 6; i <= 28; i++ {
		delete(h.resting, addDays(t, coachToday, -i))
	}
	n := h.nights[coachToday]
	n.HRV.MedianMS = f64(47)
	h.nights[coachToday] = n
	out := coachSession(t, h, nil).ok("morning_briefing", nil)
	data := out["data"]
	if get(out, "coverage", "n_days") != 5.0 {
		t.Errorf("coverage %v", out["coverage"])
	}
	if got := fmt.Sprint(get(data, "readiness", "reasons")); got != "[hrv_below_baseline missing:resting_hr]" {
		t.Errorf("reasons %s", got)
	}
	// 10 nights alternating 48/52: mean 50, sd 2.11; 47 is z −1.42, −6%.
	if get(data, "hrv", "z_score_vs_28d") != -1.42 || get(data, "hrv", "delta_pct_vs_28d") != -6.0 {
		t.Errorf("hrv %v", get(data, "hrv"))
	}
}

func TestBriefingNoNightHints(t *testing.T) {
	for _, tc := range []struct {
		name  string
		tweak func(h *fakeHealth)
		hint  string
	}{
		{"not synced", func(*fakeHealth) {}, "synced"},
		{"unreadable", func(h *fakeHealth) { h.recovery.Skipped = 1 }, "could not be read"},
		{"another platform", func(h *fakeHealth) { h.recovery.Empty = []googlehealth.DataType{googlehealth.Sleep} }, "another platform"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := history(t, 3)
			delete(h.nights, coachToday)
			tc.tweak(h)
			te := coachSession(t, h, nil).fails("morning_briefing", nil)
			if te.Code != coach.CodeNoData || !strings.Contains(te.Hint, tc.hint) {
				t.Errorf("error %+v, want a hint about %q", te, tc.hint)
			}
		})
	}
}

func TestBriefingLoadFlags(t *testing.T) {
	yesterday := addDays(t, coachToday, -1)
	for _, tc := range []struct {
		name  string
		tweak func(h *fakeHealth)
		flags string
	}{
		// The day's row was dropped as unreadable: not evidence the band was off.
		{"unreadable activity", func(h *fakeHealth) { h.activitySkipped = 1 }, "[unreadable_records]"},
		{"unreadable sessions", func(h *fakeHealth) { h.exercises.Skipped = 1 }, "[unreadable_records]"},
		{"unreadable weight", func(h *fakeHealth) { h.bodySkipped = 1 }, "[unreadable_records]"},
		{"recorded but not worn", func(h *fakeHealth) { h.activity[yesterday] = healthdata.ActivityDay{TotalKcal: f64(1700)} }, "[band_not_worn]"},
		{"sessions from another platform", func(h *fakeHealth) { h.exercises.OtherSource = 2 }, "[other_source_sessions_excluded]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := history(t, 28)
			h.activity[yesterday] = healthdata.ActivityDay{Steps: f64(8000), Worn: true}
			if tc.name == "unreadable activity" {
				delete(h.activity, yesterday)
			}
			tc.tweak(h)
			out := coachSession(t, h, nil).ok("morning_briefing", nil)
			if got := fmt.Sprint(out["quality_flags"]); got != tc.flags {
				t.Errorf("flags %s, want %s", got, tc.flags)
			}
		})
	}
}

func TestBriefingSessionsAndSources(t *testing.T) {
	h := history(t, 28)
	yesterday := addDays(t, coachToday, -1)
	h.activity[yesterday] = healthdata.ActivityDay{Steps: f64(8000), Worn: true}
	h.recovery.Sources = []string{"Band B"}
	h.weight[yesterday] = healthdata.Reading{Value: 80, Source: "Scale"}
	for i := range maxSessions + 3 {
		s := session(t, fmt.Sprint(i), yesterday, 0, "WALKING", 10, nil, "no_hr_data")
		s.Source = "Band A"
		h.sessions = append(h.sessions, s)
	}
	out := coachSession(t, h, nil).ok("morning_briefing", nil)
	if n := len(get(out["data"], "yesterday_load", "exercises").([]any)); n != maxSessions {
		t.Errorf("listed %d sessions", n)
	}
	// Each flag once, however many sessions carry it.
	if got := fmt.Sprint(out["quality_flags"]); got != "[sessions_truncated no_hr_data]" {
		t.Errorf("flags %s", got)
	}
	if got := fmt.Sprint(out["sources"]); got != "[Band A Band B Scale]" {
		t.Errorf("sources %s", got)
	}
}

func TestRounding(t *testing.T) {
	for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if roundTo(&v, 1) != nil {
			t.Errorf("roundTo(%v) is not nil", v)
		}
		if got := round1(v); !math.IsNaN(got) && !math.IsInf(got, 0) {
			t.Errorf("round1(%v) = %v, want it unchanged", v, got)
		}
	}
	if roundTo(nil, 1) != nil || *roundTo(f64(1.25), 1) != 1.3 || *roundTo(f64(-1.474), 2) != -1.47 || round1(2.04) != 2 {
		t.Error("rounding")
	}
	if efficiency(400, 0) != nil || *efficiency(450, 500) != 90 {
		t.Error("efficiency")
	}
}
