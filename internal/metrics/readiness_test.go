package metrics

import (
	"math"
	"slices"
	"testing"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// sig is a signal with a full 28-night baseline.
func sig(v *float64) Signal { return Signal{Value: v, Nights: 28} }

func TestReadinessLevels(t *testing.T) {
	for name, tc := range map[string]struct {
		hrvZ, rhrDelta, asleep *float64
		level                  Level
		reasons                []string
	}{
		"all good":         {f(0.2), f(1), f(450), LevelGreen, []string{}},
		"hrv z −1.5":       {f(-1.5), f(0), f(450), LevelYellow, []string{"hrv_below_baseline"}}, // red is strictly below
		"hrv z below −1.5": {f(-1.51), f(0), f(450), LevelRed, []string{"hrv_well_below_baseline"}},
		"hrv z −0.5":       {f(-0.5), f(0), f(450), LevelGreen, []string{}}, // yellow is strictly below
		"hrv z below −0.5": {f(-0.51), f(0), f(450), LevelYellow, []string{"hrv_below_baseline"}},
		"rhr +5":           {f(0), f(5), f(450), LevelRed, []string{"resting_hr_well_above_baseline"}}, // inclusive
		"rhr +5 rounded":   {f(0), f(4.9999999999), f(450), LevelRed, []string{"resting_hr_well_above_baseline"}},
		"rhr +4.9":         {f(0), f(4.9), f(450), LevelYellow, []string{"resting_hr_above_baseline"}},
		"rhr +3":           {f(0), f(3), f(450), LevelYellow, []string{"resting_hr_above_baseline"}},
		"rhr +2.9":         {f(0), f(2.9), f(450), LevelGreen, []string{}},
		"rhr lower":        {f(0), f(-6), f(450), LevelGreen, []string{}},
		"asleep 360":       {f(0), f(0), f(360), LevelYellow, []string{"sleep_short"}}, // red is strictly below
		"asleep 359":       {f(0), f(0), f(359), LevelRed, []string{"sleep_very_short"}},
		"asleep 420":       {f(0), f(0), f(420), LevelGreen, []string{}},
		"asleep 419":       {f(0), f(0), f(419), LevelYellow, []string{"sleep_short"}},
		"worst wins, all reasons listed in order": {
			f(-0.8), f(6), f(400), LevelRed, []string{"hrv_below_baseline", "resting_hr_well_above_baseline", "sleep_short"},
		},
		"hrv missing, good sleep": {nil, f(0), f(480), LevelGreen, []string{"missing:hrv"}},
		"only one signal":         {nil, nil, f(300), LevelRed, []string{"missing:hrv", "missing:resting_hr", "sleep_very_short"}},
		"no signal":               {nil, nil, nil, LevelUnknown, []string{"missing:hrv", "missing:resting_hr", "missing:sleep"}},
		// A value that is not a number must not pass every comparison as green.
		"NaN everywhere": {f(math.NaN()), f(math.NaN()), f(math.NaN()), LevelUnknown, []string{"missing:hrv", "missing:resting_hr", "missing:sleep"}},
		"infinite hrv":   {f(math.Inf(-1)), f(0), f(450), LevelGreen, []string{"missing:hrv"}},
	} {
		r := AssessReadiness(DefaultThresholds(), sig(tc.hrvZ), sig(tc.rhrDelta), tc.asleep)
		if r.Level != tc.level || !slices.Equal(r.Reasons, tc.reasons) || r.Reasons == nil {
			t.Errorf("%s: got %s %q, want %s %q", name, r.Level, r.Reasons, tc.level, tc.reasons)
		}
	}
}

func TestReadinessShortBaseline(t *testing.T) {
	// Resting HR +6 on a 2-night baseline is not evidence of anything.
	r := AssessReadiness(DefaultThresholds(), sig(f(0)), Signal{f(6), 2}, f(450))
	if r.Level != LevelGreen || !slices.Equal(r.Reasons, []string{"missing:resting_hr"}) || r.Confidence != coach.ConfidenceMedium {
		t.Errorf("short resting-HR baseline = %+v", r)
	}
	// Both baselines short: only sleep is left, and it carries no baseline.
	r = AssessReadiness(DefaultThresholds(), Signal{f(-3), 6}, Signal{f(9), 6}, f(450))
	if r.Level != LevelGreen || r.Confidence != coach.ConfidenceLow {
		t.Errorf("6-night baselines = %+v", r)
	}
}

func TestReadinessConfidence(t *testing.T) {
	for name, tc := range map[string]struct {
		hrv, rhr Signal
		asleep   *float64
		want     coach.ConfidenceLevel
	}{
		"full baselines":            {sig(f(0)), sig(f(0)), f(450), coach.ConfidenceHigh},
		"21 nights":                 {Signal{f(0), 21}, Signal{f(0), 21}, f(450), coach.ConfidenceHigh},
		"the smaller baseline wins": {Signal{f(0), 28}, Signal{f(0), 14}, f(450), coach.ConfidenceMedium},
		"7 nights":                  {Signal{f(0), 7}, Signal{f(0), 7}, f(450), coach.ConfidenceMedium},
		"6 nights":                  {Signal{f(0), 6}, Signal{f(0), 6}, f(450), coach.ConfidenceLow},
		"one missing":               {Signal{}, sig(f(0)), f(480), coach.ConfidenceMedium},
		"one missing, 7 nights":     {Signal{}, Signal{f(0), 7}, f(480), coach.ConfidenceMedium},
		"one missing, 6 nights":     {Signal{f(0), 6}, sig(f(0)), f(480), coach.ConfidenceMedium},
		"sleep missing, 28 nights":  {sig(f(0)), sig(f(0)), nil, coach.ConfidenceMedium},
		"two missing":               {Signal{}, Signal{}, f(480), coach.ConfidenceLow},
		"no signal":                 {Signal{}, Signal{}, nil, coach.ConfidenceLow},
	} {
		if got := AssessReadiness(DefaultThresholds(), tc.hrv, tc.rhr, tc.asleep).Confidence; got != tc.want {
			t.Errorf("%s: confidence = %s, want %s", name, got, tc.want)
		}
	}
}

func TestReadinessReadsEveryThreshold(t *testing.T) {
	// Each line is moved past a value that is green under the defaults; a closure
	// reading the wrong field would leave the level unchanged.
	for name, tc := range map[string]struct {
		move             func(*ReadinessThresholds)
		hrv, rhr, asleep float64
		want             Level
	}{
		"hrv red":       {func(th *ReadinessThresholds) { th.HRVZRed = 0.5 }, 0, 0, 450, LevelRed},
		"hrv yellow":    {func(th *ReadinessThresholds) { th.HRVZYellow = 0.5 }, 0, 0, 450, LevelYellow},
		"rhr red":       {func(th *ReadinessThresholds) { th.RestingHRRed = 1 }, 0, 1, 450, LevelRed},
		"rhr yellow":    {func(th *ReadinessThresholds) { th.RestingHRYellow = 1 }, 0, 1, 450, LevelYellow},
		"asleep red":    {func(th *ReadinessThresholds) { th.AsleepMinRed = 460 }, 0, 0, 450, LevelRed},
		"asleep yellow": {func(th *ReadinessThresholds) { th.AsleepMinYellow = 460 }, 0, 0, 450, LevelYellow},
	} {
		th := DefaultThresholds()
		tc.move(&th)
		if got := AssessReadiness(th, sig(f(tc.hrv)), sig(f(tc.rhr)), f(tc.asleep)).Level; got != tc.want {
			t.Errorf("%s: level = %s, want %s", name, got, tc.want)
		}
	}
	if DefaultThresholds() != DefaultThresholds() || DefaultThresholds().HRVZRed != -1.5 {
		t.Error("DefaultThresholds is not a fixed copy")
	}
}
