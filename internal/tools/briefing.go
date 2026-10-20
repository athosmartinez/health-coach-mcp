package tools

import (
	"context"
	"slices"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
)

const (
	// baselineDays is the long baseline; shortBaselineDays the recent one.
	baselineDays      = 28
	shortBaselineDays = 7
	// weightLookbackDays bounds the search for the last weigh-in.
	weightLookbackDays = 90
)

// RegisterBriefing adds morning_briefing (CAPABILITY §4.1).
func RegisterBriefing(s *mcp.Server, d CoachDeps) {
	Register(s, &mcp.Tool{
		Name: "morning_briefing",
		Description: "Morning recovery check for the night that ended on date (default today): sleep (minutes asleep " +
			"and awake, efficiency, stages, bedtime and wake time, each against the 7- and 28-day averages), overnight " +
			"HRV and resting heart rate against the 28-day baseline, yesterday's training load (sessions, Active Zone " +
			"Minutes, steps), the last weight, and a readiness level (green, yellow or red) with reason codes. Readiness " +
			"compares the user with their own recent baseline; it is a training cue, not a medical assessment. Reasons " +
			"such as missing:hrv mean that signal was left out, so a green with missing reasons rests only on the " +
			"signals left: say so. provisional:sleep means Google is still processing the night and the level may " +
			"change. unknown means no signal was usable: do not infer a level. readiness.confidence qualifies the " +
			"level; coverage qualifies the averages. Values are null when not recorded. Mention quality_flags and " +
			"follow the notice.",
		Annotations: readOnly,
	}, briefing{d}.handle)
}

type briefingIn struct {
	Date coach.LocalDate `json:"date,omitempty" jsonschema:"local day the night ended (YYYY-MM-DD); omitted means today"`
}

// Briefing is morning_briefing's data.
type Briefing struct {
	Sleep         BriefingSleep     `json:"sleep"`
	HRV           BriefingHRV       `json:"hrv"`
	RestingHR     BriefingRestingHR `json:"resting_hr"`
	YesterdayLoad DayLoad           `json:"yesterday_load"`
	Readiness     metrics.Readiness `json:"readiness"`
	Body          LastWeight        `json:"body"`
	Notice        string            `json:"notice"`
}

// BriefingSleep is the night, in minutes, against the averages before it.
type BriefingSleep struct {
	AsleepMin float64 `json:"asleep_min"`
	AwakeMin  float64 `json:"awake_min"`
	// EfficiencyPct is time asleep as a percent of time in bed.
	EfficiencyPct *float64  `json:"efficiency_pct"`
	StagesMin     StagesMin `json:"stages_min"`
	Start         time.Time `json:"start"`
	End           time.Time `json:"end"`
	Vs7d          SleepVs   `json:"vs_7d"`
	Vs28d         SleepVs   `json:"vs_28d"`
}

// StagesMin holds minutes per sleep stage; deep, light and REM are null on a
// night without final stages.
type StagesMin struct {
	Deep  *float64 `json:"deep"`
	Light *float64 `json:"light"`
	REM   *float64 `json:"rem"`
	Awake float64  `json:"awake"`
}

// SleepVs compares the night with the average of the nights before it;
// each field is null when no earlier night has the value.
type SleepVs struct {
	AsleepMin     *Versus `json:"asleep_min"`
	AwakeMin      *Versus `json:"awake_min"`
	EfficiencyPct *Versus `json:"efficiency_pct"`
	DeepMin       *Versus `json:"deep_min"`
	LightMin      *Versus `json:"light_min"`
	REMMin        *Versus `json:"rem_min"`
}

// BriefingHRV is the night's median rMSSD against the 28-day baseline.
type BriefingHRV struct {
	MedianMS      *float64 `json:"median_ms"`
	DeltaPctVs28d *float64 `json:"delta_pct_vs_28d"`
	ZScoreVs28d   *float64 `json:"z_score_vs_28d"`
}

// BriefingRestingHR is the day's resting heart rate against the 28-day baseline.
type BriefingRestingHR struct {
	BPM           *float64 `json:"bpm"`
	DeltaBPMVs28d *float64 `json:"delta_bpm_vs_28d"`
}

// DayLoad is one day's training load.
type DayLoad struct {
	Date      coach.LocalDate `json:"date"`
	Exercises []LoadSession   `json:"exercises"`
	AZMMin    *float64        `json:"azm_min"`
	Steps     *float64        `json:"steps"`
}

