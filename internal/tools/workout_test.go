package tools

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// session is a synthetic session starting at hh:00 local on day.
func session(t *testing.T, id string, day coach.LocalDate, hh int, typ string, minutes float64, hr *healthdata.ExerciseHR, flags ...string) healthdata.Exercise {
	t.Helper()
	midnight, _, err := day.Bounds(saoPaulo(t))
	if err != nil {
		t.Fatal(err)
	}
	start := midnight.Add(time.Duration(hh) * time.Hour)
	return healthdata.Exercise{
		ID: "users/me/dataTypes/exercise/dataPoints/" + id, Day: day, Type: typ, Name: "Session " + id,
		Start: start, End: start.Add(time.Duration(minutes) * time.Minute), ActiveMin: minutes,
		Kcal: f64(minutes * 8), AZM: minutes / 2, HR: hr, Flags: append([]string{}, flags...), Source: "Synthetic Band",
	}
}

// workoutWeek: in the week of Mon 2026-10-12, a run on Monday and, on
// Wednesday, a jiu-jitsu class with a low average heart rate and a manual
// strength session without heart rate. A run on the Sunday before is
// outside the week.
func workoutWeek(t *testing.T) *fakeHealth {
	t.Helper()
	h := history(t, 28)
	jj := &healthdata.ExerciseHR{AvgBPM: 81, MaxBPM: f64(150), ZoneMin: healthdata.ZoneMinutes{Light: 30, Moderate: 20, Vigorous: 8, Peak: 2}}
	h.sessions = []healthdata.Exercise{
		session(t, "0", date("2026-10-11"), 9, "RUNNING", 30, &healthdata.ExerciseHR{AvgBPM: 150}),
		session(t, "1", date("2026-10-12"), 7, "RUNNING", 40, &healthdata.ExerciseHR{AvgBPM: 145, MaxBPM: f64(170)}),
		session(t, "2", date("2026-10-14"), 19, "JIU_JITSU", 60, jj, "low_hr_for_activity"),
		session(t, "3", date("2026-10-14"), 7, "STRENGTH_TRAINING", 45, nil, "manual_entry", "no_hr_data"),
	}
	return h
}

func date(s string) coach.LocalDate { return coach.LocalDate(s) }

var weeklyTargets = fakeTargets{versions: []store.Target{
	{EffectiveFrom: "2026-10-01", WeeklySessions: ptr(3)},
	{EffectiveFrom: "2026-10-15", WeeklySessions: ptr(5)},
}}

func hasFlag(out map[string]any, flag string) bool {
	flags, _ := out["quality_flags"].([]any)
	return slices.Contains(flags, any(flag))
}

