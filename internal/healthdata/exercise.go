package healthdata

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"slices"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
)

// ZoneMinutes is the time spent in each of the band's heart-rate zones.
type ZoneMinutes struct {
	Light, Moderate, Vigorous, Peak float64
}

// ExerciseHR is a session's heart rate.
type ExerciseHR struct {
	AvgBPM float64
	// MaxBPM is the highest median of maxHRWindow consecutive band samples
	// inside the session, so one optical spike is not the max: nil unless
	// asked for, beyond maxHRSessions, or with too few samples.
	MaxBPM  *float64
	ZoneMin ZoneMinutes
}

// Exercise is one workout session.
type Exercise struct {
	// ID is the record's resource name, stable across calls ("" when the
	// API sent an unexpected one).
	ID         string
	Day        coach.LocalDate // the local day it started
	Type       string          // Google's exerciseType, e.g. JIU_JITSU
	Name       string          // display name
	Start, End time.Time
	ActiveMin  float64 // without pauses
	Kcal       *float64
	AZM        float64
	HR         *ExerciseHR // nil without heart rate
	// Manual: logged by hand. The band may still have measured its heart
	// rate, so it is a separate fact from HR.
	Manual bool
	Source string
	Flags  []string // metrics.ExerciseFlags
}

// Exercises holds the sessions that started in [From, To], oldest first.
type Exercises struct {
	From, To    coach.LocalDate
	Sessions    []Exercise
	Skipped     int // records that could not be read
	OtherSource int // records from another platform
	// MaxHROmitted counts sessions with heart rate left without a max
	// because the call asked for more than maxHRSessions.
	MaxHROmitted int
}

// Exercises returns the sessions that started in [from, to]. With maxHR, each
// session with heart rate costs one more request for its samples.
func (d *Data) Exercises(ctx context.Context, from, to coach.LocalDate, maxHR bool) (Exercises, error) {
	if _, err := dayList(from, to); err != nil {
		return Exercises{}, err
	}
	// The API filters on the device's local start time; a day of margin
	// keeps a session near midnight in the configured zone.
	before, err := from.AddDays(-1)
	if err != nil {
		return Exercises{}, err
	}
	after, err := to.AddDays(1)
	if err != nil {
		return Exercises{}, err
	}
	raws, err := d.api.List(ctx, googlehealth.Exercise, before, after)
	if err != nil {
		return Exercises{}, err
	}
	out := Exercises{From: from, To: to, Sessions: []Exercise{}}
	for _, raw := range raws {
		e, err := parseExercise(raw)
		if e.Start.IsZero() {
			out.Skipped++
			continue
		}
		e.Day = coach.DateOf(e.Start, d.loc)
		if e.Day < from || e.Day > to {
			continue
		}
		switch {
		case errors.Is(err, errOtherSource):
			out.OtherSource++
		case err != nil:
			out.Skipped++
		default:
			out.Sessions = append(out.Sessions, e)
		}
	}
	slices.SortFunc(out.Sessions, func(a, b Exercise) int { return a.Start.Compare(b.Start) })
	lookups := 0
	for i := len(out.Sessions) - 1; i >= 0; i-- { // newest first, for the cap
		e := &out.Sessions[i]
		if !maxHR || e.HR == nil {
			continue
		}
		if lookups == maxHRSessions {
			out.MaxHROmitted++
			continue
		}
		lookups++
		if e.HR.MaxBPM, err = d.maxHR(ctx, e.Start, e.End); err != nil {
			return Exercises{}, err
		}
	}
	for i := range out.Sessions {
		e := &out.Sessions[i]
		var avg *float64
		if e.HR != nil {
			avg = &e.HR.AvgBPM
		}
		dur := time.Duration(e.ActiveMin * float64(time.Minute))
		e.Flags = metrics.ExerciseFlags(metrics.Exercise{Type: e.Type, Duration: dur, AvgHR: avg, ManualEntry: e.Manual})
	}
	if out.Skipped > 0 {
		d.log.Warn("unreadable exercise records", "from", string(from), "to", string(to), "skipped", out.Skipped)
	}
	return out, nil
}

// maxHR is the highest median of maxHRWindow consecutive Fitbit heart-rate
// samples in [start, end], or nil with fewer samples.
func (d *Data) maxHR(ctx context.Context, start, end time.Time) (*float64, error) {
	// The last second is included; a session of a full day keeps the
	// request within the API client's one-day window.
	stop := end.Add(time.Second)
	if limit := start.Add(24 * time.Hour); stop.After(limit) {
		stop = limit
	}
	raws, err := d.api.ListBetween(ctx, googlehealth.HeartRate, start, stop)
	if err != nil {
		return nil, err
	}
	type sample struct {
		at  time.Time
		bpm float64
	}
	var ss []sample
	unreadable := 0
	for _, raw := range raws {
		var r struct {
			DataSource dataSource `json:"dataSource"`
			HeartRate  *struct {
				BPM        *int64s `json:"beatsPerMinute"`
				SampleTime struct {
					PhysicalTime time.Time `json:"physicalTime"`
				} `json:"sampleTime"`
			} `json:"heartRate"`
		}
		if json.Unmarshal(raw, &r) != nil || r.HeartRate == nil || r.HeartRate.BPM == nil {
			unreadable++
			continue
		}
		if r.DataSource.Platform != primaryPlatform {
			continue
		}
		if v := float64(*r.HeartRate.BPM); v >= minHRBPM && v <= maxHRBPM {
			ss = append(ss, sample{r.HeartRate.SampleTime.PhysicalTime, v})
		}
	}
	if unreadable > 0 && len(ss) == 0 {
		d.log.Warn("heart rate samples arrived but none were usable", "unreadable", unreadable)
	}
	if len(ss) < maxHRWindow {
		return nil, nil
	}
	slices.SortFunc(ss, func(a, b sample) int { return a.at.Compare(b.at) })
	var best float64
	win := make([]float64, maxHRWindow)
	for i := 0; i+maxHRWindow <= len(ss); i++ {
		for j := range win {
			win[j] = ss[i+j].bpm
		}
		best = max(best, median(win))
	}
	return &best, nil
}

