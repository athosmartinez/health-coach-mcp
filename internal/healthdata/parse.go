package healthdata

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// primaryPlatform is the source the coach trusts for sleep, HRV and resting
// HR. Apple Health copies of the same nights arrive as HEALTH_KIT records and
// are dropped, so a night is never counted twice or taken from the phone.
const primaryPlatform = "FITBIT"

// Reasons a readable record is left out; the caller counts them.
var (
	errOtherSource = errors.New("record from another platform")
	errNoValue     = errors.New("record without a value")
)

type dataSource struct {
	Platform        string `json:"platform"`
	RecordingMethod string `json:"recordingMethod"`
	Device          struct {
		DisplayName string `json:"displayName"`
	} `json:"device"`
}

const maxLabelRunes = 64

// label names the source in envelopes: the device when known, else the
// platform.
func (d dataSource) label() string {
	if s := clean(d.Device.DisplayName); s != "" {
		return s
	}
	return clean(d.Platform)
}

// clean makes a Google-supplied string safe to show: it reaches the cache and
// tool output, which an LLM reads, so control, format (bidi overrides,
// zero-width) and line/paragraph separator characters are dropped and the
// length is capped.
func clean(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n == maxLabelRunes {
			break
		}
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			continue
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}

// int64s is an int64 the API sends as a JSON string. Proto3 JSON omits
// zero values, so an absent field decodes as 0.
type int64s int64

func (n *int64s) UnmarshalJSON(b []byte) error {
	v, err := strconv.ParseInt(string(bytes.Trim(b, `"`)), 10, 64)
	if err != nil {
		return errors.New("not an integer")
	}
	*n = int64s(v)
	return nil
}

type sleepRecord struct {
	DataSource dataSource `json:"dataSource"`
	Sleep      *struct {
		Type     string `json:"type"`
		Interval struct {
			StartTime time.Time `json:"startTime"`
			EndTime   time.Time `json:"endTime"`
		} `json:"interval"`
		Metadata struct {
			Nap          bool   `json:"nap"`
			Processed    bool   `json:"processed"`
			StagesStatus string `json:"stagesStatus"`
		} `json:"metadata"`
		Summary *struct {
			MinutesAsleep        int64s  `json:"minutesAsleep"`
			MinutesAwake         int64s  `json:"minutesAwake"`
			MinutesInSleepPeriod int64s  `json:"minutesInSleepPeriod"`
			StagesSummary        []stage `json:"stagesSummary"`
		} `json:"summary"`
	} `json:"sleep"`
}

type stage struct {
	Type    string `json:"type"`
	Minutes int64s `json:"minutes"`
}

// session is one sleep record, checked and in the coach's units.
type session struct {
	start, end           time.Time
	asleep, awake, inBed float64
	stages               *Stages // nil without final stages
	nap                  bool
	// settled: processed, with final stages or a classic record. A night that
	// is not settled may still change and is never cached.
	settled     bool
	unknownType bool // a sleep type other than STAGES or CLASSIC, read without stages
	source      string
}

const (
	maxSessionMinutes = 24 * 60
	// minuteSlack absorbs rounding between Fitbit's separately rounded
	// minute fields when checking that the parts fit the whole.
	minuteSlack = 2
)

// parseSleep decodes one record. errOtherSource marks a record left out on
// purpose; any other error a record that cannot be read. When the interval was
// readable, s.start and s.end are set even with an error, so the caller can
// tell which day it concerns. Error texts never quote the record.
func parseSleep(raw json.RawMessage) (s session, err error) {
	var r sleepRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return session{}, errors.New("unreadable sleep record")
	}
	sl := r.Sleep
	if sl == nil || sl.Interval.StartTime.IsZero() || !sl.Interval.EndTime.After(sl.Interval.StartTime) {
		return session{}, errors.New("sleep record without an interval")
	}
	s.start, s.end = sl.Interval.StartTime, sl.Interval.EndTime
	if r.DataSource.Platform != primaryPlatform {
		return s, errOtherSource
	}
	if sl.Summary == nil {
		return s, errors.New("sleep record without a summary")
	}
	sum := sl.Summary
	s.asleep, s.awake, s.inBed = float64(sum.MinutesAsleep), float64(sum.MinutesAwake), float64(sum.MinutesInSleepPeriod)
	s.nap, s.source = sl.Metadata.Nap, r.DataSource.label()
	if s.inBed <= 0 || s.inBed > maxSessionMinutes || s.asleep <= 0 || s.awake < 0 ||
		s.asleep+s.awake > s.inBed+minuteSlack {
		return s, errors.New("sleep record with implausible minutes")
	}
	switch sl.Type {
	case "STAGES":
		// Stages still being computed may be missing or zero: leave them out
		// and check only final ones.
		if sl.Metadata.StagesStatus == "SUCCEEDED" {
			st, err := stageMinutes(sum.StagesSummary, s.asleep, s.inBed)
			if err != nil {
				return s, err
			}
			s.stages = &st
		}
		s.settled = sl.Metadata.Processed && s.stages != nil
	case "CLASSIC":
		s.settled = sl.Metadata.Processed
	default:
		s.unknownType = true
	}
	return s, nil
}

