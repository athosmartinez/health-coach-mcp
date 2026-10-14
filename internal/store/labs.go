package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// LabSources is where a lab result came from, mirrored by the schema CHECK.
var LabSources = []string{"pdf", "chat", "file"}

const (
	// maxLabBatch bounds one report; a full panel is well under this.
	maxLabBatch = 200
	// maxLabRows bounds one query result (years of panels for every analyte).
	maxLabRows = 2000
	// maxLabTotal bounds the table: decades of monthly panels.
	maxLabTotal = 20_000
)

// Lab value statuses. no_reference means the report gave no range, which is
// not the same as normal. flagged means the report marked a value that the
// recorded range does not put outside: the report's mark wins.
const (
	LabInRange     = "in_range"
	LabLow         = "low"
	LabHigh        = "high"
	LabNoReference = "no_reference"
	LabFlagged     = "flagged"
)

// LabValue is one analyte measurement with its reference range as printed.
type LabValue struct {
	Analyte string   `json:"analyte"`
	Value   float64  `json:"value"`
	Unit    string   `json:"unit"`
	RefLow  *float64 `json:"ref_low,omitempty"`
	RefHigh *float64 `json:"ref_high,omitempty"`
	// Exclusive bounds come from ranges printed as "> X" or "< X": a value
	// equal to the bound is already outside.
	RefLowExclusive  bool `json:"ref_low_exclusive,omitempty"`
	RefHighExclusive bool `json:"ref_high_exclusive,omitempty"`
	// RefText is the range exactly as printed, so the chosen bounds can be checked.
	RefText string `json:"ref_text,omitempty"`
	// ReportFlag is the lab's own mark (H, L, crítico, *), passed through.
	ReportFlag string `json:"report_flag,omitempty"`
}

// LabResult is a stored LabValue.
type LabResult struct {
	ID          int64           `json:"id"`
	CollectedOn coach.LocalDate `json:"collected_on"`
	Lab         string          `json:"lab,omitempty"`
	LabValue
	Source    string    `json:"source"`
	CreatedAt time.Time `json:"created_at"`
}

// Status compares the value with its own reference range (R3). Values on an
// inclusive bound are in range.
func (v LabValue) Status() string {
	if v.RefLow == nil && v.RefHigh == nil {
		return LabNoReference
	}
	if lo := v.RefLow; lo != nil && (v.Value < *lo || (v.RefLowExclusive && v.Value == *lo)) {
		return LabLow
	}
	if hi := v.RefHigh; hi != nil && (v.Value > *hi || (v.RefHighExclusive && v.Value == *hi)) {
		return LabHigh
	}
	return LabInRange
}

// OutOfRange reports whether the value falls outside its reference range.
func (v LabValue) OutOfRange() bool { s := v.Status(); return s == LabLow || s == LabHigh }

// Assess is the status to report: Status, except that a value the report itself
// marked is never in_range or no_reference (the range may have been read for
// the wrong sex or age band, and panic limits are not reference ranges).
// urgent is set when the mark says critical.
func (v LabValue) Assess() (status string, urgent bool) {
	status = v.Status()
	if v.ReportFlag != "" && (status == LabInRange || status == LabNoReference) {
		status = LabFlagged
	}
	return status, CriticalFlag(v.ReportFlag)
}

// NeedsReview reports whether a status calls for mentioning the value and
// suggesting a doctor: anything but in_range.
func NeedsReview(status string) bool { return status != LabInRange }

var foldAccents = strings.NewReplacer("á", "a", "à", "a", "â", "a", "ã", "a", "é", "e", "ê", "e",
	"í", "i", "ó", "o", "ô", "o", "õ", "o", "ú", "u", "ç", "c")

// CriticalFlag recognizes the marks labs print for critical (panic) values:
// crítico/critical, pânico/panic, alerta/alert and the HL7 codes HH, LL, AA.
func CriticalFlag(flag string) bool {
	f := foldAccents.Replace(strings.ToLower(strings.TrimSpace(flag)))
	switch f {
	case "hh", "ll", "aa":
		return true
	}
	for _, word := range []string{"crit", "panic", "alert"} {
		if strings.Contains(f, word) {
			return true
		}
	}
	return false
}

