package metrics

import "github.com/athosmartinez/health-coach-mcp/internal/coach"

// Level is the readiness traffic light.
type Level string

const (
	LevelGreen   Level = "green"
	LevelYellow  Level = "yellow"
	LevelRed     Level = "red"
	LevelUnknown Level = "unknown"
)

// ReadinessThresholds holds the readiness rule's lines. HRV z-score and sleep
// lines are strict (z < line, minutes < line); resting-HR lines are inclusive
// (delta ≥ line, in bpm above the 28-day mean).
type ReadinessThresholds struct {
	HRVZRed, HRVZYellow           float64
	RestingHRRed, RestingHRYellow float64
	AsleepMinRed, AsleepMinYellow float64
}

// Thresholds is the one place the readiness rule's lines live, so they can be tuned.
var Thresholds = ReadinessThresholds{
	HRVZRed: -1.5, HRVZYellow: -0.5,
	RestingHRRed: 5, RestingHRYellow: 3,
	AsleepMinRed: 360, AsleepMinYellow: 420,
}

// Readiness is the morning traffic light with the codes that explain it.
type Readiness struct {
	Level      Level                 `json:"level"`
	Reasons    []string              `json:"reasons"`
	Confidence coach.ConfidenceLevel `json:"confidence"`
}

// AssessReadiness applies the readiness rule to last night's HRV z-score (vs 28
// days), resting-HR delta (bpm vs 28 days) and minutes asleep. The worst signal
// sets the level. A missing signal counts neither way: it is listed as
// missing:<signal> and lowers confidence; with no signal the level is unknown.
// A z-score is nil below MinBaselineNights, so a short baseline reads as
// missing:hrv. nNights is the size of the baseline: below MinBaselineNights
// confidence is low whatever the signals say.
//
// Reasons are stable codes in a fixed order (hrv, resting_hr, sleep), one per
// signal that is missing or not green. They describe the data, never a diagnosis.
func AssessReadiness(hrvZ, restingHRDelta, asleepMin *float64, nNights int) Readiness {
	th := Thresholds
	signals := []struct {
		name  string
		value *float64
		level func(v float64) Level
		codes [2]string // yellow, red
	}{
		{"hrv", hrvZ, func(v float64) Level {
			return pick(v < th.HRVZRed, v < th.HRVZYellow)
		}, [2]string{"hrv_low", "hrv_very_low"}},
		{"resting_hr", restingHRDelta, func(v float64) Level {
			return pick(v >= th.RestingHRRed, v >= th.RestingHRYellow)
		}, [2]string{"resting_hr_high", "resting_hr_very_high"}},
		{"sleep", asleepMin, func(v float64) Level {
			return pick(v < th.AsleepMinRed, v < th.AsleepMinYellow)
		}, [2]string{"sleep_short", "sleep_very_short"}},
	}

	r := Readiness{Level: LevelUnknown, Reasons: []string{}}
	missing := 0
	for _, s := range signals {
		if s.value == nil {
			missing++
			r.Reasons = append(r.Reasons, "missing:"+s.name)
			continue
		}
		l := s.level(*s.value)
		switch l {
		case LevelRed:
			r.Reasons = append(r.Reasons, s.codes[1])
		case LevelYellow:
			r.Reasons = append(r.Reasons, s.codes[0])
		}
		r.Level = worse(r.Level, l)
	}

	r.Confidence = coach.Confidence(nNights)
	switch {
	case missing == len(signals), missing >= 2, nNights < MinBaselineNights:
		r.Confidence = coach.ConfidenceLow
	case missing == 1 && r.Confidence == coach.ConfidenceHigh:
		r.Confidence = coach.ConfidenceMedium
	}
	return r
}

func pick(red, yellow bool) Level {
	switch {
	case red:
		return LevelRed
	case yellow:
		return LevelYellow
	default:
		return LevelGreen
	}
}

// worse returns the more severe level; unknown is the least severe, so any
// present signal replaces it.
func worse(a, b Level) Level {
	rank := map[Level]int{LevelUnknown: 0, LevelGreen: 1, LevelYellow: 2, LevelRed: 3}
	if rank[b] > rank[a] {
		return b
	}
	return a
}
