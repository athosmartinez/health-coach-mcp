package store

import (
	"strings"
	"testing"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

func TestLabAssessLetsTheReportFlagWin(t *testing.T) {
	lo, hi := ptr(3.5), ptr(5.1)
	cases := []struct {
		v          LabValue
		want       string
		wantUrgent bool
	}{
		{LabValue{Value: 4, RefLow: lo, RefHigh: hi}, LabInRange, false},
		{LabValue{Value: 4, RefLow: lo, RefHigh: hi, ReportFlag: "H"}, LabFlagged, false}, // wrong band picked
		{LabValue{Value: 4, RefLow: lo, RefHigh: hi, ReportFlag: "crítico"}, LabFlagged, true},
		{LabValue{Value: 6.4, RefLow: lo, RefHigh: hi, ReportFlag: "Crítico"}, LabHigh, true},
		{LabValue{Value: 2, RefLow: lo, RefHigh: hi, ReportFlag: "LL"}, LabLow, true},
		{LabValue{Value: 9, ReportFlag: "*"}, LabFlagged, false}, // no range, but marked
		{LabValue{Value: 9}, LabNoReference, false},
	}
	for _, c := range cases {
		got, urgent := c.v.Assess()
		if got != c.want || urgent != c.wantUrgent {
			t.Errorf("Assess(%+v) = %s, %v; want %s, %v", c.v, got, urgent, c.want, c.wantUrgent)
		}
	}
	for _, s := range []string{LabLow, LabHigh, LabFlagged, LabNoReference} {
		if !NeedsReview(s) {
			t.Errorf("NeedsReview(%s) = false", s)
		}
	}
	if NeedsReview(LabInRange) {
		t.Error("NeedsReview(in_range) = true")
	}
}

func TestCriticalFlag(t *testing.T) {
	for _, f := range []string{"crítico", "CRITICO", "Valor crítico", "critical", "pânico", "panic", "alerta", "HH", " ll ", "AA"} {
		if !CriticalFlag(f) {
			t.Errorf("CriticalFlag(%q) = false", f)
		}
	}
	for _, f := range []string{"", "H", "L", "*", "A", "alto", "baixo", "hhh"} {
		if CriticalFlag(f) {
			t.Errorf("CriticalFlag(%q) = true", f)
		}
	}
}

func TestRecordLabsCorrectionOverwritesEveryField(t *testing.T) {
	s, _ := openTest(t)
	if _, err := s.RecordLabs(ctx, "2026-09-01", "LabA", "pdf", []LabValue{{
		Analyte: "hdl", Value: 50, Unit: "mg/dL", RefLow: ptr(40.0), RefHigh: ptr(90.0), RefText: "40 a 90",
	}}); err != nil {
		t.Fatal(err)
	}
	fixed := LabValue{Analyte: "hdl", Value: 1.2, Unit: "mmol/L", RefLow: ptr(1.0), RefHigh: ptr(2.0),
		RefLowExclusive: true, RefHighExclusive: true, RefText: "> 1,0", ReportFlag: "L"}
	if _, err := s.RecordLabs(ctx, "2026-09-01", "LabB", "chat", []LabValue{fixed}); err != nil {
		t.Fatal(err)
	}
	rows, err := labRows(s.QueryLabs(ctx, "hdl", ""))
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows = %+v, %v", rows, err)
	}
	got := rows[0]
	if got.Value != 1.2 || got.Unit != "mmol/L" || *got.RefLow != 1.0 || *got.RefHigh != 2.0 ||
		!got.RefLowExclusive || !got.RefHighExclusive || got.RefText != "> 1,0" || got.ReportFlag != "L" ||
		got.Lab != "LabB" || got.Source != "chat" {
		t.Errorf("correction kept old fields: %+v", got)
	}
}

func TestReplacedKeepsPreviousStatusAndFlag(t *testing.T) {
	s, _ := openTest(t)
	lo, hi := ptr(3.5), ptr(5.1)
	if _, err := s.RecordLabs(ctx, "2026-09-01", "", "pdf", []LabValue{
		{Analyte: "potassium", Value: 6.4, Unit: "mmol/L", RefLow: lo, RefHigh: hi, ReportFlag: "crítico"},
		{Analyte: "sodium", Value: 140, Unit: "mmol/L", RefLow: ptr(135.0), RefHigh: ptr(145.0), ReportFlag: "*"},
	}); err != nil {
		t.Fatal(err)
	}
	b, err := s.RecordLabs(ctx, "2026-09-01", "", "chat", []LabValue{
		{Analyte: "potassium", Value: 4.4, Unit: "mmol/L", RefLow: lo, RefHigh: hi},
		{Analyte: "sodium", Value: 140, Unit: "mmol/L", RefLow: ptr(135.0), RefHigh: ptr(145.0)},
	})
	if err != nil || len(b.Replaced) != 2 {
		t.Fatalf("replaced = %+v, %v", b.Replaced, err)
	}
	if r := b.Replaced[0]; r.PreviousStatus != LabHigh || r.PreviousReportFlag != "crítico" {
		t.Errorf("critical value corrected without a trace: %+v", r)
	}
	if r := b.Replaced[1]; r.PreviousStatus != LabFlagged || r.PreviousReportFlag != "*" {
		t.Errorf("flagged value corrected without a trace: %+v", r)
	}
}

