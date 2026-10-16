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

// vigorousTypes are the exercise types whose average heart rate is expected to
// reach LowHRBPM over a long session. Strength training is left out: with rests
// between sets a correct average under 100 bpm is normal. Matching ignores case
// and treats spaces and hyphens as underscores ("Jiu-jitsu" = JIU_JITSU).
var vigorousTypes = set("JIU_JITSU", "MARTIAL_ARTS", "BOXING", "KICKBOXING", "RUNNING", "RUN", "HIIT", "CROSSFIT")

const (
	// LowHRBPM: an average below this in a vigorous session suggests the band
	// missed the effort (loose strap, wrist position), not an easy session.
	LowHRBPM = 100
	// LowHRMinDuration is the shortest session the low-HR check applies to.
	LowHRMinDuration = 30 * time.Minute
)

// mainMeals are the meal types that count as a main meal.
var mainMeals = set("BREAKFAST", "LUNCH", "DINNER")

// IsVigorous reports whether an exercise type is in the low-HR check's list.
func IsVigorous(exerciseType string) bool { return vigorousTypes[normalize(exerciseType)] }

// IsMainMeal reports whether a meal type counts as a main meal.
func IsMainMeal(mealType string) bool { return mainMeals[normalize(mealType)] }

// Exercise is the part of a session the quality checks read.
type Exercise struct {
	Type        string
	Duration    time.Duration
	AvgHR       *float64 // nil, 0 or not finite when the session has no heart rate
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
	case !finite(e.AvgHR) || *e.AvgHR <= 0:
		flags = append(flags, FlagNoHRData)
	case *e.AvgHR < LowHRBPM && e.Duration >= LowHRMinDuration && IsVigorous(e.Type):
		flags = append(flags, FlagLowHRForActivity)
	}
	return flags
}

// PartialDay reports whether date is today or later, so its totals can still grow.
func PartialDay(date, today coach.LocalDate) (bool, error) {
	for _, d := range []coach.LocalDate{date, today} {
		if _, err := coach.ParseDate(string(d)); err != nil {
			return false, err
		}
	}
	return date >= today, nil
}

// Logging describes how complete a day's food log looks.
type Logging struct {
	LikelyIncomplete bool `json:"likely_incomplete"`
	HasMainMeal      bool `json:"has_main_meal"`
	// KcalPctOfTarget is intake as a percent of the target in force, so a very
	// low day stays visible whether it is a gap in the log or real under-eating.
	KcalPctOfTarget *float64 `json:"kcal_pct_of_target"`
}

// CheckLogging flags a food log that likely misses meals: nothing (or 0 kcal)
// logged, no main meal, or kcal strictly below half the target in force. A
// missing or non-positive target only drops the kcal check. Callers pair it with
// PartialDay: today's log is not finished yet.
func CheckLogging(kcal, targetKcal *float64, mealTypes []string) Logging {
	l := Logging{HasMainMeal: slices.ContainsFunc(mealTypes, IsMainMeal)}
	hasTarget := finite(targetKcal) && *targetKcal > 0
	if finite(kcal) && hasTarget {
		pct := *kcal / *targetKcal * 100
		l.KcalPctOfTarget = &pct
	}
	l.LikelyIncomplete = !finite(kcal) || *kcal <= 0 || !l.HasMainMeal || (hasTarget && *kcal < *targetKcal/2)
	return l
}

var separators = strings.NewReplacer(" ", "_", "-", "_")

func normalize(s string) string {
	return strings.ToUpper(separators.Replace(strings.TrimSpace(s)))
}

func set(items ...string) map[string]bool {
	m := make(map[string]bool, len(items))
	for _, it := range items {
		m[it] = true
	}
	return m
}
