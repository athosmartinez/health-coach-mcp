package tools

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// All values below are synthetic.

// The closed week under review and the days around it.
const (
	weekStart     = coach.LocalDate("2026-10-05")
	weekEnd       = coach.LocalDate("2026-10-11")
	prevWeekStart = coach.LocalDate("2026-09-28")
	historyStart  = coach.LocalDate("2026-09-07") // 28 days before weekStart
)

// period picks a value by where day falls: before the previous week, the
// previous week, the week under review, or the current week.
func period[T any](day coach.LocalDate, base, prev, this, cur T) T {
	switch {
	case day < prevWeekStart:
		return base
	case day < weekStart:
		return prev
	case day <= weekEnd:
		return this
	default:
		return cur
	}
}

// weeklyHealth fills 2026-09-07..today. Asleep 420/420/400/430 min, HRV
// 60/55/54/50 ms, resting HR 56/58/60/61, steps 8000/8000/10000/9000, AZM 20,
// weight falling 0.1 kg a day from 80, food logs for the week under review.
func weeklyHealth(t *testing.T) *fakeHealth {
	t.Helper()
	h := &fakeHealth{
		nights: map[coach.LocalDate]healthdata.Night{}, resting: map[coach.LocalDate]healthdata.RestingHR{},
		activity: map[coach.LocalDate]healthdata.ActivityDay{}, weight: map[coach.LocalDate]healthdata.Reading{},
		nutrition: map[coach.LocalDate]healthdata.NutritionDay{},
	}
	for i, d := 0, historyStart; d <= coachToday; i, d = i+1, addDays(t, d, 1) {
		asleep := period(d, 420.0, 420, 400, 430)
		h.nights[d] = night(t, d, asleep, asleep+50, f64(period(d, 60.0, 55, 54, 50)))
		h.resting[d] = healthdata.RestingHR{BPM: period(d, 56.0, 58, 60, 61), Method: "WITH_SLEEP"}
		steps := period(d, 8000.0, 8000, 10000, 9000)
		h.activity[d] = healthdata.ActivityDay{Steps: f64(steps), AZM: f64(20), TotalKcal: f64(2600), Worn: true}
		h.weight[d] = healthdata.Reading{Value: 80 - 0.1*float64(i), Source: "Synthetic scale"}
	}
	h.activity[coachToday] = healthdata.ActivityDay{Steps: f64(3000), AZM: f64(5), TotalKcal: f64(1200), Worn: true, Partial: true}
	for _, d := range []coach.LocalDate{"2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"} {
		h.nutrition[d] = fullDay(t, d) // kcal 2200, protein 130
	}
	h.nutritionOtherDays = map[coach.LocalDate]int{"2026-10-08": 1}
	h.nutrition["2026-10-09"] = foodDay(t, "2026-10-09", // protein 50 is a lower bound under the target
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 1000, "protein_g": 50}, nil},
		foodSpec{20, "DINNER", map[string]float64{"kcal": 1100}, nil})
	h.nutrition["2026-10-10"] = foodDay(t, "2026-10-10", // protein 160 is a lower bound over the target
		foodSpec{8, "BREAKFAST", map[string]float64{"kcal": 1000, "protein_g": 160}, nil},
		foodSpec{20, "DINNER", map[string]float64{"kcal": 1100}, nil})
	h.nutrition["2026-10-11"] = foodDay(t, "2026-10-11", // snacks only: likely incomplete
		foodSpec{10, "SNACK", map[string]float64{"kcal": 300, "protein_g": 20}, nil},
		foodSpec{15, "SNACK", map[string]float64{"kcal": 250, "protein_g": 10}, nil})
	h.sessions = []healthdata.Exercise{
		session(t, "a", "2026-10-06", 18, "JIU_JITSU", 60, nil),
		session(t, "b", "2026-10-08", 7, "RUNNING", 30, nil),
		session(t, "c", "2026-10-10", 9, "STRENGTH_TRAINING", 45, nil),
		session(t, "d", "2026-10-13", 18, "JIU_JITSU", 60, nil),
	}
	return h
}