var errStageMinutes = errors.New("sleep record with implausible stage minutes")

// stageMinutes returns the deep, light and REM minutes. Every type must be known
// and appear once, and the three must add up to the time asleep (Fitbit's
// asleep minutes are their sum): a renamed or split stage would otherwise read
// as zero minutes and be cached as final.
func stageMinutes(list []stage, asleep, inBed float64) (Stages, error) {
	var out Stages
	if len(list) == 0 {
		return out, errors.New("staged sleep record without stages")
	}
	seen := map[string]bool{}
	for _, st := range list {
		m := float64(st.Minutes)
		if seen[st.Type] || m < 0 || m > inBed {
			return out, errStageMinutes
		}
		seen[st.Type] = true
		switch st.Type {
		case "DEEP":
			out.DeepMin = m
		case "LIGHT":
			out.LightMin = m
		case "REM":
			out.REMMin = m
		case "AWAKE":
		default:
			return out, errors.New("sleep record with an unknown stage")
		}
	}
	if math.Abs(out.DeepMin+out.LightMin+out.REMMin-asleep) > minuteSlack {
		return out, errStageMinutes
	}
	return out, nil
}

type hrvRecord struct {
	DataSource           dataSource `json:"dataSource"`
	HeartRateVariability *struct {
		SampleTime struct {
			PhysicalTime time.Time `json:"physicalTime"`
		} `json:"sampleTime"`
		RMSSD *float64 `json:"rootMeanSquareOfSuccessiveDifferencesMilliseconds"`
	} `json:"heartRateVariability"`
}

type hrvSample struct {
	at    time.Time
	rmssd float64
}

const maxRMSSD = 500

// parseHRV decodes one sample; errors as parseSleep, with h.at set when the
// sample time was readable.
func parseHRV(raw json.RawMessage) (h hrvSample, err error) {
	var r hrvRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return hrvSample{}, errors.New("unreadable HRV sample")
	}
	v := r.HeartRateVariability
	if v == nil || v.SampleTime.PhysicalTime.IsZero() {
		return hrvSample{}, errors.New("HRV sample without a time")
	}
	h.at = v.SampleTime.PhysicalTime
	if r.DataSource.Platform != primaryPlatform {
		return h, errOtherSource
	}
	if v.RMSSD == nil { // the field is optional
		return h, errNoValue
	}
	x := *v.RMSSD
	if math.IsNaN(x) || math.IsInf(x, 0) || x <= 0 || x > maxRMSSD {
		return h, errors.New("HRV sample out of range")
	}
	h.rmssd = x
	return h, nil
}

type restingRecord struct {
	DataSource            dataSource `json:"dataSource"`
	DailyRestingHeartRate *struct {
		BeatsPerMinute int64s `json:"beatsPerMinute"`
		Date           struct {
			Year  int `json:"year"`
			Month int `json:"month"`
			Day   int `json:"day"`
		} `json:"date"`
		Metadata struct {
			CalculationMethod string `json:"calculationMethod"`
		} `json:"dailyRestingHeartRateMetadata"`
	} `json:"dailyRestingHeartRate"`
}

type restingDay struct {
	date   coach.LocalDate
	bpm    float64
	method string
	source string
}

const minRestingBPM, maxRestingBPM = 20, 250

// parseResting decodes one day; errors as parseSleep, with d.date set when
// the date was readable.
func parseResting(raw json.RawMessage) (d restingDay, err error) {
	var r restingRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return restingDay{}, errors.New("unreadable resting heart rate record")
	}
	v := r.DailyRestingHeartRate
	if v == nil {
		return restingDay{}, errors.New("resting heart rate record without a value")
	}
	t := time.Date(v.Date.Year, time.Month(v.Date.Month), v.Date.Day, 0, 0, 0, 0, time.UTC)
	if v.Date.Year == 0 || t.Year() != v.Date.Year || int(t.Month()) != v.Date.Month || t.Day() != v.Date.Day {
		return restingDay{}, errors.New("resting heart rate record with an invalid date")
	}
	d.date = coach.LocalDate(t.Format(time.DateOnly))
	if r.DataSource.Platform != primaryPlatform {
		return d, errOtherSource
	}
	bpm := float64(v.BeatsPerMinute)
	if bpm < minRestingBPM || bpm > maxRestingBPM {
		return d, errors.New("resting heart rate out of range")
	}
	d.bpm, d.method, d.source = bpm, clean(v.Metadata.CalculationMethod), r.DataSource.label()
	return d, nil
}
