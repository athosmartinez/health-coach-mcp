package store

import (
	"context"
	"database/sql"
	"slices"
	"strings"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// LabSources is where a lab result came from, mirrored by the schema CHECK.
var LabSources = []string{"pdf", "chat", "file"}

// maxLabBatch bounds one report; a full panel is well under this.
const maxLabBatch = 200

// LabValue is one analyte measurement with its reference range.
type LabValue struct {
	Analyte string   `json:"analyte"`
	Value   float64  `json:"value"`
	Unit    string   `json:"unit"`
	RefLow  *float64 `json:"ref_low,omitempty"`
	RefHigh *float64 `json:"ref_high,omitempty"`
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

// OutOfRange reports whether the value falls outside its reference range (R3).
func (r LabResult) OutOfRange() bool {
	return (r.RefLow != nil && r.Value < *r.RefLow) || (r.RefHigh != nil && r.Value > *r.RefHigh)
}

// NormalizeAnalyte lowercases and joins words with "_" ("Glucose Fasting" →
// "glucose_fasting") so the same analyte from different reports lines up.
func NormalizeAnalyte(name string) string {
	return strings.Join(strings.Fields(strings.ToLower(name)), "_")
}

func (v LabValue) validate(i int) error {
	if v.Analyte == "" || len(v.Analyte) > maxNameLen {
		return invalid("result %d: analyte is required (max %d characters)", i, maxNameLen)
	}
	if v.Unit == "" || len(v.Unit) > maxNameLen {
		return invalid("result %d (%s): unit is required", i, v.Analyte)
	}
	// Error messages name the analyte, never its value.
	if !finite(v.Value) {
		return invalid("result %d (%s): value must be a finite number", i, v.Analyte)
	}
	for _, ref := range []*float64{v.RefLow, v.RefHigh} {
		if ref != nil && !finite(*ref) {
			return invalid("result %d (%s): reference range must be finite", i, v.Analyte)
		}
	}
	if v.RefLow != nil && v.RefHigh != nil && *v.RefLow > *v.RefHigh {
		return invalid("result %d (%s): ref_low is above ref_high", i, v.Analyte)
	}
	return nil
}

// RecordLabs stores a batch from one collection date. A result for an analyte
// already recorded on that date replaces it (a correction). The batch is
// validated first and written in one transaction: all or nothing.
func (s *Store) RecordLabs(ctx context.Context, collectedOn coach.LocalDate, lab, source string, values []LabValue) (out []LabResult, err error) {
	defer wrapErr("record labs", &err)
	if _, err := coach.ParseDate(string(collectedOn)); err != nil {
		return nil, invalid("collected_on must be YYYY-MM-DD")
	}
	if !slices.Contains(LabSources, source) {
		return nil, invalid("source must be one of %s", strings.Join(LabSources, ", "))
	}
	if len(values) == 0 || len(values) > maxLabBatch {
		return nil, invalid("a lab batch needs 1 to %d results", maxLabBatch)
	}
	if len(lab) > maxNameLen {
		return nil, invalid("lab name is too long")
	}
	values = slices.Clone(values) // normalize without mutating the caller's slice
	for i := range values {
		values[i].Analyte = NormalizeAnalyte(values[i].Analyte)
		values[i].Unit = strings.TrimSpace(values[i].Unit)
		if err := values[i].validate(i); err != nil {
			return nil, err
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	stamp := s.stamp()
	out = make([]LabResult, 0, len(values))
	for _, v := range values {
		r := LabResult{CollectedOn: collectedOn, Lab: lab, LabValue: v, Source: source, CreatedAt: parseStamp(stamp)}
		err := tx.QueryRowContext(ctx, `
			INSERT INTO lab_results (collected_on, lab, analyte, value, unit, ref_low, ref_high, source, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (collected_on, analyte) DO UPDATE SET lab = excluded.lab, value = excluded.value,
				unit = excluded.unit, ref_low = excluded.ref_low, ref_high = excluded.ref_high,
				source = excluded.source, created_at = excluded.created_at
			RETURNING id`,
			string(collectedOn), nullString(lab), v.Analyte, v.Value, v.Unit,
			nullFloat(v.RefLow), nullFloat(v.RefHigh), source, stamp).Scan(&r.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// QueryLabs lists results ordered by analyte then date. analyte "" means all;
// since "" means no lower bound.
func (s *Store) QueryLabs(ctx context.Context, analyte string, since coach.LocalDate) (out []LabResult, err error) {
	defer wrapErr("query labs", &err)
	analyte = NormalizeAnalyte(analyte)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, collected_on, lab, analyte, value, unit, ref_low, ref_high, source, created_at FROM lab_results
		WHERE (? = '' OR analyte = ?) AND (? = '' OR collected_on >= ?)
		ORDER BY analyte, collected_on`,
		analyte, analyte, string(since), string(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out = []LabResult{}
	for rows.Next() {
		var (
			r         LabResult
			collected string
			stamp     stampCol
			lab       sql.NullString
			low, high sql.NullFloat64
		)
		if err := rows.Scan(&r.ID, &collected, &lab, &r.Analyte, &r.Value, &r.Unit, &low, &high, &r.Source, &stamp); err != nil {
			return nil, err
		}
		r.CollectedOn, r.Lab, r.RefLow, r.RefHigh, r.CreatedAt =
			coach.LocalDate(collected), lab.String, floatPtr(low), floatPtr(high), time.Time(stamp)
		out = append(out, r)
	}
	return out, rows.Err()
}