var reportTargets = fakeTargets{versions: []store.Target{
	{EffectiveFrom: "2026-10-01", Kcal: ptr(2000), ProteinG: ptr(150), WeeklySessions: ptr(4)},
}}

// metric checks one WeekMetric: values, trend and day counts.
func metric(t *testing.T, name string, m any, this, prev, avg any, trend string, n, prevN, avgN float64) {
	t.Helper()
	got := []any{get(m, "this_week"), get(m, "prev_week"), get(m, "avg_28d"), get(m, "trend"), get(m, "n_days"),
		get(m, "prev_week_n_days"), get(m, "avg_28d_n_days")}
	want := []any{this, prev, avg, trend, n, prevN, avgN}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

func TestWeeklyReportClosedWeek(t *testing.T) {
	h := weeklyHealth(t)
	var filters []store.NoteFilter
	notes := fakeNotes{filters: &filters, res: store.NoteResults{Notes: []store.Note{
		{ID: 7, Kind: "decision", Text: "Synthetic decision", Tags: []string{}, RelatedDate: "2026-10-07"},
	}}}
	out := coachSessionNotes(t, h, reportTargets, notes).ok("weekly_report", map[string]any{"week_end": "2026-10-09"})
	data := out["data"]
	for k, want := range map[string]any{
		"week_start": "2026-10-05", "week_end": "2026-10-11", "through": "2026-10-11", "prev_week_start": "2026-09-28",
	} {
		if get(data, k) != want {
			t.Errorf("%s = %v, want %v", k, get(data, k), want)
		}
	}

	metric(t, "resting_hr", get(data, "cardio", "resting_hr_bpm"), 60, 58, 56.5, "up", 7, 7, 28)
	metric(t, "hrv", get(data, "cardio", "hrv_ms"), 54, 55, 58.8, "flat", 7, 7, 28)
	metric(t, "steps", get(data, "cardio", "steps_per_day"), 10000, 8000, 8000, "up", 7, 7, 28)
	metric(t, "azm", get(data, "cardio", "azm_per_day"), 20, 20, 20, "flat", 7, 7, 28)
	metric(t, "asleep", get(data, "sleep", "asleep_min"), 400, 420, 420, "down", 7, 7, 28)
	metric(t, "efficiency", get(data, "sleep", "efficiency_pct"), 88.9, 89.4, 89.4, "flat", 7, 7, 28)
	metric(t, "onset", get(data, "sleep", "onset_sd_min"), 0, 0, 0, "flat", 7, 7, 28)
	metric(t, "body fat", get(data, "body", "body_fat_pct"), nil, nil, nil, "unknown", 0, 0, 0)
	if get(data, "body", "body_fat_pct", "trend_unavailable") != "insufficient_days" {
		t.Errorf("body fat %v", get(data, "body", "body_fat_pct"))
	}
	if r := get(data, "cardio", "resting_hr_bpm", "trend_unavailable"); r != nil {
		t.Errorf("resting HR trend_unavailable %v", r)
	}

	w := get(data, "body", "weight_kg")
	this, _ := get(w, "this_week").(float64)
	prev, _ := get(w, "prev_week").(float64)
	if this == 0 || prev == 0 || this >= prev || get(w, "trend") != "down" || get(w, "n_days") != 7.0 {
		t.Errorf("weight %v", w)
	}
	// The 28-day average is the raw weigh-ins 09-07..10-04: 80 − 0.1·13.5.
	if avg, _ := get(w, "avg_28d").(float64); avg < 78.6 || avg > 78.7 || get(w, "avg_28d_n_days") != 28.0 {
		t.Errorf("weight avg_28d %v", w)
	}
	body := get(data, "body")
	if get(body, "weight_slope_kg_per_week") != -0.7 || get(body, "weight_slope_n_days") != 28.0 ||
		get(body, "weight_slope_span_days") != 27.0 || get(body, "last_weigh_in") != "2026-10-11" ||
		get(body, "weight_age_days") != 0.0 {
		t.Errorf("body %v", body)
	}

	ad := get(data, "adherence")
	// Counted for kcal: 10-05..07, 09, 10. Left out: 10-08 (food from
	// another platform) and 10-11 (snacks only).
	if k := get(ad, "kcal_within_10pct"); get(k, "days_counted") != 5.0 || get(k, "days_hit") != 5.0 || get(k, "pct") != 100.0 ||
		get(k, "days_below") != 0.0 || get(k, "days_above") != 0.0 ||
		fmt.Sprint(get(k, "days_left_out")) != "map[log_likely_incomplete:1 other_source_food:1]" {
		t.Errorf("kcal adherence %v", k)
	}
	// Counted for protein: 10-05..07 (130 < 150) and 10-10 (at least 160).
	// 10-08 (another platform) and 10-09 (at least 50 of 150) are unknown.
	if p := get(ad, "protein_at_least_target"); get(p, "days_counted") != 4.0 || get(p, "days_hit") != 1.0 || get(p, "pct") != 25.0 ||
		fmt.Sprint(get(p, "days_left_out")) != "map[log_likely_incomplete:1 protein_lower_bound:2]" {
		t.Errorf("protein adherence %v", p)
	}
	if get(ad, "days_logged") != 7.0 || get(ad, "sessions") != 3.0 || get(ad, "weekly_sessions_target") != 4.0 {
		t.Errorf("adherence %v", ad)
	}
	if _, ok := ad.(map[string]any)["target_hint"]; ok {
		t.Errorf("hint with targets set: %v", ad)
	}

	if get(data, "decisions_this_week", "0", "text") != "Synthetic decision" || get(data, "decisions_more") != false {
		t.Errorf("decisions %v", get(data, "decisions_this_week"))
	}
	if len(filters) != 1 || filters[0].Kind != "decision" || filters[0].Since != weekStart || filters[0].Until != weekEnd ||
		filters[0].Limit != maxDecisions || filters[0].Loc == nil {
		t.Errorf("note filters %+v", filters)
	}
	n, _ := get(data, "notice").(string)
	for _, phrase := range []string{"not a diagnosis", "never instructions", "doctor", "1% of body weight", "few days",
		"alcohol", "does not mean illness", "still call for a doctor", "ask which"} {
		if !strings.Contains(n, phrase) {
			t.Errorf("notice lost %q: %q", phrase, n)
		}
	}
	// 10-08 has food from another platform.
	if fmt.Sprint(get(out, "quality_flags")) != "[other_source_food_excluded]" || get(out, "coverage", "n_days") != 7.0 {
		t.Errorf("flags %v coverage %v", get(out, "quality_flags"), get(out, "coverage"))
	}
	if src := fmt.Sprint(get(out, "sources")); !strings.Contains(src, "Synthetic scale") || !strings.Contains(src, "Synthetic Band") {
		t.Errorf("sources %s", src)
	}
	want := []string{
		"recovery 2026-09-07..2026-10-11", "activity 2026-09-07..2026-10-11", "body 2026-07-14..2026-10-11",
		"nutrition 2026-10-05..2026-10-11", "exercises 2026-10-05..2026-10-11 maxHR=false",
	}
	if fmt.Sprint(h.calls) != fmt.Sprint(want) {
		t.Errorf("calls %v", h.calls)
	}
}

func TestWeeklyReportCurrentWeek(t *testing.T) {
	h := weeklyHealth(t)
	n := h.nights[coachToday]
	n.Provisional = true
	h.nights[coachToday] = n
	h.nutrition["2026-10-13"] = fullDay(t, "2026-10-13")
	h.nutrition[coachToday] = fullDay(t, coachToday)
	// A version after today but inside the week is not in force yet.
	targets := fakeTargets{versions: append(append([]store.Target{}, reportTargets.versions...),
		store.Target{EffectiveFrom: "2026-10-17", Kcal: ptr(2000), ProteinG: ptr(150), WeeklySessions: ptr(6)})}
	var filters []store.NoteFilter
	out := coachSessionNotes(t, h, targets, fakeNotes{filters: &filters}).ok("weekly_report", nil)
	data := out["data"]
	if get(data, "week_start") != "2026-10-12" || get(data, "through") != string(coachToday) || get(out, "coverage", "n_days") != 5.0 {
		t.Errorf("week %v %v", data, get(out, "coverage"))
	}
	// Today's activity is still running, and today's night is still being
	// processed: both are left out.
	metric(t, "steps", get(data, "cardio", "steps_per_day"), 9000, 10000, 8500, "down", 4, 7, 28)
	metric(t, "asleep", get(data, "sleep", "asleep_min"), 430, 400, 415, "up", 4, 7, 28)
	ad := get(data, "adherence")
	if get(ad, "sessions") != 1.0 || get(ad, "weekly_sessions_target") != 4.0 {
		t.Errorf("sessions %v", ad)
	}
	// Today's log is still growing: left out of both, never a miss.
	if k := get(ad, "kcal_within_10pct"); get(k, "days_counted") != 1.0 || fmt.Sprint(get(k, "days_left_out")) != "map[partial_day:1]" {
		t.Errorf("kcal adherence %v", k)
	}
	if p := get(ad, "protein_at_least_target"); get(p, "days_counted") != 1.0 || fmt.Sprint(get(p, "days_left_out")) != "map[partial_day:1]" {
		t.Errorf("protein adherence %v", p)
	}
	// Weight is read up to today, not up to the Sunday.
	body := get(data, "body")
	if get(body, "last_weigh_in") != string(coachToday) || get(body, "weight_age_days") != 0.0 ||
		get(body, "weight_slope_n_days") != 28.0 || get(body, "weight_slope_span_days") != 27.0 || get(body, "weight_slope_kg_per_week") != -0.7 {
		t.Errorf("body %v", body)
	}
	for _, f := range []string{"partial_day", "provisional_sleep"} {
		if !hasFlag(out, f) {
			t.Errorf("flags %v lack %s", get(out, "quality_flags"), f)
		}
	}
	if len(filters) != 1 || filters[0].Since != "2026-10-12" || filters[0].Until != coachToday {
		t.Errorf("note filters %+v", filters)
	}
	if fmt.Sprint(get(data, "decisions_this_week")) != "[]" {
		t.Errorf("decisions %v", get(data, "decisions_this_week"))
	}
}

func TestWeeklyReportProvisionalFlagOnlyForTheWeek(t *testing.T) {
	h := weeklyHealth(t)
	n := h.nights["2026-09-10"]
	n.Provisional = true
	h.nights["2026-09-10"] = n
	out := coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
	if hasFlag(out, "provisional_sleep") {
		t.Errorf("a baseline night raised the flag: %v", get(out, "quality_flags"))
	}
	n = h.nights["2026-10-07"]
	n.Provisional = true
	h.nights["2026-10-07"] = n
	out = coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
	if !hasFlag(out, "provisional_sleep") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
}

func TestWeeklyReportTrendNeedsDays(t *testing.T) {
	h := weeklyHealth(t)
	// Three nights this week: too few for a trend.
	for _, d := range []coach.LocalDate{"2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"} {
		delete(h.nights, d)
	}
	// Resting HR from 10-01 only: 4 days last week, but a 4-day baseline.
	for d := historyStart; d < "2026-10-01"; d = addDays(t, d, 1) {
		delete(h.resting, d)
	}
	data := coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})["data"]
	for _, c := range []struct {
		section, key, reason string
	}{
		{"sleep", "asleep_min", "insufficient_days"},
		{"sleep", "efficiency_pct", "insufficient_days"},
		{"sleep", "onset_sd_min", "insufficient_days"},
		{"cardio", "hrv_ms", "insufficient_days"},
		{"cardio", "resting_hr_bpm", "insufficient_baseline"},
	} {
		m := get(data, c.section, c.key)
		if get(m, "trend") != "unknown" || get(m, "trend_unavailable") != c.reason || get(m, "this_week") == nil {
			t.Errorf("%s %v, want unknown for %s", c.key, m, c.reason)
		}
	}
	if m := get(data, "cardio", "steps_per_day"); get(m, "trend") != "up" {
		t.Errorf("steps %v", m)
	}
}

