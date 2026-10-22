package tools

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// All values below are synthetic.

const closedDay = coach.LocalDate("2026-10-14")

type foodSpec struct {
	hour      int
	meal      string
	nutrients map[string]float64
	rejected  []string
}

// foodDay builds a logged day the way healthdata does: items in time order,
// totals over the items that report each nutrient.
func foodDay(t *testing.T, day coach.LocalDate, specs ...foodSpec) healthdata.NutritionDay {
	t.Helper()
	d, err := time.Parse(time.DateOnly, string(day))
	if err != nil {
		t.Fatal(err)
	}
	loc := saoPaulo(t)
	nd := healthdata.NutritionDay{Totals: map[string]healthdata.Total{}, Partial: day >= coachToday}
	for i, s := range specs {
		item := healthdata.FoodItem{
			ID: fmt.Sprintf("users/me/dataTypes/nutrition-log/dataPoints/syn-%d", i), Name: fmt.Sprintf("Synthetic food %d", i),
			Meal: s.meal, At: time.Date(d.Year(), d.Month(), d.Day(), s.hour, 0, 0, 0, loc), Nutrients: s.nutrients,
			Rejected: s.rejected, Source: "Google Fitbit Air",
		}
		nd.Items = append(nd.Items, item)
		nd.Rejected += len(s.rejected)
		for k, v := range s.nutrients {
			tot := nd.Totals[k]
			tot.Value += v
			tot.Items++
			nd.Totals[k] = tot
		}
	}
	return nd
}

// fullDay has the four meals, kcal 2200 and protein 130 in every item, and
// fiber in one item only.
func fullDay(t *testing.T, day coach.LocalDate) healthdata.NutritionDay {
	return foodDay(t, day,
		foodSpec{8, "BREAKFAST", map[string]float64{"kcal": 500, "protein_g": 30, "carb_g": 60, "fat_g": 15}, nil},
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 800, "protein_g": 50, "carb_g": 90, "fat_g": 25, "fiber_g": 10}, nil},
		foodSpec{16, "SNACK", map[string]float64{"kcal": 200, "protein_g": 10, "carb_g": 20, "fat_g": 8}, nil},
		foodSpec{20, "DINNER", map[string]float64{"kcal": 700, "protein_g": 40, "carb_g": 70, "fat_g": 20}, nil},
	)
}

func nutritionHealth(t *testing.T) *fakeHealth {
	return &fakeHealth{
		nutrition: map[coach.LocalDate]healthdata.NutritionDay{closedDay: fullDay(t, closedDay)},
		activity: map[coach.LocalDate]healthdata.ActivityDay{
			closedDay:  {TotalKcal: f64(2600), Worn: true},
			coachToday: {TotalKcal: f64(1500), Worn: true, Partial: true},
		},
		weight: map[coach.LocalDate]healthdata.Reading{"2026-10-13": {Value: 80, Source: "Synthetic scale"}},
	}
}

var nutritionTarget = fakeTargets{versions: []store.Target{{EffectiveFrom: "2026-10-01", Kcal: ptr(2000), ProteinG: ptr(150)}}}

