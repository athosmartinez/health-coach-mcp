package store

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

func ptr[T any](v T) *T { return &v }

func TestProfileMergesPatches(t *testing.T) {
	s, _ := openTest(t)
	if _, err := s.Profile(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatalf("empty profile err = %v, want ErrNotFound", err)
	}

	birth := coach.LocalDate("1990-01-01")
	if _, err := s.UpdateProfile(ctx, ProfilePatch{BirthDate: &birth, HeightCm: ptr(180.0)}); err != nil {
		t.Fatal(err)
	}
	p, err := s.UpdateProfile(ctx, ProfilePatch{
		Goal: &Goal{Type: "cut", TargetWeightKg: ptr(75.0), Deadline: "2027-01-31"},
		Plan: &TrainingPlan{Split: "ppl"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.BirthDate != birth || *p.HeightCm != 180 || p.Goal.Type != "cut" || p.Plan.Split != "ppl" {
		t.Errorf("second patch dropped earlier fields: %+v", p)
	}

	got, err := s.Profile(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.BirthDate != birth || *got.Goal.TargetWeightKg != 75 || got.Goal.Deadline != "2027-01-31" || got.Sex != "" {
		t.Errorf("stored profile = %+v", got)
	}
	if !got.UpdatedAt.Equal(fixedClock()) {
		t.Errorf("updated_at = %v", got.UpdatedAt)
	}
}

func TestTargetsVersioning(t *testing.T) {
	s, _ := openTest(t)
	if _, err := s.TargetInForce(ctx, "2026-10-14"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no targets err = %v", err)
	}
	if _, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-01", Kcal: ptr(2400), WeeklySessions: ptr(4)}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-15", Kcal: ptr(2200)}); err != nil {
		t.Fatal(err)
	}

	cases := map[coach.LocalDate]int{"2026-10-01": 2400, "2026-10-14": 2400, "2026-10-15": 2200, "2026-12-01": 2200}
	for day, want := range cases {
		tg, err := s.TargetInForce(ctx, day)
		if err != nil || *tg.Kcal != want {
			t.Errorf("InForce(%s) = %+v, %v; want kcal %d", day, tg, err, want)
		}
	}
	if _, err := s.TargetInForce(ctx, "2026-09-30"); !errors.Is(err, ErrNotFound) {
		t.Errorf("before the first version err = %v", err)
	}

	// Same effective date replaces that version only.
	if _, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-15", Kcal: ptr(2250)}); err != nil {
		t.Fatal(err)
	}
	all, err := s.Targets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || *all[0].Kcal != 2250 || *all[1].Kcal != 2400 {
		t.Errorf("versions = %+v", all)
	}

	for _, bad := range []Target{
		{EffectiveFrom: "2026-10-01"},
		{EffectiveFrom: "bad", Kcal: ptr(1)},
		{EffectiveFrom: "2026-10-01", ProteinG: ptr(-1)},
	} {
		if _, err := s.SetTarget(ctx, bad); !isInvalidInput(err) {
			t.Errorf("SetTarget(%+v) err = %v, want invalid_input", bad, err)
		}
	}
}

func TestPartialTargetCarriesOtherFieldsForward(t *testing.T) {
	s, _ := openTest(t)
	if _, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-01", Kcal: ptr(2000), ProteinG: ptr(150), WeeklySessions: ptr(4)}); err != nil {
		t.Fatal(err)
	}
	got, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-20", Kcal: ptr(1900)})
	if err != nil {
		t.Fatal(err)
	}
	inForce, _ := s.TargetInForce(ctx, "2026-10-21")
	for _, tg := range []Target{got, inForce} {
		if *tg.Kcal != 1900 || tg.ProteinG == nil || *tg.ProteinG != 150 || *tg.WeeklySessions != 4 {
			t.Errorf("kcal-only change dropped other targets: %+v", tg)
		}
	}
	// The earlier version is untouched.
	if old, _ := s.TargetInForce(ctx, "2026-10-05"); *old.Kcal != 2000 {
		t.Errorf("earlier version changed: %+v", old)
	}
}

