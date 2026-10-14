package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

func ptr[T any](v T) *T { return &v }

func isCode(err error, code coach.Code) bool {
	var te coach.ToolError
	return errors.As(err, &te) && te.Code == code
}

func isInvalidInput(err error) bool { return isCode(err, coach.CodeInvalidInput) }

// --- profile ---

func TestProfileMergesPatches(t *testing.T) {
	s, _ := openTest(t)
	_, err := s.Profile(ctx)
	if !errors.Is(err, ErrNotFound) || !isCode(err, coach.CodeNoData) {
		t.Fatalf("empty profile err = %v, want ErrNotFound / no_data", err)
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
		{HeightCm: ptr(400.0)},
		{BirthDate: ptr(coach.LocalDate("01/01/1990"))},
		{BirthDate: ptr(coach.LocalDate("1850-01-01"))},
		{BirthDate: ptr(coach.LocalDate("2030-01-01"))},
		{Goal: &Goal{TargetWeightKg: ptr(0.0)}},
		{Goal: &Goal{TargetBodyFatPct: ptr(90.0)}},
		{Goal: &Goal{Deadline: "soon"}},
		{Plan: &TrainingPlan{Notes: string(make([]byte, maxProfileText+1))}},
	}
	for _, patch := range bad {
		if _, err := s.UpdateProfile(ctx, patch); !isInvalidInput(err) {
			t.Errorf("UpdateProfile(%+v) err = %v, want invalid_input", patch, err)
		}
	}
}

func TestProfileValidationIsDeterministic(t *testing.T) {
	s, _ := openTest(t)
	patch := ProfilePatch{HeightCm: ptr(-1.0), Goal: &Goal{TargetWeightKg: ptr(-1.0), TargetBodyFatPct: ptr(-1.0)}}
	first := fmt.Sprint(s.UpdateProfile(ctx, patch))
	for range 20 {
		if got := fmt.Sprint(s.UpdateProfile(ctx, patch)); got != first {
			t.Fatalf("error changes between runs: %q vs %q", got, first)
		}
	}
}