func TestWeeklyReportTrendNoise(t *testing.T) {
	h := weeklyHealth(t)
	// Resting HR swings 50/66 before the previous week: a 2 bpm change
	// between weeks is inside that spread.
	for i, d := 0, historyStart; d < prevWeekStart; i, d = i+1, addDays(t, d, 1) {
		h.resting[d] = healthdata.RestingHR{BPM: 50 + 16*float64(i%2), Method: "WITH_SLEEP"}
	}
	data := coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})["data"]
	if m := get(data, "cardio", "resting_hr_bpm"); get(m, "trend") != "flat" || get(m, "trend_unavailable") != nil {
		t.Errorf("resting HR %v", m)
	}
}

// constantHealth has the same value every day before the week under review
// and value+delta in it, for one metric; the other metrics stay constant.
func constantHealth(t *testing.T, metric string, delta float64) *fakeHealth {
	t.Helper()
	h := &fakeHealth{
		nights: map[coach.LocalDate]healthdata.Night{}, resting: map[coach.LocalDate]healthdata.RestingHR{},
		activity: map[coach.LocalDate]healthdata.ActivityDay{}, weight: map[coach.LocalDate]healthdata.Reading{},
		bodyFat: map[coach.LocalDate]healthdata.Reading{},
	}
	for i, d := 0, historyStart; d <= weekEnd; i, d = i+1, addDays(t, d, 1) {
		in := func(m string) float64 {
			if m == metric && d >= weekStart {
				return delta
			}
			return 0
		}
		inBed := 470.0
		if metric == "onset" && d >= weekStart {
			inBed += delta * float64(1-2*(i%2)) // bedtimes alternate ±delta
		}
		h.nights[d] = night(t, d, 420+in("asleep"), inBed+in("asleep"), f64(50+in("hrv")))
		h.resting[d] = healthdata.RestingHR{BPM: 60 + in("resting"), Method: "WITH_SLEEP"}
		h.activity[d] = healthdata.ActivityDay{Steps: f64(8000 + in("steps")), AZM: f64(20 + in("azm")), TotalKcal: f64(2600), Worn: true}
		h.weight[d] = healthdata.Reading{Value: 80 + in("weight"), Source: "Synthetic scale"}
		h.bodyFat[d] = healthdata.Reading{Value: 20 + in("fat"), Source: "Synthetic scale"}
	}
	return h
}