func TestHealthItemsUpsertAndFilter(t *testing.T) {
	s, _ := openTest(t)
	knee, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "injury", Name: "knee", Status: "active", StartedOn: "2026-09-01"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "supplement", Name: "creatine", Status: "active", Details: "5 g/day"}); err != nil {
		t.Fatal(err)
	}
	again, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "injury", Name: "knee", Status: "resolved", EndedOn: "2026-10-10"})
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != knee.ID {
		t.Errorf("upsert created a second row: %d vs %d", again.ID, knee.ID)
	}

	all, err := s.HealthItems(ctx, "", "")
	if err != nil || len(all) != 2 {
		t.Fatalf("all = %+v, %v", all, err)
	}
	injuries, _ := s.HealthItems(ctx, "injury", "")
	if len(injuries) != 1 || injuries[0].Status != "resolved" || injuries[0].EndedOn != "2026-10-10" || injuries[0].StartedOn != "" {
		t.Errorf("injuries = %+v (upsert replaces every field)", injuries)
	}
	active, _ := s.HealthItems(ctx, "", "active")
	if len(active) != 1 || active[0].Name != "creatine" || active[0].Details != "5 g/day" {
		t.Errorf("active = %+v", active)
	}

	// Names are trimmed, so a trailing space does not create a second item.
	if trimmed, _ := s.UpsertHealthItem(ctx, HealthItem{Kind: "injury", Name: " knee ", Status: "active"}); trimmed.ID != knee.ID {
		t.Errorf("trimmed name created a new item: %+v", trimmed)
	}

	bad := []HealthItem{
		{Kind: "hobby", Name: "x", Status: "active"},
		{Kind: "injury", Name: "x", Status: "gone"},
		{Kind: "injury", Name: "  ", Status: "active"},
		{Kind: "injury", Name: "x", Status: "active", StartedOn: "yesterday"},
		{Kind: "injury", Name: "x", Status: "active", Details: string(make([]byte, maxDetailsLen+1))},
	}
	for _, it := range bad {
		if _, err := s.UpsertHealthItem(ctx, it); !isInvalidInput(err) {
			t.Errorf("UpsertHealthItem(%s/%s/%s) err = %v, want invalid_input", it.Kind, it.Name, it.Status, err)
		}
	}
}

