package healthdata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
)

// Nutrient keys, in the coach's units (CAPABILITY I5).
const (
	NutrientKcal    = "kcal"
	NutrientProtein = "protein_g"
	NutrientCarb    = "carb_g"
	NutrientFat     = "fat_g"
	NutrientFiber   = "fiber_g"
	NutrientSugar   = "sugar_g"
	NutrientSodium  = "sodium_mg"
)

// Nutrients lists the nutrient keys in report order.
var Nutrients = []string{NutrientKcal, NutrientProtein, NutrientCarb, NutrientFat, NutrientFiber, NutrientSugar, NutrientSodium}

// FoodItem is one logged food.
type FoodItem struct {
	ID   string
	Name string
	Meal string // BREAKFAST, LUNCH, DINNER or SNACK
	At   time.Time
	// Source labels the device or platform that logged it.
	Source string
	// Nutrients holds only what the item reports: a nutrient left out is
	// unknown, not zero.
	Nutrients map[string]float64
	// Rejected lists nutrients the item reported with an implausible value
	// or twice; they count as unknown, and the rest of the item is kept.
	Rejected []string
}

// Total is a day's sum of one nutrient over the items that report it.
type Total struct {
	Value float64
	Items int // items that report it; fewer than the day's items is a partial total
}

// NutritionDay is one local day's food log.
type NutritionDay struct {
	Items  []FoodItem // in time order
	Totals map[string]Total
	// Rejected counts nutrient values dropped from the day's items.
	Rejected int
	// Partial: today, so the log can still grow. Baselines leave it out.
	Partial bool
}

// Complete reports whether every item of the day reports the nutrient.
func (n NutritionDay) Complete(nutrient string) bool {
	return len(n.Items) > 0 && n.Totals[nutrient].Items == len(n.Items)
}

// Nutrition holds the logged days of [From, To]; a day without items is absent.
type Nutrition struct {
	From, To coach.LocalDate
	Days     map[coach.LocalDate]NutritionDay
	// Skipped counts unreadable records; their day is unknown.
	Skipped     int
	OtherSource int
	// OtherSourceDays counts per day the records left out for coming from
	// another platform, so a day's intake can be known to miss food.
	OtherSourceDays map[coach.LocalDate]int
}

// Series returns one point per day with the day's total of nutrient, nil on a
// day without a log or where an item does not report it: a partial total
// would read as a low day (a missed protein target) in adherence and trends.
// Tools show a day's partial totals from Days.
func (n Nutrition) Series(nutrient string) ([]metrics.Point, error) { return n.series(nutrient, false) }

// BaselineSeries is Series without partial days.
func (n Nutrition) BaselineSeries(nutrient string) ([]metrics.Point, error) {
	return n.series(nutrient, true)
}

func (n Nutrition) series(nutrient string, baseline bool) ([]metrics.Point, error) {
	if !slices.Contains(Nutrients, nutrient) {
		return nil, fmt.Errorf("healthdata: no nutrient %q", nutrient)
	}
	return points(n.From, n.To, func(day coach.LocalDate) *float64 {
		v, ok := n.Days[day]
		if !ok || (baseline && v.Partial) {
			return nil
		}
		if v.Complete(nutrient) {
			return ptr(v.Totals[nutrient].Value)
		}
		return nil
	})
}

// Nutrition returns the food log of [from, to]. The log is entered by hand
// and edited for days after the fact, so it is never cached.
func (d *Data) Nutrition(ctx context.Context, from, to coach.LocalDate) (Nutrition, error) {
	if _, err := dayList(from, to); err != nil {
		return Nutrition{}, err
	}
	// A day of margin: the API filters on the device's local start time.
	before, err := from.AddDays(-1)
	if err != nil {
		return Nutrition{}, err
	}
	after, err := to.AddDays(1)
	if err != nil {
		return Nutrition{}, err
	}
	raws, err := d.api.List(ctx, googlehealth.NutritionLog, before, after)
	if err != nil {
		return Nutrition{}, err
	}
	today := coach.Today(d.now(), d.loc)
	out := Nutrition{From: from, To: to, Days: map[coach.LocalDate]NutritionDay{}, OtherSourceDays: map[coach.LocalDate]int{}}
	for _, raw := range raws {
		item, err := parseFood(raw)
		if item.At.IsZero() {
			out.Skipped++
			continue
		}
		day := coach.DateOf(item.At, d.loc)
		if day < from || day > to {
			continue
		}
		switch {
		case errors.Is(err, errOtherSource):
			out.OtherSource++
			out.OtherSourceDays[day]++
			continue
		case err != nil:
			out.Skipped++
			continue
		}
		nd := out.Days[day]
		if nd.Totals == nil {
			nd.Totals, nd.Partial = map[string]Total{}, day >= today
		}
		nd.Items = append(nd.Items, item)
		nd.Rejected += len(item.Rejected)
		for k, v := range item.Nutrients {
			t := nd.Totals[k]
			t.Value += v
			t.Items++
			nd.Totals[k] = t
		}
		out.Days[day] = nd
	}
	for day, nd := range out.Days {
		slices.SortStableFunc(nd.Items, func(a, b FoodItem) int { return a.At.Compare(b.At) })
		out.Days[day] = nd
	}
	if out.Skipped > 0 {
		d.log.Warn("unreadable nutrition records", "from", string(from), "to", string(to), "skipped", out.Skipped)
	}
	return out, nil
}