func TestNutritionDayClosedDay(t *testing.T) {
	h := nutritionHealth(t)
	out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	data := out["data"]
	if get(data, "date") != string(closedDay) || get(data, "items_logged") != 4.0 || get(data, "items_omitted") != 0.0 {
		t.Errorf("data %v", data)
	}
	totals := get(data, "totals")
	for _, c := range []struct {
		key      string
		value    float64
		items    float64
		complete bool
	}{
		{"kcal", 2200, 4, true}, {"protein_g", 130, 4, true}, {"carb_g", 240, 4, true}, {"fat_g", 68, 4, true},
		{"fiber_g", 10, 1, false},
	} {
		got := get(totals, c.key)
		if get(got, "value") != c.value || get(got, "items_reporting") != c.items || get(got, "complete") != c.complete {
			t.Errorf("total %s = %v", c.key, got)
		}
	}
	// A nutrient no item reports is unknown, not zero.
	for _, k := range []string{"sugar_g", "sodium_mg"} {
		if v, ok := totals.(map[string]any)[k]; !ok || v != nil {
			t.Errorf("total %s = %v, want null", k, v)
		}
	}

	var meals []string
	for _, m := range get(data, "per_meal").([]any) {
		meals = append(meals, get(m, "meal_type").(string))
	}
	if fmt.Sprint(meals) != "[BREAKFAST LUNCH DINNER SNACK]" {
		t.Errorf("meals %v", meals)
	}
	lunch := get(data, "per_meal", "1")
	if get(lunch, "totals", "kcal", "value") != 800.0 || get(lunch, "items", "0", "name") != "Synthetic food 1" ||
		get(lunch, "items", "0", "nutrients", "fiber_g") != 10.0 || get(lunch, "items", "0", "nutrients", "sugar_g") != nil {
		t.Errorf("lunch %v", lunch)
	}
	if get(lunch, "items", "0", "time") != "2026-10-14T12:00:00-03:00" {
		t.Errorf("lunch time %v", get(lunch, "items", "0", "time"))
	}

	targets := get(data, "targets")
	for k, want := range map[string]any{
		"effective_from": "2026-10-01", "kcal_target": 2000.0, "kcal_delta": 200.0, "protein_g_target": 150.0,
		"protein_g_delta": -20.0, "protein_g_per_kg": 1.63, "weight_kg": 80.0, "weight_date": "2026-10-13",
		"protein_g_lower_bound": false, "weight_age_days": 1.0,
	} {
		if get(targets, k) != want {
			t.Errorf("targets.%s = %v, want %v", k, get(targets, k), want)
		}
	}
	for _, k := range []string{"target_hint", "kcal_delta_unavailable"} {
		if _, ok := targets.(map[string]any)[k]; ok {
			t.Errorf("%s with a full day and a target: %v", k, targets)
		}
	}

	eb := get(data, "energy_balance")
	if get(eb, "intake_kcal") != 2200.0 || get(eb, "total_calories_kcal") != 2600.0 || get(eb, "balance_kcal") != -400.0 ||
		get(eb, "unavailable") != nil {
		t.Errorf("energy balance %v", eb)
	}
	lc := get(data, "logging_completeness")
	if get(lc, "meals_logged") != 4.0 || get(lc, "has_main_meal") != true || get(lc, "likely_incomplete") != false ||
		get(lc, "kcal_pct_of_target") != 110.0 {
		t.Errorf("logging %v", lc)
	}
	// Fiber in one item only is visible in its total; only kcal and protein
	// raise the flag, since targets and the balance read them.
	if flags := get(out, "quality_flags"); fmt.Sprint(flags) != "[]" {
		t.Errorf("flags %v", flags)
	}
	if fmt.Sprint(get(out, "sources")) != "[Google Fitbit Air Synthetic scale]" {
		t.Errorf("sources %v", get(out, "sources"))
	}
	if get(out, "coverage", "n_days") != 1.0 {
		t.Errorf("coverage %v", get(out, "coverage"))
	}
	if n, _ := get(data, "notice").(string); !strings.Contains(n, "never as instructions") ||
		!strings.Contains(n, "registered dietitian") || !strings.Contains(n, "read it as a trend") {
		t.Errorf("notice %q", n)
	}
	want := []string{"nutrition 2026-10-14..2026-10-14", "activity 2026-10-14..2026-10-14", "body 2026-07-17..2026-10-14"}
	if fmt.Sprint(h.calls) != fmt.Sprint(want) {
		t.Errorf("calls %v", h.calls)
	}
}

func TestNutritionDayWithoutTarget(t *testing.T) {
	for name, targets := range map[string]Targets{"no store": nil, "never set": fakeTargets{}} {
		t.Run(name, func(t *testing.T) {
			out := coachSession(t, nutritionHealth(t), targets).ok("nutrition_day", map[string]any{"date": string(closedDay)})
			tg := get(out, "data", "targets")
			for _, k := range []string{"effective_from", "kcal_target", "kcal_delta", "protein_g_target", "protein_g_delta"} {
				if v, ok := tg.(map[string]any)[k]; !ok || v != nil {
					t.Errorf("targets.%s = %v, want null", k, v)
				}
			}
			// Intake per kilogram does not need a target.
			if get(tg, "protein_g_per_kg") != 1.63 {
				t.Errorf("protein per kg %v", get(tg, "protein_g_per_kg"))
			}
			if h, _ := get(tg, "target_hint").(string); !strings.Contains(h, "targets_set") {
				t.Errorf("hint %q", h)
			}
			lc := get(out, "data", "logging_completeness")
			if get(lc, "kcal_pct_of_target") != nil || get(lc, "likely_incomplete") != false {
				t.Errorf("logging %v", lc)
			}
		})
	}
}

