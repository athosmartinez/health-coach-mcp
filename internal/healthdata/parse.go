package healthdata

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// primaryPlatform is the source the coach trusts for sleep, HRV and resting
// HR. Apple Health copies of the same nights arrive as HEALTH_KIT records and
// are dropped, so a night is never counted twice or taken from the phone.
const primaryPlatform = "FITBIT"

type dataSource struct {
	Platform string `json:"platform"`
	Device   struct {
		DisplayName string `json:"displayName"`
	} `json:"device"`
}

// label names the source in envelopes: the device when known, else the platform.
func (d dataSource) label() string {
	if d.Device.DisplayName != "" {
		return d.Device.DisplayName
	}
	return d.Platform
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
			MinutesAsleep        int64s `json:"minutesAsleep"`
			MinutesAwake         int64s `json:"minutesAwake"`
			MinutesInSleepPeriod int64s `json:"minutesInSleepPeriod"`
			StagesSummary        []struct {
				Type    string `json:"type"`
				Minutes int64s `json:"minutes"`
			} `json:"stagesSummary"`
		} `json:"summary"`
	} `json:"sleep"`
}

// session is one sleep record, checked and in the coach's units.
type session struct {
	start, end           time.Time
	asleep, awake, inBed float64
	deep, light, rem     *float64 // nil for a night without stages
	nap                  bool
	settled              bool // processed, and stages final when it has them
	source               string
}

const maxSessionMinutes = 24 * 60

// parseSleep decodes one record. ok is false for a record of another source
// (not an error); err marks a record that cannot be read. Error texts never
// quote the record.
func parseSleep(raw json.RawMessage) (s session, ok bool, err error) {
	var r sleepRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return session{}, false, errors.New("unreadable sleep record")
	}
	if r.DataSource.Platform != primaryPlatform {
		return session{}, false, nil
	}
	sl := r.Sleep
	if sl == nil || sl.Summary == nil || sl.Interval.StartTime.IsZero() || !sl.Interval.EndTime.After(sl.Interval.StartTime) {
		return session{}, false, errors.New("sleep record without an interval or summary")
	}
	sum := sl.Summary
	s = session{
		start: sl.Interval.StartTime, end: sl.Interval.EndTime,
		asleep: float64(sum.MinutesAsleep), awake: float64(sum.MinutesAwake), inBed: float64(sum.MinutesInSleepPeriod),
		nap:    sl.Metadata.Nap,
		source: r.DataSource.label(),
	}
	if s.asleep < 0 || s.awake < 0 || s.inBed <= 0 || s.inBed > maxSessionMinutes || s.asleep > s.inBed {
		return session{}, false, errors.New("sleep record with implausible minutes")
	}
	stages := sl.Type == "STAGES"
	if stages {
		var deep, light, rem float64
		for _, st := range sum.StagesSummary {
			switch st.Type {
			case "DEEP":
				deep = float64(st.Minutes)
			case "LIGHT":
				light = float64(st.Minutes)
			case "REM":
				rem = float64(st.Minutes)
			}
		}
		s.deep, s.light, s.rem = &deep, &light, &rem
	}
	s.settled = sl.Metadata.Processed && (!stages || sl.Metadata.StagesStatus == "SUCCEEDED")
	return s, true, nil
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

// parseHRV decodes one sample. ok is false for another source or a sample
// without an rMSSD value (the field is optional).
func parseHRV(raw json.RawMessage) (h hrvSample, ok bool, err error) {
	var r hrvRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return hrvSample{}, false, errors.New("unreadable HRV sample")
	}
	if r.DataSource.Platform != primaryPlatform {
		return hrvSample{}, false, nil
	}
	v := r.HeartRateVariability
	if v == nil || v.SampleTime.PhysicalTime.IsZero() {
		return hrvSample{}, false, errors.New("HRV sample without a time")
	}
	if v.RMSSD == nil {
		return hrvSample{}, false, nil
	}
	if x := *v.RMSSD; math.IsNaN(x) || math.IsInf(x, 0) || x <= 0 || x > 500 {
		return hrvSample{}, false, errors.New("HRV sample out of range")
	}
	return hrvSample{at: v.SampleTime.PhysicalTime, rmssd: *v.RMSSD}, true, nil
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

func parseResting(raw json.RawMessage) (d restingDay, ok bool, err error) {
	var r restingRecord
	if err := json.Unmarshal(raw, &r); err != nil {
		return restingDay{}, false, errors.New("unreadable resting heart rate record")
	}
	if r.DataSource.Platform != primaryPlatform {
		return restingDay{}, false, nil
	}
	v := r.DailyRestingHeartRate
	if v == nil {
		return restingDay{}, false, errors.New("resting heart rate record without a value")
	}
	t := time.Date(v.Date.Year, time.Month(v.Date.Month), v.Date.Day, 0, 0, 0, 0, time.UTC)
	if v.Date.Year == 0 || t.Year() != v.Date.Year || int(t.Month()) != v.Date.Month || t.Day() != v.Date.Day {
		return restingDay{}, false, errors.New("resting heart rate record with an invalid date")
	}
	if bpm := float64(v.BeatsPerMinute); bpm < 20 || bpm > 250 {
		return restingDay{}, false, errors.New("resting heart rate out of range")
	}
	return restingDay{
		date: coach.LocalDate(t.Format(time.DateOnly)), bpm: float64(v.BeatsPerMinute),
		method: v.Metadata.CalculationMethod, source: r.DataSource.label(),
	}, true, nil
}
