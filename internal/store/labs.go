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
// not the same as normal.
const (
	LabInRange     = "in_range"
	LabLow         = "low"
	LabHigh        = "high"
	LabNoReference = "no_reference"
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

// LabReplacement is a stored value that a new batch overwrote (same date and analyte).
type LabReplacement struct {
	Analyte       string  `json:"analyte"`
	PreviousValue float64 `json:"previous_value"`
	PreviousUnit  string  `json:"previous_unit"`
	PreviousLab   string  `json:"previous_lab,omitempty"`
}

// LabUnitChange is an analyte recorded in a unit that differs from its most
// recent earlier value: the two must not be compared as numbers.
type LabUnitChange struct {
	Analyte      string          `json:"analyte"`
	PreviousUnit string          `json:"previous_unit"`
	PreviousOn   coach.LocalDate `json:"previous_on"`
	Unit         string          `json:"unit"`
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
			prevValue        float64
			prevUnit         string
			prevLab          sql.NullString
			lastUnit, lastOn string
		)
		err := tx.QueryRowContext(ctx, `SELECT value, unit, lab FROM lab_results WHERE collected_on = ? AND analyte = ?`,
			string(collectedOn), v.Analyte).Scan(&prevValue, &prevUnit, &prevLab)
		switch {
		case err == nil:
			out.Replaced = append(out.Replaced, LabReplacement{v.Analyte, prevValue, prevUnit, prevLab.String})
		case !errors.Is(err, sql.ErrNoRows):
			return LabBatch{}, err
		}

		err = tx.QueryRowContext(ctx, `SELECT unit, collected_on FROM lab_results WHERE analyte = ? AND collected_on < ?
			ORDER BY collected_on DESC LIMIT 1`, v.Analyte, string(collectedOn)).Scan(&lastUnit, &lastOn)
		switch {
		case err == nil && UnitKey(lastUnit) != UnitKey(v.Unit):
			out.UnitChanges = append(out.UnitChanges, LabUnitChange{v.Analyte, lastUnit, coach.LocalDate(lastOn), v.Unit})
		case err != nil && !errors.Is(err, sql.ErrNoRows):
			return LabBatch{}, err
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
	analyte = NormalizeAnalyte(analyte)
	// The inner query keeps the newest rows (one extra to detect truncation);
	// the outer one restores the analyte-then-date order.
	rows, err := s.db.QueryContext(ctx, `
		SELECT * FROM (
			SELECT id, collected_on, lab, analyte, value, unit, ref_low, ref_high,
				ref_low_exclusive, ref_high_exclusive, ref_text, report_flag, source, created_at
			FROM lab_results
			WHERE (? = '' OR analyte = ?) AND (? = '' OR collected_on >= ?)
			ORDER BY collected_on DESC, analyte DESC LIMIT ?
		) ORDER BY analyte, collected_on`,
		analyte, analyte, string(since), string(since), maxLabRows+1)
	if err != nil {
		return LabRows{}, err
	}
	defer rows.Close()
	results := []LabResult{}
	oldest := -1
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
		// The extra row is the oldest date, last analyte among ties.
		if o := oldest; o < 0 || r.CollectedOn < results[o].CollectedOn ||
			(r.CollectedOn == results[o].CollectedOn && r.Analyte > results[o].Analyte) {
			oldest = len(results) - 1
		}
	}
	if err := rows.Err(); err != nil {
		return LabRows{}, err
	}
	if len(results) > maxLabRows {
		return LabRows{Results: slices.Delete(results, oldest, oldest+1), Truncated: true}, nil
	}
	return LabRows{Results: results}, nil
}