const (
	// maxHRWindow samples (about 10 s at the band's rate) make one max HR
	// reading: optical HR spikes for a sample or two on motion.
	maxHRWindow = 5
	// maxHRSessions bounds the heart-rate requests of one call (one per
	// session), newest sessions first.
	maxHRSessions = 31
)

const (
	minHRBPM, maxHRBPM = 20, 250
	maxSessionKcal     = 10_000
)

// resourceName is the shape of a record's name; anything else is not passed
// on as an ID.
var resourceName = regexp.MustCompile(`^users/[A-Za-z0-9_-]+/dataTypes/[a-z-]+/dataPoints/[A-Za-z0-9_.-]{1,128}$`)

type exerciseRecord struct {
	Name       string     `json:"name"`
	DataSource dataSource `json:"dataSource"`
	Exercise   *struct {
		DisplayName    string `json:"displayName"`
		ExerciseType   string `json:"exerciseType"`
		ActiveDuration string `json:"activeDuration"`
		Interval       struct {
			StartTime time.Time `json:"startTime"`
			EndTime   time.Time `json:"endTime"`
		} `json:"interval"`
		MetricsSummary struct {
			AvgHR int64s   `json:"averageHeartRateBeatsPerMinute"`
			Kcal  *float64 `json:"caloriesKcal"`
			AZM   int64s   `json:"activeZoneMinutes"`
			Zones struct {
				Light    string `json:"lightTime"`
				Moderate string `json:"moderateTime"`
				Vigorous string `json:"vigorousTime"`
				Peak     string `json:"peakTime"`
			} `json:"heartRateZoneDurations"`
		} `json:"metricsSummary"`
	} `json:"exercise"`
}

// parseExercise decodes one session; errors as parseSleep, with e.Start set
// when the interval was readable.
func parseExercise(raw json.RawMessage) (e Exercise, err error) {
	var r exerciseRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return Exercise{}, errors.New("unreadable exercise record")
	}
	x := r.Exercise
	if x == nil || x.Interval.StartTime.IsZero() || !x.Interval.EndTime.After(x.Interval.StartTime) {
		return Exercise{}, errors.New("exercise record without an interval")
	}
	e.Start, e.End = x.Interval.StartTime, x.Interval.EndTime
	if r.DataSource.Platform != primaryPlatform {
		return e, errOtherSource
	}
	span := e.End.Sub(e.Start)
	// Every real session carries an active duration: none is a renamed field.
	active, err := minutes(x.ActiveDuration, span)
	if err != nil || x.ActiveDuration == "" || span > 24*time.Hour {
		return e, errors.New("exercise record with an implausible duration")
	}
	ms := x.MetricsSummary
	e.ActiveMin, e.AZM = active, float64(ms.AZM)
	e.Type, e.Name, e.Source = clean(x.ExerciseType), clean(x.DisplayName), r.DataSource.label()
	e.Manual = r.DataSource.RecordingMethod == "MANUAL"
	if resourceName.MatchString(r.Name) {
		e.ID = r.Name
	}
	if e.AZM < 0 || e.AZM > 2*span.Minutes() {
		return e, errors.New("exercise record with implausible zone minutes")
	}
	if ms.Kcal != nil {
		if k := *ms.Kcal; math.IsNaN(k) || k < 0 || k > maxSessionKcal {
			return e, errors.New("exercise record with implausible calories")
		}
		e.Kcal = ptr(*ms.Kcal)
	}
	if ms.AvgHR != 0 { // proto3 leaves out a zero: no heart rate
		avg := float64(ms.AvgHR)
		if avg < minHRBPM || avg > maxHRBPM {
			return e, errors.New("exercise record with an implausible heart rate")
		}
		hr := &ExerciseHR{AvgBPM: avg}
		zs := ms.Zones
		if zs.Light == "" && zs.Moderate == "" && zs.Vigorous == "" && zs.Peak == "" {
			// A session with heart rate always has its zone durations.
			return e, errors.New("exercise record with heart rate but no zone times")
		}
		for _, z := range []struct {
			s   string
			dst *float64
		}{{ms.Zones.Light, &hr.ZoneMin.Light}, {ms.Zones.Moderate, &hr.ZoneMin.Moderate},
			{ms.Zones.Vigorous, &hr.ZoneMin.Vigorous}, {ms.Zones.Peak, &hr.ZoneMin.Peak}} {
			if *z.dst, err = minutes(z.s, span); err != nil {
				return e, errors.New("exercise record with implausible zone times")
			}
		}
		e.HR = hr
	}
	return e, nil
}

// minutes parses a protobuf Duration ("3600s"; "" is zero) bounded by the
// session's span, with a minute of slack for rounding.
func minutes(s string, span time.Duration) (float64, error) {
	if s == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d < 0 || d > span+time.Minute {
		return 0, errors.New("implausible duration")
	}
	return d.Minutes(), nil
}
