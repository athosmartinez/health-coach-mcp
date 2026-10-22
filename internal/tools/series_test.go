package tools

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
)

// All values below are synthetic.

// renderPoints renders a series as "date=value/n_days[/partial][/reason]
// [/-left_out]" entries.
func renderPoints(out map[string]any) string {
	var b strings.Builder
	for _, p := range get(out, "data", "points").([]any) {
		fmt.Fprintf(&b, "%v=%v/%v", get(p, "date"), get(p, "value"), get(p, "n_days"))
		if get(p, "complete") == false {
			b.WriteString("/partial")
		}
		if r := get(p, "reason"); r != nil {
			fmt.Fprintf(&b, "/%v", r)
		}
		if n := get(p, "days_left_out"); n != nil {
			fmt.Fprintf(&b, "/-%v", n)
		}
		b.WriteString(" ")
	}
	return b.String()
}

func seriesArgs(from, to coach.LocalDate, metric, granularity string) map[string]any {
	args := map[string]any{"metric": metric, "from": string(from), "to": string(to)}
	if granularity != "" {
		args["granularity"] = granularity
	}
	return args
}

func TestMetricSeriesDays(t *testing.T) {
	h := weeklyHealth(t)
	h.resting["2026-10-03"] = healthdata.RestingHR{BPM: 70, Method: "WITHOUT_SLEEP"} // not comparable: left out
	out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-02", "2026-10-06", "resting_hr", ""))
	if got := renderPoints(out); got != "2026-10-02=58/1 2026-10-03=<nil>/0 2026-10-04=58/1 2026-10-05=60/1 2026-10-06=60/1 " {
		t.Errorf("points %s", got)
	}
	data := out["data"]
	if get(data, "metric") != "resting_hr" || get(data, "unit") != "bpm" || get(data, "granularity") != "day" ||
		get(out, "coverage", "n_days") != 4.0 {
		t.Errorf("data %v coverage %v", data, get(out, "coverage"))
	}
	n, _ := get(data, "notice").(string)
	for _, phrase := range []string{"not a diagnosis", "1% of body weight", "doctor", "dietitian", "swings"} {
		if !strings.Contains(n, phrase) {
			t.Errorf("notice lost %q: %q", phrase, n)
		}
	}
	if fmt.Sprint(h.calls) != "[recovery 2026-10-02..2026-10-06]" {
		t.Errorf("calls %v", h.calls)
	}
}

func TestMetricSeriesWeeks(t *testing.T) {
	h := weeklyHealth(t)
	out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-01", coachToday, "steps", "week"))
	// Weeks start on Monday; the first one only counts from 10-01, and
	// today's running total is left out.
	if got := renderPoints(out); got != "2026-09-28=8000/4 2026-10-05=10000/7 2026-10-12=9000/4/-1 " {
		t.Errorf("points %s", got)
	}
	if !hasFlag(out, "partial_day") || get(out, "coverage", "n_days") != 15.0 {
		t.Errorf("flags %v coverage %v", get(out, "quality_flags"), get(out, "coverage"))
	}
}

func TestMetricSeriesEachMetric(t *testing.T) {
	h := weeklyHealth(t)
	n := h.nights[coachToday]
	n.Provisional = true
	h.nights[coachToday] = n
	h.nutrition["2026-10-14"] = fullDay(t, "2026-10-14")
	h.nutrition["2026-10-15"] = fullDay(t, "2026-10-15")
	h.recovery.Sources = []string{"Synthetic Band"}
	for _, c := range []struct {
		metric, unit, want string
		flag, source       string
	}{
		{"weight", "kg", "2026-10-14=76.3/1 2026-10-15=76.2/1 2026-10-16=76.1/1 ", "", "Synthetic scale"},
		{"resting_hr", "bpm", "2026-10-14=61/1 2026-10-15=61/1 2026-10-16=61/1 ", "", "Synthetic Band"},
		{"hrv", "ms", "2026-10-14=50/1 2026-10-15=50/1 2026-10-16=<nil>/0 ", "provisional_sleep", "Synthetic Band"},
		{"sleep_asleep_min", "min", "2026-10-14=430/1 2026-10-15=430/1 2026-10-16=<nil>/0 ", "provisional_sleep", "Synthetic Band"},
		{"steps", "steps", "2026-10-14=9000/1 2026-10-15=9000/1 2026-10-16=<nil>/0/partial_day ", "partial_day", ""},
		{"azm", "min", "2026-10-14=20/1 2026-10-15=20/1 2026-10-16=<nil>/0/partial_day ", "partial_day", ""},
		{"total_calories", "kcal", "2026-10-14=2600/1 2026-10-15=2600/1 2026-10-16=<nil>/0/partial_day ", "partial_day", ""},
		{"kcal_in", "kcal", "2026-10-14=2200/1 2026-10-15=2200/1 2026-10-16=<nil>/0 ", "", "Google Fitbit Air"},
		{"protein_g", "g", "2026-10-14=130/1 2026-10-15=130/1 2026-10-16=<nil>/0 ", "", "Google Fitbit Air"},
	} {
		out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-14", coachToday, c.metric, ""))
		if got := renderPoints(out); got != c.want || get(out, "data", "unit") != c.unit {
			t.Errorf("%s: points %s unit %v", c.metric, got, get(out, "data", "unit"))
		}
		if c.flag != "" && !hasFlag(out, c.flag) {
			t.Errorf("%s: flags %v lack %s", c.metric, get(out, "quality_flags"), c.flag)
		}
		if c.source != "" && !strings.Contains(fmt.Sprint(get(out, "sources")), c.source) {
			t.Errorf("%s: sources %v lack %s", c.metric, get(out, "sources"), c.source)
		}
	}
	// Resting HR does not depend on the night's processing.
	if out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-14", coachToday, "resting_hr", "")); hasFlag(out, "provisional_sleep") {
		t.Errorf("resting_hr flags %v", get(out, "quality_flags"))
	}
}

