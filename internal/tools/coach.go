package tools

import (
	"context"
	"errors"
	"math"
	"slices"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// Targets is the part of the store the coach-moment tools read.
type Targets interface {
	TargetInForce(ctx context.Context, day coach.LocalDate) (store.Target, error)
}

// CoachDeps is what the coach-moment tools (CAPABILITY §4.1) need.
type CoachDeps struct {
	Health healthdata.Source
	// Targets may be nil: the tools then report targets as not set.
	Targets Targets
	Now     func() time.Time
	// Loc defines the local day (I4).
	Loc *time.Location
}

func (d CoachDeps) today() coach.LocalDate { return coach.Today(d.Now(), d.Loc) }

// day resolves an optional date argument: omitted is today, and a day after
// today has no data yet.
func (d CoachDeps) day(in coach.LocalDate) (coach.LocalDate, error) {
	today := d.today()
	if in == "" {
		return today, nil
	}
	if in > today {
		return "", coach.ToolError{Code: coach.CodeInvalidInput, Message: "date is after today", Hint: "omit date for today"}
	}
	return in, nil
}

// target returns the target in force on day, nil when none was ever set.
func (d CoachDeps) target(ctx context.Context, day coach.LocalDate) (*store.Target, error) {
	if d.Targets == nil {
		return nil, nil
	}
	t, err := d.Targets.TargetInForce(ctx, day)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// Quality flags the coach-moment tools add to metrics' own.
const (
	flagProvisionalSleep  = "provisional_sleep" // Google has not finished processing the night
	flagHRVLowCoverage    = "hrv_low_coverage"  // HRV withheld: samples cover too little of the night
	flagNonStandardRHR    = "non_standard_resting_hr"
	flagUnreadableRecords = "unreadable_records" // some records could not be read and were left out
	flagUnusableRecords   = "unusable_records"   // records arrived for a type but none could be used
	flagNotWorn           = "band_not_worn"      // no band data on the day: totals are estimates
	flagSessionsTruncated = "sessions_truncated" // more sessions than one response carries
	flagMaxHROmitted      = "max_hr_omitted"     // some sessions left without a max heart rate
)

// maxSessions caps the sessions one response lists.
const maxSessions = 20

// flagSet collects quality flags once each, in the order first added.
type flagSet []string

func (f *flagSet) add(flag string, when bool) {
	if when && !slices.Contains(*f, flag) {
		*f = append(*f, flag)
	}
}

// sourceSet collects source labels, sorted and once each.
type sourceSet map[string]bool

func (s sourceSet) add(labels ...string) {
	for _, l := range labels {
		if l != "" {
			s[l] = true
		}
	}
}

func (s sourceSet) list() []string {
	out := make([]string, 0, len(s))
	for l := range s {
		out = append(out, l)
	}
	slices.Sort(out)
	return out
}

// round keeps one decimal: the readings are not more precise than that.
func round(p *float64) *float64 { return roundTo(p, 1) }

func roundTo(p *float64, digits int) *float64 {
	if p == nil || math.IsNaN(*p) || math.IsInf(*p, 0) {
		return nil
	}
	f := math.Pow(10, float64(digits))
	v := math.Round(*p*f) / f
	return &v
}

// Versus is a value against the average of the days before it.
type Versus struct {
	Avg float64 `json:"avg"`
	// Delta is the day's value minus Avg; null when the day has no value.
	Delta *float64 `json:"delta"`
	NDays int      `json:"n_days"`
}

// versus compares value with the days [day−days, day−1] of series, nil when
// none of them has a value.
func versus(series []metrics.Point, value *float64, day coach.LocalDate, days int) (*Versus, error) {
	b, err := metrics.Baseline(series, day, days)
	if err != nil || b.N == 0 {
		return nil, err
	}
	return &Versus{Avg: *round(&b.Mean), Delta: round(metrics.Delta(value, b)), NDays: b.N}, nil
}