func TestWeeklyReportTrendThresholds(t *testing.T) {
	for _, c := range []struct {
		metric, section, key string
		threshold            float64
	}{
		{"resting", "cardio", "resting_hr_bpm", trendRestingHRBPM},
		{"hrv", "cardio", "hrv_ms", trendHRVMS},
		{"steps", "cardio", "steps_per_day", trendSteps},
		{"azm", "cardio", "azm_per_day", trendAZMMin},
		{"asleep", "sleep", "asleep_min", trendAsleepMin},
		{"fat", "body", "body_fat_pct", trendBodyFatPct},
		// The smoothed weight moves 87% of the way in a week of daily
		// weigh-ins: 1.5× the threshold still passes it, 0.5× does not.
		{"weight", "body", "weight_kg", trendWeightKg},
	} {
		for factor, want := range map[float64]string{1.5: "up", 0.5: "flat", -0.5: "flat", -1.5: "down"} {
			h := constantHealth(t, c.metric, factor*c.threshold)
			m := get(coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})["data"], c.section, c.key)
			if get(m, "trend") != want {
				t.Errorf("%s at %v× the threshold: %v, want %s", c.metric, factor, m, want)
			}
		}
	}
	// Bedtime spread grows from 0: past the threshold it is up.
	for delta, want := range map[float64]string{1.5 * trendOnsetSDMin: "up", 0.5 * trendOnsetSDMin: "flat"} {
		m := get(coachSession(t, constantHealth(t, "onset", delta), reportTargets).ok("weekly_report",
			map[string]any{"week_end": string(weekEnd)})["data"], "sleep", "onset_sd_min")
		if get(m, "trend") != want {
			t.Errorf("onset spread ±%v: %v, want %s", delta, m, want)
		}
	}
}