func TestMetricSeriesSingleDay(t *testing.T) {
	out := coachSession(t, weeklyHealth(t), nil).ok("metric_series", seriesArgs("2026-10-07", "2026-10-07", "steps", ""))
	if got := renderPoints(out); got != "2026-10-07=10000/1 " || get(out, "coverage", "n_days") != 1.0 {
		t.Errorf("points %s coverage %v", got, get(out, "coverage"))
	}
	out = coachSession(t, weeklyHealth(t), nil).ok("metric_series", seriesArgs("2026-10-07", "2026-10-07", "steps", "week"))
	if got := renderPoints(out); got != "2026-10-05=10000/1 " {
		t.Errorf("week points %s", got)
	}
}

func TestMetricSeriesBandNotWorn(t *testing.T) {
	h := weeklyHealth(t)
	h.activity["2026-10-14"] = healthdata.ActivityDay{Steps: f64(400), AZM: f64(0), TotalKcal: f64(1700), Worn: false}
	out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-13", "2026-10-15", "total_calories", ""))
	// Without the band the total is mostly a resting estimate: null.
	if got := renderPoints(out); got != "2026-10-13=2600/1 2026-10-14=<nil>/0/band_not_worn 2026-10-15=2600/1 " || !hasFlag(out, "band_not_worn") {
		t.Errorf("points %s flags %v", got, get(out, "quality_flags"))
	}
	out = coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-12", "2026-10-15", "total_calories", "week"))
	if got := renderPoints(out); got != "2026-10-12=2600/3/-1 " {
		t.Errorf("week points %s", got)
	}
	// Steps stay: they come from the band or the phone either way.
	out = coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-14", "2026-10-14", "steps", ""))
	if got := renderPoints(out); got != "2026-10-14=400/1 " {
		t.Errorf("steps %s", got)
	}
}

func TestMetricSeriesFood(t *testing.T) {
	h := weeklyHealth(t)
	h.nutrition["2026-10-12"] = foodDay(t, "2026-10-12", // kcal missing on one item
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 900, "protein_g": 60}, nil},
		foodSpec{20, "DINNER", map[string]float64{"protein_g": 40}, nil})
	out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-08", "2026-10-12", "kcal_in", ""))
	// With nutrition_day's rule, a day whose kcal would show a deficit that
	// did not happen is null: food from another platform (10-08), a log that
	// looks incomplete (10-11) and a partial kcal total (10-12).
	if got := renderPoints(out); got != "2026-10-08=<nil>/0/other_source_food 2026-10-09=2100/1 2026-10-10=2100/1 "+
		"2026-10-11=<nil>/0/log_likely_incomplete 2026-10-12=<nil>/0/intake_partial " {
		t.Errorf("kcal points %s", got)
	}
	if !hasFlag(out, "other_source_food_excluded") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
	// Without a kcal target the log check needs the calories burned.
	if fmt.Sprint(h.calls) != "[nutrition 2026-10-08..2026-10-12 activity 2026-10-08..2026-10-12]" {
		t.Errorf("calls %v", h.calls)
	}
	// A partial protein total is shown as a lower bound, with the reason.
	out = coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-08", "2026-10-12", "protein_g", ""))
	if got := renderPoints(out); got != "2026-10-08=130/1/partial/other_source_food 2026-10-09=50/1/partial/items_missing_protein "+
		"2026-10-10=160/1/partial/items_missing_protein 2026-10-11=30/1/partial/log_likely_incomplete "+
		"2026-10-12=100/1/partial/log_likely_incomplete " {
		t.Errorf("protein points %s", got)
	}
	if !hasFlag(out, "partial_nutrient_totals") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
	out = coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-05", "2026-10-11", "protein_g", "week"))
	// (130·4 + 50 + 160 + 30) / 7
	if got := renderPoints(out); got != "2026-10-05=108.6/7/partial " {
		t.Errorf("protein weeks %s", got)
	}
	out = coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-05", "2026-10-11", "kcal_in", "week"))
	// (2200·3 + 2100·2) / 5; 10-08 and 10-11 are left out.
	if got := renderPoints(out); got != "2026-10-05=2160/5/-2 " {
		t.Errorf("kcal weeks %s", got)
	}
	// Today's log is still growing: left out.
	h.nutrition[coachToday] = fullDay(t, coachToday)
	for _, metric := range []string{"protein_g", "kcal_in"} {
		out = coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-15", coachToday, metric, ""))
		if got := renderPoints(out); got != "2026-10-15=<nil>/0 2026-10-16=<nil>/0/partial_day " || !hasFlag(out, "partial_day") {
			t.Errorf("%s today: points %s flags %v", metric, got, get(out, "quality_flags"))
		}
	}
}

