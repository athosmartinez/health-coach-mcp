package tools

import (
	"context"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
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

const seriesNotice = "Values compare the user with their own history; a series is not a diagnosis. A week point is " +
	"the mean of the days with a value (n_days)."

// RegisterSeries adds metric_series (CAPABILITY §4.1).
func RegisterSeries(s *mcp.Server, d CoachDeps) {
	Register(s, &mcp.Tool{
		Name: "metric_series",
		Description: "Daily or weekly values of one metric over [from, to] (at most 366 days, at most 180 points), " +
			"for questions the coach-moment tools do not answer. A day without a value is null, never 0. Today is left " +
			"out of steps, AZM, total calories and food while its totals still grow, nights Google is still processing " +
			"are left out of HRV and sleep, and resting heart rate keeps the band's standard method only. kcal_in is " +
			"null on a day where an item lacks kcal; protein_g shows a total that misses items with complete=false (a " +
			"lower bound). Weeks are ISO weeks (Monday first); a week point is the mean of its days with a value. " +
			"Never raw heart-rate samples.",
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
	// Complete is false when Value rests on a protein total that misses
	// items, so it is a lower bound.
	Complete bool `json:"complete"`
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
	pts, lower, err := s.daily(ctx, in.Metric, in.From, to, &flags, sources)
	if err != nil {
		return zero, err
	}
	out := MetricSeries{Metric: in.Metric, Unit: unit, Granularity: gran, From: in.From, To: to, Notice: seriesNotice}
	if gran == "week" {
		if out.Points, err = byWeek(pts, lower); err != nil {
			return zero, err
		}
	} else {
		out.Points = make([]SeriesPoint, len(pts))
		for i, p := range pts {
			out.Points[i] = SeriesPoint{Date: p.Date, Value: round(p.Value), Complete: !lower[p.Date]}
			if p.Value != nil {
				out.Points[i].NDays = 1
			}
		}
	}
	covered := 0
	for _, p := range pts {
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

// daily reads one point per day of [from, to], and the days whose value is a
// lower bound.
func (s series) daily(ctx context.Context, metric string, from, to coach.LocalDate, flags *flagSet, sources sourceSet) (
	[]metrics.Point, map[coach.LocalDate]bool, error) {
	switch metric {
	case "weight":
		b, err := s.Health.Body(ctx, from, to)
		if err != nil {
			return nil, nil, err
		}
		for _, r := range b.Weight {
			sources.add(r.Source)
		}
		flags.add(flagUnreadableRecords, b.Skipped > 0)
		pts, err := b.Series(healthdata.KeyWeight)
		return pts, nil, err
	case "resting_hr", "hrv", "sleep_asleep_min":
		rec, err := s.Health.Recovery(ctx, from, to)
		if err != nil {
			return nil, nil, err
		}
		sources.add(rec.Sources...)
		if metric != "resting_hr" {
			for _, n := range rec.Nights {
				flags.add(flagProvisionalSleep, n.Provisional)
			}
		}
		flags.add(flagUnreadableRecords, rec.Skipped > 0)
		key := map[string]string{"resting_hr": healthdata.KeyRestingHR, "hrv": healthdata.KeyHRV,
			"sleep_asleep_min": healthdata.KeyAsleep}[metric]
		pts, err := rec.BaselineSeries(key)
		return pts, nil, err
	case "steps", "azm", "total_calories":
		act, err := s.Health.Activity(ctx, from, to)
		if err != nil {
			return nil, nil, err
		}
		flags.add(metrics.FlagPartialDay, to >= s.today())
		if metric == "total_calories" {
			// Without the band the day's total is mostly a resting estimate.
			for _, a := range act.Days {
				flags.add(flagNotWorn, !a.Worn)
			}
		}
		flags.add(flagUnreadableRecords, act.Skipped > 0)
		key := map[string]string{"steps": healthdata.KeySteps, "azm": healthdata.KeyAZM,
			"total_calories": healthdata.KeyTotalCalories}[metric]
		pts, err := act.BaselineSeries(key)
		return pts, nil, err
	default: // kcal_in, protein_g
		food, err := s.Health.Nutrition(ctx, from, to)
		if err != nil {
			return nil, nil, err
		}
		flags.add(metrics.FlagPartialDay, to >= s.today())
		flags.add(flagOtherSourceFood, food.OtherSource > 0)
		flags.add(flagUnreadableRecords, food.Skipped > 0)
		if metric == "kcal_in" {
			pts, err := food.BaselineSeries(healthdata.NutrientKcal)
			return pts, nil, err
		}
		return proteinSeries(food, from, to, flags)
	}
}

// proteinSeries keeps a total that misses items, as a lower bound; today is
// left out while its log still grows.
func proteinSeries(food healthdata.Nutrition, from, to coach.LocalDate, flags *flagSet) ([]metrics.Point, map[coach.LocalDate]bool, error) {
	var pts []metrics.Point
	lower := map[coach.LocalDate]bool{}
	for d := from; d <= to; {
		p := metrics.Point{Date: d}
		if nd, ok := food.Days[d]; ok && !nd.Partial {
			if t, ok := nd.Totals[healthdata.NutrientProtein]; ok {
				p.Value = ptr(t.Value)
				lower[d] = !nd.Complete(healthdata.NutrientProtein)
				flags.add(flagPartialNutrientTotals, lower[d])
			}
		}
		pts = append(pts, p)
		next, err := d.AddDays(1)
		if err != nil {
			return nil, nil, err
		}
		d = next
	}
	return pts, lower, nil
}

// byWeek averages the days of each ISO week.
func byWeek(pts []metrics.Point, lower map[coach.LocalDate]bool) ([]SeriesPoint, error) {
	var out []SeriesPoint
	var sums []float64
	for _, p := range pts {
		start, err := isoWeekStart(p.Date)
		if err != nil {
			return nil, err
		}
		if len(out) == 0 || out[len(out)-1].Date != start {
			out, sums = append(out, SeriesPoint{Date: start, Complete: true}), append(sums, 0)
		}
		w := &out[len(out)-1]
		if p.Value != nil {
			sums[len(sums)-1] += *p.Value
			w.NDays++
			w.Complete = w.Complete && !lower[p.Date]
		}
	}
	for i := range out {
		if out[i].NDays > 0 {
			out[i].Value = round(ptr(sums[i] / float64(out[i].NDays)))
		}
	}
	return out, nil
}