func TestWeeklyReportWeightSlopeNeedsSpread(t *testing.T) {
	for _, c := range []struct {
		name    string
		days    []coach.LocalDate
		set     bool
		n, span float64
	}{
		{"three weigh-ins", []coach.LocalDate{"2026-09-20", "2026-10-01", "2026-10-11"}, false, 3, 21},
		{"four in 10 days", []coach.LocalDate{"2026-10-02", "2026-10-05", "2026-10-08", "2026-10-11"}, false, 4, 9},
		{"four over 14 days", []coach.LocalDate{"2026-09-27", "2026-10-02", "2026-10-07", "2026-10-11"}, true, 4, 14},
	} {
		h := weeklyHealth(t)
		h.weight = map[coach.LocalDate]healthdata.Reading{}
		for i, d := range c.days {
			h.weight[d] = healthdata.Reading{Value: 80 - 0.2*float64(i), Source: "Synthetic scale"}
		}
		body := get(coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)}), "data", "body")
		if (get(body, "weight_slope_kg_per_week") != nil) != c.set || get(body, "weight_slope_n_days") != c.n ||
			get(body, "weight_slope_span_days") != c.span {
			t.Errorf("%s: body %v", c.name, body)
		}
	}
}

func TestWeeklyReportAdherenceDetail(t *testing.T) {
	h := weeklyHealth(t)
	h.nutrition["2026-10-05"] = foodDay(t, "2026-10-05", // 1700 kcal: below the band; protein 150 complete
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 900, "protein_g": 80}, nil},
		foodSpec{20, "DINNER", map[string]float64{"kcal": 800, "protein_g": 70}, nil})
	h.nutrition["2026-10-06"] = foodDay(t, "2026-10-06", // 2500 kcal: above; protein 100 complete
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 1300, "protein_g": 50}, nil},
		foodSpec{20, "DINNER", map[string]float64{"kcal": 1200, "protein_g": 50}, nil})
	h.nutrition["2026-10-07"] = foodDay(t, "2026-10-07", // at least 150 of 150: a sure hit
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 1000, "protein_g": 150}, nil},
		foodSpec{20, "DINNER", map[string]float64{"kcal": 1000}, nil})
	delete(h.nutrition, "2026-10-10")
	ad := get(coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)}), "data", "adherence")
	// Counted: 10-05 below, 10-06 above, 10-07 and 10-09 within.
	if k := get(ad, "kcal_within_10pct"); get(k, "days_counted") != 4.0 || get(k, "days_hit") != 2.0 || get(k, "pct") != 50.0 ||
		get(k, "days_below") != 1.0 || get(k, "days_above") != 1.0 ||
		fmt.Sprint(get(k, "days_left_out")) != "map[log_likely_incomplete:1 other_source_food:1]" {
		t.Errorf("kcal adherence %v", k)
	}
	if p := get(ad, "protein_at_least_target"); get(p, "days_counted") != 3.0 || get(p, "days_hit") != 2.0 || get(p, "pct") != 66.7 ||
		fmt.Sprint(get(p, "days_left_out")) != "map[log_likely_incomplete:1 protein_lower_bound:2]" {
		t.Errorf("protein adherence %v", p)
	}
	if get(ad, "days_logged") != 6.0 {
		t.Errorf("adherence %v", ad)
	}
}

