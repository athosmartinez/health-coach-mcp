package metrics

import (
	"slices"
	"testing"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

func TestReadinessLevels(t *testing.T) {
	for name, tc := range map[string]struct {
		hrvZ, rhrDelta, asleep *float64
		level                  Level
		reasons                []string
	}{
		"all good":         {f(0.2), f(1), f(450), LevelGreen, []string{}},
		"hrv z −1.5":       {f(-1.5), f(0), f(450), LevelYellow, []string{"hrv_low"}}, // red is strictly below
		"hrv z below −1.5": {f(-1.51), f(0), f(450), LevelRed, []string{"hrv_very_low"}},
		"hrv z −0.5":       {f(-0.5), f(0), f(450), LevelGreen, []string{}}, // yellow is strictly below
		"hrv z below −0.5": {f(-0.51), f(0), f(450), LevelYellow, []string{"hrv_low"}},
		"rhr +5":           {f(0), f(5), f(450), LevelRed, []string{"resting_hr_very_high"}}, // inclusive
		"rhr +4.9":         {f(0), f(4.9), f(450), LevelYellow, []string{"resting_hr_high"}},
		"rhr +3":           {f(0), f(3), f(450), LevelYellow, []string{"resting_hr_high"}},
		"rhr +2.9":         {f(0), f(2.9), f(450), LevelGreen, []string{}},
		"rhr lower":        {f(0), f(-6), f(450), LevelGreen, []string{}},
		"asleep 360":       {f(0), f(0), f(360), LevelYellow, []string{"sleep_short"}}, // red is strictly below
		"asleep 359":       {f(0), f(0), f(359), LevelRed, []string{"sleep_very_short"}},
		"asleep 420":       {f(0), f(0), f(420), LevelGreen, []string{}},
		"asleep 419":       {f(0), f(0), f(419), LevelYellow, []string{"sleep_short"}},
		"worst wins, all reasons listed in order": {
			f(-0.8), f(6), f(400), LevelRed, []string{"hrv_low", "resting_hr_very_high", "sleep_short"},
		},
		"hrv missing, good sleep": {nil, f(0), f(480), LevelGreen, []string{"missing:hrv"}},
		"only one signal":         {nil, nil, f(300), LevelRed, []string{"missing:hrv", "missing:resting_hr", "sleep_very_short"}},
		"no signal":               {nil, nil, nil, LevelUnknown, []string{"missing:hrv", "missing:resting_hr", "missing:sleep"}},
	} {
		r := AssessReadiness(tc.hrvZ, tc.rhrDelta, tc.asleep, 28)
		if r.Level != tc.level || !slices.Equal(r.Reasons, tc.reasons) || r.Reasons == nil {
			t.Errorf("%s: got %s %q, want %s %q", name, r.Level, r.Reasons, tc.level, tc.reasons)
		}
	}
}

func TestReadinessConfidence(t *testing.T) {
	for name, tc := range map[string]struct {
		hrvZ, rhrDelta, asleep *float64
		nights                 int
		want                   coach.ConfidenceLevel
	}{
		"full baseline":        {f(0), f(0), f(450), 28, coach.ConfidenceHigh},
		"21 nights":            {f(0), f(0), f(450), 21, coach.ConfidenceHigh},
		"two weeks":            {f(0), f(0), f(450), 14, coach.ConfidenceMedium},
		"7 nights":             {f(0), f(0), f(450), 7, coach.ConfidenceMedium},
		"6 nights":             {f(0), f(0), f(450), 6, coach.ConfidenceLow},
		"6 nights, red":        {f(0), f(9), f(450), 6, coach.ConfidenceLow},
		"one signal missing":   {nil, f(0), f(480), 28, coach.ConfidenceMedium},
		"one missing, 2 weeks": {f(0), nil, f(480), 14, coach.ConfidenceMedium},
		"two signals missing":  {nil, nil, f(480), 28, coach.ConfidenceLow},
		"no signal":            {nil, nil, nil, 28, coach.ConfidenceLow},
		"negative night count": {f(0), f(0), f(450), -3, coach.ConfidenceLow},
	} {
		if got := AssessReadiness(tc.hrvZ, tc.rhrDelta, tc.asleep, tc.nights).Confidence; got != tc.want {
			t.Errorf("%s: confidence = %s, want %s", name, got, tc.want)
		}
	}
}

func TestReadinessUsesThresholds(t *testing.T) {
	// The rule reads the one tunable table; nothing is hard-coded elsewhere.
	saved := Thresholds
	t.Cleanup(func() { Thresholds = saved })
	Thresholds.AsleepMinRed = 300
	if r := AssessReadiness(f(0), f(0), f(330), 28); r.Level != LevelYellow {
		t.Errorf("with the red sleep line at 300, 330 min = %s, want yellow", r.Level)
	}
}
