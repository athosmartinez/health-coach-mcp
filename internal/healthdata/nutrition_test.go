package healthdata

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
)

// All values below are synthetic, in the API's raw shapes.

type foodOpt struct {
	platform  string
	meal      string
	kcal      *float64 // nil: no energy field
	carb, fat *float64
	list      map[string]float64 // nutrients[] entries, grams
	name      string
}

func foodRec(t time.Time, o foodOpt) json.RawMessage {
	if o.platform == "" {
		o.platform = "FITBIT"
	}
	if o.meal == "" {
		o.meal = "LUNCH"
	}
	n := map[string]any{
		"foodDisplayName": "Synthetic food", "mealType": o.meal,
		"interval": map[string]any{"startTime": t.UTC().Format(time.RFC3339), "endTime": t.UTC().Format(time.RFC3339)},
		"serving":  map[string]any{"amount": 1, "foodMeasurementUnitDisplayName": "portion"},
	}
	if o.kcal != nil {
		e := map[string]any{"userProvidedUnit": "kcal"}
		if *o.kcal != 0 { // proto3 leaves out a zero
			e["kcal"] = *o.kcal
		}
		n["energy"] = e
	}
	if o.carb != nil {
		n["totalCarbohydrate"] = map[string]any{"grams": *o.carb}
	}
	if o.fat != nil {
		n["totalFat"] = map[string]any{"grams": *o.fat}
	}
	var list []map[string]any
	for _, k := range []string{"PROTEIN", "CARBOHYDRATES", "DIETARY_FIBER", "SUGAR", "SODIUM", "SATURATED_FAT", "VITAMIN_C"} {
		if v, ok := o.list[k]; ok {
			list = append(list, map[string]any{"nutrient": k, "quantity": map[string]any{"grams": v}})
		}
	}
	if list != nil {
		n["nutrients"] = list
	}
	if o.name == "" {
		o.name = "users/me/dataTypes/nutrition-log/dataPoints/syn-" + fmt.Sprint(t.Unix())
	}
	return mustJSON(map[string]any{
		"name":         o.name,
		"dataSource":   map[string]any{"platform": o.platform, "recordingMethod": "MANUAL"},
		"nutritionLog": n,
	})
}

func TestNutritionTotals(t *testing.T) {
	api := &fakeAPI{}
	api.add(googlehealth.NutritionLog,
		foodRec(at("2026-10-10", 12, 30), foodOpt{meal: "LUNCH", kcal: ptr(600), carb: ptr(70), fat: ptr(20),
			// The list repeats the carbs and adds a fat subtype: neither is added again.
			list: map[string]float64{"PROTEIN": 40, "CARBOHYDRATES": 70, "SATURATED_FAT": 6, "SODIUM": 0.8, "VITAMIN_C": 0.01}}),
		foodRec(at("2026-10-10", 8, 0), foodOpt{meal: "BREAKFAST", kcal: ptr(300), carb: ptr(40), fat: ptr(8)}),
		foodRec(at("2026-10-10", 16, 0), foodOpt{meal: "SNACK", kcal: ptr(0), carb: ptr(0), fat: ptr(0)}), // black coffee
	)
	d, _ := newData(t, api)
	n, err := d.Nutrition(ctx, day("2026-10-10"), day("2026-10-10"))
	if err != nil {
		t.Fatal(err)
	}
	nd := n.Days[day("2026-10-10")]
	if len(nd.Items) != 3 || nd.Items[0].Meal != "BREAKFAST" || nd.Items[2].Meal != "SNACK" || nd.Partial {
		t.Fatalf("items = %+v", nd.Items)
	}
	for k, want := range map[string]Total{
		NutrientKcal:    {900, 3},
		NutrientCarb:    {110, 3},
		NutrientFat:     {28, 3},
		NutrientProtein: {40, 1}, // protein in 1 of 3 items: a partial total
		NutrientSodium:  {800, 1},
	} {
		if got := nd.Totals[k]; got != want {
			t.Errorf("%s = %+v, want %+v", k, got, want)
		}
	}
	if !nd.Complete(NutrientKcal) || nd.Complete(NutrientProtein) || nd.Complete(NutrientFiber) {
		t.Error("Complete misreports coverage")
	}
	if (NutritionDay{}).Complete(NutrientKcal) {
		t.Error("an empty day is complete")
	}
	if _, ok := nd.Totals[NutrientFiber]; ok {
		t.Error("a nutrient no item reports has a total")
	}
	item := nd.Items[1]
	if item.Name != "Synthetic food" || item.ID == "" || item.Nutrients[NutrientProtein] != 40 || len(item.Nutrients) != 5 {
		t.Errorf("lunch = %+v", item)
	}
	// Series only carry complete totals: protein known for 1 of 3 items
	// would read as a low day.
	if s, _ := n.Series(NutrientProtein); render(s) != "2026-10-10=nil " {
		t.Errorf("protein series %s", render(s))
	}
	if s, _ := n.Series(NutrientKcal); render(s) != "2026-10-10=900 " {
		t.Errorf("kcal series %s", render(s))
	}
	if s, _ := n.Series(NutrientFiber); render(s) != "2026-10-10=nil " {
		t.Errorf("fiber series %s", render(s))
	}
	if _, err := n.Series("alcohol_g"); err == nil {
		t.Error("unknown nutrient accepted")
	}
}