func TestWeeklyReportPartialTargets(t *testing.T) {
	targets := fakeTargets{versions: []store.Target{{EffectiveFrom: "2026-10-01", Kcal: ptr(2000)}}}
	ad := get(coachSession(t, weeklyHealth(t), targets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)}), "data", "adherence")
	if h, _ := get(ad, "target_hint").(string); !strings.Contains(h, "No protein, weekly sessions target") {
		t.Errorf("hint %q", h)
	}
	if k := get(ad, "kcal_within_10pct"); get(k, "days_counted") != 5.0 {
		t.Errorf("kcal adherence %v", k)
	}
	if p := get(ad, "protein_at_least_target"); get(p, "days_counted") != 0.0 || get(p, "days_left_out", "no_target") != 6.0 {
		t.Errorf("protein adherence %v", p)
	}
}

func TestWeeklyReportWeekWithoutWeighIn(t *testing.T) {
	h := weeklyHealth(t)
	for d := weekStart; d <= weekEnd; d = addDays(t, d, 1) {
		delete(h.weight, d)
	}
	out := coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
	w := get(out, "data", "body", "weight_kg")
	// The smoothed value is not carried into a week without a weigh-in.
	if get(w, "this_week") != nil || get(w, "prev_week") == nil || get(w, "trend") != "unknown" || get(w, "n_days") != 0.0 {
		t.Errorf("weight %v", w)
	}
	if get(out, "data", "body", "last_weigh_in") != "2026-10-04" || get(out, "data", "body", "weight_age_days") != 7.0 ||
		hasFlag(out, "stale_weight") {
		t.Errorf("body %v flags %v", get(out, "data", "body"), get(out, "quality_flags"))
	}

	for d := coach.LocalDate("2026-09-27"); d <= weekEnd; d = addDays(t, d, 1) {
		delete(h.weight, d)
	}
	out = coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
	if get(out, "data", "body", "weight_age_days") != 15.0 || !hasFlag(out, "stale_weight") {
		t.Errorf("body %v flags %v", get(out, "data", "body"), get(out, "quality_flags"))
	}

	h.weight["2026-09-27"] = healthdata.Reading{Value: 80, Source: "Synthetic scale"}
	out = coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
	if get(out, "data", "body", "weight_age_days") != 14.0 || hasFlag(out, "stale_weight") {
		t.Errorf("14 days: body %v flags %v", get(out, "data", "body"), get(out, "quality_flags"))
	}

	h.weight = nil
	out = coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
	body := get(out, "data", "body")
	if get(body, "last_weigh_in") != nil || get(body, "weight_age_days") != nil || get(body, "weight_slope_kg_per_week") != nil {
		t.Errorf("no weight: body %v", body)
	}
}

