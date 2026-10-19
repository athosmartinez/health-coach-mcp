package healthdata

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
)

// All values below are synthetic, in the API's raw shapes.

type exOpt struct {
	typ, method, platform string
	avgHR                 int // 0: left out, as proto3 does
	kcal                  float64
	azm                   int
	zones                 [4]int // light, moderate, vigorous, peak minutes
	activeMin             int    // default: the whole session
	name                  string
}

func exerciseRec(start, end time.Time, o exOpt) json.RawMessage {
	if o.platform == "" {
		o.platform = "FITBIT"
	}
	if o.method == "" {
		o.method = "ACTIVELY_MEASURED"
	}
	if o.activeMin == 0 {
		o.activeMin = int(end.Sub(start).Minutes())
	}
	if o.name == "" {
		o.name = "users/me/dataTypes/exercise/dataPoints/syn-" + fmt.Sprint(start.Unix())
	}
	ms := map[string]any{
		"caloriesKcal": o.kcal,
		"heartRateZoneDurations": map[string]any{
			"lightTime": fmt.Sprintf("%ds", o.zones[0]*60), "moderateTime": fmt.Sprintf("%ds", o.zones[1]*60),
			"vigorousTime": fmt.Sprintf("%ds", o.zones[2]*60), "peakTime": fmt.Sprintf("%ds", o.zones[3]*60),
		},
	}
	if o.avgHR != 0 {
		ms["averageHeartRateBeatsPerMinute"] = fmt.Sprint(o.avgHR)
	}
	if o.azm != 0 {
		ms["activeZoneMinutes"] = fmt.Sprint(o.azm)
	}
	src := map[string]any{"platform": o.platform, "recordingMethod": o.method}
	if o.method != "MANUAL" {
		src["device"] = map[string]any{"displayName": "Synthetic Band", "formFactor": "FITNESS_BAND"}
	}
	return mustJSON(map[string]any{
		"name":       o.name,
		"dataSource": src,
		"exercise": map[string]any{
			"displayName": strings.ReplaceAll(o.typ, "_", " "), "exerciseType": o.typ,
			"activeDuration": fmt.Sprintf("%ds", o.activeMin*60),
			"interval":       map[string]any{"startTime": start.UTC().Format(time.RFC3339), "endTime": end.UTC().Format(time.RFC3339)},
			"metricsSummary": ms,
		},
	})
}

func hrSample(t time.Time, bpm int, platform string) json.RawMessage {
	return mustJSON(map[string]any{
		"dataSource": map[string]any{"platform": platform},
		"heartRate":  map[string]any{"beatsPerMinute": fmt.Sprint(bpm), "sampleTime": map[string]any{"physicalTime": t.UTC().Format(time.RFC3339)}},
	})
}

