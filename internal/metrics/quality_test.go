package metrics

import (
	"slices"
	"testing"
	"time"
)

func TestExerciseFlags(t *testing.T) {
	for name, tc := range map[string]struct {
		e    Exercise
		want []string
	}{
		"jiu-jitsu with a low average HR": {Exercise{Type: "JIU_JITSU", Duration: time.Hour, AvgHR: f(81)}, []string{FlagLowHRForActivity}},
		"display name spelling":           {Exercise{Type: "Jiu-jitsu", Duration: time.Hour, AvgHR: f(81)}, []string{FlagLowHRForActivity}},
		"exactly 100 bpm":                 {Exercise{Type: "RUNNING", Duration: time.Hour, AvgHR: f(100)}, []string{}},
		"exactly 30 min":                  {Exercise{Type: "HIIT", Duration: 30 * time.Minute, AvgHR: f(90)}, []string{FlagLowHRForActivity}},
		"short session":                   {Exercise{Type: "HIIT", Duration: 29 * time.Minute, AvgHR: f(90)}, []string{}},
		"easy activity":                   {Exercise{Type: "WALKING", Duration: time.Hour, AvgHR: f(85)}, []string{}},
		"no heart rate":                   {Exercise{Type: "JIU_JITSU", Duration: time.Hour}, []string{FlagNoHRData}},
		"zero heart rate":                 {Exercise{Type: "JIU_JITSU", Duration: time.Hour, AvgHR: f(0)}, []string{FlagNoHRData}},
		"manual entry without HR": {
			Exercise{Type: "RUNNING", Duration: time.Hour, ManualEntry: true}, []string{FlagManualEntry, FlagNoHRData},
		},
	} {
		got := ExerciseFlags(tc.e)
		if !slices.Equal(got, tc.want) || got == nil {
			t.Errorf("%s: flags = %q, want %q", name, got, tc.want)
		}
	}
}

func TestPartialDay(t *testing.T) {
	today := day(t, 10)
	if !PartialDay(today, today) || !PartialDay(day(t, 11), today) || PartialDay(day(t, 9), today) {
		t.Error("only today and later days are partial")
	}
}

func TestNutritionIncomplete(t *testing.T) {
	main := []string{"SNACK", "LUNCH"}
	for name, tc := range map[string]struct {
		kcal, target *float64
		meals        []string
		want         bool
	}{
		"complete":            {f(1900), f(2200), main, false},
		"half the target":     {f(1100), f(2200), main, false}, // the rule is strictly below 50%
		"under half":          {f(1099), f(2200), main, true},
		"only snacks":         {f(1900), f(2200), []string{"SNACK"}, true},
		"nothing logged":      {nil, f(2200), nil, true},
		"no target":           {f(800), nil, main, false},
		"lowercase meal type": {f(1900), f(2200), []string{"dinner"}, false},
	} {
		if got := NutritionIncomplete(tc.kcal, tc.target, tc.meals); got != tc.want {
			t.Errorf("%s: incomplete = %v, want %v", name, got, tc.want)
		}
	}
}