func TestWeeklyReportWithoutTargets(t *testing.T) {
	for name, targets := range map[string]Targets{"no store": nil, "never set": fakeTargets{}} {
		t.Run(name, func(t *testing.T) {
			out := coachSession(t, weeklyHealth(t), targets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
			ad := get(out, "data", "adherence")
			for _, k := range []string{"kcal_within_10pct", "protein_at_least_target"} {
				if a := get(ad, k); get(a, "pct") != nil || get(a, "days_counted") != 0.0 {
					t.Errorf("%s %v", k, a)
				}
			}
			if h, _ := get(ad, "target_hint").(string); get(ad, "weekly_sessions_target") != nil || !strings.Contains(h, "targets_set") {
				t.Errorf("adherence %v", ad)
			}
			// The log reasons come first: 10-08 and 10-11 keep theirs.
			if got := fmt.Sprint(get(ad, "kcal_within_10pct", "days_left_out")); got != "map[log_likely_incomplete:1 no_target:5 other_source_food:1]" {
				t.Errorf("kcal left out %s", got)
			}
		})
	}
}

func TestWeeklyReportTargetPerDay(t *testing.T) {
	// From Thursday the kcal target is 2400: 2100 then misses.
	targets := fakeTargets{versions: []store.Target{
		{EffectiveFrom: "2026-10-01", Kcal: ptr(2000), ProteinG: ptr(150), WeeklySessions: ptr(4)},
		{EffectiveFrom: "2026-10-08", Kcal: ptr(2400), ProteinG: ptr(150), WeeklySessions: ptr(5)},
	}}
	out := coachSession(t, weeklyHealth(t), targets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
	ad := get(out, "data", "adherence")
	if k := get(ad, "kcal_within_10pct"); get(k, "days_counted") != 5.0 || get(k, "days_hit") != 3.0 || get(k, "pct") != 60.0 {
		t.Errorf("kcal adherence %v", k)
	}
	// The sessions target is the one in force at the end of the week.
	if get(ad, "weekly_sessions_target") != 5.0 {
		t.Errorf("adherence %v", ad)
	}
}

func TestWeeklyReportDecisionsCapped(t *testing.T) {
	notes := fakeNotes{res: store.NoteResults{Notes: []store.Note{{ID: 1, Kind: "decision", Text: "x", Tags: []string{}}}, More: true}}
	out := coachSessionNotes(t, weeklyHealth(t), reportTargets, notes).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
	if get(out, "data", "decisions_more") != true || !hasFlag(out, "decisions_truncated") {
		t.Errorf("decisions %v flags %v", get(out, "data", "decisions_more"), get(out, "quality_flags"))
	}
}

func TestWeeklyReportFlagsExcludedRecords(t *testing.T) {
	h := weeklyHealth(t)
	h.nutritionSkip, h.nutritionOther = 1, 1
	h.exercises.OtherSource = 1
	out := coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)})
	for _, f := range []string{"unreadable_records", "other_source_food_excluded", "other_source_sessions_excluded"} {
		if !hasFlag(out, f) {
			t.Errorf("flags %v lack %s", get(out, "quality_flags"), f)
		}
	}
	// An unreadable food record has no known day: any day may miss it, as in
	// nutrition_day. Only 10-10's protein (at least 160 of 150) is sure.
	ad := get(out, "data", "adherence")
	if k := get(ad, "kcal_within_10pct"); get(k, "days_counted") != 0.0 ||
		fmt.Sprint(get(k, "days_left_out")) != "map[other_source_food:1 unreadable_food:6]" {
		t.Errorf("kcal adherence %v", k)
	}
	if p := get(ad, "protein_at_least_target"); get(p, "days_counted") != 1.0 || get(p, "days_hit") != 1.0 ||
		fmt.Sprint(get(p, "days_left_out")) != "map[log_likely_incomplete:1 protein_lower_bound:5]" {
		t.Errorf("protein adherence %v", p)
	}
}

