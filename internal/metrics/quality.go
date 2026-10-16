package metrics

import (
	"slices"
	"strings"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// Quality flags travel with the data they describe; suspicious data is
// flagged, never hidden or corrected.
const (
	FlagLowHRForActivity          = "low_hr_for_activity"
	FlagNoHRData                  = "no_hr_data"
	FlagManualEntry               = "manual_entry"
	FlagPartialDay                = "partial_day"
	FlagLikelyIncompleteNutrition = "likely_incomplete_nutrition"
)

// VigorousExerciseTypes are the exercise types whose average heart rate is
// expected to reach LowHRBPM over a long session. Matching ignores case and
// treats spaces and hyphens as underscores ("Jiu-jitsu" = JIU_JITSU).
var VigorousExerciseTypes = []string{
	"JIU_JITSU", "MARTIAL_ARTS", "BOXING", "KICKBOXING",
	"RUNNING", "RUN", "HIIT", "CROSSFIT", "STRENGTH_TRAINING", "WEIGHTLIFTING",
}

const (
	// LowHRBPM: an average below this in a vigorous session suggests the band
	// missed the effort (loose strap, wrist position), not an easy session.
	LowHRBPM = 100
	// LowHRMinDuration is the shortest session the low-HR check applies to.
	LowHRMinDuration = 30 * time.Minute
)

// MainMeals are the meal types that count as a main meal.
var MainMeals = []string{"BREAKFAST", "LUNCH", "DINNER"}

// Exercise is the part of a session the quality checks read.
type Exercise struct {
	Type        string
	Duration    time.Duration
	AvgHR       *float64 // nil or 0 when the session has no heart rate
	ManualEntry bool
}

// ExerciseFlags returns the session's quality flags in a fixed order. It never
// returns nil.
func ExerciseFlags(e Exercise) []string {
	flags := []string{}
	if e.ManualEntry {
		flags = append(flags, FlagManualEntry)
	}
	switch {
	case e.AvgHR == nil || *e.AvgHR <= 0:
		flags = append(flags, FlagNoHRData)
	case *e.AvgHR < LowHRBPM && e.Duration >= LowHRMinDuration && slices.Contains(VigorousExerciseTypes, normalize(e.Type)):
		flags = append(flags, FlagLowHRForActivity)
	}
	return flags
}

// PartialDay reports whether date is today or later, so its totals can still grow.
func PartialDay(date, today coach.LocalDate) bool {
	return date >= today
}

// NutritionIncomplete reports a food log that likely misses meals: nothing
// logged, no main meal (MainMeals), or kcal strictly below half the target in
// force. A nil target only drops the kcal check.
func NutritionIncomplete(kcal, targetKcal *float64, mealTypes []string) bool {
	if kcal == nil {
		return true
	}
	if !slices.ContainsFunc(mealTypes, func(m string) bool { return slices.Contains(MainMeals, normalize(m)) }) {
		return true
	}
	return targetKcal != nil && *targetKcal > 0 && *kcal < *targetKcal/2
}

func normalize(s string) string {
	return strings.ToUpper(strings.NewReplacer(" ", "_", "-", "_").Replace(strings.TrimSpace(s)))
}