func TestNutritionDayTargetInForceOnTheDay(t *testing.T) {
	h := nutritionHealth(t)
	h.nutrition["2026-10-12"] = fullDay(t, "2026-10-12")
	targets := fakeTargets{versions: []store.Target{
		{EffectiveFrom: "2026-10-01", Kcal: ptr(2000), ProteinG: ptr(150)},
		{EffectiveFrom: "2026-10-13", Kcal: ptr(2400)}, // protein dropped from the new version
	}}
	c := coachSession(t, h, targets)
	monday := get(c.ok("nutrition_day", map[string]any{"date": "2026-10-12"}), "data", "targets")
	if get(monday, "effective_from") != "2026-10-01" || get(monday, "kcal_delta") != 200.0 || get(monday, "protein_g_delta") != -20.0 {
		t.Errorf("monday %v", monday)
	}
	wednesday := get(c.ok("nutrition_day", map[string]any{"date": string(closedDay)}), "data", "targets")
	if get(wednesday, "effective_from") != "2026-10-13" || get(wednesday, "kcal_delta") != -200.0 ||
		get(wednesday, "protein_g_target") != nil || get(wednesday, "protein_g_delta") != nil {
		t.Errorf("wednesday %v", wednesday)
	}
	if h, _ := get(wednesday, "target_hint").(string); !strings.Contains(h, "protein") || !strings.Contains(h, "targets_set") {
		t.Errorf("hint %q", h)
	}
}

func TestNutritionDayItemWithoutProtein(t *testing.T) {
	h := nutritionHealth(t)
	h.nutrition[closedDay] = foodDay(t, closedDay,
		foodSpec{8, "BREAKFAST", map[string]float64{"kcal": 500, "protein_g": 30}, nil},
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 800, "protein_g": 50}, nil},
		foodSpec{20, "DINNER", map[string]float64{"kcal": 700}, nil},
	)
	out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	data := out["data"]
	if p := get(data, "totals", "protein_g"); get(p, "value") != 80.0 || get(p, "items_reporting") != 2.0 || get(p, "complete") != false {
		t.Errorf("protein %v", p)
	}
	// Items without protein are mostly low-kcal ones: the partial total is a
	// lower bound, not a missing value.
	if tg := get(data, "targets"); get(tg, "protein_g_delta") != -70.0 || get(tg, "protein_g_per_kg") != 1.0 ||
		get(tg, "protein_g_lower_bound") != true {
		t.Errorf("targets %v", tg)
	}
	if get(data, "targets", "kcal_delta") != 0.0 || get(data, "energy_balance", "balance_kcal") != -600.0 {
		t.Errorf("kcal side %v %v", get(data, "targets"), get(data, "energy_balance"))
	}
	if !hasFlag(out, "partial_nutrient_totals") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
}

func TestNutritionDayItemWithoutKcal(t *testing.T) {
	h := nutritionHealth(t)
	h.nutrition[closedDay] = foodDay(t, closedDay,
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 1200, "protein_g": 50}, nil},
		foodSpec{20, "DINNER", map[string]float64{"protein_g": 40}, []string{"kcal"}},
	)
	out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	data := out["data"]
	eb := get(data, "energy_balance")
	if get(eb, "intake_kcal") != nil || get(eb, "balance_kcal") != nil || get(eb, "unavailable") != "intake_partial" ||
		get(eb, "total_calories_kcal") != 2600.0 {
		t.Errorf("energy balance %v", eb)
	}
	if get(data, "targets", "kcal_delta") != nil || get(data, "targets", "kcal_delta_unavailable") != "intake_partial" ||
		get(data, "targets", "protein_g_delta") != -60.0 ||
		get(data, "targets", "protein_g_lower_bound") != false {
		t.Errorf("targets %v", get(data, "targets"))
	}
	// The partial kcal still counts toward the logging check: 1200 of 2000.
	if get(data, "logging_completeness", "kcal_pct_of_target") != 60.0 {
		t.Errorf("logging %v", get(data, "logging_completeness"))
	}
	if get(data, "per_meal", "1", "items", "0", "rejected_nutrients", "0") != "kcal" {
		t.Errorf("dinner %v", get(data, "per_meal", "1"))
	}
	if !hasFlag(out, "partial_nutrient_totals") || !hasFlag(out, "rejected_nutrient_values") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
}

