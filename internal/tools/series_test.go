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

// renderPoints renders a series as "date=value/n_days[/partial]" entries.
func renderPoints(out map[string]any) string {
	var b strings.Builder
	for _, p := range get(out, "data", "points").([]any) {
		fmt.Fprintf(&b, "%v=%v/%v", get(p, "date"), get(p, "value"), get(p, "n_days"))
		if get(p, "complete") == false {
			b.WriteString("/partial")
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
	if n, _ := get(data, "notice").(string); !strings.Contains(n, "not a diagnosis") {
		t.Errorf("notice %q", n)
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
	if got := renderPoints(out); got != "2026-09-28=8000/4 2026-10-05=10000/7 2026-10-12=9000/4 " {
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
	for _, c := range []struct {
		metric, unit, want string
		flag               string
	}{
		{"weight", "kg", "2026-10-14=76.3/1 2026-10-15=76.2/1 2026-10-16=76.1/1 ", ""},
		{"hrv", "ms", "2026-10-14=50/1 2026-10-15=50/1 2026-10-16=<nil>/0 ", "provisional_sleep"},
		{"sleep_asleep_min", "min", "2026-10-14=430/1 2026-10-15=430/1 2026-10-16=<nil>/0 ", "provisional_sleep"},
		{"azm", "min", "2026-10-14=20/1 2026-10-15=20/1 2026-10-16=<nil>/0 ", "partial_day"},
		{"total_calories", "kcal", "2026-10-14=2600/1 2026-10-15=2600/1 2026-10-16=<nil>/0 ", "partial_day"},
	} {
		out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-14", coachToday, c.metric, ""))
		if got := renderPoints(out); got != c.want || get(out, "data", "unit") != c.unit {
			t.Errorf("%s: points %s unit %v", c.metric, got, get(out, "data", "unit"))
		}
		if c.flag != "" && !hasFlag(out, c.flag) {
			t.Errorf("%s: flags %v lack %s", c.metric, get(out, "quality_flags"), c.flag)
		}
	}
}

func TestMetricSeriesFood(t *testing.T) {
	h := weeklyHealth(t)
	h.nutrition["2026-10-12"] = foodDay(t, "2026-10-12", // kcal missing on one item
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 900, "protein_g": 60}, nil},
		foodSpec{20, "DINNER", map[string]float64{"protein_g": 40}, nil})
	out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-08", "2026-10-12", "kcal_in", ""))
	// A partial kcal total would read as a low day: null.
	if got := renderPoints(out); got != "2026-10-08=2200/1 2026-10-09=2100/1 2026-10-10=2100/1 2026-10-11=550/1 2026-10-12=<nil>/0 " {
		t.Errorf("kcal points %s", got)
	}
	if !hasFlag(out, "other_source_food_excluded") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
	// A partial protein total is shown as a lower bound.
	out = coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-08", "2026-10-12", "protein_g", ""))
	if got := renderPoints(out); got != "2026-10-08=130/1 2026-10-09=50/1/partial 2026-10-10=160/1/partial 2026-10-11=30/1 2026-10-12=100/1 " {
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
	// Today's log is still growing: left out.
	h.nutrition[coachToday] = fullDay(t, coachToday)
	out = coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-15", coachToday, "protein_g", ""))
	if got := renderPoints(out); got != "2026-10-15=<nil>/0 2026-10-16=<nil>/0 " || !hasFlag(out, "partial_day") {
		t.Errorf("today: points %s flags %v", got, get(out, "quality_flags"))
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
	h := weeklyHealth(t)
	h.activitySkipped = 1
	out := coachSession(t, h, nil).ok("metric_series", seriesArgs("2026-10-01", "2026-10-10", "steps", ""))
	if !hasFlag(out, "unreadable_records") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
}