func TestWorkoutReviewOfADay(t *testing.T) {
	h := workoutWeek(t)
	out := coachSession(t, h, weeklyTargets).ok("workout_review", map[string]any{"date": "2026-10-14"})
	data := out["data"]
	if got := fmt.Sprint(keys(data)); got != "[date notice recovery_context sessions sessions_omitted week_context]" {
		t.Errorf("keys %s", got)
	}
	if get(data, "notice") != vendorNotice || get(data, "date") != "2026-10-14" {
		t.Errorf("notice %v, date %v", get(data, "notice"), get(data, "date"))
	}
	s := get(data, "sessions", "0")
	for p, want := range map[string]any{
		"exercise_id": "users/me/dataTypes/exercise/dataPoints/2", "type": "JIU_JITSU", "name": "Session 2",
		"active_min": 60.0, "avg_hr_bpm": 81.0, "max_hr_bpm": 150.0, "kcal": 480.0, "azm_min": 30.0,
		"heart_rate_zone_minutes.light": 30.0, "heart_rate_zone_minutes.moderate": 20.0,
		"heart_rate_zone_minutes.vigorous": 8.0, "heart_rate_zone_minutes.peak": 2.0,
		"start": "2026-10-14T19:00:00-03:00", "end": "2026-10-14T20:00:00-03:00", "source": "Synthetic Band",
	} {
		if got := path(s, p); got != want {
			t.Errorf("session %s = %v, want %v", p, got, want)
		}
	}
	if fmt.Sprint(get(s, "quality_flags")) != "[low_hr_for_activity]" {
		t.Errorf("session flags %v", get(s, "quality_flags"))
	}
	strength := get(data, "sessions", "1")
	if get(strength, "heart_rate_zone_minutes") != nil || get(strength, "avg_hr_bpm") != nil || get(strength, "max_hr_bpm") != nil {
		t.Errorf("a session without heart rate: %v", strength)
	}
	if got := fmt.Sprint(out["quality_flags"]); got != "[low_hr_for_activity manual_entry no_hr_data]" {
		t.Errorf("flags %s", got)
	}
	// The week runs Monday to Sunday, up to today, against the target in force on the day.
	wc := get(data, "week_context")
	for p, want := range map[string]any{
		"week_start": "2026-10-12", "through": "2026-10-16", "sessions": 3.0, "weekly_sessions_target": 3.0,
		"active_min_by_type.RUNNING": 40.0, "active_min_by_type.JIU_JITSU": 60.0, "active_min_by_type.STRENGTH_TRAINING": 45.0,
	} {
		if got := path(wc, p); got != want {
			t.Errorf("week %s = %v, want %v", p, got, want)
		}
	}
	if get(wc, "target_hint") != nil {
		t.Errorf("hint with a target set: %v", get(wc, "target_hint"))
	}
	// The night after the session is the one ending on the 15th: HRV 52 ms
	// and resting HR 62 against the 27 earlier nights (means 49.9 and 59.9).
	rc := get(data, "recovery_context")
	for p, want := range map[string]any{
		"night_ending": "2026-10-15", "hrv_ms": 52.0, "hrv_delta_pct_vs_28d": 4.2, "hrv_baseline_n_days": 27.0,
		"resting_hr_bpm": 62.0, "resting_hr_delta_bpm_vs_28d": 2.1, "resting_hr_baseline_n_days": 27.0,
	} {
		if got := path(rc, p); got != want {
			t.Errorf("recovery %s = %v, want %v", p, got, want)
		}
	}
	if get(out, "coverage", "n_days") != 5.0 || fmt.Sprint(out["sources"]) != "[Synthetic Band]" {
		t.Errorf("coverage %v, sources %v", out["coverage"], out["sources"])
	}
	// Max heart rate is read for the reviewed day only, never for the week.
	want := []string{
		"exercises 2026-10-14..2026-10-14 maxHR=true", "exercises 2026-10-12..2026-10-16 maxHR=false",
		"recovery 2026-09-17..2026-10-15",
	}
	if !slices.Equal(h.calls, want) {
		t.Errorf("calls %v\nwant %v", h.calls, want)
	}
}

func TestWorkoutReviewOfOneSession(t *testing.T) {
	h := workoutWeek(t)
	c := coachSession(t, h, weeklyTargets)
	out := c.ok("workout_review", map[string]any{"exercise_id": "users/me/dataTypes/exercise/dataPoints/3"})
	data := out["data"]
	if n := len(get(data, "sessions").([]any)); n != 1 || get(data, "sessions", "0", "type") != "STRENGTH_TRAINING" || get(data, "date") != "2026-10-14" {
		t.Errorf("sessions %v, date %v", get(data, "sessions"), get(data, "date"))
	}
	// The flags are the session's own; the week still counts every session.
	if fmt.Sprint(out["quality_flags"]) != "[manual_entry no_hr_data]" || get(data, "week_context", "sessions") != 3.0 {
		t.Errorf("flags %v, week %v", out["quality_flags"], get(data, "week_context"))
	}
	if want := "exercises 2026-09-19..2026-10-16 maxHR=false"; h.calls[0] != want {
		t.Errorf("lookup call %v, want %s", h.calls[0], want)
	}

	te := c.fails("workout_review", map[string]any{"exercise_id": "users/me/dataTypes/exercise/dataPoints/missing"})
	if te.Code != coach.CodeNoData || !strings.Contains(te.Hint, "date") {
		t.Errorf("unknown id: %+v", te)
	}
	te = c.fails("workout_review", map[string]any{"date": "2026-10-14", "exercise_id": "users/me/dataTypes/exercise/dataPoints/3"})
	if te.Code != coach.CodeInvalidInput {
		t.Errorf("date and id: %+v", te)
	}
	// The schema bounds the ID's length.
	res, err := c.cs.CallTool(t.Context(), callParams("workout_review", map[string]any{"exercise_id": strings.Repeat("x", maxExerciseID+1)}))
	if err == nil && !res.IsError {
		t.Error("an over-long exercise_id was accepted")
	}
}

