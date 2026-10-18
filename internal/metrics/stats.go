// Package metrics is the pure math behind the coach tools: baselines, z-scores,
// smoothing, trends, adherence, readiness and data-quality flags. It does no I/O
// and knows no time zone: callers pass values already assigned to local days.
// A nil value is a missing day (never 0), and every function skips it.
package metrics

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// AlgoVersion is stored with every cached daily aggregate. Bump it when a change
// here alters a stored value, so the cache recomputes instead of mixing versions.
const AlgoVersion = 2

// MinBaselineNights is the baseline size below which a z-score is not given.
const MinBaselineNights = 7

// EWMAAlpha weighs the newest value in EWMA; 0.25 behaves like a ~7-day window
// ((2 / alpha) − 1 values).
const EWMAAlpha = 0.25

// relTol absorbs float rounding when two values that should be equal are compared
// (70.3 − 70.0 is 0.2999…), scaled to the magnitude of the operands.
const relTol = 1e-9

// Point is one local day of a daily series. A nil Value means no data that day.
type Point struct {
	Date  coach.LocalDate
	Value *float64
}

// Stats summarizes a baseline. SD is the sample standard deviation (n − 1): the
// baseline estimates the person's usual spread from a sample of their nights.
// It is 0 when N < 2.
type Stats struct {
	Mean, SD float64
	N        int
}

// Baseline summarizes the days [before − days, before − 1]: the day being judged
// is never part of its own baseline. Missing days are skipped. Only the points in
// the window are checked for duplicates and non-finite values, so a bad row
// outside it does not fail today's baseline.
func Baseline(series []Point, before coach.LocalDate, days int) (Stats, error) {
	if days <= 0 {
		return Stats{}, fmt.Errorf("baseline needs at least 1 day, got %d days", days)
	}
	first, err := before.AddDays(-days)
	if err != nil {
		return Stats{}, err
	}
	var window []Point
	for _, p := range series {
		if _, err := coach.ParseDate(string(p.Date)); err != nil {
			return Stats{}, err
		}
		if p.Date >= first && p.Date < before {
			window = append(window, p)
		}
	}
	pts, err := sorted(window)
	if err != nil {
		return Stats{}, err
	}
	var vals []float64
	for _, p := range pts {
		if p.Value != nil {
			vals = append(vals, *p.Value)
		}
	}
	return describe(vals, 1), nil
}

// describe returns mean and standard deviation with the given degrees-of-freedom
// correction (1 = sample, 0 = population), in two passes for accuracy.
func describe(vals []float64, ddof int) Stats {
	s := Stats{N: len(vals)}
	if s.N == 0 {
		return s
	}
	for _, v := range vals {
		s.Mean += v
	}
	s.Mean /= float64(s.N)
	if s.N <= ddof {
		return s
	}
	var ss float64
	for _, v := range vals {
		ss += (v - s.Mean) * (v - s.Mean)
	}
	s.SD = math.Sqrt(ss / float64(s.N-ddof))
	return s
}

// ZScore is (value − mean) / sd, or nil when the value is missing, the baseline
// has fewer than MinBaselineNights values or no spread. A flat baseline of a
// non-round value leaves a rounding residue instead of an exact 0 sd, so a
// spread below float precision counts as none.
//
// The guard is scaled for values of order 1 or larger (ms, bpm, minutes, kg).
func ZScore(value *float64, b Stats) *float64 {
	if !finite(value) || !finite(&b.Mean) || !finite(&b.SD) || b.N < MinBaselineNights ||
		b.SD <= relTol*math.Max(1, math.Abs(b.Mean)) {
		return nil
	}
	z := (*value - b.Mean) / b.SD
	return &z
}

// Delta is value − mean, or nil when the value is missing or not finite or the
// baseline is empty. A short baseline still gives a delta: callers that judge it
// (AssessReadiness) pass the baseline size along.
func Delta(value *float64, b Stats) *float64 {
	if !finite(value) || !finite(&b.Mean) || b.N == 0 {
		return nil
	}
	d := *value - b.Mean
	return &d
}

// DeltaPct is the change from the mean in percent of |mean| (so a rise is
// positive whatever the sign), or nil when Delta is nil or the mean is 0.
func DeltaPct(value *float64, b Stats) *float64 {
	d := Delta(value, b)
	if d == nil || b.Mean == 0 {
		return nil
	}
	pct := *d / math.Abs(b.Mean) * 100
	return &pct
}