func TestNutritionDayOnlySnacks(t *testing.T) {
	h := nutritionHealth(t)
	h.nutrition[closedDay] = foodDay(t, closedDay,
		foodSpec{10, "SNACK", map[string]float64{"kcal": 300, "protein_g": 20}, nil},
		foodSpec{15, "SNACK", map[string]float64{"kcal": 250, "protein_g": 10}, nil},
	)
	out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	data := out["data"]
	lc := get(data, "logging_completeness")
	if get(lc, "meals_logged") != 1.0 || get(lc, "has_main_meal") != false || get(lc, "likely_incomplete") != true ||
		get(lc, "kcal_pct_of_target") != 27.5 {
		t.Errorf("logging %v", lc)
	}
	// The intake behind a likely incomplete log is too low: its balance would
	// read as a large deficit.
	eb := get(data, "energy_balance")
	if get(eb, "balance_kcal") != nil || get(eb, "unavailable") != "log_likely_incomplete" || get(eb, "intake_kcal") != 550.0 ||
		get(eb, "total_calories_kcal") != 2600.0 {
		t.Errorf("energy balance %v", eb)
	}
	if tg := get(data, "targets"); get(tg, "kcal_delta") != nil || get(tg, "kcal_delta_unavailable") != "log_likely_incomplete" {
		t.Errorf("targets %v", tg)
	}
	if !hasFlag(out, "likely_incomplete_nutrition") || hasFlag(out, "partial_day") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
}

func TestNutritionDayTodayIsPartial(t *testing.T) {
	h := nutritionHealth(t)
	h.nutrition[coachToday] = foodDay(t, coachToday, foodSpec{7, "SNACK", map[string]float64{"kcal": 200, "protein_g": 10}, nil})
	out := coachSession(t, h, nutritionTarget).ok("nutrition_day", nil)
	data := out["data"]
	if get(data, "date") != string(coachToday) {
		t.Errorf("date %v", get(data, "date"))
	}
	// The day is not over: no main meal yet is not a failure.
	lc := get(data, "logging_completeness")
	if get(lc, "likely_incomplete") != false || get(lc, "has_main_meal") != false || get(lc, "kcal_pct_of_target") != 10.0 {
		t.Errorf("logging %v", lc)
	}
	// Intake and burn are running totals: no deficit until the day closes.
	if eb := get(data, "energy_balance"); get(eb, "balance_kcal") != nil || get(eb, "unavailable") != "partial_day" ||
		get(eb, "intake_kcal") != 200.0 || get(eb, "total_calories_kcal") != 1500.0 {
		t.Errorf("energy balance %v", eb)
	}
	if tg := get(data, "targets"); get(tg, "kcal_delta") != nil || get(tg, "kcal_delta_unavailable") != "partial_day" {
		t.Errorf("targets %v", tg)
	}
	if !hasFlag(out, "partial_day") || hasFlag(out, "likely_incomplete_nutrition") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
}

func TestNutritionDayBandNotWorn(t *testing.T) {
	for name, act := range map[string]map[coach.LocalDate]healthdata.ActivityDay{
		"not worn":    {closedDay: {TotalKcal: f64(1700)}},
		"no activity": {},
	} {
		t.Run(name, func(t *testing.T) {
			h := nutritionHealth(t)
			h.activity = act
			out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
			eb := get(out, "data", "energy_balance")
			// Without the band, total calories is mostly a resting estimate.
			if get(eb, "total_calories_kcal") != nil || get(eb, "balance_kcal") != nil || get(eb, "unavailable") != "band_not_worn" ||
				get(eb, "intake_kcal") != 2200.0 {
				t.Errorf("energy balance %v", eb)
			}
			if !hasFlag(out, "band_not_worn") {
				t.Errorf("flags %v", get(out, "quality_flags"))
			}
		})
	}
}