const (
	maxItemKcal   = 10_000
	maxItemGrams  = 2_000
	maxItemSodium = 20_000 // mg: 50 g of salt in one item
)

type grams struct {
	Grams *float64 `json:"grams"`
}

type foodRecord struct {
	Name         string     `json:"name"`
	DataSource   dataSource `json:"dataSource"`
	NutritionLog *struct {
		FoodDisplayName string `json:"foodDisplayName"`
		MealType        string `json:"mealType"`
		Interval        struct {
			StartTime time.Time `json:"startTime"`
		} `json:"interval"`
		Energy *struct {
			Kcal *float64 `json:"kcal"`
		} `json:"energy"`
		TotalCarbohydrate *grams `json:"totalCarbohydrate"`
		TotalFat          *grams `json:"totalFat"`
		Nutrients         []struct {
			Nutrient string `json:"nutrient"`
			Quantity grams  `json:"quantity"`
		} `json:"nutrients"`
	} `json:"nutritionLog"`
}

// fromList maps the per-item nutrient list to the coach's keys and the
// factor from grams. Carbohydrates and fat come from the item's own total
// fields; the list's CARBOHYDRATES entry repeats them and fat subtypes
// (saturated, mono, poly) are part of the total, so neither is added.
var fromList = map[string]struct {
	key    string
	factor float64
}{
	"PROTEIN":       {NutrientProtein, 1},
	"DIETARY_FIBER": {NutrientFiber, 1},
	"SUGAR":         {NutrientSugar, 1},
	"SODIUM":        {NutrientSodium, 1000},
}

// parseFood decodes one item; errors as parseSleep, with item.At set when the
// time was readable. An implausible or repeated nutrient is rejected alone:
// dropping the whole item would take its calories out of a day that would
// still look complete.
func parseFood(raw json.RawMessage) (item FoodItem, err error) {
	var r foodRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return FoodItem{}, errors.New("unreadable nutrition record")
	}
	n := r.NutritionLog
	if n == nil || n.Interval.StartTime.IsZero() {
		return FoodItem{}, errors.New("nutrition record without a time")
	}
	item.At = n.Interval.StartTime
	if r.DataSource.Platform != primaryPlatform {
		return item, errOtherSource
	}
	item.Name, item.Meal, item.Source = clean(n.FoodDisplayName), clean(n.MealType), r.DataSource.label()
	if resourceName.MatchString(r.Name) {
		item.ID = r.Name
	}
	item.Nutrients = map[string]float64{}
	rejected := map[string]bool{}
	set := func(key string, v float64, hi float64) {
		_, dup := item.Nutrients[key]
		if rejected[key] || dup || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > hi {
			delete(item.Nutrients, key)
			rejected[key] = true
			return
		}
		item.Nutrients[key] = v
	}
	// Proto3 leaves out a zero inside a present field: kcal 0 is "0 kcal".
	if n.Energy != nil {
		set(NutrientKcal, deref(n.Energy.Kcal), maxItemKcal)
	}
	if n.TotalCarbohydrate != nil {
		set(NutrientCarb, deref(n.TotalCarbohydrate.Grams), maxItemGrams)
	}
	if n.TotalFat != nil {
		set(NutrientFat, deref(n.TotalFat.Grams), maxItemGrams)
	}
	for _, x := range n.Nutrients {
		m, ok := fromList[x.Nutrient]
		if !ok {
			continue
		}
		hi := float64(maxItemGrams)
		if m.key == NutrientSodium {
			hi = maxItemSodium
		}
		set(m.key, deref(x.Quantity.Grams)*m.factor, hi)
	}
	for _, k := range Nutrients {
		if rejected[k] {
			item.Rejected = append(item.Rejected, k)
		}
	}
	return item, nil
}

func deref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