// NormalizeAnalyte lowercases and joins words with "_" ("Glucose Fasting" →
// "glucose_fasting") so the same analyte from different reports lines up.
func NormalizeAnalyte(name string) string {
	return strings.Join(strings.Fields(strings.ToLower(name)), "_")
}

// UnitKey compares units ignoring case and spaces ("mg/dL" = "mg / dl"). It
// does not convert: equivalent units with different names stay different.
func UnitKey(unit string) string {
	return strings.ToLower(strings.Join(strings.Fields(unit), ""))
}

func (v LabValue) validate(i int) error {
	if v.Analyte == "" || len(v.Analyte) > maxNameLen {
		return invalid("result %d: analyte is required (max %d characters)", i, maxNameLen)
	}
	if v.Unit == "" || len(v.Unit) > maxNameLen {
		return invalid("result %d (%q): unit is required", i, v.Analyte)
	}
	// Error messages name the analyte, never its value.
	if !finite(v.Value) {
		return invalid("result %d (%q): value must be a finite number", i, v.Analyte)
	}
	for _, ref := range []*float64{v.RefLow, v.RefHigh} {
		if ref != nil && !finite(*ref) {
			return invalid("result %d (%q): reference range must be finite", i, v.Analyte)
		}
	}
	if v.RefLow != nil && v.RefHigh != nil && *v.RefLow > *v.RefHigh {
		return invalid("result %d (%q): ref_low is above ref_high", i, v.Analyte)
	}
	if (v.RefLowExclusive && v.RefLow == nil) || (v.RefHighExclusive && v.RefHigh == nil) {
		return invalid("result %d (%q): an exclusive flag needs its bound", i, v.Analyte)
	}
	if len(v.RefText) > maxNameLen || len(v.ReportFlag) > maxNameLen {
		return invalid("result %d (%q): ref_text or report_flag is too long", i, v.Analyte)
	}
	return nil
}

// LabReplacement is a stored value that a new batch overwrote (same date and
// analyte). The previous status and mark keep a corrected critical value visible.
type LabReplacement struct {
	Analyte            string  `json:"analyte"`
	PreviousValue      float64 `json:"previous_value"`
	PreviousUnit       string  `json:"previous_unit"`
	PreviousLab        string  `json:"previous_lab,omitempty"`
	PreviousStatus     string  `json:"previous_status"`
	PreviousReportFlag string  `json:"previous_report_flag,omitempty"`
}

// LabUnitChange is an analyte recorded in a unit that differs from its nearest
// stored value before or after the collection date: the two must not be
// compared as numbers.
type LabUnitChange struct {
	Analyte   string          `json:"analyte"`
	Unit      string          `json:"unit"`
	OtherUnit string          `json:"other_unit"`
	OtherOn   coach.LocalDate `json:"other_on"`
	Relation  string          `json:"relation" jsonschema:"earlier or later: where other_on falls relative to collected_on"`
}

// LabBatch is the outcome of RecordLabs.
type LabBatch struct {
	Results     []LabResult      `json:"results"`
	Replaced    []LabReplacement `json:"replaced"`
	UnitChanges []LabUnitChange  `json:"unit_changes"`
}