func TestWeeklyReportUnreadableRecordsPerSource(t *testing.T) {
	for name, set := range map[string]func(*fakeHealth){
		"recovery":  func(h *fakeHealth) { h.recovery.Skipped = 1 },
		"activity":  func(h *fakeHealth) { h.activitySkipped = 1 },
		"body":      func(h *fakeHealth) { h.bodySkipped = 1 },
		"nutrition": func(h *fakeHealth) { h.nutritionSkip = 1 },
		"exercises": func(h *fakeHealth) { h.exercises.Skipped = 1 },
	} {
		h := weeklyHealth(t)
		set(h)
		if out := coachSession(t, h, reportTargets).ok("weekly_report", map[string]any{"week_end": string(weekEnd)}); !hasFlag(out, "unreadable_records") {
			t.Errorf("%s: flags %v", name, get(out, "quality_flags"))
		}
	}
}

func TestWeeklyReportInputAndErrors(t *testing.T) {
	c := coachSession(t, weeklyHealth(t), reportTargets)
	if te := c.fails("weekly_report", map[string]any{"week_end": "2026-10-17"}); te.Code != coach.CodeInvalidInput {
		t.Errorf("future week %+v", te)
	}
	for _, method := range []string{"recovery", "activity", "body", "nutrition", "exercises"} {
		h := weeklyHealth(t)
		h.errs = map[string]error{method: errors.New("synthetic failure")}
		if te := coachSession(t, h, reportTargets).fails("weekly_report", map[string]any{"week_end": string(weekEnd)}); te.Code != coach.CodeInternal {
			t.Errorf("%s failure %+v", method, te)
		}
	}
	for name, c := range map[string]coachClient{
		"targets": coachSession(t, weeklyHealth(t), fakeTargets{err: errors.New("synthetic failure")}),
		"notes":   coachSessionNotes(t, weeklyHealth(t), reportTargets, fakeNotes{err: errors.New("synthetic failure")}),
	} {
		if te := c.fails("weekly_report", map[string]any{"week_end": string(weekEnd)}); te.Code != coach.CodeInternal {
			t.Errorf("%s failure %+v", name, te)
		}
	}
}