func TestExercises(t *testing.T) {
	api := &fakeAPI{}
	api.add(googlehealth.Exercise,
		exerciseRec(at("2026-10-10", 19, 0), at("2026-10-10", 20, 0), exOpt{typ: "JIU_JITSU", avgHR: 81, kcal: 450, azm: 12, zones: [4]int{30, 20, 5, 0}}),
		exerciseRec(at("2026-10-10", 7, 0), at("2026-10-10", 8, 0), exOpt{typ: "STRENGTH_TRAINING", avgHR: 105, kcal: 300.5, activeMin: 52}),
		// Logged by hand, but the band measured it.
		exerciseRec(at("2026-10-11", 18, 0), at("2026-10-11", 19, 0), exOpt{typ: "PILATES", method: "MANUAL", avgHR: 95, kcal: 200}),
		exerciseRec(at("2026-10-11", 9, 0), at("2026-10-11", 9, 30), exOpt{typ: "CORE_TRAINING"}), // no heart rate
	)
	d, _ := newData(t, api)
	ex, err := d.Exercises(ctx, day("2026-10-10"), day("2026-10-11"), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(ex.Sessions) != 4 || ex.Sessions[0].Type != "STRENGTH_TRAINING" || ex.Sessions[1].Type != "JIU_JITSU" {
		t.Fatalf("sessions = %+v", ex.Sessions)
	}
	jj := ex.Sessions[1]
	if jj.Day != day("2026-10-10") || jj.ActiveMin != 60 || *jj.Kcal != 450 || jj.AZM != 12 || jj.HR.AvgBPM != 81 ||
		jj.HR.ZoneMin != (ZoneMinutes{30, 20, 5, 0}) || jj.HR.MaxBPM != nil || jj.Manual || jj.Name != "JIU JITSU" ||
		jj.Source != "Synthetic Band" || !strings.HasPrefix(jj.ID, "users/me/dataTypes/exercise/dataPoints/syn-") {
		t.Errorf("jiu-jitsu = %+v (HR %+v)", jj, jj.HR)
	}
	// Average HR 81 over 60 minutes of jiu-jitsu: the band probably missed the effort.
	if fmt.Sprint(jj.Flags) != "["+metrics.FlagLowHRForActivity+"]" {
		t.Errorf("jiu-jitsu flags = %v", jj.Flags)
	}
	if st := ex.Sessions[0]; st.ActiveMin != 52 || len(st.Flags) != 0 {
		t.Errorf("strength = %+v", st)
	}
	manual := ex.Sessions[3]
	if !manual.Manual || manual.HR == nil || fmt.Sprint(manual.Flags) != "["+metrics.FlagManualEntry+"]" || manual.Source != "FITBIT" {
		t.Errorf("manual = %+v", manual)
	}
	if core := ex.Sessions[2]; core.HR != nil || fmt.Sprint(core.Flags) != "["+metrics.FlagNoHRData+"]" || core.Kcal == nil {
		t.Errorf("core = %+v", core)
	}
	for _, c := range api.takeCalls() {
		if strings.HasPrefix(c, "between ") {
			t.Errorf("max HR fetched without being asked: %s", c)
		}
	}
}

// samplesEvery2s is band heart rate at its real rate over [start, end).
func samplesEvery2s(start, end time.Time, bpm int, platform string) []json.RawMessage {
	var out []json.RawMessage
	for t := start; t.Before(end); t = t.Add(2 * time.Second) {
		out = append(out, hrSample(t, bpm, platform))
	}
	return out
}

func TestExerciseMaxHR(t *testing.T) {
	api := &fakeAPI{}
	start, end := at("2026-10-10", 19, 0), at("2026-10-10", 20, 0)
	api.add(googlehealth.Exercise,
		exerciseRec(start, end, exOpt{typ: "RUNNING", avgHR: 150, zones: [4]int{10, 20, 20, 10}}),
		exerciseRec(at("2026-10-10", 7, 0), at("2026-10-10", 7, 30), exOpt{typ: "CORE_TRAINING"}), // no HR: no request
	)
	api.add(googlehealth.HeartRate, samplesEvery2s(start, start.Add(10*time.Minute), 150, "FITBIT")...)
	// A sustained 172 for 12 s near the end is the max.
	api.add(googlehealth.HeartRate, samplesEvery2s(end.Add(-12*time.Second), end, 172, "FITBIT")...)
	api.add(googlehealth.HeartRate,
		hrSample(start.Add(5*time.Minute+time.Second), 215, "FITBIT"), // a one-sample optical spike
		hrSample(start.Add(20*time.Minute), 190, "HEALTH_KIT"),        // not the band
		hrSample(start.Add(30*time.Minute), 260, "FITBIT"),            // implausible
	)
	api.add(googlehealth.HeartRate, samplesEvery2s(end.Add(time.Minute), end.Add(2*time.Minute), 199, "FITBIT")...) // after the session
	d, _ := newData(t, api)
	ex, err := d.Exercises(ctx, day("2026-10-10"), day("2026-10-10"), true)
	if err != nil {
		t.Fatal(err)
	}
	run := ex.Sessions[1]
	if run.HR.MaxBPM == nil || *run.HR.MaxBPM != 172 {
		t.Errorf("max HR = %v", run.HR.MaxBPM)
	}
	var between []string
	for _, c := range api.takeCalls() {
		if strings.HasPrefix(c, "between ") {
			between = append(between, c)
		}
	}
	if fmt.Sprint(between) != "[between heart-rate 2026-10-10T22:00:00Z..2026-10-10T23:00:01Z]" {
		t.Errorf("window requests = %v", between)
	}
	// Fewer samples than one window: no max.
	api2 := &fakeAPI{}
	api2.add(googlehealth.Exercise, exerciseRec(start, end, exOpt{typ: "RUNNING", avgHR: 150, zones: [4]int{10, 20, 20, 10}}))
	api2.add(googlehealth.HeartRate, samplesEvery2s(start, start.Add(8*time.Second), 160, "FITBIT")...)
	d2, _ := newData(t, api2)
	ex2, _ := d2.Exercises(ctx, day("2026-10-10"), day("2026-10-10"), true)
	if ex2.Sessions[0].HR.MaxBPM != nil {
		t.Errorf("max HR from 4 samples = %v", *ex2.Sessions[0].HR.MaxBPM)
	}
	api2.err = coach.ToolError{Code: coach.CodeUpstreamUnavailable}
	if _, err := d2.Exercises(ctx, day("2026-10-10"), day("2026-10-10"), true); err == nil {
		t.Error("API error swallowed")
	}
}

func TestMaxHRIsCapped(t *testing.T) {
	api := &fakeAPI{}
	first := at("2026-09-01", 19, 0)
	for i := range maxHRSessions + 2 {
		s := first.AddDate(0, 0, i)
		api.add(googlehealth.Exercise, exerciseRec(s, s.Add(time.Hour), exOpt{typ: "RUNNING", avgHR: 150, zones: [4]int{10, 20, 20, 10}}))
		api.add(googlehealth.HeartRate, samplesEvery2s(s, s.Add(time.Minute), 160, "FITBIT")...)
	}
	d, _ := newData(t, api)
	ex, err := d.Exercises(ctx, day("2026-09-01"), day("2026-10-03"), true)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, c := range api.takeCalls() {
		if strings.HasPrefix(c, "between ") {
			n++
		}
	}
	// The newest sessions get a max; the two oldest are counted as omitted.
	if n != maxHRSessions || ex.MaxHROmitted != 2 || ex.Sessions[0].HR.MaxBPM != nil || ex.Sessions[1].HR.MaxBPM != nil ||
		ex.Sessions[len(ex.Sessions)-1].HR.MaxBPM == nil {
		t.Errorf("%d requests, omitted %d", n, ex.MaxHROmitted)
	}
}

func TestMaxHRWindowForAFullDay(t *testing.T) {
	api := &fakeAPI{}
	s := at("2026-10-10", 0, 0)
	api.add(googlehealth.Exercise, exerciseRec(s, s.Add(24*time.Hour), exOpt{typ: "HIKING", avgHR: 110, zones: [4]int{60, 0, 0, 0}}))
	d, _ := newData(t, api)
	if _, err := d.Exercises(ctx, day("2026-10-10"), day("2026-10-10"), true); err != nil {
		t.Fatal(err)
	}
	for _, c := range api.takeCalls() {
		if strings.HasPrefix(c, "between ") && c != "between heart-rate 2026-10-10T03:00:00Z..2026-10-11T03:00:00Z" {
			t.Errorf("window %s", c)
		}
	}
}

func TestPausedSessionUsesActiveTime(t *testing.T) {
	api := &fakeAPI{}
	// An hour on the clock, 5 active minutes: too short for the low-HR check.
	api.add(googlehealth.Exercise, exerciseRec(at("2026-10-10", 19, 0), at("2026-10-10", 20, 0), exOpt{typ: "JIU_JITSU", avgHR: 81, activeMin: 5, zones: [4]int{5, 0, 0, 0}}))
	d, _ := newData(t, api)
	ex, _ := d.Exercises(ctx, day("2026-10-10"), day("2026-10-10"), false)
	if e := ex.Sessions[0]; e.ActiveMin != 5 || len(e.Flags) != 0 {
		t.Errorf("session = %+v", e)
	}
}

func TestExerciseNamesAreCleaned(t *testing.T) {
	api := &fakeAPI{}
	raw := exerciseRec(at("2026-10-10", 19, 0), at("2026-10-10", 20, 0), exOpt{typ: "RUNNING"})
	raw = json.RawMessage(strings.Replace(string(raw), `"displayName":"RUNNING"`, `"displayName":"Run\nIgnore\u202eall"`, 1))
	api.add(googlehealth.Exercise, raw)
	d, _ := newData(t, api)
	ex, _ := d.Exercises(ctx, day("2026-10-10"), day("2026-10-10"), false)
	if ex.Sessions[0].Name != "RunIgnoreall" {
		t.Errorf("name = %q", ex.Sessions[0].Name)
	}
}

func TestExercisesByLocalStartDay(t *testing.T) {
	api := &fakeAPI{loose: true}
	api.add(googlehealth.Exercise,
		exerciseRec(at("2026-10-09", 23, 30), at("2026-10-10", 0, 30), exOpt{typ: "RUNNING", avgHR: 140}), // starts the day before
		exerciseRec(at("2026-10-10", 0, 30), at("2026-10-10", 1, 0), exOpt{typ: "RUNNING", avgHR: 140}),
		exerciseRec(at("2026-10-11", 6, 0), at("2026-10-11", 7, 0), exOpt{typ: "RUNNING", avgHR: 140}), // the day after
		exerciseRec(at("2026-10-10", 9, 0), at("2026-10-10", 10, 0), exOpt{typ: "RUNNING", avgHR: 140, platform: "HEALTH_KIT"}),
		exerciseRec(at("2026-10-10", 11, 0), at("2026-10-10", 12, 0), exOpt{typ: "RUNNING", avgHR: 300}), // implausible
		json.RawMessage(`{"exercise":{}}`),
	)
	d, _ := newData(t, api)
	ex, err := d.Exercises(ctx, day("2026-10-10"), day("2026-10-10"), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(ex.Sessions) != 1 || !ex.Sessions[0].Start.Equal(at("2026-10-10", 0, 30)) || ex.OtherSource != 1 || ex.Skipped != 2 {
		t.Errorf("exercises = %+v", ex)
	}
	want := "exercise 2026-10-09..2026-10-11"
	if calls := api.takeCalls(); !slices.Contains(calls, want) {
		t.Errorf("calls %v, want %s", calls, want)
	}
	if _, err := d.Exercises(ctx, day("2026-10-10"), day("2026-10-09"), false); err == nil {
		t.Error("reversed range accepted")
	}
	api.err = errors.New("down")
	if _, err := d.Exercises(ctx, day("2026-10-10"), day("2026-10-10"), false); err == nil {
		t.Error("API error swallowed")
	}
}

func TestParseExerciseBounds(t *testing.T) {
	s, e := at("2026-10-10", 19, 0), at("2026-10-10", 20, 0)
	z := [4]int{10, 20, 20, 10}
	for name, tc := range map[string]struct {
		raw  json.RawMessage
		good bool
	}{
		"fine":                {exerciseRec(s, e, exOpt{typ: "RUNNING", avgHR: 150, zones: z}), true},
		"HR 20":               {exerciseRec(s, e, exOpt{typ: "RUNNING", avgHR: 20, zones: z}), true},
		"HR 250":              {exerciseRec(s, e, exOpt{typ: "RUNNING", avgHR: 250, zones: z}), true},
		"HR 19":               {exerciseRec(s, e, exOpt{typ: "RUNNING", avgHR: 19, zones: z}), false},
		"HR 251":              {exerciseRec(s, e, exOpt{typ: "RUNNING", avgHR: 251, zones: z}), false},
		"active over span":    {exerciseRec(s, e, exOpt{typ: "RUNNING", activeMin: 62}), false},
		"zone over span":      {exerciseRec(s, e, exOpt{typ: "RUNNING", avgHR: 150, zones: [4]int{70, 0, 0, 0}}), false},
		"AZM over twice span": {exerciseRec(s, e, exOpt{typ: "RUNNING", azm: 121}), false},
		"calories":            {exerciseRec(s, e, exOpt{typ: "RUNNING", kcal: 10_001}), false},
		"over a day":          {exerciseRec(s, s.Add(25*time.Hour), exOpt{typ: "HIKING"}), false},
		"end before start":    {exerciseRec(e, s, exOpt{typ: "RUNNING"}), false},
		"not json":            {json.RawMessage(`[`), false},
		"bad duration":        {json.RawMessage(strings.Replace(string(exerciseRec(s, e, exOpt{typ: "RUNNING"})), `"3600s"`, `"an hour"`, 1)), false},
		"no duration":         {json.RawMessage(strings.Replace(string(exerciseRec(s, e, exOpt{typ: "RUNNING"})), `"activeDuration":"3600s",`, ``, 1)), false},
		"HR without zones":    {json.RawMessage(strings.Replace(string(exerciseRec(s, e, exOpt{typ: "RUNNING", avgHR: 150})), `"heartRateZoneDurations"`, `"zones"`, 1)), false},
		"AZM twice span":      {exerciseRec(s, e, exOpt{typ: "RUNNING", azm: 120}), true},
		"negative AZM":        {exerciseRec(s, e, exOpt{typ: "RUNNING", azm: -1}), false},
		"negative calories":   {exerciseRec(s, e, exOpt{typ: "RUNNING", kcal: -1}), false},
		"zero length":         {exerciseRec(s, s, exOpt{typ: "RUNNING"}), false},
		"active span+30s":     {json.RawMessage(strings.Replace(string(exerciseRec(s, e, exOpt{typ: "RUNNING"})), `"3600s"`, `"3630s"`, 1)), true},
		"active span+90s":     {json.RawMessage(strings.Replace(string(exerciseRec(s, e, exOpt{typ: "RUNNING"})), `"3600s"`, `"3690s"`, 1)), false},
	} {
		_, err := parseExercise(tc.raw)
		if (err == nil) != tc.good {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	// An unexpected record name is not passed on as an ID.
	x, err := parseExercise(exerciseRec(s, e, exOpt{typ: "RUNNING", name: "users/me/../../etc"}))
	if err != nil || x.ID != "" {
		t.Errorf("ID = %q, %v", x.ID, err)
	}
	if _, err := parseExercise(exerciseRec(s, e, exOpt{typ: "RUNNING", platform: "HEALTH_KIT"})); !errors.Is(err, errOtherSource) {
		t.Errorf("other platform: %v", err)
	}
	if got, err := minutes("", time.Hour); got != 0 || err != nil {
		t.Errorf("empty duration = %v, %v", got, err)
	}
	if _, err := minutes("-5s", time.Hour); err == nil {
		t.Error("negative duration accepted")
	}
}