// RecordLabs stores a batch from one collection date. A result for an analyte
// already recorded on that date replaces it (a correction) and is reported in
// Replaced. The batch is validated first and written in one transaction.
func (s *Store) RecordLabs(ctx context.Context, collectedOn coach.LocalDate, lab, source string, values []LabValue) (out LabBatch, err error) {
	defer wrapErr("record labs", &err)
	if err := validDate("collected_on", collectedOn, false); err != nil {
		return LabBatch{}, err
	}
	if err := oneOf("source", source, LabSources, false); err != nil {
		return LabBatch{}, err
	}
	if len(values) == 0 || len(values) > maxLabBatch {
		return LabBatch{}, invalid("a lab batch needs 1 to %d results", maxLabBatch)
	}
	if len(lab) > maxNameLen {
		return LabBatch{}, invalid("lab name is too long")
	}
	values = slices.Clone(values) // normalize without mutating the caller's slice
	for i := range values {
		values[i].Analyte = NormalizeAnalyte(values[i].Analyte)
		values[i].Unit = strings.TrimSpace(values[i].Unit)
		values[i].RefText = strings.TrimSpace(values[i].RefText)
		values[i].ReportFlag = strings.TrimSpace(values[i].ReportFlag)
		if err := values[i].validate(i); err != nil {
			return LabBatch{}, err
		}
	}
	// Two values for one analyte on one date would silently overwrite each other.
	seen := map[string]int{}
	for i, v := range values {
		if j, dup := seen[v.Analyte]; dup {
			return LabBatch{}, invalid("results %d and %d are both %q on %s; send one value per analyte", j, i, v.Analyte, collectedOn)
		}
		seen[v.Analyte] = i
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return LabBatch{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var total int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM lab_results`).Scan(&total); err != nil {
		return LabBatch{}, err
	}
	if total+len(values) > maxLabTotal {
		return LabBatch{}, invalid("lab history is full (%d results)", maxLabTotal)
	}

	stamp, at := s.stamp()
	out = LabBatch{Results: make([]LabResult, 0, len(values)), Replaced: []LabReplacement{}, UnitChanges: []LabUnitChange{}}
	for _, v := range values {
		var (
			prev          LabValue
			prevLab       sql.NullString
			refText, flag sql.NullString
			low, high     sql.NullFloat64
		)
		err := tx.QueryRowContext(ctx, `SELECT value, unit, lab, ref_low, ref_high, ref_low_exclusive,
				ref_high_exclusive, ref_text, report_flag FROM lab_results WHERE collected_on = ? AND analyte = ?`,
			string(collectedOn), v.Analyte).Scan(&prev.Value, &prev.Unit, &prevLab, &low, &high,
			&prev.RefLowExclusive, &prev.RefHighExclusive, &refText, &flag)
		switch {
		case err == nil:
			prev.RefLow, prev.RefHigh, prev.RefText, prev.ReportFlag = floatPtr(low), floatPtr(high), refText.String, flag.String
			status, _ := prev.Assess()
			out.Replaced = append(out.Replaced, LabReplacement{
				Analyte: v.Analyte, PreviousValue: prev.Value, PreviousUnit: prev.Unit, PreviousLab: prevLab.String,
				PreviousStatus: status, PreviousReportFlag: prev.ReportFlag,
			})
		case !errors.Is(err, sql.ErrNoRows):
			return LabBatch{}, err
		}

		// The nearest value on each side: a backfilled old report can differ
		// from newer values as much as a new report from older ones.
		for _, side := range []struct{ relation, query string }{
			{"earlier", `collected_on < ? ORDER BY collected_on DESC`},
			{"later", `collected_on > ? ORDER BY collected_on ASC`},
		} {
			var otherUnit, otherOn string
			err = tx.QueryRowContext(ctx, `SELECT unit, collected_on FROM lab_results WHERE analyte = ? AND `+side.query+` LIMIT 1`,
				v.Analyte, string(collectedOn)).Scan(&otherUnit, &otherOn)
			switch {
			case err == nil && UnitKey(otherUnit) != UnitKey(v.Unit):
				out.UnitChanges = append(out.UnitChanges, LabUnitChange{
					Analyte: v.Analyte, Unit: v.Unit, OtherUnit: otherUnit, OtherOn: coach.LocalDate(otherOn), Relation: side.relation,
				})
			case err != nil && !errors.Is(err, sql.ErrNoRows):
				return LabBatch{}, err
			}
		}

		r := LabResult{CollectedOn: collectedOn, Lab: lab, LabValue: v, Source: source, CreatedAt: at}
		err = tx.QueryRowContext(ctx, `
			INSERT INTO lab_results (collected_on, lab, analyte, value, unit, ref_low, ref_high,
				ref_low_exclusive, ref_high_exclusive, ref_text, report_flag, source, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (collected_on, analyte) DO UPDATE SET lab = excluded.lab, value = excluded.value,
				unit = excluded.unit, ref_low = excluded.ref_low, ref_high = excluded.ref_high,
				ref_low_exclusive = excluded.ref_low_exclusive, ref_high_exclusive = excluded.ref_high_exclusive,
				ref_text = excluded.ref_text, report_flag = excluded.report_flag,
				source = excluded.source, created_at = excluded.created_at
			RETURNING id`,
			string(collectedOn), nullString(lab), v.Analyte, v.Value, v.Unit, nullFloat(v.RefLow), nullFloat(v.RefHigh),
			v.RefLowExclusive, v.RefHighExclusive, nullString(v.RefText), nullString(v.ReportFlag), source, stamp).Scan(&r.ID)
		if err != nil {
			return LabBatch{}, err
		}
		out.Results = append(out.Results, r)
	}
	if err := tx.Commit(); err != nil {
		return LabBatch{}, err
	}
	return out, nil
}

// LabRows is a query result. Truncated means more rows matched than were
// returned; the oldest are the ones left out.
type LabRows struct {
	Results   []LabResult
	Truncated bool
}

// QueryLabs lists results ordered by analyte then date. analyte "" means all;
// since "" means no lower bound. Past the row cap the oldest rows are dropped,
// so each analyte's latest value is never lost.
func (s *Store) QueryLabs(ctx context.Context, analyte string, since coach.LocalDate) (out LabRows, err error) {
	defer wrapErr("query labs", &err)
	if err := validDate("since", since, true); err != nil {
		return LabRows{}, err
	}
	if len(analyte) > maxNameLen {
		return LabRows{}, invalid("analyte is too long (max %d characters)", maxNameLen)
	}
	analyte = NormalizeAnalyte(analyte)
	// Newest first, one extra row to detect truncation: the extra row is the
	// one dropped, then the rest is sorted by analyte and date.
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, collected_on, lab, analyte, value, unit, ref_low, ref_high,
			ref_low_exclusive, ref_high_exclusive, ref_text, report_flag, source, created_at
		FROM lab_results
		WHERE (? = '' OR analyte = ?) AND (? = '' OR collected_on >= ?)
		ORDER BY collected_on DESC, analyte DESC LIMIT ?`,
		analyte, analyte, string(since), string(since), maxLabRows+1)
	if err != nil {
		return LabRows{}, err
	}
	defer rows.Close()
	results := []LabResult{}
	for rows.Next() {
		var (
			r                  LabResult
			collected          string
			stamp              stampCol
			lab, refText, flag sql.NullString
			low, high          sql.NullFloat64
			lowExcl, highExcl  bool
		)
		if err := rows.Scan(&r.ID, &collected, &lab, &r.Analyte, &r.Value, &r.Unit, &low, &high,
			&lowExcl, &highExcl, &refText, &flag, &r.Source, &stamp); err != nil {
			return LabRows{}, err
		}
		r.CollectedOn, r.Lab, r.RefLow, r.RefHigh, r.CreatedAt =
			coach.LocalDate(collected), lab.String, floatPtr(low), floatPtr(high), time.Time(stamp)
		r.RefLowExclusive, r.RefHighExclusive, r.RefText, r.ReportFlag = lowExcl, highExcl, refText.String, flag.String
		results = append(results, r)
	}
	if err := rows.Err(); err != nil {
		return LabRows{}, err
	}
	truncated := len(results) > maxLabRows
	if truncated {
		results = results[:maxLabRows]
	}
	// Byte order, matching SQLite's default BINARY collation.
	slices.SortFunc(results, func(a, b LabResult) int {
		if c := strings.Compare(a.Analyte, b.Analyte); c != 0 {
			return c
		}
		return strings.Compare(string(a.CollectedOn), string(b.CollectedOn))
	})
	return LabRows{Results: results, Truncated: truncated}, nil
}