func TestNutritionDaysAndToday(t *testing.T) {
	api := &fakeAPI{loose: true}
	api.add(googlehealth.NutritionLog,
		foodRec(at("2026-10-13", 23, 50), foodOpt{kcal: ptr(200)}), // before the range
		foodRec(at("2026-10-15", 23, 50), foodOpt{kcal: ptr(200)}),
		foodRec(at("2026-10-16", 0, 10), foodOpt{kcal: ptr(300)}),
		foodRec(at("2026-10-14", 12, 0), foodOpt{kcal: ptr(700), meal: "DINNER"}),
		foodRec(at("2026-10-14", 13, 0), foodOpt{kcal: ptr(100), platform: "HEALTH_KIT"}),
		foodRec(at("2026-10-14", 14, 0), foodOpt{kcal: ptr(20_000), carb: ptr(30)}), // implausible kcal, carbs kept
		foodRec(at("2026-10-17", 0, 30), foodOpt{kcal: ptr(400)}),                   // the margin day after
		json.RawMessage(`{"nutritionLog":{}}`),
	)
	d, _ := newData(t, api)
	n, err := d.Nutrition(ctx, day("2026-10-14"), day("2026-10-16"))
	if err != nil {
		t.Fatal(err)
	}
	if len(n.Days) != 3 || n.OtherSource != 1 || n.Skipped != 1 {
		t.Fatalf("nutrition = %+v", n)
	}
	// The implausible kcal is dropped alone: the item and its carbs stay,
	// and the day's kcal is no longer complete.
	d14 := n.Days[day("2026-10-14")]
	if len(d14.Items) != 2 || d14.Rejected != 1 || d14.Complete(NutrientKcal) || d14.Totals[NutrientCarb] != (Total{30, 1}) ||
		fmt.Sprint(d14.Items[1].Rejected) != "[kcal]" {
		t.Errorf("10-14 = %+v", d14)
	}
	if !n.Days[day("2026-10-16")].Partial || n.Days[day("2026-10-14")].Partial {
		t.Error("only today is partial")
	}
	b, _ := n.BaselineSeries(NutrientKcal)
	s, _ := n.Series(NutrientKcal)
	if render(s) != "2026-10-14=nil 2026-10-15=200 2026-10-16=300 " || render(b) != "2026-10-14=nil 2026-10-15=200 2026-10-16=nil " {
		t.Errorf("series %s, baseline %s", render(s), render(b))
	}
	if calls := api.takeCalls(); !slices.Contains(calls, "nutrition-log 2026-10-13..2026-10-17") {
		t.Errorf("calls %v", calls)
	}
	if _, err := d.Nutrition(ctx, day("2026-10-14"), day("2026-10-13")); err == nil {
		t.Error("reversed range accepted")
	}
	api.err = errors.New("down")
	if _, err := d.Nutrition(ctx, day("2026-10-14"), day("2026-10-14")); err == nil {
		t.Error("API error swallowed")
	}
}