func TestNutritionDayActivityUnreadable(t *testing.T) {
	h := nutritionHealth(t)
	h.activity, h.activitySkipped = nil, 1
	out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	if get(out, "data", "energy_balance", "unavailable") != "no_total_calories" || hasFlag(out, "band_not_worn") ||
		!hasFlag(out, "unreadable_records") {
		t.Errorf("result %v", out)
	}
	h = nutritionHealth(t)
	h.activity[closedDay] = healthdata.ActivityDay{Worn: true}
	out = coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	if get(out, "data", "energy_balance", "unavailable") != "no_total_calories" {
		t.Errorf("worn without total %v", get(out, "data", "energy_balance"))
	}
}

func TestNutritionDayWithoutWeight(t *testing.T) {
	h := nutritionHealth(t)
	h.weight = nil
	out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	tg := get(out, "data", "targets")
	if get(tg, "protein_g_per_kg") != nil || get(tg, "weight_kg") != nil || get(tg, "weight_date") != nil || get(tg, "protein_g_delta") != -20.0 {
		t.Errorf("targets %v", tg)
	}
}

func TestNutritionDayMealOrder(t *testing.T) {
	h := nutritionHealth(t)
	h.nutrition[closedDay] = foodDay(t, closedDay,
		foodSpec{6, "SNACK", map[string]float64{"kcal": 100}, nil},
		foodSpec{7, "", map[string]float64{"kcal": 100}, nil},
		foodSpec{8, "BRUNCH", map[string]float64{"kcal": 100}, nil},
		foodSpec{9, "DINNER", map[string]float64{"kcal": 100}, nil},
		foodSpec{10, "BREAKFAST", map[string]float64{"kcal": 100}, nil},
		foodSpec{11, "AFTERNOON", map[string]float64{"kcal": 100}, nil},
		foodSpec{12, "SNACK", map[string]float64{"kcal": 100}, nil},
	)
	data := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})["data"]
	var meals []string
	for _, m := range get(data, "per_meal").([]any) {
		meals = append(meals, fmt.Sprint(get(m, "meal_type"), "x", len(get(m, "items").([]any))))
	}
	if fmt.Sprint(meals) != "[BREAKFASTx1 DINNERx1 SNACKx2 AFTERNOONx1 BRUNCHx1 UNSPECIFIEDx1]" {
		t.Errorf("meals %v", meals)
	}
	// Distinct meal types, the unspecified bucket included.
	if get(data, "logging_completeness", "meals_logged") != 6.0 {
		t.Errorf("logging %v", get(data, "logging_completeness"))
	}
}

func TestNutritionDayCapsItems(t *testing.T) {
	h := nutritionHealth(t)
	var specs []foodSpec
	for i := range maxFoodItems + 5 {
		meal := "LUNCH"
		if i%2 == 1 {
			meal = "SNACK"
		}
		specs = append(specs, foodSpec{i % 24, meal, map[string]float64{"kcal": 10, "protein_g": 1}, nil})
	}
	h.nutrition[closedDay] = foodDay(t, closedDay, specs...)
	out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	data := out["data"]
	listed := 0
	for _, m := range get(data, "per_meal").([]any) {
		listed += len(get(m, "items").([]any))
	}
	if listed != maxFoodItems || get(data, "items_omitted") != 5.0 || get(data, "items_logged") != float64(maxFoodItems+5) {
		t.Errorf("listed %d, omitted %v", listed, get(data, "items_omitted"))
	}
	// Totals still cover every item.
	if get(data, "totals", "kcal", "value") != float64(10*(maxFoodItems+5)) {
		t.Errorf("totals %v", get(data, "totals", "kcal"))
	}
	if get(data, "per_meal", "0", "totals", "kcal", "value") != float64(10*((maxFoodItems+5+1)/2)) {
		t.Errorf("lunch totals %v", get(data, "per_meal", "0", "totals", "kcal"))
	}
	if !hasFlag(out, "food_items_truncated") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
}

