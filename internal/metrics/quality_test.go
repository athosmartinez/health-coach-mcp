package metrics

import (
	"math"
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
		"display name spelling":           {Exercise{Type: " Jiu-jitsu", Duration: time.Hour, AvgHR: f(81)}, []string{FlagLowHRForActivity}},
		"exactly 100 bpm":                 {Exercise{Type: "RUNNING", Duration: time.Hour, AvgHR: f(100)}, []string{}},
		"exactly 30 min":                  {Exercise{Type: "HIIT", Duration: 30 * time.Minute, AvgHR: f(90)}, []string{FlagLowHRForActivity}},
		"short session":                   {Exercise{Type: "HIIT", Duration: 29 * time.Minute, AvgHR: f(90)}, []string{}},
		"easy activity":                   {Exercise{Type: "WALKING", Duration: time.Hour, AvgHR: f(85)}, []string{}},
		"strength training rests":         {Exercise{Type: "STRENGTH_TRAINING", Duration: time.Hour, AvgHR: f(92)}, []string{}},
		"no heart rate":                   {Exercise{Type: "JIU_JITSU", Duration: time.Hour}, []string{FlagNoHRData}},
		"zero heart rate":                 {Exercise{Type: "JIU_JITSU", Duration: time.Hour, AvgHR: f(0)}, []string{FlagNoHRData}},
		"NaN heart rate":                  {Exercise{Type: "JIU_JITSU", Duration: time.Hour, AvgHR: f(math.NaN())}, []string{FlagNoHRData}},
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
	for d, want := range map[int]bool{10: true, 11: true, 9: false} {
		if got, err := PartialDay(day(t, d), today); err != nil || got != want {
			t.Errorf("day %d: partial = %v, %v; want %v", d, got, err, want)
		}
	}
	if _, err := PartialDay("", today); err == nil {
		t.Error("an empty date was accepted")
	}
	if _, err := PartialDay(today, ""); err == nil {
		t.Error("an empty today was accepted")
	}
}

func TestCheckLogging(t *testing.T) {
	main := []string{"SNACK", "LUNCH"}
	for name, tc := range map[string]struct {
		kcal, target *float64
		meals        []string
		incomplete   bool
		pct          *float64
	}{
		"complete":            {f(1100), f(2200), main, false, f(50)}, // the rule is strictly below 50%
		"under half":          {f(1078), f(2200), main, true, f(49)},
		"only snacks":         {f(1900), f(1900), []string{"SNACK"}, true, f(100)},
		"nothing logged":      {nil, f(2200), nil, true, nil},
		"zero kcal":           {f(0), nil, main, true, nil},
		"NaN kcal":            {f(math.NaN()), f(2200), main, true, nil},
		"no target":           {f(800), nil, main, false, nil},
		"zero target":         {f(800), f(0), main, false, nil},
		"lowercase meal type": {f(1900), f(1900), []string{"dinner"}, false, f(100)},
	} {
		got := CheckLogging(tc.kcal, tc.target, tc.meals)
		if got.LikelyIncomplete != tc.incomplete || (tc.pct == nil) != (got.KcalPctOfTarget == nil) ||
			(tc.pct != nil && !near(got.KcalPctOfTarget, *tc.pct)) {
			t.Errorf("%s: %+v (pct %v), want incomplete %v pct %v", name, got, show(got.KcalPctOfTarget), tc.incomplete, show(tc.pct))
		}
	}
	if !IsMainMeal("Breakfast") || IsMainMeal("SNACK") || !IsVigorous("crossfit") || IsVigorous("WEIGHTLIFTING") {
		t.Error("meal or exercise type lookup is wrong")
	}
}