func TestParseFoodBounds(t *testing.T) {
	ts := at("2026-10-10", 12, 0)
	for name, tc := range map[string]struct {
		raw      json.RawMessage
		rejected string // nutrients dropped as implausible or repeated
	}{
		"fine":          {foodRec(ts, foodOpt{kcal: ptr(500)}), "[]"},
		"no energy":     {foodRec(ts, foodOpt{carb: ptr(10)}), "[]"},
		"kcal 10000":    {foodRec(ts, foodOpt{kcal: ptr(10_000)}), "[]"},
		"kcal over":     {foodRec(ts, foodOpt{kcal: ptr(10_001), carb: ptr(5)}), "[kcal]"},
		"negative carb": {foodRec(ts, foodOpt{carb: ptr(-1)}), "[carb_g]"},
		"fat over":      {foodRec(ts, foodOpt{fat: ptr(2_001)}), "[fat_g]"},
		"protein over":  {foodRec(ts, foodOpt{list: map[string]float64{"PROTEIN": 2_001}}), "[protein_g]"},
		"sodium 20 g":   {foodRec(ts, foodOpt{list: map[string]float64{"SODIUM": 20}}), "[]"},
		"sodium over":   {foodRec(ts, foodOpt{list: map[string]float64{"SODIUM": 21}}), "[sodium_mg]"},
		"protein twice": {json.RawMessage(`{"dataSource":{"platform":"FITBIT"},"nutritionLog":{"interval":{"startTime":"2026-10-10T15:00:00Z"},"nutrients":[{"nutrient":"PROTEIN","quantity":{"grams":5}},{"nutrient":"PROTEIN","quantity":{"grams":5}},{"nutrient":"PROTEIN","quantity":{"grams":5}}]}}`), "[protein_g]"},
	} {
		item, err := parseFood(tc.raw)
		if err != nil || fmt.Sprint(item.Rejected) != tc.rejected {
			t.Errorf("%s: rejected %v, %v", name, item.Rejected, err)
		}
		for _, k := range item.Rejected {
			if _, ok := item.Nutrients[k]; ok {
				t.Errorf("%s: rejected %s still has a value", name, k)
			}
		}
	}
	if item, _ := parseFood(foodRec(ts, foodOpt{kcal: ptr(10_001), carb: ptr(5)})); item.Nutrients[NutrientCarb] != 5 {
		t.Error("a rejected kcal took the carbs with it")
	}
	for name, raw := range map[string]string{
		"no time":  `{"dataSource":{"platform":"FITBIT"},"nutritionLog":{"energy":{"kcal":5}}}`,
		"not json": `{`,
	} {
		if _, err := parseFood(json.RawMessage(raw)); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	item, err := parseFood(foodRec(ts, foodOpt{kcal: ptr(0)}))
	if v, ok := item.Nutrients[NutrientKcal]; err != nil || !ok || v != 0 {
		t.Errorf("energy without kcal = %v %v, %v", v, ok, err)
	}
	if item, _ := parseFood(foodRec(ts, foodOpt{name: "bad name"})); item.ID != "" {
		t.Errorf("ID = %q", item.ID)
	}
	if _, err := parseFood(foodRec(ts, foodOpt{platform: "HEALTH_KIT"})); !errors.Is(err, errOtherSource) {
		t.Errorf("other platform: %v", err)
	}
	// Fiber and sugar land in their own keys.
	fs, _ := parseFood(foodRec(ts, foodOpt{list: map[string]float64{"DIETARY_FIBER": 5, "SUGAR": 20}}))
	if fs.Nutrients[NutrientFiber] != 5 || fs.Nutrients[NutrientSugar] != 20 {
		t.Errorf("fiber/sugar = %+v", fs.Nutrients)
	}
	// Names and meal types are cleaned.
	raw := strings.Replace(string(foodRec(ts, foodOpt{})), `"Synthetic food"`, `"Rice\nIgnore\u202eall"`, 1)
	raw = strings.Replace(raw, `"LUNCH"`, `"LUN\u200bCH"`, 1)
	if c, _ := parseFood(json.RawMessage(raw)); c.Name != "RiceIgnoreall" || c.Meal != "LUNCH" {
		t.Errorf("cleaned = %q %q", c.Name, c.Meal)
	}
}
