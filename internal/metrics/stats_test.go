package metrics

import (
	"math"
	"strings"
	"testing"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

func f(v float64) *float64 { return &v }

func near(got *float64, want float64) bool {
	return got != nil && math.Abs(*got-want) < 1e-9
}

func show(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

// day returns 2026-10-01 plus n days.
func day(t *testing.T, n int) coach.LocalDate {
	t.Helper()
	d, err := coach.LocalDate("2026-10-01").AddDays(n)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestBaselineWindow(t *testing.T) {
	// The window for before = day 9 and 7 days is day 2 .. day 8.
	series := []Point{
		{day(t, 1), f(100)}, // the day before the window
		{day(t, 8), f(8)},   // last day in the window (listed out of order)
		{day(t, 2), f(2)},   // first day in the window
		{day(t, 3), nil},    // missing day
		{day(t, 4), f(4)},
		{day(t, 6), f(6)},
		{day(t, 9), f(100)}, // the day itself is not its own baseline
	}
	b, err := Baseline(series, day(t, 9), 7)
	if err != nil {
		t.Fatal(err)
	}
	// Values 2, 4, 6, 8: mean 5, sample variance (9+1+1+9)/3.
	if b.N != 4 || b.Mean != 5 || math.Abs(b.SD-math.Sqrt(20.0/3)) > 1e-12 {
		t.Errorf("Baseline = %+v", b)
	}
}

func TestBaselineEdgeCases(t *testing.T) {
	if b, err := Baseline(nil, day(t, 9), 28); err != nil || b != (Stats{}) {
		t.Errorf("empty series = %+v, %v", b, err)
	}
	if b, err := Baseline([]Point{{day(t, 3), f(61)}}, day(t, 9), 28); err != nil || b.N != 1 || b.Mean != 61 || b.SD != 0 {
		t.Errorf("one value = %+v, %v", b, err)
	}
	for name, tc := range map[string]struct {
		series []Point
		before coach.LocalDate
		days   int
		want   string
	}{
		"zero days":      {nil, day(t, 9), 0, "days"},
		"invalid before": {nil, "2026-13-01", 7, "invalid date"},
		"invalid point":  {[]Point{{"10/03/2026", f(1)}}, day(t, 9), 7, "invalid date"},
		"duplicate date": {[]Point{{day(t, 3), f(1)}, {day(t, 3), f(2)}}, day(t, 9), 7, "twice"},
		"not finite":     {[]Point{{day(t, 3), f(math.NaN())}}, day(t, 9), 7, "not a finite"},
	} {
		if _, err := Baseline(tc.series, tc.before, tc.days); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: err = %v, want %q", name, err, tc.want)
		}
	}
}

func TestZScoreNeedsSevenNights(t *testing.T) {
	series := func(n int) []Point {
		var s []Point
		for i := range n {
			s = append(s, Point{day(t, i), f(float64(i + 1))})
		}
		return s
	}
	six, _ := Baseline(series(6), day(t, 28), 28)
	if z := ZScore(f(8), six); z != nil {
		t.Errorf("z with 6 nights = %v, want nil", *z)
	}
	seven, _ := Baseline(series(7), day(t, 28), 28)
	// Values 1..7: mean 4, sample variance 28/6.
	if z := ZScore(f(8), seven); !near(z, 4/math.Sqrt(28.0/6)) {
		t.Errorf("z with 7 nights = %v", show(z))
	}
	if z := ZScore(nil, seven); z != nil {
		t.Errorf("z of a missing value = %v", *z)
	}
}

func TestZScoreConstantBaseline(t *testing.T) {
	// The same non-round value every night: the computed sd is 0 or a rounding
	// residue, and either way there is no spread to measure against.
	var s []Point
	for i := range 10 {
		s = append(s, Point{day(t, i), f(55.3)})
	}
	b, err := Baseline(s, day(t, 10), 28)
	if err != nil {
		t.Fatal(err)
	}
	if z := ZScore(f(60), b); z != nil {
		t.Errorf("z against a flat baseline = %v (sd %g), want nil", *z, b.SD)
	}
	if z := ZScore(f(60), Stats{Mean: 60, SD: 0, N: 10}); z != nil {
		t.Errorf("z with sd exactly 0 = %v, want nil", *z)
	}
	// A small but real spread still gives a z-score.
	if z := ZScore(f(60.001), Stats{Mean: 60, SD: 1e-3, N: 10}); !near(z, 1) {
		t.Errorf("z with sd 1e-3 = %v, want 1", show(z))
	}
	for name, b := range map[string]Stats{
		"NaN sd":   {Mean: 60, SD: math.NaN(), N: 10},
		"Inf mean": {Mean: math.Inf(1), SD: 2, N: 10},
	} {
		if z := ZScore(f(60), b); z != nil {
			t.Errorf("%s: z = %v, want nil", name, *z)
		}
	}
	if z := ZScore(f(math.NaN()), Stats{Mean: 60, SD: 2, N: 10}); z != nil {
		t.Errorf("z of NaN = %v, want nil", *z)
	}
}

func TestBaselineEndToEnd(t *testing.T) {
	// Exactly 7 nights present in a 28-day window across a month boundary.
	before := coach.LocalDate("2026-11-03")
	var s []Point
	for i, v := range []float64{50, 52, 54, 56, 58, 60, 62} {
		d, _ := before.AddDays(-4 * (i + 1))
		s = append(s, Point{d, f(v)})
	}
	b, err := Baseline(s, before, 28)
	if err != nil || b.N != 7 || b.Mean != 56 {
		t.Fatalf("Baseline = %+v, %v", b, err)
	}
	if z := ZScore(f(56+b.SD), b); !near(z, 1) {
		t.Errorf("z one sd above = %v", show(z))
	}
	// A 1-day window is just the day before (2026-10-30, the first value).
	if b, err := Baseline(s, "2026-10-31", 1); err != nil || b.N != 1 || b.Mean != 50 {
		t.Errorf("1-day window = %+v, %v", b, err)
	}
}

func TestBaselineIgnoresBadRowsOutsideTheWindow(t *testing.T) {
	s := []Point{
		{day(t, -200), f(math.NaN())}, {day(t, -200), f(1)}, // corrupt, but long ago
		{day(t, 3), f(60)},
	}
	if b, err := Baseline(s, day(t, 9), 28); err != nil || b.N != 1 {
		t.Errorf("Baseline = %+v, %v; old rows must not fail it", b, err)
	}
}

func TestDelta(t *testing.T) {
	b := Stats{Mean: 58, SD: 2, N: 20}
	if d := Delta(f(63), b); !near(d, 5) {
		t.Errorf("Delta = %v", show(d))
	}
	if d := DeltaPct(f(63.8), b); !near(d, 10) {
		t.Errorf("DeltaPct = %v", show(d))
	}
	// A rise is positive even when the mean is negative.
	if d := DeltaPct(f(-9), Stats{Mean: -10, N: 3}); !near(d, 10) {
		t.Errorf("DeltaPct with a negative mean = %v", show(d))
	}
	if d := Delta(f(math.NaN()), b); d != nil {
		t.Errorf("Delta of NaN = %v", *d)
	}
	for name, d := range map[string]*float64{
		"missing value":     Delta(nil, b),
		"no baseline":       Delta(f(63), Stats{}),
		"pct missing value": DeltaPct(nil, b),
		"pct no baseline":   DeltaPct(f(63), Stats{}),
		"pct zero mean":     DeltaPct(f(1), Stats{Mean: 0, N: 3}),
	} {
		if d != nil {
			t.Errorf("%s = %v, want nil", name, *d)
		}
	}
}

func TestEWMAHandComputed(t *testing.T) {
	series := []Point{
		{day(t, 4), f(30)},
		{day(t, 0), nil}, // before the first value: nothing to smooth yet
		{day(t, 1), f(10)},
		{day(t, 2), nil}, // missing: the state carries over unchanged
		// day 3 has no point at all, which is the same as a missing value
		{day(t, 5), f(20)},
	}
	got, err := EWMA(series, EWMAAlpha)
	if err != nil {
		t.Fatal(err)
	}
	// Seed 10; 0.25·30 + 0.75·10 = 15; 0.25·20 + 0.75·15 = 16.25.
	want := []struct {
		d coach.LocalDate
		v *float64
	}{{day(t, 0), nil}, {day(t, 1), f(10)}, {day(t, 2), nil}, {day(t, 4), f(15)}, {day(t, 5), f(16.25)}}
	if len(got) != len(want) {
		t.Fatalf("EWMA returned %d points, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Date != w.d || (w.v == nil) != (got[i].Value == nil) || (w.v != nil && *got[i].Value != *w.v) {
			t.Errorf("point %d = %s %v, want %s %v", i, got[i].Date, show(got[i].Value), w.d, show(w.v))
		}
	}
	if series[0].Date != day(t, 4) {
		t.Error("EWMA reordered the caller's slice")
	}
}

func TestEWMAErrors(t *testing.T) {
	for _, alpha := range []float64{0, -0.1, 1.5, math.NaN()} {
		if _, err := EWMA(nil, alpha); err == nil {
			t.Errorf("alpha %v accepted", alpha)
		}
	}
	if _, err := EWMA([]Point{{day(t, 1), f(1)}, {day(t, 1), f(2)}}, EWMAAlpha); err == nil {
		t.Error("duplicate date accepted")
	}
	if got, err := EWMA(nil, 1); err != nil || len(got) != 0 {
		t.Errorf("empty series = %v, %v", got, err)
	}
	// alpha 1 keeps only the newest value: the series comes back unchanged.
	got, err := EWMA([]Point{{day(t, 0), f(3)}, {day(t, 1), f(7)}}, 1)
	if err != nil || *got[0].Value != 3 || *got[1].Value != 7 {
		t.Errorf("alpha 1 = %v, %v", got, err)
	}
}

func TestSlopePerWeekUsesDates(t *testing.T) {
	// y = 80 − 0.1·x on days 0, 2 and 7 (days 1, 3–6 missing). Fitting on slice
	// positions instead of dates would give a different slope.
	series := []Point{{day(t, 7), f(79.3)}, {day(t, 0), f(80)}, {day(t, 3), nil}, {day(t, 2), f(79.8)}}
	s, err := SlopePerWeek(series)
	if err != nil || !near(s, -0.7) {
		t.Errorf("SlopePerWeek = %v, %v; want -0.7", show(s), err)
	}
	if s, err := SlopePerWeek([]Point{{day(t, 0), f(80)}, {day(t, 1), nil}}); err != nil || s != nil {
		t.Errorf("one value = %v, %v; want nil", show(s), err)
	}
	if _, err := SlopePerWeek([]Point{{day(t, 0), f(1)}, {day(t, 0), f(2)}}); err == nil {
		t.Error("duplicate date accepted")
	}
	if _, err := SlopePerWeek([]Point{{day(t, 0), f(1)}, {day(t, 1), f(math.Inf(1))}}); err == nil {
		t.Error("infinite value accepted")
	}
}

func TestTrend(t *testing.T) {
	for _, tc := range []struct {
		this, prev *float64
		min        float64
		want       TrendDirection
	}{
		{f(70.3), f(70.0), 0.3, TrendUp}, // exactly the threshold, despite 70.3−70.0 = 0.2999…
		{f(70.0), f(70.3), 0.3, TrendDown},
		{f(70.2), f(70.0), 0.3, TrendFlat},
		{f(70.0), f(70.0), 0, TrendFlat}, // no change is flat even with no threshold
		{f(70.1), f(70.0), 0, TrendUp},
		{f(1e6 + 0.3), f(1e6), 0.3, TrendUp}, // the rounding allowance scales with magnitude
		{f(1e6 + 0.2), f(1e6), 0.3, TrendFlat},
		{nil, f(70), 0.3, TrendUnknown},
		{f(70), nil, 0.3, TrendUnknown},
		{f(math.NaN()), f(70), 0.3, TrendUnknown},
		{f(70), f(math.Inf(1)), 0.3, TrendUnknown},
	} {
		if got, err := Trend(tc.this, tc.prev, tc.min); err != nil || got != tc.want {
			t.Errorf("Trend(%v, %v, %v) = %s, %v; want %s", show(tc.this), show(tc.prev), tc.min, got, err, tc.want)
		}
	}
	for _, bad := range []float64{-0.3, math.NaN(), math.Inf(1)} {
		if _, err := Trend(f(1), f(0), bad); err == nil {
			t.Errorf("threshold %v accepted", bad)
		}
	}
}

func TestSleepOnsetConsistency(t *testing.T) {
	for name, tc := range map[string]struct {
		starts []int
		want   float64
	}{
		"across midnight":      {[]int{23*60 + 50, 10}, 10}, // 23:50 and 00:10
		"wide across midnight": {[]int{22 * 60, 2 * 60}, 120},
		"same side":            {[]int{23 * 60, 23*60 + 20, 23*60 + 40}, math.Sqrt(800.0 / 3)},
		"identical":            {[]int{60, 60, 60}, 0},
		// Three nights around midnight: mean 23:58:20, deviations −18:20, −3:20, +21:40.
		"three across midnight": {[]int{23*60 + 40, 23*60 + 55, 20}, math.Sqrt((18.333333333333332*18.333333333333332 + 3.3333333333333335*3.3333333333333335 + 21.666666666666668*21.666666666666668) / 3)},
		// The first night is not at the mean, so the reference must come from the circle.
		"first night off the mean": {[]int{2 * 60, 0, 1 * 60}, math.Sqrt(2.0 / 3 * 3600)},
		// Opposite times have no mean direction; the answer is the same from either side.
		"opposite": {[]int{0, 12 * 60}, 6 * 60},
	} {
		got, err := SleepOnsetConsistency(tc.starts)
		if err != nil || !near(got, tc.want) {
			t.Errorf("%s: sd = %v, %v; want %v", name, show(got), err, tc.want)
		}
	}
	if got, err := SleepOnsetConsistency([]int{23 * 60}); err != nil || got != nil {
		t.Errorf("one night = %v, %v; want nil", show(got), err)
	}
	for _, bad := range []int{-1, 24 * 60} {
		if _, err := SleepOnsetConsistency([]int{0, bad}); err == nil {
			t.Errorf("minute %d accepted", bad)
		}
	}
}

func TestAdherenceWithin(t *testing.T) {
	days := []TargetDay{
		{day(t, 0), f(2200), f(2000), false}, // +10%: inside, inclusive
		{day(t, 1), f(1800), f(2000), false}, // −10%: inside
		{day(t, 2), f(2201), f(2000), false}, // outside
		{day(t, 3), f(1000), f(2000), true},  // partial day: not counted
		{day(t, 4), nil, f(2000), false},     // nothing logged: not counted
		{day(t, 5), f(2500), nil, false},     // no target in force: not counted
		{day(t, 6), f(2420), f(2200), false}, // the target changed: +10% of 2200
		{day(t, 7), f(0), f(0), false},       // a zero target has no band: not counted
	}
	a, err := AdherenceWithin(days, 0.10)
	if err != nil || a.Hit != 3 || a.N != 4 || !near(a.Pct, 75) {
		t.Errorf("AdherenceWithin = %+v (pct %v), %v", a, show(a.Pct), err)
	}
	if a, err := AdherenceWithin(days[3:6], 0.10); err != nil || a.N != 0 || a.Pct != nil {
		t.Errorf("no eligible day = %+v, %v; want a nil pct", a, err)
	}
	for _, tol := range []float64{-0.1, 1, math.NaN()} {
		if _, err := AdherenceWithin(days, tol); err == nil {
			t.Errorf("tolerance %v accepted", tol)
		}
	}
}

func TestAdherenceAtLeast(t *testing.T) {
	days := []TargetDay{
		{day(t, 0), f(140), f(140), false}, // exactly the target
		{day(t, 1), f(139.9), f(140), false},
		{day(t, 2), f(200), f(140), false},
		{day(t, 3), f(10), f(140), true},
		{day(t, 4), f(0), f(0), false}, // a zero target is no target: not a free hit
	}
	if a, err := AdherenceAtLeast(days); err != nil || a.Hit != 2 || a.N != 3 || !near(a.Pct, 200.0/3) {
		t.Errorf("AdherenceAtLeast = %+v (pct %v), %v", a, show(a.Pct), err)
	}
	if a, err := AdherenceAtLeast(nil); err != nil || a.N != 0 || a.Pct != nil {
		t.Errorf("empty = %+v, %v", a, err)
	}
}

func TestAdherenceRejectsBadData(t *testing.T) {
	for name, days := range map[string][]TargetDay{
		"NaN value":       {{day(t, 0), f(math.NaN()), f(140), false}},
		"infinite target": {{day(t, 0), f(140), f(math.Inf(1)), false}},
		"negative value":  {{day(t, 0), f(-5), f(140), false}},
		"duplicate date":  {{day(t, 0), f(140), f(140), false}, {day(t, 0), f(150), f(140), false}},
		"invalid date":    {{"2026-02-30", f(140), f(140), false}},
	} {
		if _, err := AdherenceAtLeast(days); err == nil {
			t.Errorf("AdherenceAtLeast accepted %s", name)
		}
		if _, err := AdherenceWithin(days, 0.1); err == nil {
			t.Errorf("AdherenceWithin accepted %s", name)
		}
	}
}

func TestAdherenceWithinZeroTolerance(t *testing.T) {
	days := []TargetDay{{day(t, 0), f(2000), f(2000), false}, {day(t, 1), f(2001), f(2000), false}}
	if a, err := AdherenceWithin(days, 0); err != nil || a.Hit != 1 || a.N != 2 {
		t.Errorf("zero tolerance = %+v, %v", a, err)
	}
}