func TestNutritionDayNothingLogged(t *testing.T) {
	for name, c := range map[string]struct {
		skipped, other int
		hint           string
	}{
		"nothing":          {0, 0, "log"},
		"other source":     {0, 2, "another app"},
		"unreadable":       {1, 0, "could not be read"},
		"unreadable+other": {1, 2, "could not be read"},
	} {
		t.Run(name, func(t *testing.T) {
			h := nutritionHealth(t)
			h.nutrition, h.nutritionSkip, h.nutritionOther = nil, c.skipped, c.other
			te := coachSession(t, h, nutritionTarget).fails("nutrition_day", map[string]any{"date": string(closedDay)})
			if te.Code != coach.CodeNoData || !strings.Contains(te.Hint, c.hint) {
				t.Errorf("error %+v", te)
			}
		})
	}
}

func TestNutritionDayFlagsExcludedAndUnreadableRecords(t *testing.T) {
	for name, c := range map[string]struct {
		skipped, other int
		reason         string
	}{
		"both":         {1, 1, "other_source_food"},
		"other source": {0, 1, "other_source_food"},
		"unreadable":   {1, 0, "unreadable_food"},
	} {
		t.Run(name, func(t *testing.T) {
			h := nutritionHealth(t)
			h.nutritionSkip, h.nutritionOther = c.skipped, c.other
			out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
			// Food missing from the log would read as a deficit.
			data := out["data"]
			if get(data, "energy_balance", "balance_kcal") != nil || get(data, "energy_balance", "unavailable") != c.reason ||
				get(data, "targets", "kcal_delta") != nil || get(data, "targets", "kcal_delta_unavailable") != c.reason {
				t.Errorf("data %v %v", get(data, "energy_balance"), get(data, "targets"))
			}
			if hasFlag(out, "unreadable_records") != (c.skipped > 0) || hasFlag(out, "other_source_food_excluded") != (c.other > 0) {
				t.Errorf("flags %v", get(out, "quality_flags"))
			}
		})
	}
	h := nutritionHealth(t)
	var out map[string]any
	h = nutritionHealth(t)
	h.bodySkipped = 1
	out = coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	if !hasFlag(out, "unreadable_records") {
		t.Errorf("body skipped: flags %v", get(out, "quality_flags"))
	}
}

func TestNutritionDayInputAndErrors(t *testing.T) {
	c := coachSession(t, nutritionHealth(t), nutritionTarget)
	if te := c.fails("nutrition_day", map[string]any{"date": "2026-10-17"}); te.Code != coach.CodeInvalidInput {
		t.Errorf("future day %+v", te)
	}
	for _, method := range []string{"nutrition", "activity", "body"} {
		h := nutritionHealth(t)
		h.errs = map[string]error{method: errors.New("synthetic failure")}
		if te := coachSession(t, h, nutritionTarget).fails("nutrition_day", map[string]any{"date": string(closedDay)}); te.Code != coach.CodeInternal {
			t.Errorf("%s failure %+v", method, te)
		}
	}
	if te := coachSession(t, nutritionHealth(t), fakeTargets{err: errors.New("synthetic failure")}).
		fails("nutrition_day", map[string]any{"date": string(closedDay)}); te.Code != coach.CodeInternal {
		t.Errorf("targets failure %+v", te)
	}
}

func TestNutritionDayUnavailableReasonOrder(t *testing.T) {
	snacks := func(t *testing.T, kcal bool) healthdata.NutritionDay {
		second := map[string]float64{"protein_g": 10}
		if kcal {
			second["kcal"] = 250
		}
		return foodDay(t, closedDay,
			foodSpec{10, "SNACK", map[string]float64{"kcal": 300, "protein_g": 20}, nil},
			foodSpec{15, "SNACK", second, nil})
	}
	for name, c := range map[string]struct {
		kcalOnEveryItem bool
		activity        healthdata.ActivityDay
		other           int
		want            string
	}{
		"partial intake over not worn":       {false, healthdata.ActivityDay{TotalKcal: f64(1700)}, 0, "intake_partial"},
		"partial intake over incomplete log": {false, healthdata.ActivityDay{TotalKcal: f64(2600), Worn: true}, 0, "intake_partial"},
		"other source over not worn":         {true, healthdata.ActivityDay{TotalKcal: f64(1700)}, 1, "other_source_food"},
		"not worn over incomplete log":       {true, healthdata.ActivityDay{TotalKcal: f64(1700)}, 0, "band_not_worn"},
		"no burn over incomplete log":        {true, healthdata.ActivityDay{Worn: true}, 0, "no_total_calories"},
	} {
		t.Run(name, func(t *testing.T) {
			h := nutritionHealth(t)
			h.nutrition[closedDay] = snacks(t, c.kcalOnEveryItem)
			h.activity[closedDay], h.nutritionOther = c.activity, c.other
			out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
			if got := get(out, "data", "energy_balance", "unavailable"); got != c.want {
				t.Errorf("unavailable = %v, want %s", got, c.want)
			}
		})
	}
}

