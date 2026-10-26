package tools

import (
	"context"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// maxSeriesPoints caps one series response.
const maxSeriesPoints = 180

// seriesUnits maps each metric_series metric to its unit; the keys are the
// closed list the input schema accepts.
var seriesUnits = map[string]string{
	"weight": "kg", "resting_hr": "bpm", "hrv": "ms", "sleep_asleep_min": "min", "steps": "steps", "azm": "min",
	"kcal_in": "kcal", "protein_g": "g", "total_calories": "kcal",
}

// seriesMetrics is seriesUnits' keys in a fixed order, for the schema enum.
var seriesMetrics = []string{
	"weight", "resting_hr", "hrv", "sleep_asleep_min", "steps", "azm", "kcal_in", "protein_g", "total_calories",
}

// reasonMissingProtein: some items do not report protein, so the total is a
// lower bound.
const reasonMissingProtein = "items_missing_protein"

// seriesNotice travels in every series (R3).
const seriesNotice = "Values compare the user with their own history; a series is not a diagnosis. A week point is " +
	"the mean of the days with a value (n_days). Weight swings from day to day with water and food: read the trend " +
	"over weeks, not single days. Do not encourage losing weight faster than about 1% of body weight per week or " +
	"eating far below the targets. If weight falls fast without trying, intake stays very low, or resting heart rate " +
	"stays up for days, suggest seeing a doctor (a registered dietitian for eating)."

// RegisterSeries adds metric_series (CAPABILITY §4.1).
func RegisterSeries(s *mcp.Server, d CoachDeps) {
	Register(s, &mcp.Tool{
		Name: "metric_series",
		Description: "Daily or weekly values of one metric over [from, to] (at most 366 days, at most 180 points), " +
			"for questions the coach-moment tools do not answer. A day without a value is null, never 0. Today is left " +
			"out of steps, AZM, total calories and food while its totals still grow, nights Google is still processing " +
			"are left out of HRV and sleep, and resting heart rate keeps the band's standard method only. Days follow " +
			"nutrition_day's rule: kcal_in is null on a day whose log cannot show the intake (an item lacks kcal, food " +
			"from another platform or unreadable, the log looks incomplete) and total_calories is null on a day without " +
			"the band; the point's reason says why. protein_g keeps a total that may miss food with complete=false (a " +
			"lower bound) and the reason. Weeks are ISO weeks (Monday first); a week point is the mean of its days " +
			"with a value, and days_left_out counts the days withheld for a reason. Never raw heart-rate samples.",
		InputSchema: MustInputSchema[seriesIn](map[string][]string{"metric": seriesMetrics, "granularity": {"day", "week"}}),
		Annotations: readOnly,
	}, series{d}.handle)
}

type seriesIn struct {
	Metric      string          `json:"metric" jsonschema:"the metric"`
	From        coach.LocalDate `json:"from" jsonschema:"first local day (YYYY-MM-DD)"`
	To          coach.LocalDate `json:"to" jsonschema:"last local day (YYYY-MM-DD), today at the latest"`
	Granularity string          `json:"granularity,omitempty" jsonschema:"day (default) or week"`
}

// MetricSeries is metric_series' data.
type MetricSeries struct {
	Metric      string          `json:"metric"`
	Unit        string          `json:"unit"`
	Granularity string          `json:"granularity"`
	From        coach.LocalDate `json:"from"`
	To          coach.LocalDate `json:"to"`
	Points      []SeriesPoint   `json:"points"`
	Notice      string          `json:"notice"`
}

// SeriesPoint is one day, or one week from its Monday.
type SeriesPoint struct {
	Date  coach.LocalDate `json:"date"`
	Value *float64        `json:"value"`
	// NDays counts the days behind Value.
	NDays int `json:"n_days"`
	// Complete is false when Value rests on a protein total that may miss
	// food, so it is a lower bound.
	Complete bool `json:"complete"`
	// Reason says why a day's value is null or a lower bound.
	Reason string `json:"reason,omitempty"`
	// DaysLeftOut counts the days of a week point withheld for a reason.
	DaysLeftOut int `json:"days_left_out,omitempty"`
}

type series struct{ CoachDeps }

func (s series) handle(ctx context.Context, _ *mcp.CallToolRequest, in seriesIn) (coach.Envelope[MetricSeries], error) {
	var zero coach.Envelope[MetricSeries]
	unit, ok := seriesUnits[in.Metric]
	if !ok {
		return zero, invalidSeries("unknown metric", "pick one of the listed metrics")
	}
	if in.From == "" || in.To == "" {
		return zero, invalidSeries("from and to are required", "")
	}
	to, err := s.day(in.To)
	if err != nil {
		return zero, err
	}
	if in.From > to {
		return zero, invalidSeries("from is after to", "")
	}
	days, err := daysBetween(in.From, to)
	if err != nil {
		return zero, err
	}
	if days > healthdata.MaxRangeDays {
		return zero, invalidSeries(fmt.Sprintf("a range spans at most %d days", healthdata.MaxRangeDays), "split it in two calls")
	}
	gran := in.Granularity
	if gran == "" {
		gran = "day"
	}
	n := days
	if gran == "week" {
		if n, err = weeksBetween(in.From, to); err != nil {
			return zero, err
		}
	}
	if n > maxSeriesPoints {
		return zero, invalidSeries(fmt.Sprintf("the series would have %d points, more than %d", n, maxSeriesPoints),
			"use granularity week or a shorter range")
	}

	var flags flagSet
	sources := sourceSet{}
	ds, err := s.daily(ctx, in.Metric, in.From, to, &flags, sources)
	if err != nil {
		return zero, err
	}
	out := MetricSeries{Metric: in.Metric, Unit: unit, Granularity: gran, From: in.From, To: to, Notice: seriesNotice}
	if gran == "week" {
		if out.Points, err = byWeek(ds); err != nil {
			return zero, err
		}
	} else {
		out.Points = make([]SeriesPoint, len(ds.pts))
		for i, p := range ds.pts {
			out.Points[i] = SeriesPoint{Date: p.Date, Value: round(p.Value), Complete: !ds.lower[p.Date], Reason: ds.reason[p.Date]}
			if p.Value != nil {
				out.Points[i].NDays = 1
			}
		}
	}
	covered := 0
	for _, p := range ds.pts {
		if p.Value != nil {
			covered++
		}
	}
	return coach.NewEnvelope(out, covered, sources.list(), flags, s.Now()), nil
}

func invalidSeries(msg, hint string) coach.ToolError {
	return coach.ToolError{Code: coach.CodeInvalidInput, Message: msg, Hint: hint}
}

// weeksBetween counts the ISO weeks [from, to] touches.
func weeksBetween(from, to coach.LocalDate) (int, error) {
	first, err := isoWeekStart(from)
	if err != nil {
		return 0, err
	}
	last, err := isoWeekStart(to)
	if err != nil {
		return 0, err
	}
	span, err := daysBetween(first, last)
	return (span-1)/7 + 1, err
}

// dailySeries is one point per day of a range, the days whose value is a
// lower bound, and why a day's value is null or a lower bound.
type dailySeries struct {
	pts    []metrics.Point
	lower  map[coach.LocalDate]bool
	reason map[coach.LocalDate]string
}

func plain(pts []metrics.Point) dailySeries {
	return dailySeries{pts: pts, lower: map[coach.LocalDate]bool{}, reason: map[coach.LocalDate]string{}}
}

// daily reads one point per day of [from, to].
func (s series) daily(ctx context.Context, metric string, from, to coach.LocalDate, flags *flagSet, sources sourceSet) (
	dailySeries, error) {
	switch metric {
	case "weight":
		b, err := s.Health.Body(ctx, from, to)
		if err != nil {
			return dailySeries{}, err
		}
		for _, r := range b.Weight {
			sources.add(r.Source)
		}
		flags.add(flagUnreadableRecords, b.Skipped > 0)
		pts, err := b.Series(healthdata.KeyWeight)
		return plain(pts), err
	case "resting_hr", "hrv", "sleep_asleep_min":
		rec, err := s.Health.Recovery(ctx, from, to)
		if err != nil {
			return dailySeries{}, err
		}
		sources.add(rec.Sources...)
		if metric != "resting_hr" {
			for _, n := range rec.Nights {
				flags.add(flagProvisionalSleep, n.Provisional)
			}
		}
		flags.add(flagUnreadableRecords, rec.Skipped > 0)
		key := map[string]healthdata.RecoveryKey{"resting_hr": healthdata.KeyRestingHR, "hrv": healthdata.KeyHRV,
			"sleep_asleep_min": healthdata.KeyAsleep}[metric]
		pts, err := rec.BaselineSeries(key)
		return plain(pts), err
	case "steps", "azm", "total_calories":
		act, err := s.Health.Activity(ctx, from, to)
		if err != nil {
			return dailySeries{}, err
		}
		today := s.today()
		flags.add(metrics.FlagPartialDay, to >= today)
		flags.add(flagUnreadableRecords, act.Skipped > 0)
		key := map[string]healthdata.ActivityKey{"steps": healthdata.KeySteps, "azm": healthdata.KeyAZM,
			"total_calories": healthdata.KeyTotalCalories}[metric]
		pts, err := act.BaselineSeries(key)
		if err != nil {
			return dailySeries{}, err
		}
		ds := plain(pts)
		for i, p := range ds.pts {
			switch a, ok := act.Days[p.Date]; {
			case p.Value == nil && p.Date >= today:
				ds.reason[p.Date] = reasonPartialDay
			case metric == "total_calories" && p.Value != nil && ok && !a.Worn:
				// Without the band the day's total is mostly a resting estimate.
				ds.pts[i].Value, ds.reason[p.Date] = nil, reasonNotWorn
				flags.add(flagNotWorn, true)
			}
		}
		return ds, nil
	default: // kcal_in, protein_g
		food, err := s.Health.Nutrition(ctx, from, to)
		if err != nil {
			return dailySeries{}, err
		}
		flags.add(metrics.FlagPartialDay, to >= s.today())
		flags.add(flagOtherSourceFood, food.OtherSource > 0)
		flags.add(flagUnreadableRecords, food.Skipped > 0)
		return s.food(ctx, metric, food, from, to, flags, sources)
	}
}

// food judges each logged day with nutrition_day's rule (checkFood). The
// calories burned are read only when a logged day has no kcal target, since
// only then does the log check need them.
func (s series) food(ctx context.Context, metric string, food healthdata.Nutrition, from, to coach.LocalDate,
	flags *flagSet, sources sourceSet) (dailySeries, error) {
	targets := map[coach.LocalDate]*store.Target{}
	needBurn := false
	for d, nd := range food.Days {
		if d < from || d > to || len(nd.Items) == 0 {
			continue
		}
		t, err := s.target(ctx, d)
		if err != nil {
			return dailySeries{}, err
		}
		targets[d] = t
		needBurn = needBurn || t == nil || t.Kcal == nil
		for _, it := range nd.Items {
			sources.add(it.Source)
		}
	}
	var act healthdata.Activity
	if needBurn {
		var err error
		if act, err = s.Health.Activity(ctx, from, to); err != nil {
			return dailySeries{}, err
		}
	}
	today := s.today()
	ds := plain(nil)
	for d := from; d <= to; {
		p := metrics.Point{Date: d}
		if nd, ok := food.Days[d]; ok && len(nd.Items) > 0 {
			var burned *float64
			if a, ok := act.Days[d]; ok && a.Worn {
				burned = a.TotalKcal
			}
			other := food.OtherSourceDays[d]
			fc := checkFood(nd.Items, other, food.Skipped, targets[d], burned, nd.Partial || d >= today)
			switch {
			case metric == "kcal_in":
				if gap := fc.kcalGap(); gap != "" {
					ds.reason[d] = gap
				} else {
					p.Value = fc.kcal
				}
			case fc.dayGap == reasonPartialDay:
				ds.reason[d] = reasonPartialDay
			case fc.protein != nil:
				p.Value = fc.protein
				var missing, otherFood, unreadable string
				if !fc.proteinComplete {
					missing = reasonMissingProtein
				}
				if other > 0 {
					otherFood = reasonOtherSource
				}
				if food.Skipped > 0 {
					unreadable = reasonUnreadableFood
				}
				if r := firstOf(missing, otherFood, unreadable, fc.dayGap); r != "" {
					ds.lower[d], ds.reason[d] = true, r
				}
				flags.add(flagPartialNutrientTotals, !fc.proteinComplete)
			}
		}
		ds.pts = append(ds.pts, p)
		next, err := d.AddDays(1)
		if err != nil {
			return dailySeries{}, err
		}
		d = next
	}
	return ds, nil
}

// byWeek averages the days of each ISO week.
func byWeek(ds dailySeries) ([]SeriesPoint, error) {
	var out []SeriesPoint
	var sums []float64
	for _, p := range ds.pts {
		start, err := isoWeekStart(p.Date)
		if err != nil {
			return nil, err
		}
		if len(out) == 0 || out[len(out)-1].Date != start {
			out, sums = append(out, SeriesPoint{Date: start, Complete: true}), append(sums, 0)
		}
		w := &out[len(out)-1]
		switch {
		case p.Value != nil:
			sums[len(sums)-1] += *p.Value
			w.NDays++
			w.Complete = w.Complete && !ds.lower[p.Date]
		case ds.reason[p.Date] != "":
			w.DaysLeftOut++
		}
	}
	for i := range out {
		if out[i].NDays > 0 {
			out[i].Value = round(ptr(sums[i] / float64(out[i].NDays)))
		}
	}
	return out, nil
}