// LoadSession is a session in a load summary: its type, never its free-text name.
type LoadSession struct {
	Type         string   `json:"type"`
	Minutes      float64  `json:"minutes"`
	AvgHRBPM     *float64 `json:"avg_hr_bpm"`
	QualityFlags []string `json:"quality_flags"`
}

// LastWeight is the latest weigh-in on or before the day.
type LastWeight struct {
	WeightKg *float64         `json:"weight_kg"`
	Date     *coach.LocalDate `json:"date"`
}

type briefing struct{ CoachDeps }

func (b briefing) handle(ctx context.Context, _ *mcp.CallToolRequest, in briefingIn) (coach.Envelope[Briefing], error) {
	var zero coach.Envelope[Briefing]
	day, err := b.day(in.Date)
	if err != nil {
		return zero, err
	}
	from, err := day.AddDays(-baselineDays)
	if err != nil {
		return zero, err
	}
	rec, err := b.Health.Recovery(ctx, from, day)
	if err != nil {
		return zero, err
	}
	n, ok := rec.Nights[day]
	if !ok {
		return zero, noNight(rec)
	}
	yesterday, err := day.AddDays(-1)
	if err != nil {
		return zero, err
	}
	act, err := b.Health.Activity(ctx, yesterday, yesterday)
	if err != nil {
		return zero, err
	}
	ex, err := b.Health.Exercises(ctx, yesterday, yesterday, false)
	if err != nil {
		return zero, err
	}
	bodyFrom, err := day.AddDays(-(weightLookbackDays - 1))
	if err != nil {
		return zero, err
	}
	body, err := b.Health.Body(ctx, bodyFrom, day)
	if err != nil {
		return zero, err
	}

	var flags flagSet
	sources := sourceSet{}
	sources.add(rec.Sources...)
	out := Briefing{Notice: readinessNotice + " " + vendorNotice}
	if out.Sleep, err = sleepOf(rec, n, day); err != nil {
		return zero, err
	}
	sig, err := signalsOf(rec, day, &flags)
	if err != nil {
		return zero, err
	}
	out.HRV = BriefingHRV{MedianMS: round(sig.hrv), DeltaPctVs28d: round(sig.hrvDeltaPct), ZScoreVs28d: roundTo(sig.hrvZ, 2)}
	out.RestingHR = BriefingRestingHR{BPM: round(sig.rhr), DeltaBPMVs28d: round(sig.rhrDelta)}

	asleep := n.AsleepMin
	out.Readiness = metrics.AssessReadiness(metrics.DefaultThresholds(),
		metrics.Signal{Value: sig.hrvZ, Nights: sig.hrvN}, metrics.Signal{Value: sig.rhrDelta, Nights: sig.rhrN}, &asleep)
	if n.Provisional {
		// Minutes asleep and HRV may still change after the next sync.
		out.Readiness.Reasons = append(out.Readiness.Reasons, reasonProvisionalSleep)
		out.Readiness.Confidence = coach.ConfidenceLow
	}

	sleepBase, err := baselineOf(rec, healthdata.KeyAsleep, day)
	if err != nil {
		return zero, err
	}
	nDays := min(sleepBase.N, sig.hrvN, sig.rhrN)

	out.YesterdayLoad = loadOf(act, ex, yesterday, &flags, sources)
	if d, r, ok := healthdata.Last(body.Weight); ok {
		out.Body = LastWeight{WeightKg: round(&r.Value), Date: &d}
		sources.add(r.Source)
	}
	flags.add(flagUnreadableRecords, act.Skipped+ex.Skipped+body.Skipped > 0)
	// Exercise flags last, after the day-level ones.
	for _, s := range out.YesterdayLoad.Exercises {
		for _, f := range s.QualityFlags {
			flags.add(f, true)
		}
	}
	return coach.NewEnvelope(out, nDays, sources.list(), flags, b.Now()), nil
}

// noNight explains a missing night by its likely cause.
func noNight(rec healthdata.Recovery) coach.ToolError {
	te := coach.ToolError{
		Code: coach.CodeNoData, Message: "no main sleep recorded for the night ending on that date",
		Hint: "the band may not have synced yet: open the Fitbit app, then call again",
	}
	switch {
	case rec.Skipped > 0:
		te.Hint = "some sleep or heart records could not be read; call again later, and report it if it persists"
	case slices.Contains(rec.Empty, googlehealth.Sleep):
		te.Hint = "sleep arrived only from another platform (such as Apple Health); the coach reads the band's sleep: " +
			"check that the band was worn and has synced"
	}
	return te
}