func TestPreferences(t *testing.T) {
	s, _ := openTest(t)
	if err := s.SetPreference(ctx, "training_time", json.RawMessage(`"morning"`)); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPreference(ctx, "foods_avoid", json.RawMessage(`["lactose"]`)); err != nil {
		t.Fatal(err)
	}
	if err := s.SetPreference(ctx, "training_time", json.RawMessage(`"evening"`)); err != nil {
		t.Fatal(err)
	}
	prefs, err := s.Preferences(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if string(prefs["training_time"]) != `"evening"` || string(prefs["foods_avoid"]) != `["lactose"]` || len(prefs) != 2 {
		t.Errorf("prefs = %v", prefs)
	}
	big := json.RawMessage(`"` + string(make([]byte, maxPrefValue)) + `"`)
	for key, v := range map[string]json.RawMessage{"x": json.RawMessage(`not json`), "": json.RawMessage(`1`), "big": big} {
		if err := s.SetPreference(ctx, key, v); !isInvalidInput(err) {
			t.Errorf("SetPreference(%q) err = %v, want invalid_input", key, err)
		}
	}
}

func TestLabsUpsertAndQuery(t *testing.T) {
	s, _ := openTest(t)
	first, err := s.RecordLabs(ctx, "2026-09-01", "LabX", "chat", []LabValue{
		{Analyte: "LDL", Value: 110, Unit: "mg/dL", RefHigh: ptr(130.0)},
		{Analyte: "Glucose Fasting", Value: 105, Unit: "mg/dL", RefLow: ptr(70.0), RefHigh: ptr(99.0)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if first[1].Analyte != "glucose_fasting" || !first[1].OutOfRange() || first[0].OutOfRange() {
		t.Errorf("normalization/out-of-range wrong: %+v", first)
	}

	// A correction on the same date replaces the value.
	if _, err := s.RecordLabs(ctx, "2026-09-01", "LabX", "pdf", []LabValue{{Analyte: "ldl", Value: 120, Unit: "mg/dL", RefHigh: ptr(130.0)}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordLabs(ctx, "2026-10-01", "", "chat", []LabValue{{Analyte: "ldl", Value: 100, Unit: "mg/dL"}}); err != nil {
		t.Fatal(err)
	}

	ldl, err := s.QueryLabs(ctx, "LDL", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(ldl) != 2 || ldl[0].Value != 120 || ldl[0].Source != "pdf" || ldl[1].CollectedOn != "2026-10-01" || ldl[1].Lab != "" || ldl[1].RefHigh != nil {
		t.Errorf("ldl series = %+v", ldl)
	}
	recent, _ := s.QueryLabs(ctx, "", "2026-09-15")
	if len(recent) != 1 || recent[0].CollectedOn != "2026-10-01" {
		t.Errorf("since filter = %+v", recent)
	}
	all, _ := s.QueryLabs(ctx, "", "")
	if len(all) != 3 {
		t.Errorf("all = %d rows, want 3", len(all))
	}

	bad := []struct {
		date   coach.LocalDate
		source string
		values []LabValue
	}{
		{"2026-09-01", "chat", nil},
		{"bad", "chat", []LabValue{{Analyte: "ldl", Value: 1, Unit: "mg/dL"}}},
		{"2026-09-01", "fax", []LabValue{{Analyte: "ldl", Value: 1, Unit: "mg/dL"}}},
		{"2026-09-01", "chat", []LabValue{{Analyte: " ", Value: 1, Unit: "mg/dL"}}},
		{"2026-09-01", "chat", []LabValue{{Analyte: "ldl", Value: 1}}},
	}
	nan, inf := math.NaN(), math.Inf(1)
	bad = append(bad,
		struct {
			date   coach.LocalDate
			source string
			values []LabValue
		}{"2026-09-01", "chat", []LabValue{{Analyte: "ldl", Value: nan, Unit: "mg/dL"}}},
		struct {
			date   coach.LocalDate
			source string
			values []LabValue
		}{"2026-09-01", "chat", []LabValue{{Analyte: "ldl", Value: 1, Unit: "mg/dL", RefHigh: &inf}}},
		struct {
			date   coach.LocalDate
			source string
			values []LabValue
		}{"2026-09-01", "chat", []LabValue{{Analyte: "ldl", Value: 1, Unit: "mg/dL", RefLow: ptr(10.0), RefHigh: ptr(5.0)}}},
		struct {
			date   coach.LocalDate
			source string
			values []LabValue
		}{"2026-09-01", "chat", make([]LabValue, maxLabBatch+1)},
	)
	for _, b := range bad {
		if _, err := s.RecordLabs(ctx, b.date, "", b.source, b.values); !isInvalidInput(err) {
			t.Errorf("RecordLabs(%s, %s, %d values) err = %v, want invalid_input", b.date, b.source, len(b.values), err)
		}
	}
	// Errors name the analyte, never the value.
	_, err = s.RecordLabs(ctx, "2026-09-01", "", "chat", []LabValue{{Analyte: "ldl", Value: 187.25, Unit: "mg/dL", RefLow: ptr(200.0), RefHigh: ptr(100.0)}})
	if err == nil || strings.Contains(err.Error(), "187") {
		t.Errorf("err = %v", err)
	}
	// The caller's slice is not mutated by normalization.
	in := []LabValue{{Analyte: "Free T4", Value: 1.1, Unit: "ng/dL"}}
	if _, err := s.RecordLabs(ctx, "2026-09-02", "", "file", in); err != nil || in[0].Analyte != "Free T4" {
		t.Errorf("input mutated or rejected: %+v, %v", in, err)
	}
	// A rejected batch must not leave partial rows behind.
	if _, err := s.RecordLabs(ctx, "2026-11-01", "", "chat", []LabValue{{Analyte: "hdl", Value: 50, Unit: "mg/dL"}, {Analyte: "", Value: 1, Unit: "x"}}); err == nil {
		t.Fatal("batch with a bad row accepted")
	}
	if hdl, _ := s.QueryLabs(ctx, "hdl", ""); len(hdl) != 0 {
		t.Errorf("partial batch committed: %+v", hdl)
	}
}

func TestNotesSearch(t *testing.T) {
	s, _ := openTest(t)
	add := func(n Note) Note {
		t.Helper()
		out, err := s.AddNote(ctx, n)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	knee := add(Note{Kind: "symptom", Text: "sore knee after squats", Tags: []string{"knee", "legs"}, RelatedDate: "2026-10-10"})
	add(Note{Kind: "decision", Text: "cut carbs on rest days"})
	add(Note{Kind: "checkin", Text: "a-b \"quoted\" AND weird text", RelatedDate: "2026-09-01"})

	// Inserted after the migration: found only if the notes_ai trigger works.
	hits, err := s.SearchNotes(ctx, NoteFilter{Query: "knee"})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].ID != knee.ID || len(hits[0].Tags) != 2 || hits[0].RelatedDate != "2026-10-10" {
		t.Errorf("knee hits = %+v", hits)
	}
	if hits, _ := s.SearchNotes(ctx, NoteFilter{Query: "knee squats"}); len(hits) != 1 {
		t.Errorf("all words must match: %+v", hits)
	}
	if hits, _ := s.SearchNotes(ctx, NoteFilter{Query: "knee carbs"}); len(hits) != 0 {
		t.Errorf("words are ANDed: %+v", hits)
	}
	for _, q := range []string{`a-b "c" AND`, `NEAR(`, `text:x`, `"`, `*`} {
		if _, err := s.SearchNotes(ctx, NoteFilter{Query: q}); err != nil {
			t.Errorf("query %q must be treated as plain words, got %v", q, err)
		}
	}
	if hits, _ := s.SearchNotes(ctx, NoteFilter{Query: `"quoted"`}); len(hits) != 1 {
		t.Errorf("quoted word not found: %+v", hits)
	}

	if hits, _ := s.SearchNotes(ctx, NoteFilter{Kind: "decision"}); len(hits) != 1 || hits[0].Tags == nil {
		t.Errorf("kind filter = %+v (tags must be [] not nil)", hits)
	}
	// related_date wins over created_at (2026-10-14 for every note here).
	since, _ := s.SearchNotes(ctx, NoteFilter{Since: "2026-10-05"})
	if len(since) != 2 {
		t.Errorf("since 10-05 = %d notes, want knee + the undated decision", len(since))
	}
	if limited, _ := s.SearchNotes(ctx, NoteFilter{Limit: 1}); len(limited) != 1 {
		t.Errorf("limit ignored: %d", len(limited))
	}
	if _, err := s.SearchNotes(ctx, NoteFilter{Since: "bad"}); err == nil {
		t.Error("invalid since accepted")
	}

	// Updates and deletes keep the index in sync (notes_au / notes_ad).
	if _, err := s.db.ExecContext(ctx, `UPDATE notes SET text = 'sore ankle' WHERE id = ?`, knee.ID); err != nil {
		t.Fatal(err)
	}
	if hits, _ := s.SearchNotes(ctx, NoteFilter{Query: "knee"}); len(hits) != 0 {
		t.Errorf("stale FTS row after update: %+v", hits)
	}
	if hits, _ := s.SearchNotes(ctx, NoteFilter{Query: "ankle"}); len(hits) != 1 {
		t.Errorf("updated text not indexed: %+v", hits)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM notes WHERE id = ?`, knee.ID); err != nil {
		t.Fatal(err)
	}
	if hits, _ := s.SearchNotes(ctx, NoteFilter{Query: "ankle"}); len(hits) != 0 {
		t.Errorf("deleted note still indexed: %+v", hits)
	}

	badNotes := []Note{
		{Kind: "checkin", Text: "  "},
		{Kind: "rant", Text: "x"},
		{Kind: "checkin", Text: string(make([]byte, maxNoteText+1))},
		{Kind: "checkin", Text: "x", Tags: make([]string, maxTags+1)},
		{Kind: "checkin", Text: "x", Tags: []string{""}},
		{Kind: "checkin", Text: "x", RelatedDate: "today"},
	}
	for _, n := range badNotes {
		if _, err := s.AddNote(ctx, n); !isInvalidInput(err) {
			t.Errorf("AddNote(kind %q, %d bytes, %d tags) err = %v, want invalid_input", n.Kind, len(n.Text), len(n.Tags), err)
		}
	}
	if _, err := s.SearchNotes(ctx, NoteFilter{Query: strings.Repeat("w ", maxQueryWords+1)}); !isInvalidInput(err) {
		t.Errorf("long query err = %v, want invalid_input", err)
	}
	if _, err := s.SearchNotes(ctx, NoteFilter{Query: "knee\x00"}); err != nil {
		t.Errorf("NUL byte in query: %v", err)
	}
}

func TestNotesNewestFirstWithinOneSecond(t *testing.T) {
	// 12:00:00.0 then 12:00:00.5: variable-width stamps used to sort these backwards.
	stamps := []time.Time{
		time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC),
		time.Date(2026, 10, 14, 12, 0, 0, 500_000_000, time.UTC),
	}
	i := 0
	s, err := Open(ctx, t.TempDir()+"/coach.db", func() time.Time { i++; return stamps[min(i-1, 1)] })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	i = 0
	first, _ := s.AddNote(ctx, Note{Kind: "checkin", Text: "first"})
	second, _ := s.AddNote(ctx, Note{Kind: "checkin", Text: "second"})
	hits, err := s.SearchNotes(ctx, NoteFilter{})
	if err != nil || len(hits) != 2 || hits[0].ID != second.ID || hits[1].ID != first.ID {
		t.Fatalf("order = %+v, %v; want second then first", hits, err)
	}
	if !hits[0].CreatedAt.Equal(stamps[1]) {
		t.Errorf("created_at round trip = %v", hits[0].CreatedAt)
	}
	// Since compares created_at as text, which only works with fixed-width stamps.
	if got, _ := s.SearchNotes(ctx, NoteFilter{Since: "2026-10-14"}); len(got) != 2 {
		t.Errorf("since = %d notes", len(got))
	}
}

func TestProfileClearAndValidation(t *testing.T) {
	s, _ := openTest(t)
	h := 180.0
	p, err := s.UpdateProfile(ctx, ProfilePatch{Sex: ptr("m"), HeightCm: &h, Goal: &Goal{Type: "cut"}})
	if err != nil {
		t.Fatal(err)
	}
	h = 999 // the stored profile must not alias the caller's value
	if *p.HeightCm != 180 {
		t.Errorf("result aliases the patch: %v", *p.HeightCm)
	}
	p, err = s.UpdateProfile(ctx, ProfilePatch{Clear: []string{"sex", "goal"}})
	if err != nil {
		t.Fatal(err)
	}
	if p.Sex != "" || p.Goal != nil || *p.HeightCm != 180 {
		t.Errorf("clear = %+v", p)
	}
	if got, _ := s.Profile(ctx); got.Sex != "" || got.Goal != nil {
		t.Errorf("stored after clear = %+v", got)
	}
	bad := []ProfilePatch{
		{Clear: []string{"weight"}},
		{HeightCm: ptr(-1.0)},
		{HeightCm: ptr(math.NaN())},
		{BirthDate: ptr(coach.LocalDate("01/01/1990"))},
		{Goal: &Goal{TargetWeightKg: ptr(0.0)}},
		{Goal: &Goal{Deadline: "soon"}},
		{Plan: &TrainingPlan{Notes: string(make([]byte, maxProfileText+1))}},
	}
	for _, patch := range bad {
		if _, err := s.UpdateProfile(ctx, patch); !isInvalidInput(err) {
			t.Errorf("UpdateProfile(%+v) err = %v, want invalid_input", patch, err)
		}
	}
}

func TestConcurrentReadThenWriteTransactions(t *testing.T) {
	// Deferred transactions that read and then write fail with SQLITE_BUSY at
	// the lock upgrade; _txlock=immediate makes them wait instead.
	s, _ := openTest(t)
	var wg sync.WaitGroup
	errs := make(chan error, 32)
	for i := range 16 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, err := s.UpdateProfile(ctx, ProfilePatch{HeightCm: ptr(float64(170 + i))})
			errs <- err
		}()
		go func() {
			defer wg.Done()
			_, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-01", Kcal: ptr(2000 + i)})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent read-then-write failed: %v", err)
		}
	}
}

func isInvalidInput(err error) bool {
	var te coach.ToolError
	return errors.As(err, &te) && te.Code == coach.CodeInvalidInput
}

func TestFTSErrorBecomesInvalidInput(t *testing.T) {
	err := ftsError(errors.New("SQL logic error: fts5: syntax error near \"AND\""))
	var te coach.ToolError
	if !errors.As(err, &te) || te.Code != coach.CodeInvalidInput {
		t.Errorf("err = %v, want invalid_input", err)
	}
	if other := errors.New("disk full"); ftsError(other) != other {
		t.Error("non-FTS errors must pass through")
	}
}

func TestSearchNotesSinceUsesZone(t *testing.T) {
	// Created 2026-10-14 01:00 UTC = 2026-10-13 22:00 in São Paulo.
	s, err := Open(ctx, t.TempDir()+"/coach.db", func() time.Time { return time.Date(2026, 10, 14, 1, 0, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err := s.AddNote(ctx, Note{Kind: "checkin", Text: "late note"}); err != nil {
		t.Fatal(err)
	}
	brt, _ := time.LoadLocation("America/Sao_Paulo")
	if hits, _ := s.SearchNotes(ctx, NoteFilter{Since: "2026-10-14", Loc: brt}); len(hits) != 0 {
		t.Errorf("note from local Oct 13 matched since Oct 14: %+v", hits)
	}
	if hits, _ := s.SearchNotes(ctx, NoteFilter{Since: "2026-10-13", Loc: brt}); len(hits) != 1 {
		t.Errorf("note from local Oct 13 missed: %+v", hits)
	}
}