// EWMA smooths the series in date order, returning one point per input point.
// The first value seeds it; days before it come back nil. A missing day (a nil
// value or a date with no point) comes back nil and leaves the state as it was,
// so the next value blends with the last one seen however long the gap: the
// average runs over logged values, it does not decay with time.
func EWMA(series []Point, alpha float64) ([]Point, error) {
	if !(alpha > 0 && alpha <= 1) {
		return nil, fmt.Errorf("EWMA alpha must be in (0, 1], got %v", alpha)
	}
	pts, err := sorted(series)
	if err != nil {
		return nil, err
	}
	out := make([]Point, len(pts))
	var state *float64
	for i, p := range pts {
		out[i].Date = p.Date
		if p.Value == nil {
			continue
		}
		next := *p.Value
		if state != nil {
			next = alpha**p.Value + (1-alpha)**state
		}
		state = &next
		out[i].Value = &next
	}
	return out, nil
}

// SlopePerWeek is the least-squares slope of the series per 7 days, with x the
// number of days since the first value (so gaps keep their real width). It is
// nil with fewer than 2 values.
func SlopePerWeek(series []Point) (*float64, error) {
	pts, err := sorted(series)
	if err != nil {
		return nil, err
	}
	var xs, ys []float64
	for _, p := range pts {
		if p.Value == nil {
			continue
		}
		xs, ys = append(xs, float64(dayNumber(p.Date))), append(ys, *p.Value)
	}
	if len(xs) < 2 {
		return nil, nil
	}
	mx, my := describe(xs, 0).Mean, describe(ys, 0).Mean
	var sxy, sxx float64
	for i := range xs {
		sxy += (xs[i] - mx) * (ys[i] - my)
		sxx += (xs[i] - mx) * (xs[i] - mx)
	}
	slope := sxy / sxx * 7 // dates are distinct, so sxx > 0
	return &slope, nil
}

// TrendDirection compares two periods.
type TrendDirection string

const (
	TrendUp      TrendDirection = "up"
	TrendDown    TrendDirection = "down"
	TrendFlat    TrendDirection = "flat"
	TrendUnknown TrendDirection = "unknown"
)

// Trend is up or down when this − prev reaches minChange (inclusive, within float
// rounding) and is not zero, flat otherwise, and unknown when either value is
// missing or not finite. minChange must be a finite number ≥ 0.
func Trend(this, prev *float64, minChange float64) (TrendDirection, error) {
	if !(minChange >= 0) || math.IsInf(minChange, 0) {
		return TrendUnknown, fmt.Errorf("trend threshold must be a finite number ≥ 0, got %v", minChange)
	}
	if !finite(this) || !finite(prev) {
		return TrendUnknown, nil
	}
	d := *this - *prev
	tol := relTol * math.Max(1, math.Max(math.Abs(*this), math.Abs(*prev)))
	switch {
	case d > tol && d >= minChange-tol:
		return TrendUp, nil
	case d < -tol && d <= -minChange+tol:
		return TrendDown, nil
	default:
		return TrendFlat, nil
	}
}

// SleepOnsetConsistency is the population standard deviation, in minutes, of
// sleep start times given as minutes after local midnight (0–1439). Times are
// read on a 24-hour circle around their circular mean, so 23:50 and 00:10 are 20
// minutes apart (sd 10), not 23h40. It describes these nights, hence population
// sd. It is nil with fewer than 2 nights.
func SleepOnsetConsistency(startMinutes []int) (*float64, error) {
	const day = 24 * 60
	var sin, cos float64
	for i, m := range startMinutes {
		if m < 0 || m >= day {
			// The index, not the value: errors never carry health data.
			return nil, fmt.Errorf("sleep start #%d is not a minute of the day (0–%d)", i, day-1)
		}
		a := 2 * math.Pi * float64(m) / day
		sin, cos = sin+math.Sin(a), cos+math.Cos(a)
	}
	if len(startMinutes) < 2 {
		return nil, nil
	}
	// Times spread evenly around the clock have no mean direction; measure from the
	// first night then, which gives the same spread.
	ref := float64(startMinutes[0])
	if math.Hypot(sin, cos) > relTol*float64(len(startMinutes)) {
		ref = math.Mod(math.Atan2(sin, cos)*day/(2*math.Pi)+day, day)
	}
	devs := make([]float64, len(startMinutes))
	for i, m := range startMinutes {
		d := math.Mod(float64(m)-ref, day)
		switch {
		case d >= day/2:
			d -= day
		case d < -day/2:
			d += day
		}
		devs[i] = d
	}
	sd := describe(devs, 0).SD
	return &sd, nil
}