func TestMetricSeriesFoodWithTargets(t *testing.T) {
	h := weeklyHealth(t)
	out := coachSession(t, h, reportTargets).ok("metric_series", seriesArgs("2026-10-09", "2026-10-11", "kcal_in", ""))
	// 10-11 is under half the 2000 kcal target. Every day has a kcal target:
	// no activity read.
	if got := renderPoints(out); got != "2026-10-09=2100/1 2026-10-10=2100/1 2026-10-11=<nil>/0/log_likely_incomplete " {
		t.Errorf("points %s", got)
	}
	if fmt.Sprint(h.calls) != "[nutrition 2026-10-09..2026-10-11]" {
		t.Errorf("calls %v", h.calls)
	}
}

func TestMetricSeriesUnreadableFood(t *testing.T) {
	h := weeklyHealth(t)
	h.nutritionSkip = 1
	// The unreadable record has no known day: any day may miss it.
	out := coachSession(t, h, reportTargets).ok("metric_series", seriesArgs("2026-10-05", "2026-10-06", "kcal_in", ""))
	if got := renderPoints(out); got != "2026-10-05=<nil>/0/unreadable_food 2026-10-06=<nil>/0/unreadable_food " || !hasFlag(out, "unreadable_records") {
		t.Errorf("kcal points %s flags %v", got, get(out, "quality_flags"))
	}
	out = coachSession(t, h, reportTargets).ok("metric_series", seriesArgs("2026-10-05", "2026-10-06", "protein_g", ""))
	if got := renderPoints(out); got != "2026-10-05=130/1/partial/unreadable_food 2026-10-06=130/1/partial/unreadable_food " {
		t.Errorf("protein points %s", got)
	}
}

func TestMetricSeriesLimits(t *testing.T) {
	c := coachSession(t, &fakeHealth{}, nil)
	// 180 daily points pass, 181 do not.
	if out := c.ok("metric_series", seriesArgs("2026-04-20", "2026-10-16", "steps", "")); len(get(out, "data", "points").([]any)) != 180 {
		t.Errorf("180 days: %d points", len(get(out, "data", "points").([]any)))
	}
	if te := c.fails("metric_series", seriesArgs("2026-04-19", "2026-10-16", "steps", "")); te.Code != coach.CodeInvalidInput ||
		!strings.Contains(te.Hint, "week") {
		t.Errorf("181 days %+v", te)
	}
	// A year by week is 53 points; past 366 days the range is too long.
	if out := c.ok("metric_series", seriesArgs("2025-10-16", "2026-10-16", "steps", "week")); len(get(out, "data", "points").([]any)) != 53 {
		t.Errorf("366 days by week: %d points", len(get(out, "data", "points").([]any)))
	}
	for name, args := range map[string]map[string]any{
		"367 days":    seriesArgs("2025-10-15", "2026-10-16", "steps", "week"),
		"reversed":    seriesArgs("2026-10-10", "2026-10-09", "steps", ""),
		"after today": seriesArgs("2026-10-10", "2026-10-17", "steps", ""),
	} {
		if te := c.fails("metric_series", args); te.Code != coach.CodeInvalidInput {
			t.Errorf("%s: %+v", name, te)
		}
	}
}

func TestMetricSeriesErrors(t *testing.T) {
	for metric, method := range map[string]string{
		"weight": "body", "hrv": "recovery", "steps": "activity", "protein_g": "nutrition",
	} {
		h := weeklyHealth(t)
		h.errs = map[string]error{method: errors.New("synthetic failure")}
		if te := coachSession(t, h, nil).fails("metric_series", seriesArgs("2026-10-01", "2026-10-10", metric, "")); te.Code != coach.CodeInternal {
			t.Errorf("%s: %+v", metric, te)
		}
	}
	for metric, set := range map[string]func(*fakeHealth){
		"steps":  func(h *fakeHealth) { h.activitySkipped = 1 },
		"weight": func(h *fakeHealth) { h.bodySkipped = 1 },
		"hrv":    func(h *fakeHealth) { h.recovery.Skipped = 1 },
	} {
		h := weeklyHealth(t)
		set(h)
		out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-01", "2026-10-10", metric, ""))
		if !hasFlag(out, "unreadable_records") {
			t.Errorf("%s: flags %v", metric, get(out, "quality_flags"))
		}
	}
}