func sleepOf(rec healthdata.Recovery, n healthdata.Night, day coach.LocalDate) (BriefingSleep, error) {
	s := BriefingSleep{
		AsleepMin: round1(n.AsleepMin), AwakeMin: round1(n.AwakeMin),
		EfficiencyPct: round(efficiency(n.AsleepMin, n.InBedMin)),
		StagesMin:     StagesMin{Deep: round(n.DeepMin), Light: round(n.LightMin), REM: round(n.REMMin), Awake: round1(n.AwakeMin)},
		Start:         n.Start, End: n.End,
	}
	fields := []struct {
		key   string
		value *float64
		set   func(*SleepVs, *Versus)
	}{
		{healthdata.KeyAsleep, &n.AsleepMin, func(v *SleepVs, x *Versus) { v.AsleepMin = x }},
		{healthdata.KeyAwake, &n.AwakeMin, func(v *SleepVs, x *Versus) { v.AwakeMin = x }},
		{healthdata.KeyDeep, n.DeepMin, func(v *SleepVs, x *Versus) { v.DeepMin = x }},
		{healthdata.KeyLight, n.LightMin, func(v *SleepVs, x *Versus) { v.LightMin = x }},
		{healthdata.KeyREM, n.REMMin, func(v *SleepVs, x *Versus) { v.REMMin = x }},
	}
	for _, f := range fields {
		series, err := rec.BaselineSeries(f.key)
		if err != nil {
			return BriefingSleep{}, err
		}
		for _, w := range []struct {
			days int
			vs   *SleepVs
		}{{shortBaselineDays, &s.Vs7d}, {baselineDays, &s.Vs28d}} {
			x, err := versus(series, f.value, day, w.days)
			if err != nil {
				return BriefingSleep{}, err
			}
			f.set(w.vs, x)
		}
	}
	eff, err := efficiencySeries(rec)
	if err != nil {
		return BriefingSleep{}, err
	}
	tonight := efficiency(n.AsleepMin, n.InBedMin)
	if s.Vs7d.EfficiencyPct, err = versus(eff, tonight, day, shortBaselineDays); err != nil {
		return BriefingSleep{}, err
	}
	if s.Vs28d.EfficiencyPct, err = versus(eff, tonight, day, baselineDays); err != nil {
		return BriefingSleep{}, err
	}
	return s, nil
}

func efficiency(asleep, inBed float64) *float64 {
	if inBed <= 0 {
		return nil
	}
	v := asleep / inBed * 100
	return &v
}

// efficiencySeries is asleep / in bed per night, over the baseline nights.
func efficiencySeries(rec healthdata.Recovery) ([]metrics.Point, error) {
	asleep, err := rec.BaselineSeries(healthdata.KeyAsleep)
	if err != nil {
		return nil, err
	}
	inBed, err := rec.BaselineSeries(healthdata.KeyInBed)
	if err != nil {
		return nil, err
	}
	out := make([]metrics.Point, len(asleep))
	for i, p := range asleep {
		out[i] = metrics.Point{Date: p.Date}
		if p.Value != nil && i < len(inBed) && inBed[i].Date == p.Date && inBed[i].Value != nil {
			out[i].Value = efficiency(*p.Value, *inBed[i].Value)
		}
	}
	return out, nil
}

// loadOf summarizes a day's sessions, AZM and steps.
func loadOf(act healthdata.Activity, ex healthdata.Exercises, day coach.LocalDate, flags *flagSet, sources sourceSet) DayLoad {
	l := DayLoad{Date: day, Exercises: []LoadSession{}}
	a, ok := act.Days[day]
	if ok {
		l.AZMMin, l.Steps = round(a.AZM), round(a.Steps)
	}
	// A day missing because its row was unreadable is not a day off the
	// wrist: unreadable_records covers it.
	flags.add(flagNotWorn, (ok && !a.Worn) || (!ok && act.Skipped == 0))
	flags.add(flagOtherSourceSessions, ex.OtherSource > 0)
	for i, s := range ex.Sessions {
		if i == maxSessions {
			flags.add(flagSessionsTruncated, true)
			break
		}
		ls := LoadSession{Type: s.Type, Minutes: round1(s.ActiveMin), QualityFlags: append([]string{}, s.Flags...)}
		if s.HR != nil {
			ls.AvgHRBPM = round(&s.HR.AvgBPM)
		}
		l.Exercises = append(l.Exercises, ls)
		sources.add(s.Source)
	}
	return l
}