func TestCorruptProfileJSONCanBeRepaired(t *testing.T) {
	s, _ := openTest(t)
	if _, err := s.UpdateProfile(ctx, ProfilePatch{Sex: ptr("m"), Goal: &Goal{Type: "cut"}, Plan: &TrainingPlan{Split: "ppl"}}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ col, field string }{{"goal_json", "goal"}, {"plan_json", "training_plan"}} {
		if _, err := s.db.ExecContext(ctx, `UPDATE profile SET `+c.col+` = '{bad'`); err != nil {
			t.Fatal(err)
		}
		_, err := s.Profile(ctx)
		var cf corruptField
		if !errors.As(err, &cf) || cf.field != c.field || !strings.Contains(err.Error(), "set or clear it") {
			t.Errorf("corrupt %s: err = %v", c.col, err)
		}
		var syntax *json.SyntaxError
		if !errors.As(err, &syntax) {
			t.Errorf("corrupt %s: JSON cause dropped: %v", c.col, err)
		}
		if _, err := s.UpdateProfile(ctx, ProfilePatch{Sex: ptr("f")}); err == nil {
			t.Errorf("unrelated patch over corrupt %s must still fail", c.col)
		}
		// Clearing (or setting) the corrupt field repairs the profile.
		p, err := s.UpdateProfile(ctx, ProfilePatch{Clear: []string{c.field}})
		if err != nil {
			t.Fatalf("repair %s: %v", c.col, err)
		}
		if p.Sex != "m" {
			t.Errorf("repair dropped other fields: %+v", p)
		}
		if _, err := s.Profile(ctx); err != nil {
			t.Errorf("still corrupt after repair: %v", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE profile SET goal_json = '{bad'`); err != nil {
		t.Fatal(err)
	}
	if p, err := s.UpdateProfile(ctx, ProfilePatch{Goal: &Goal{Type: "bulk"}}); err != nil || p.Goal.Type != "bulk" {
		t.Errorf("setting the corrupt goal must repair it: %+v, %v", p, err)
	}
}

// --- targets ---

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
	if _, err := s.TargetInForce(ctx, "garbage"); !isInvalidInput(err) {
		t.Errorf("invalid day err = %v, want invalid_input", err)
	}

	all, err := s.Targets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].EffectiveFrom != "2026-10-15" || all[1].EffectiveFrom != "2026-10-01" {
		t.Errorf("versions = %+v, want newest first", all)
	}

	for _, bad := range []Target{
		{EffectiveFrom: "2026-10-01"},
		{EffectiveFrom: "bad", Kcal: ptr(1)},
		{EffectiveFrom: "2026-10-01", ProteinG: ptr(-1)},
		{EffectiveFrom: "2026-10-01", Kcal: ptr(maxKcal + 1)},
		{EffectiveFrom: "2026-10-01", WeeklySessions: ptr(maxWeeklySessions + 1)},
		{EffectiveFrom: "2026-10-01", Clear: []string{"carbs"}},
	} {
		if _, err := s.SetTarget(ctx, bad); !isInvalidInput(err) {
			t.Errorf("SetTarget(%+v) err = %v, want invalid_input", bad, err)
		}
	}
	// Exactly at the limits is accepted.
	if _, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-11-01", Kcal: ptr(maxKcal), ProteinG: ptr(maxProteinG), WeeklySessions: ptr(maxWeeklySessions)}); err != nil {
		t.Errorf("limits rejected: %v", err)
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
	if old, _ := s.TargetInForce(ctx, "2026-10-05"); *old.Kcal != 2000 {
		t.Errorf("earlier version changed: %+v", old)
	}
}

func TestSameDateCorrectionCarriesFromThatRow(t *testing.T) {
	s, _ := openTest(t)
	steps := []Target{
		{EffectiveFrom: "2026-10-01", Kcal: ptr(2000), ProteinG: ptr(150), WeeklySessions: ptr(4)},
		{EffectiveFrom: "2026-10-15", ProteinG: ptr(160)},
		{EffectiveFrom: "2026-10-15", Kcal: ptr(1900)},
	}
	for _, st := range steps {
		if _, err := s.SetTarget(ctx, st); err != nil {
			t.Fatal(err)
		}
	}
	tg, _ := s.TargetInForce(ctx, "2026-10-15")
	if *tg.Kcal != 1900 || *tg.ProteinG != 160 || *tg.WeeklySessions != 4 {
		t.Errorf("same-date correction = %+v, want {1900, 160 from the same row, 4}", tg)
	}
	// A back-dated version does not rewrite the later one.
	if _, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-10", Kcal: ptr(2100)}); err != nil {
		t.Fatal(err)
	}
	if later, _ := s.TargetInForce(ctx, "2026-10-15"); *later.Kcal != 1900 || *later.ProteinG != 160 {
		t.Errorf("back-dated insert rewrote the later version: %+v", later)
	}
	if mid, _ := s.TargetInForce(ctx, "2026-10-12"); *mid.Kcal != 2100 || *mid.ProteinG != 150 {
		t.Errorf("back-dated version = %+v, want kcal 2100 carrying protein 150 from 10-01", mid)
	}
}

func TestTargetClear(t *testing.T) {
	s, _ := openTest(t)
	if _, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-01", Kcal: ptr(2000), ProteinG: ptr(150)}); err != nil {
		t.Fatal(err)
	}
	got, err := s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-10", Clear: []string{"protein_g"}})
	if err != nil {
		t.Fatal(err)
	}
	if *got.Kcal != 2000 || got.ProteinG != nil || got.Clear != nil {
		t.Errorf("clear = %+v", got)
	}
	if tg, _ := s.TargetInForce(ctx, "2026-10-10"); tg.ProteinG != nil || *tg.Kcal != 2000 {
		t.Errorf("stored after clear = %+v", tg)
	}
}

// --- health items ---

func TestHealthItemsUpsertAndFilter(t *testing.T) {
	s, _ := openTest(t)
	knee, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "injury", Name: "knee", Status: "active", Details: "ACL", StartedOn: "2026-09-01"})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range []HealthItem{
		{Kind: "supplement", Name: "creatine", Status: "active", Details: "5 g/day"},
		{Kind: "supplement", Name: "omega 3", Status: "paused"},
		{Kind: "injury", Name: "ankle", Status: "resolved"},
	} {
		if _, err := s.UpsertHealthItem(ctx, it); err != nil {
			t.Fatal(err)
		}
	}

	// A status-only update keeps details and dates.
	again, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "injury", Name: "Knee ", Status: "resolved", EndedOn: "2026-10-10"})
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != knee.ID || again.Name != "knee" {
		t.Errorf("trimmed/case-insensitive name created a second item: %+v", again)
	}
	if again.Details != "ACL" || again.StartedOn != "2026-09-01" || again.EndedOn != "2026-10-10" || again.Status != "resolved" {
		t.Errorf("status update erased history: %+v", again)
	}

	all, err := s.HealthItems(ctx, "", "")
	if err != nil || len(all) != 4 {
		t.Fatalf("all = %+v, %v", all, err)
	}
	var order []string
	for _, it := range all {
		order = append(order, it.Kind+"/"+it.Name)
	}
	if want := []string{"injury/ankle", "injury/knee", "supplement/creatine", "supplement/omega 3"}; !slices.Equal(order, want) {
		t.Errorf("order = %v, want %v", order, want)
	}
	if both, _ := s.HealthItems(ctx, "injury", "resolved"); len(both) != 2 {
		t.Errorf("kind+status = %+v", both)
	}
	if active, _ := s.HealthItems(ctx, "supplement", "active"); len(active) != 1 || active[0].Details != "5 g/day" {
		t.Errorf("active supplements = %+v", active)
	}
	for _, f := range [][2]string{{"bogus", ""}, {"", "zzz"}} {
		if _, err := s.HealthItems(ctx, f[0], f[1]); !isInvalidInput(err) {
			t.Errorf("HealthItems(%q, %q) err = %v, want invalid_input", f[0], f[1], err)
		}
	}
}

func TestHealthItemClearAndDateOrder(t *testing.T) {
	s, _ := openTest(t)
	if _, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "condition", Name: "asthma", Status: "active", Details: "mild", StartedOn: "2010-01-01"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "condition", Name: "asthma", Status: "active", Clear: []string{"details"}})
	if err != nil || got.Details != "" || got.StartedOn != "2010-01-01" {
		t.Errorf("clear details = %+v, %v", got, err)
	}
	// A new ended_on before the stored started_on is rejected and rolled back.
	if _, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "condition", Name: "asthma", Status: "resolved", EndedOn: "2009-01-01"}); !isInvalidInput(err) {
		t.Errorf("ended_on before stored started_on err = %v", err)
	}
	if items, _ := s.HealthItems(ctx, "condition", ""); items[0].Status != "active" || items[0].EndedOn != "" {
		t.Errorf("rejected upsert was committed: %+v", items[0])
	}
}

func TestHealthItemValidation(t *testing.T) {
	s, _ := openTest(t)
	bad := []HealthItem{
		{Kind: "hobby", Name: "x", Status: "active"},
		{Kind: "injury", Name: "x", Status: "gone"},
		{Kind: "injury", Name: "  ", Status: "active"},
		{Kind: "injury", Name: "x", Status: "active", StartedOn: "yesterday"},
		{Kind: "injury", Name: "x", Status: "active", StartedOn: "2026-10-10", EndedOn: "2026-10-01"},
		{Kind: "injury", Name: "x", Status: "active", Details: string(make([]byte, maxDetailsLen+1))},
		{Kind: "injury", Name: "x", Status: "active", Clear: []string{"status"}},
	}
	for _, it := range bad {
		if _, err := s.UpsertHealthItem(ctx, it); !isInvalidInput(err) {
			t.Errorf("UpsertHealthItem(%s/%q/%s) err = %v, want invalid_input", it.Kind, it.Name, it.Status, err)
		}
	}
	if _, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "injury", Name: "x", Status: "active", Details: string(make([]byte, maxDetailsLen))}); err != nil {
		t.Errorf("details at the limit rejected: %v", err)
	}
}

func TestHealthItemCountCap(t *testing.T) {
	s, _ := openTest(t)
	for i := range maxHealthItems {
		if _, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "supplement", Name: fmt.Sprintf("s%d", i), Status: "active"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "supplement", Name: "one more", Status: "active"}); !isInvalidInput(err) {
		t.Errorf("item over the cap err = %v", err)
	}
	if _, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "supplement", Name: "s0", Status: "paused"}); err != nil {
		t.Errorf("updating an existing item at the cap must work: %v", err)
	}
}

// --- preferences ---

func TestPreferences(t *testing.T) {
	s, _ := openTest(t)
	if err := s.SetPreference(ctx, " training_time ", json.RawMessage(`"morning"`)); err != nil {
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
		t.Errorf("prefs = %v (key must be trimmed)", prefs)
	}
	big := json.RawMessage(`"` + strings.Repeat("a", maxPrefValue) + `"`)
	for key, v := range map[string]json.RawMessage{"x": json.RawMessage(`not json`), "": json.RawMessage(`1`), "big": big} {
		if err := s.SetPreference(ctx, key, v); !isInvalidInput(err) {
			t.Errorf("SetPreference(%q) err = %v, want invalid_input", key, err)
		}
	}
	atLimit := json.RawMessage(`"` + strings.Repeat("a", maxPrefValue-2) + `"`)
	if err := s.SetPreference(ctx, "notes", atLimit); err != nil {
		t.Errorf("value at the limit rejected: %v", err)
	}
}

func TestPreferenceCountCap(t *testing.T) {
	s, _ := openTest(t)
	for i := range maxPreferences {
		if err := s.SetPreference(ctx, fmt.Sprintf("k%d", i), json.RawMessage(`1`)); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SetPreference(ctx, "one_more", json.RawMessage(`1`)); !isInvalidInput(err) {
		t.Errorf("key over the cap err = %v", err)
	}
	if err := s.SetPreference(ctx, "k0", json.RawMessage(`2`)); err != nil {
		t.Errorf("overwriting at the cap must work: %v", err)
	}
}

// --- labs ---

type labCase struct {
	date   coach.LocalDate
	source string
	values []LabValue
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

	// A correction on the same date replaces value, lab and source.
	if _, err := s.RecordLabs(ctx, "2026-09-01", "LabY", "pdf", []LabValue{{Analyte: "ldl", Value: 120, Unit: "mg/dL", RefHigh: ptr(130.0)}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordLabs(ctx, "2026-10-01", "", "chat", []LabValue{{Analyte: "ldl", Value: 100, Unit: "mg/dL"}}); err != nil {
		t.Fatal(err)
	}

	ldl, err := s.QueryLabs(ctx, "LDL", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(ldl) != 2 || ldl[0].Value != 120 || ldl[0].Source != "pdf" || ldl[0].Lab != "LabY" ||
		ldl[1].CollectedOn != "2026-10-01" || ldl[1].Lab != "" || ldl[1].RefHigh != nil {
		t.Errorf("ldl series = %+v", ldl)
	}
	recent, _ := s.QueryLabs(ctx, "", "2026-09-15")
	if len(recent) != 1 || recent[0].CollectedOn != "2026-10-01" {
		t.Errorf("since filter = %+v", recent)
	}
	all, _ := s.QueryLabs(ctx, "", "")
	var seq []string
	for _, r := range all {
		seq = append(seq, r.Analyte+"@"+string(r.CollectedOn))
	}
	if want := []string{"glucose_fasting@2026-09-01", "ldl@2026-09-01", "ldl@2026-10-01"}; !slices.Equal(seq, want) {
		t.Errorf("order = %v, want %v", seq, want)
	}
	if _, err := s.QueryLabs(ctx, "", "garbage"); !isInvalidInput(err) {
		t.Errorf("invalid since err = %v", err)
	}
}

func TestLabsValidation(t *testing.T) {
	s, _ := openTest(t)
	one := func(v LabValue) []LabValue { return []LabValue{v} }
	bad := []labCase{
		{"2026-09-01", "chat", nil},
		{"bad", "chat", one(LabValue{Analyte: "ldl", Value: 1, Unit: "mg/dL"})},
		{"2026-09-01", "fax", one(LabValue{Analyte: "ldl", Value: 1, Unit: "mg/dL"})},
		{"2026-09-01", "chat", one(LabValue{Analyte: " ", Value: 1, Unit: "mg/dL"})},
		{"2026-09-01", "chat", one(LabValue{Analyte: "ldl", Value: 1})},
		{"2026-09-01", "chat", one(LabValue{Analyte: "ldl", Value: math.NaN(), Unit: "mg/dL"})},
		{"2026-09-01", "chat", one(LabValue{Analyte: "ldl", Value: 1, Unit: "mg/dL", RefHigh: ptr(math.Inf(1))})},
		{"2026-09-01", "chat", one(LabValue{Analyte: "ldl", Value: 1, Unit: "mg/dL", RefLow: ptr(10.0), RefHigh: ptr(5.0)})},
		{"2026-09-01", "chat", []LabValue{{Analyte: "ldl", Value: 1, Unit: "mg/dL"}, {Analyte: "LDL", Value: 2, Unit: "mg/dL"}}},
		{"2026-09-01", "chat", make([]LabValue, maxLabBatch+1)},
	}
	for _, b := range bad {
		if _, err := s.RecordLabs(ctx, b.date, "", b.source, b.values); !isInvalidInput(err) {
			t.Errorf("RecordLabs(%s, %s, %d values) err = %v, want invalid_input", b.date, b.source, len(b.values), err)
		}
	}
	// Errors name the analyte, never the value.
	_, err := s.RecordLabs(ctx, "2026-09-01", "", "chat", []LabValue{{Analyte: "ldl", Value: 187.25, Unit: "mg/dL", RefLow: ptr(200.0), RefHigh: ptr(100.0)}})
	if err == nil || strings.Contains(err.Error(), "187") {
		t.Errorf("err = %v", err)
	}
	// A batch with one bad row commits nothing.
	if _, err := s.RecordLabs(ctx, "2026-11-01", "", "chat", []LabValue{{Analyte: "hdl", Value: 50, Unit: "mg/dL"}, {Analyte: "", Value: 1, Unit: "x"}}); err == nil {
		t.Fatal("batch with a bad row accepted")
	}
	if hdl, _ := s.QueryLabs(ctx, "hdl", ""); len(hdl) != 0 {
		t.Errorf("partial batch committed: %+v", hdl)
	}
	// The caller's slice is not mutated by normalization.
	in := []LabValue{{Analyte: "Free T4", Value: 1.1, Unit: "ng/dL"}}
	if _, err := s.RecordLabs(ctx, "2026-09-02", "", "file", in); err != nil || in[0].Analyte != "Free T4" {
		t.Errorf("input mutated or rejected: %+v, %v", in, err)
	}
	// Exactly maxLabBatch distinct analytes is accepted.
	full := make([]LabValue, maxLabBatch)
	for i := range full {
		full[i] = LabValue{Analyte: fmt.Sprintf("a%d", i), Value: 1, Unit: "u"}
	}
	if _, err := s.RecordLabs(ctx, "2026-12-01", "", "pdf", full); err != nil {
		t.Errorf("batch at the limit rejected: %v", err)
	}
}

// --- notes ---

func addNote(t *testing.T, s *Store, n Note) Note {
	t.Helper()
	out, err := s.AddNote(ctx, n)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func search(t *testing.T, s *Store, f NoteFilter) NoteResults {
	t.Helper()
	res, err := s.SearchNotes(ctx, f)
	if err != nil {
		t.Fatalf("SearchNotes(%+v): %v", f, err)
	}
	return res
}

func TestNotesSearch(t *testing.T) {
	s, _ := openTest(t)
	knee := addNote(t, s, Note{Kind: "symptom", Text: "sore knee after squats", Tags: []string{"knee", "legs"}, RelatedDate: "2026-10-10"})
	addNote(t, s, Note{Kind: "decision", Text: "cut carbs on rest days"})
	weird := addNote(t, s, Note{Kind: "checkin", Text: "a-b \"quoted\" AND weird text", RelatedDate: "2026-09-01"})
	acao := addNote(t, s, Note{Kind: "insight", Text: "Ação rápida: dor no joelho"})

	// Inserted after the migration: found only if the notes_ai trigger works.
	hits := search(t, s, NoteFilter{Query: "knee"}).Notes
	if len(hits) != 1 || hits[0].ID != knee.ID || len(hits[0].Tags) != 2 || hits[0].RelatedDate != "2026-10-10" {
		t.Errorf("knee hits = %+v", hits)
	}
	cases := []struct {
		q    string
		want []int64
	}{
		{"knee squats", []int64{knee.ID}},
		{"knee carbs", nil}, // words are ANDed
		{"KNEE", []int64{knee.ID}},
		{"kne", nil},  // no prefix matching
		{"legs", nil}, // tags are not indexed
		{"a-b", []int64{weird.ID}},
		{"AND", []int64{weird.ID}}, // a literal word, not an operator
		{`"quoted"`, []int64{weird.ID}},
		{`a-b "c" AND`, nil},
		{"acao", []int64{acao.ID}}, // diacritics folded (unicode61)
		{"joelho dor", []int64{acao.ID}},
		{"knee\x00", []int64{knee.ID}},
		{`NEAR(`, nil},
		{`text:x`, nil},
		{`*`, nil},
		{`"`, nil},
	}
	for _, c := range cases {
		var got []int64
		for _, n := range search(t, s, NoteFilter{Query: c.q}).Notes {
			got = append(got, n.ID)
		}
		if !slices.Equal(got, c.want) {
			t.Errorf("query %q = %v, want %v", c.q, got, c.want)
		}
	}

	if hits := search(t, s, NoteFilter{Kind: "decision"}).Notes; len(hits) != 1 || hits[0].Tags == nil {
		t.Errorf("kind filter = %+v (tags must be [] not nil)", hits)
	}
	// related_date wins over created_at (2026-10-14 for every note here).
	if since := search(t, s, NoteFilter{Since: "2026-10-05"}).Notes; len(since) != 3 {
		t.Errorf("since 10-05 = %d notes, want knee + the two undated ones", len(since))
	}
	if combo := search(t, s, NoteFilter{Kind: "symptom", Since: "2026-10-01", Query: "knee"}).Notes; len(combo) != 1 {
		t.Errorf("query + kind + since = %+v", combo)
	}
	if combo := search(t, s, NoteFilter{Kind: "decision", Query: "knee"}).Notes; len(combo) != 0 {
		t.Errorf("kind must narrow the FTS match: %+v", combo)
	}
	newest := search(t, s, NoteFilter{Limit: 1})
	if len(newest.Notes) != 1 || newest.Notes[0].ID != acao.ID || !newest.More {
		t.Errorf("limit 1 = %+v, want the newest note and More", newest)
	}
	if all := search(t, s, NoteFilter{}); all.More || len(all.Notes) != 4 {
		t.Errorf("all = %d notes, more=%v", len(all.Notes), all.More)
	}

	for _, f := range []NoteFilter{{Since: "bad"}, {Kind: "rant"}, {Query: "   "}, {Query: "\x00"}, {Query: strings.Repeat("w ", maxQueryWords+1)}} {
		if _, err := s.SearchNotes(ctx, f); !isInvalidInput(err) {
			t.Errorf("SearchNotes(%+v) err = %v, want invalid_input", f, err)
		}
	}
	if _, err := s.SearchNotes(ctx, NoteFilter{Query: strings.Repeat("w ", maxQueryWords)}); err != nil {
		t.Errorf("query at the word limit rejected: %v", err)
	}
}

func TestNoteLimitIsClamped(t *testing.T) {
	s, _ := openTest(t)
	for range maxNoteLimit + 5 {
		addNote(t, s, Note{Kind: "checkin", Text: "daily"})
	}
	res := search(t, s, NoteFilter{Limit: 10_000})
	if len(res.Notes) != maxNoteLimit || !res.More {
		t.Errorf("limit 10000 = %d notes, more=%v; want %d and more", len(res.Notes), res.More, maxNoteLimit)
	}
	if def := search(t, s, NoteFilter{}); len(def.Notes) != defaultNoteLimit || !def.More {
		t.Errorf("default = %d notes, more=%v", len(def.Notes), def.More)
	}
}

func TestNotesFTSStaysInSync(t *testing.T) {
	s, _ := openTest(t)
	knee := addNote(t, s, Note{Kind: "symptom", Text: "sore knee"})
	if _, err := s.db.ExecContext(ctx, `UPDATE notes SET text = 'sore ankle' WHERE id = ?`, knee.ID); err != nil {
		t.Fatal(err)
	}
	if n := len(search(t, s, NoteFilter{Query: "knee"}).Notes); n != 0 {
		t.Errorf("stale FTS row after update: %d hits", n)
	}
	if n := len(search(t, s, NoteFilter{Query: "ankle"}).Notes); n != 1 {
		t.Errorf("updated text not indexed: %d hits", n)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM notes WHERE id = ?`, knee.ID); err != nil {
		t.Fatal(err)
	}
	// The next note must not inherit the deleted note's index terms.
	next := addNote(t, s, Note{Kind: "checkin", Text: "fresh start"})
	if next.ID == knee.ID {
		t.Errorf("note id %d reused after delete", next.ID)
	}
	if n := len(search(t, s, NoteFilter{Query: "ankle"}).Notes); n != 0 {
		t.Errorf("deleted note still indexed: %d hits", n)
	}
	// The FTS index must match the content table exactly (proves notes_ad ran).
	if _, err := s.db.ExecContext(ctx, `INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')`); err != nil {
		t.Errorf("FTS integrity check: %v", err)
	}
	var indexed int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes_fts WHERE notes_fts MATCH '"ankle"'`).Scan(&indexed); err != nil || indexed != 0 {
		t.Errorf("raw FTS still has the deleted text: %d rows, %v", indexed, err)
	}
}

func TestNotesValidation(t *testing.T) {
	s, _ := openTest(t)
	bad := []Note{
		{Kind: "checkin", Text: "  "},
		{Kind: "rant", Text: "x"},
		{Kind: "checkin", Text: strings.Repeat("a", maxNoteText+1)},
		{Kind: "checkin", Text: "x", Tags: make([]string, maxTags+1)},
		{Kind: "checkin", Text: "x", Tags: []string{""}},
		{Kind: "checkin", Text: "x", Tags: []string{strings.Repeat("t", maxTagLen+1)}},
		{Kind: "checkin", Text: "x", RelatedDate: "today"},
	}
	for _, n := range bad {
		if _, err := s.AddNote(ctx, n); !isInvalidInput(err) {
			t.Errorf("AddNote(kind %q, %d bytes, %d tags) err = %v, want invalid_input", n.Kind, len(n.Text), len(n.Tags), err)
		}
	}
	tags := make([]string, maxTags)
	for i := range tags {
		tags[i] = strings.Repeat("t", maxTagLen)
	}
	if _, err := s.AddNote(ctx, Note{Kind: "checkin", Text: strings.Repeat("a", maxNoteText), Tags: tags}); err != nil {
		t.Errorf("note at the limits rejected: %v", err)
	}
}

func TestNotesNewestFirstWithinOneSecond(t *testing.T) {
	// 12:00:00.0 then 12:00:00.5: stamps must round-trip exactly and compare as
	// text, which variable-width RFC3339Nano stamps do not.
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
	first := addNote(t, s, Note{Kind: "checkin", Text: "first"})
	second := addNote(t, s, Note{Kind: "checkin", Text: "second"})
	hits := search(t, s, NoteFilter{}).Notes
	if len(hits) != 2 || hits[0].ID != second.ID || hits[1].ID != first.ID {
		t.Fatalf("order = %+v; want second then first", hits)
	}
	if !hits[0].CreatedAt.Equal(stamps[1]) || !hits[1].CreatedAt.Equal(stamps[0]) {
		t.Errorf("created_at round trip = %v, %v", hits[0].CreatedAt, hits[1].CreatedAt)
	}
	var lt int
	if err := s.db.QueryRowContext(ctx, `SELECT (SELECT created_at FROM notes WHERE id = ?) < (SELECT created_at FROM notes WHERE id = ?)`,
		first.ID, second.ID).Scan(&lt); err != nil || lt != 1 {
		t.Errorf("stored stamps do not compare in time order as text (%d, %v)", lt, err)
	}
}

func TestSearchNotesSinceUsesZone(t *testing.T) {
	// Created 2026-10-14 01:00 UTC = 2026-10-13 22:00 in São Paulo.
	s, err := Open(ctx, t.TempDir()+"/coach.db", func() time.Time { return time.Date(2026, 10, 14, 1, 0, 0, 0, time.UTC) })
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	addNote(t, s, Note{Kind: "checkin", Text: "late note"})
	brt, _ := time.LoadLocation("America/Sao_Paulo")
	if hits := search(t, s, NoteFilter{Since: "2026-10-14", Loc: brt}).Notes; len(hits) != 0 {
		t.Errorf("note from local Oct 13 matched since Oct 14: %+v", hits)
	}
	if hits := search(t, s, NoteFilter{Since: "2026-10-13", Loc: brt}).Notes; len(hits) != 1 {
		t.Errorf("note from local Oct 13 missed: %+v", hits)
	}
}

func TestFTSSyntaxErrorMapping(t *testing.T) {
	if err := ftsSyntaxError(errors.New(`SQL logic error: fts5: syntax error near "AND"`)); !isInvalidInput(err) {
		t.Errorf("syntax error = %v, want invalid_input", err)
	}
	// Other FTS5 failures are real faults and must not be blamed on the input.
	for _, msg := range []string{"fts5: missing row 3 from content table", "no such module: fts5", "disk full"} {
		in := errors.New(msg)
		if got := ftsSyntaxError(in); got != in {
			t.Errorf("%q mapped to %v", msg, got)
		}
	}
}

// --- concurrency ---

func TestConcurrentReadThenWriteTransactions(t *testing.T) {
	// Deferred transactions that read and then write fail with SQLITE_BUSY at
	// the lock upgrade; _txlock=immediate makes them wait instead.
	s, _ := openTest(t)
	var wg sync.WaitGroup
	errs := make(chan error, 48)
	for i := range 16 {
		wg.Add(3)
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
		go func() {
			defer wg.Done()
			_, err := s.UpsertHealthItem(ctx, HealthItem{Kind: "supplement", Name: "creatine", Status: "active"})
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
	var targets, items int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM targets`).Scan(&targets)
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM health_items`).Scan(&items)
	if targets != 1 || items != 1 {
		t.Errorf("rows after concurrent upserts: %d targets, %d items; want 1 and 1", targets, items)
	}
	if p, _ := s.Profile(ctx); *p.HeightCm < 170 || *p.HeightCm > 185 {
		t.Errorf("height = %v, want one of the written values", *p.HeightCm)
	}
}