func TestWorkoutReviewToday(t *testing.T) {
	h := workoutWeek(t)
	h.sessions = append(h.sessions, session(t, "4", coachToday, 6, "TREADMILL", 20, &healthdata.ExerciseHR{AvgBPM: 120}))
	out := coachSession(t, h, nil).ok("workout_review", nil)
	data := out["data"]
	// Today's night has not come: no recovery context, and the day may grow.
	if get(data, "recovery_context") != nil || !hasFlag(out, "partial_day") || get(data, "date") != string(coachToday) {
		t.Errorf("recovery %v, flags %v", get(data, "recovery_context"), out["quality_flags"])
	}
	// No target store: the target is null with a hint to set one.
	wc := get(data, "week_context")
	if get(wc, "weekly_sessions_target") != nil || !strings.Contains(fmt.Sprint(get(wc, "target_hint")), "targets_set") || get(wc, "sessions") != 4.0 {
		t.Errorf("week %v", wc)
	}
	for _, c := range h.calls {
		if strings.HasPrefix(c, "recovery") {
			t.Errorf("recovery read for a night still to come: %v", h.calls)
		}
	}
}

func TestWorkoutReviewTargets(t *testing.T) {
	h := workoutWeek(t)
	// The version starting on the 15th is in force on the 16th.
	data := coachSession(t, h, weeklyTargets).ok("workout_review", map[string]any{"date": "2026-10-16"})["data"]
	if get(data, "week_context", "weekly_sessions_target") != 5.0 {
		t.Errorf("week %v", get(data, "week_context"))
	}
	// A version without a sessions target leaves it null, with the hint.
	kcalOnly := fakeTargets{versions: []store.Target{{EffectiveFrom: "2026-10-01", Kcal: ptr(2200)}}}
	wc := get(coachSession(t, h, kcalOnly).ok("workout_review", map[string]any{"date": "2026-10-14"})["data"], "week_context")
	if get(wc, "weekly_sessions_target") != nil || get(wc, "target_hint") == nil {
		t.Errorf("week %v", wc)
	}
	// No version yet on the day reads the same as no target.
	early := fakeTargets{versions: []store.Target{{EffectiveFrom: "2026-10-15", WeeklySessions: ptr(5)}}}
	wc = get(coachSession(t, h, early).ok("workout_review", map[string]any{"date": "2026-10-14"})["data"], "week_context")
	if get(wc, "weekly_sessions_target") != nil || get(wc, "target_hint") == nil {
		t.Errorf("week before any target %v", wc)
	}
	// A failing store is an error, not a missing target.
	te := coachSession(t, h, fakeTargets{err: errors.New("disk I/O error")}).fails("workout_review", map[string]any{"date": "2026-10-14"})
	if te.Code != coach.CodeInternal {
		t.Errorf("store failure: %+v", te)
	}
}

func TestWorkoutReviewRestDayAndWeekBounds(t *testing.T) {
	h := workoutWeek(t)
	data := coachSession(t, h, nil).ok("workout_review", map[string]any{"date": "2026-10-13"})["data"]
	if n := len(get(data, "sessions").([]any)); n != 0 || get(data, "week_context", "week_start") != "2026-10-12" {
		t.Errorf("rest day: %v", data)
	}
	// Sunday the 11th closes the week of Monday the 5th.
	data = coachSession(t, h, nil).ok("workout_review", map[string]any{"date": "2026-10-11"})["data"]
	wc := get(data, "week_context")
	if get(wc, "week_start") != "2026-10-05" || get(wc, "through") != "2026-10-11" || get(wc, "sessions") != 1.0 {
		t.Errorf("past week %v", wc)
	}
}