// TargetDay is one day of a value against the target in force that day (targets
// are versioned, so they can differ between days). Partial days, missing values
// and days without a positive target (none in force) are skipped.
type TargetDay struct {
	Date          coach.LocalDate
	Value, Target *float64
	Partial       bool
}

// Adherence counts the eligible days (value and target present, day not partial)
// and those that hit. Pct is nil when no day is eligible, never 0%.
type Adherence struct {
	Pct *float64 `json:"pct"`
	Hit int      `json:"days_hit"`
	N   int      `json:"days_counted"`
}

// AdherenceWithin counts days within ±tolerance of the target (0.10 = ±10%),
// boundaries included.
func AdherenceWithin(days []TargetDay, tolerance float64) (Adherence, error) {
	if !(tolerance >= 0 && tolerance < 1) {
		return Adherence{}, fmt.Errorf("tolerance must be in [0, 1), got %v", tolerance)
	}
	return adherence(days, func(v, t float64) bool { return math.Abs(v-t) <= tolerance*t+relTol*t })
}

// AdherenceAtLeast counts days at or above the target.
func AdherenceAtLeast(days []TargetDay) (Adherence, error) {
	return adherence(days, func(v, t float64) bool { return v >= t-relTol*t })
}

// adherence rejects data that would skew the percentage instead of being skipped:
// an invalid or repeated date, or a value or target that is not a finite number,
// or a negative value.
func adherence(days []TargetDay, hit func(v, t float64) bool) (Adherence, error) {
	seen := make(map[coach.LocalDate]bool, len(days))
	var a Adherence
	for _, d := range days {
		if _, err := coach.ParseDate(string(d.Date)); err != nil {
			return Adherence{}, err
		}
		if seen[d.Date] {
			return Adherence{}, fmt.Errorf("date %s appears twice", d.Date)
		}
		seen[d.Date] = true
		for _, v := range []*float64{d.Value, d.Target} {
			if v != nil && !finite(v) {
				return Adherence{}, fmt.Errorf("value on %s is not a finite number", d.Date)
			}
		}
		if d.Value != nil && *d.Value < 0 {
			return Adherence{}, fmt.Errorf("value on %s is negative", d.Date)
		}
		if d.Partial || d.Value == nil || d.Target == nil || *d.Target <= 0 {
			continue
		}
		a.N++
		if hit(*d.Value, *d.Target) {
			a.Hit++
		}
	}
	if a.N > 0 {
		pct := float64(a.Hit) / float64(a.N) * 100
		a.Pct = &pct
	}
	return a, nil
}

// sorted returns a date-ordered copy of series, rejecting invalid dates, a date
// listed twice and non-finite values (NaN would poison every average silently).
func sorted(series []Point) ([]Point, error) {
	for _, p := range series {
		if _, err := coach.ParseDate(string(p.Date)); err != nil {
			return nil, err
		}
		if p.Value != nil && !finite(p.Value) {
			return nil, fmt.Errorf("value on %s is not a finite number", p.Date)
		}
	}
	pts := slices.Clone(series)
	// YYYY-MM-DD sorts as text in date order.
	slices.SortFunc(pts, func(a, b Point) int { return cmp.Compare(a.Date, b.Date) })
	for i := 1; i < len(pts); i++ {
		if pts[i].Date == pts[i-1].Date {
			return nil, fmt.Errorf("date %s appears twice in the series", pts[i].Date)
		}
	}
	return pts, nil
}

// dayNumber is the number of days from the Unix epoch to d, which sorted has
// already validated.
func dayNumber(d coach.LocalDate) int {
	t, _ := time.Parse(time.DateOnly, string(d))
	return int(t.Unix() / 86400)
}

// finite reports whether p is present and a finite number.
func finite(p *float64) bool {
	return p != nil && !math.IsNaN(*p) && !math.IsInf(*p, 0)
}