func TestNutritionDayWithoutTargetSmallLog(t *testing.T) {
	h := nutritionHealth(t)
	// One coffee logged as breakfast passes the main-meal check.
	h.nutrition[closedDay] = foodDay(t, closedDay, foodSpec{8, "BREAKFAST", map[string]float64{"kcal": 30, "protein_g": 1}, nil})
	out := coachSession(t, h, nil).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	data := out["data"]
	if get(data, "logging_completeness", "likely_incomplete") != true || get(data, "logging_completeness", "kcal_pct_of_target") != nil {
		t.Errorf("logging %v", get(data, "logging_completeness"))
	}
	if get(data, "energy_balance", "balance_kcal") != nil || get(data, "energy_balance", "unavailable") != "log_likely_incomplete" {
		t.Errorf("energy balance %v", get(data, "energy_balance"))
	}
	// Without a target there is no delta, so no reason for one either.
	if _, ok := get(data, "targets").(map[string]any)["kcal_delta_unavailable"]; ok {
		t.Errorf("targets %v", get(data, "targets"))
	}
	if !hasFlag(out, "likely_incomplete_nutrition") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
	// The full day stays complete without a target: 2200 of 2600 burned.
	out = coachSession(t, nutritionHealth(t), nil).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	if get(out, "data", "logging_completeness", "likely_incomplete") != false || get(out, "data", "energy_balance", "balance_kcal") != -400.0 {
		t.Errorf("full day %v", get(out, "data", "energy_balance"))
	}
}

func TestNutritionDayNoItemReportsProtein(t *testing.T) {
	h := nutritionHealth(t)
	h.nutrition[closedDay] = foodDay(t, closedDay,
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 1100}, nil},
		foodSpec{20, "DINNER", map[string]float64{"kcal": 1000}, nil})
	out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
	data := out["data"]
	if v, ok := get(data, "totals").(map[string]any)["protein_g"]; !ok || v != nil {
		t.Errorf("protein total %v", v)
	}
	tg := get(data, "targets")
	if get(tg, "protein_g_delta") != nil || get(tg, "protein_g_per_kg") != nil || get(tg, "protein_g_lower_bound") != false ||
		get(tg, "kcal_delta") != 100.0 {
		t.Errorf("targets %v", tg)
	}
	if !hasFlag(out, "partial_nutrient_totals") {
		t.Errorf("flags %v", get(out, "quality_flags"))
	}
}

func TestNutritionDayTargetHints(t *testing.T) {
	for name, c := range map[string]struct {
		target   store.Target
		has, not string
	}{
		"protein only": {store.Target{EffectiveFrom: "2026-10-01", ProteinG: ptr(150)}, "No kcal target", "protein"},
		"neither":      {store.Target{EffectiveFrom: "2026-10-01", WeeklySessions: ptr(4)}, "No kcal or protein target", ""},
	} {
		t.Run(name, func(t *testing.T) {
			out := coachSession(t, nutritionHealth(t), fakeTargets{versions: []store.Target{c.target}}).
				ok("nutrition_day", map[string]any{"date": string(closedDay)})
			tg := get(out, "data", "targets")
			hint, _ := get(tg, "target_hint").(string)
			if !strings.Contains(hint, c.has) || !strings.Contains(hint, "targets_set") || (c.not != "" && strings.Contains(hint, c.not)) {
				t.Errorf("hint %q", hint)
			}
			if get(tg, "kcal_target") != nil || get(tg, "kcal_delta") != nil || get(out, "data", "logging_completeness", "kcal_pct_of_target") != nil {
				t.Errorf("targets %v", tg)
			}
			if wantDelta := c.target.ProteinG != nil; (get(tg, "protein_g_delta") != nil) != wantDelta {
				t.Errorf("protein delta %v", get(tg, "protein_g_delta"))
			}
		})
	}
}

