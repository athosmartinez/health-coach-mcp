package metrics

import (
	"math"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

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

// DefaultThresholds returns the readiness rule's lines. They live only here, so
// tuning them is a one-line change; callers get a copy, so nothing shares state.
func DefaultThresholds() ReadinessThresholds {
	return ReadinessThresholds{
		HRVZRed: -1.5, HRVZYellow: -0.5,
		RestingHRRed: 5, RestingHRYellow: 3,
		AsleepMinRed: 360, AsleepMinYellow: 420,
	}
}

// Signal is a value judged against a baseline, with the number of nights in that
// baseline.
type Signal struct {
	Value  *float64
	Nights int
}

// Readiness is the morning traffic light with the codes that explain it.
type Readiness struct {
	Level      Level                 `json:"level"`
	Reasons    []string              `json:"reasons"`
	Confidence coach.ConfidenceLevel `json:"confidence"`
}

// AssessReadiness applies the readiness rule to last night's HRV z-score and
// resting-HR delta (bpm), each against its own 28-day baseline, and minutes
// asleep. The worst signal sets the level.
//
// A signal that is missing, not a finite number, or whose baseline has fewer than
// MinBaselineNights nights counts neither way: it is listed as missing:<signal>
// and lowers confidence. With no usable signal the level is unknown. Confidence
// follows the smaller baseline in use (coach.Confidence), is capped at medium
// with one signal missing and is low with two or more.
//
// Reasons are stable codes in a fixed order (hrv, resting_hr, sleep), one per
// signal that is missing or not green. HRV and resting-HR codes are relative to
// the person's own baseline; none of them is a diagnosis.
func AssessReadiness(th ReadinessThresholds, hrvZ, restingHRDelta Signal, asleepMin *float64) Readiness {
	usable := func(s Signal) *float64 {
		if !finite(s.Value) || s.Nights < MinBaselineNights {
			return nil
		}
		return s.Value
	}
	signals := []struct {
		name  string
		value *float64
		level func(v float64) Level
		codes [2]string // yellow, red
	}{
		{"hrv", usable(hrvZ), func(v float64) Level {
			return pick(below(v, th.HRVZRed), below(v, th.HRVZYellow))
		}, [2]string{"hrv_below_baseline", "hrv_well_below_baseline"}},
		{"resting_hr", usable(restingHRDelta), func(v float64) Level {
			return pick(atLeast(v, th.RestingHRRed), atLeast(v, th.RestingHRYellow))
		}, [2]string{"resting_hr_above_baseline", "resting_hr_well_above_baseline"}},
		{"sleep", finiteOrNil(asleepMin), func(v float64) Level {
			return pick(below(v, th.AsleepMinRed), below(v, th.AsleepMinYellow))
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
		if severity(l) > severity(r.Level) {
			r.Level = l
		}
	}

	// Sleep has no baseline, so only the baselined signals set the night count.
	nights := math.MaxInt
	for i, s := range []Signal{hrvZ, restingHRDelta} {
		if signals[i].value != nil {
			nights = min(nights, s.Nights)
		}
	}
	switch {
	case missing >= 2 || nights == math.MaxInt:
		r.Confidence = coach.ConfidenceLow
	case missing == 1:
		r.Confidence = min2(coach.Confidence(nights), coach.ConfidenceMedium)
	default:
		r.Confidence = coach.Confidence(nights)
	}
	return r
}

// below is v < line and atLeast is v ≥ line, both allowing for float rounding
// (a 28-day mean of fractional readings lands a hair off the line).
func below(v, line float64) bool   { return v < line-tolAt(line) }
func atLeast(v, line float64) bool { return v >= line-tolAt(line) }
func tolAt(line float64) float64   { return relTol * math.Max(1, math.Abs(line)) }

func finiteOrNil(p *float64) *float64 {
	if !finite(p) {
		return nil
	}
	return p
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

// severity orders levels; unknown is the least severe, so any usable signal
// replaces it.
func severity(l Level) int {
	switch l {
	case LevelGreen:
		return 1
	case LevelYellow:
		return 2
	case LevelRed:
		return 3
	default:
		return 0
	}
}

// min2 returns the lower of two confidence levels.
func min2(a, b coach.ConfidenceLevel) coach.ConfidenceLevel {
	rank := func(c coach.ConfidenceLevel) int {
		switch c {
		case coach.ConfidenceHigh:
			return 2
		case coach.ConfidenceMedium:
			return 1
		default:
			return 0
		}
	}
	if rank(b) < rank(a) {
		return b
	}
	return a
}