func TestWorkoutReviewCapsSessions(t *testing.T) {
	h := history(t, 28)
	for i := range maxSessions + 3 {
		h.sessions = append(h.sessions, session(t, fmt.Sprint(i), date("2026-10-14"), 0, "WALKING", 10, nil))
	}
	out := coachSession(t, h, nil).ok("workout_review", map[string]any{"date": "2026-10-14"})
	data := out["data"]
	if n := len(get(data, "sessions").([]any)); n != maxSessions || get(data, "sessions_omitted") != 3.0 || !hasFlag(out, "sessions_truncated") {
		t.Errorf("listed %d, omitted %v, flags %v", n, get(data, "sessions_omitted"), out["quality_flags"])
	}
	if get(data, "week_context", "sessions") != float64(maxSessions+3) {
		t.Errorf("week %v", get(data, "week_context"))
	}
}

func TestWorkoutReviewFlagsAndErrors(t *testing.T) {
	h := workoutWeek(t)
	h.exercises = healthdata.Exercises{Skipped: 1, MaxHROmitted: 2}
	out := coachSession(t, h, nil).ok("workout_review", map[string]any{"date": "2026-10-14"})
	if !hasFlag(out, "max_hr_omitted") || !hasFlag(out, "unreadable_records") || hasFlag(out, "partial_day") {
		t.Errorf("flags %v", out["quality_flags"])
	}
	te := coachSession(t, workoutWeek(t), nil).fails("workout_review", map[string]any{"date": "2026-10-17"})
	if te.Code != coach.CodeInvalidInput {
		t.Errorf("future date: %+v", te)
	}
	for _, method := range []string{"exercises", "recovery"} {
		h := workoutWeek(t)
		h.errs = map[string]error{method: coach.ToolError{Code: coach.CodeUpstreamUnavailable, Message: "try later"}}
		te := coachSession(t, h, nil).fails("workout_review", map[string]any{"date": "2026-10-14"})
		if te.Code != coach.CodeUpstreamUnavailable {
			t.Errorf("%s error: %+v", method, te)
		}
	}
}

func TestWorkoutReviewExerciseIDLength(t *testing.T) {
	if maxExerciseID != 256 {
		t.Fatalf("maxExerciseID = %d, want 256", maxExerciseID)
	}
	c := coachSession(t, workoutWeek(t), nil)
	// At the bound the handler runs (and finds nothing); past it the schema
	// rejects the call before the handler.
	if te := c.fails("workout_review", map[string]any{"exercise_id": strings.Repeat("x", 256)}); te.Code != coach.CodeNoData {
		t.Errorf("256 characters: %+v", te)
	}
	res, err := c.cs.CallTool(t.Context(), callParams("workout_review", map[string]any{"exercise_id": strings.Repeat("x", 257)}))
	if err == nil {
		if !res.IsError {
			t.Fatal("257 characters accepted")
		}
		var te coach.ToolError
		if json.Unmarshal([]byte(res.Content[0].(*mcp.TextContent).Text), &te) == nil && te.Code == coach.CodeNoData {
			t.Error("257 characters reached the handler")
		}
	}
}

func TestWorkoutReviewOfYesterday(t *testing.T) {
	// Reviewed the next morning: the night after ends today.
	data := coachSession(t, workoutWeek(t), nil).ok("workout_review", map[string]any{"date": "2026-10-15"})["data"]
	rc := get(data, "recovery_context")
	if get(rc, "night_ending") != string(coachToday) || get(rc, "hrv_ms") != 50.0 || get(rc, "resting_hr_bpm") != 60.0 {
		t.Errorf("recovery context %v", rc)
	}
}