func TestNutritionDayRounding(t *testing.T) {
	h := nutritionHealth(t)
	h.nutrition[closedDay] = foodDay(t, closedDay,
		foodSpec{12, "LUNCH", map[string]float64{"kcal": 1100.04, "protein_g": 0.1}, nil},
		foodSpec{20, "DINNER", map[string]float64{"kcal": 1000.06, "protein_g": 0.2}, nil})
	h.activity[closedDay] = healthdata.ActivityDay{TotalKcal: f64(2626.4), Worn: true}
	h.weight = map[coach.LocalDate]healthdata.Reading{"2026-10-13": {Value: 80.04}}
	data := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})["data"]
	for path, want := range map[string]any{
		"totals.kcal.value":                       2100.1,
		"totals.protein_g.value":                  0.3,
		"per_meal.0.items.0.nutrients.kcal":       1100.0,
		"targets.kcal_delta":                      100.1,
		"targets.protein_g_delta":                 -149.7,
		"targets.weight_kg":                       80.0,
		"energy_balance.total_calories_kcal":      2650.0, // nearest 50
		"energy_balance.balance_kcal":             -550.0, // 2100.1 − 2626.4 = −526.3
		"logging_completeness.kcal_pct_of_target": 105.0,
	} {
		if got := get(data, strings.Split(path, ".")...); got != want {
			t.Errorf("%s = %v, want %v", path, got, want)
		}
	}
}

func TestNutritionDayItemTimeIsLocal(t *testing.T) {
	h := nutritionHealth(t)
	nd := fullDay(t, closedDay)
	nd.Items[1].At = nd.Items[1].At.UTC() // the API sends UTC instants
	h.nutrition[closedDay] = nd
	data := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})["data"]
	if got := get(data, "per_meal", "1", "items", "0", "time"); got != "2026-10-14T12:00:00-03:00" {
		t.Errorf("time %v", got)
	}
}

func TestNutritionDayMealTypeSpelling(t *testing.T) {
	h := nutritionHealth(t)
	h.nutrition[closedDay] = foodDay(t, closedDay,
		foodSpec{8, "lunch", map[string]float64{"kcal": 100}, nil},
		foodSpec{9, " LUNCH ", map[string]float64{"kcal": 100}, nil},
		foodSpec{10, "Late snack", map[string]float64{"kcal": 100}, nil},
		foodSpec{11, "LATE-SNACK", map[string]float64{"kcal": 100}, nil},
		foodSpec{12, "ZZZ", map[string]float64{"kcal": 100}, nil},
		foodSpec{13, "  ", map[string]float64{"kcal": 100}, nil},
	)
	data := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})["data"]
	var meals []string
	for _, m := range get(data, "per_meal").([]any) {
		meals = append(meals, fmt.Sprint(get(m, "meal_type"), "x", len(get(m, "items").([]any))))
	}
	if fmt.Sprint(meals) != "[LUNCHx2 LATE_SNACKx2 ZZZx1 UNSPECIFIEDx1]" {
		t.Errorf("meals %v", meals)
	}
}

func TestPerNutrientHasEveryNutrient(t *testing.T) {
	seen := map[*int]bool{}
	var p PerNutrient[int]
	for _, k := range healthdata.Nutrients {
		f := p.field(k)
		if f == nil || seen[f] {
			t.Errorf("nutrient %s has no slot of its own", k)
		}
		seen[f] = true
	}
	if p.field("alcohol_g") != nil {
		t.Error("unknown nutrient has a slot")
	}
}

func TestNutritionDayStaleWeight(t *testing.T) {
	for _, c := range []struct {
		weighed coach.LocalDate
		age     float64
		stale   bool
	}{{"2026-09-30", 14, false}, {"2026-09-29", 15, true}} {
		h := nutritionHealth(t)
		h.weight = map[coach.LocalDate]healthdata.Reading{c.weighed: {Value: 80}}
		out := coachSession(t, h, nutritionTarget).ok("nutrition_day", map[string]any{"date": string(closedDay)})
		if get(out, "data", "targets", "weight_age_days") != c.age || hasFlag(out, "stale_weight") != c.stale {
			t.Errorf("weighed %s: targets %v flags %v", c.weighed, get(out, "data", "targets"), get(out, "quality_flags"))
		}
	}
}