func TestUnitChangesCheckBothSidesAndTheNearestValue(t *testing.T) {
	s, _ := openTest(t)
	rec := func(on, unit string) LabBatch {
		t.Helper()
		b, err := s.RecordLabs(ctx, coach.LocalDate(on), "", "chat", []LabValue{{Analyte: "glucose", Value: 1, Unit: unit}})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	rec("2026-01-01", "mg/dL")
	if b := rec("2026-03-01", "mmol/L"); len(b.UnitChanges) != 1 || b.UnitChanges[0].OtherOn != "2026-01-01" {
		t.Errorf("change against the earlier value missed: %+v", b.UnitChanges)
	}
	// The nearest earlier value is mmol/L, not the oldest one in mg/dL.
	if b := rec("2026-05-01", "mmol/L"); len(b.UnitChanges) != 0 {
		t.Errorf("compared with the oldest value instead of the nearest: %+v", b.UnitChanges)
	}
	// A backfilled report: mg/dL on 2026-02-01 matches the earlier value but not the later one.
	b := rec("2026-02-01", "mg/dL")
	want := LabUnitChange{Analyte: "glucose", Unit: "mg/dL", OtherUnit: "mmol/L", OtherOn: "2026-03-01", Relation: "later"}
	if len(b.UnitChanges) != 1 || b.UnitChanges[0] != want {
		t.Errorf("backfill unit changes = %+v, want [%+v]", b.UnitChanges, want)
	}
	// A same-date correction is compared with its neighbours, never with itself.
	b = rec("2026-05-01", "mg/dL")
	if len(b.Replaced) != 1 || b.Replaced[0].PreviousUnit != "mmol/L" {
		t.Errorf("replaced = %+v", b.Replaced)
	}
	if len(b.UnitChanges) != 1 || b.UnitChanges[0].OtherOn != "2026-03-01" || b.UnitChanges[0].Relation != "earlier" {
		t.Errorf("correction unit changes = %+v", b.UnitChanges)
	}
}

func TestQueryLabsTruncationDropsExactlyTheOldestRow(t *testing.T) {
	s, _ := openTest(t)
	stamp, _ := s.stamp()
	// Two analytes share the oldest date, plus enough newer rows to reach the cap exactly.
	if _, err := s.RecordLabs(ctx, "2000-01-01", "", "chat", []LabValue{
		{Analyte: "bbb", Value: 1, Unit: "u"}, {Analyte: "ccc", Value: 1, Unit: "u"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < ?)
		INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at)
		SELECT date('2001-01-01', '+' || i || ' days'), 'mmm', i, 'u', 'chat', ? FROM seq`, maxLabRows-2, stamp); err != nil {
		t.Fatal(err)
	}
	r, err := s.QueryLabs(ctx, "", "")
	if err != nil || r.Truncated || len(r.Results) != maxLabRows {
		t.Fatalf("exactly the cap: truncated=%v rows=%d err=%v; want false and %d", r.Truncated, len(r.Results), err, maxLabRows)
	}
	// One more row on the oldest date: newest-first order puts "aaa" last, so it is the one left out.
	if _, err := s.RecordLabs(ctx, "2000-01-01", "", "chat", []LabValue{{Analyte: "aaa", Value: 1, Unit: "u"}}); err != nil {
		t.Fatal(err)
	}
	r, err = s.QueryLabs(ctx, "", "")
	if err != nil || !r.Truncated || len(r.Results) != maxLabRows {
		t.Fatalf("over the cap: truncated=%v rows=%d err=%v", r.Truncated, len(r.Results), err)
	}
	got := map[string]bool{}
	for _, x := range r.Results {
		got[x.Analyte] = true
	}
	if got["aaa"] || !got["bbb"] || !got["ccc"] {
		t.Errorf("wrong row dropped: analytes present %v", got)
	}
	for i := 1; i < len(r.Results); i++ {
		a, b := r.Results[i-1], r.Results[i]
		if a.Analyte > b.Analyte || (a.Analyte == b.Analyte && a.CollectedOn >= b.CollectedOn) {
			t.Fatalf("not ordered by analyte then date at %d: %s/%s, %s/%s", i, a.Analyte, a.CollectedOn, b.Analyte, b.CollectedOn)
		}
	}
	// since is inclusive.
	if one, err := labRows(s.QueryLabs(ctx, "bbb", "2000-01-01")); err != nil || len(one) != 1 {
		t.Errorf("since on the collection date = %+v, %v", one, err)
	}
}

func TestQueryLabsRejectsLongAnalyte(t *testing.T) {
	s, _ := openTest(t)
	if _, err := s.QueryLabs(ctx, strings.Repeat("a", maxNameLen+1), ""); !isInvalidInput(err) {
		t.Errorf("err = %v", err)
	}
}