func TestWorkoutReviewRecoveryQuality(t *testing.T) {
	h := workoutWeek(t)
	next := date("2026-10-15")
	n := h.nights[next]
	n.Provisional, n.HRV = true, healthdata.HRVNight{Coverage: 0.3}
	h.nights[next] = n
	h.resting[next] = healthdata.RestingHR{BPM: 66, Method: "OTHER"}
	h.recovery.Skipped = 1
	out := coachSession(t, h, nil).ok("workout_review", map[string]any{"date": "2026-10-14"})
	for _, f := range []string{"provisional_sleep", "hrv_low_coverage", "non_standard_resting_hr", "unreadable_records"} {
		if !hasFlag(out, f) {
			t.Errorf("flags %v lack %s", out["quality_flags"], f)
		}
	}
	rc := get(out["data"], "recovery_context")
	if get(rc, "resting_hr_bpm") != 66.0 || get(rc, "resting_hr_delta_bpm_vs_28d") != nil || get(rc, "hrv_ms") != nil {
		t.Errorf("recovery context %v", rc)
	}

	// Below 7 nights of baseline the deltas are left out; the counts stay.
	short := history(t, 4)
	short.sessions = workoutWeek(t).sessions
	rc = get(coachSession(t, short, nil).ok("workout_review", map[string]any{"date": "2026-10-14"})["data"], "recovery_context")
	if get(rc, "hrv_delta_pct_vs_28d") != nil || get(rc, "resting_hr_delta_bpm_vs_28d") != nil ||
		get(rc, "hrv_baseline_n_days") != 3.0 || get(rc, "hrv_ms") != 52.0 {
		t.Errorf("short baseline %v", rc)
	}
}

func TestWorkoutReviewWeekSignals(t *testing.T) {
	week := "2026-10-12..2026-10-16"
	for _, tc := range []struct {
		name string
		ex   healthdata.Exercises
		flag string
	}{
		{"unreadable in the week", healthdata.Exercises{Skipped: 1}, "unreadable_records"},
		{"another platform in the week", healthdata.Exercises{OtherSource: 1}, "other_source_sessions_excluded"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := workoutWeek(t)
			h.byRange = map[string]healthdata.Exercises{week: tc.ex}
			out := coachSession(t, h, nil).ok("workout_review", map[string]any{"date": "2026-10-14"})
			if !hasFlag(out, tc.flag) {
				t.Errorf("flags %v lack %s", out["quality_flags"], tc.flag)
			}
		})
	}
	// The reviewed day alone can carry them too.
	h := workoutWeek(t)
	h.byRange = map[string]healthdata.Exercises{"2026-10-14..2026-10-14": {OtherSource: 1}}
	if out := coachSession(t, h, nil).ok("workout_review", map[string]any{"date": "2026-10-14"}); !hasFlag(out, "other_source_sessions_excluded") {
		t.Errorf("flags %v", out["quality_flags"])
	}
}

func TestWorkoutReviewLookupWithUnreadableRecords(t *testing.T) {
	h := workoutWeek(t)
	h.exercises.Skipped = 1
	te := coachSession(t, h, nil).fails("workout_review", map[string]any{"exercise_id": "users/me/dataTypes/exercise/dataPoints/missing"})
	if te.Code != coach.CodeNoData || !strings.Contains(te.Hint, "could not be read") {
		t.Errorf("error %+v", te)
	}
}

func TestWorkoutReviewSumsMinutesPerType(t *testing.T) {
	h := workoutWeek(t)
	h.sessions = []healthdata.Exercise{
		session(t, "a", date("2026-10-12"), 7, "RUNNING", 25.4, nil),
		session(t, "b", date("2026-10-13"), 7, "RUNNING", 20.3, nil),
	}
	wc := get(coachSession(t, h, nil).ok("workout_review", map[string]any{"date": "2026-10-13"})["data"], "week_context")
	if get(wc, "active_min_by_type", "RUNNING") != 45.7 || get(wc, "sessions") != 2.0 {
		t.Errorf("week %v", wc)
	}
}
