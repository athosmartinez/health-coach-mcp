package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// LabSources is where a lab result came from, mirrored by the schema CHECK.
var LabSources = []string{"pdf", "chat", "file"}

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

// RecordLabs stores a batch from one collection date. A result for an analyte
// already recorded on that date replaces it (a correction), in one transaction.
func (s *Store) RecordLabs(ctx context.Context, collectedOn coach.LocalDate, lab, source string, values []LabValue) ([]LabResult, error) {
	if _, err := coach.ParseDate(string(collectedOn)); err != nil {
		return nil, fmt.Errorf("labs collected_on: %w", err)
	}
	if len(values) == 0 {
		return nil, errors.New("labs batch is empty")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	stamp := s.stamp()
	out := make([]LabResult, 0, len(values))
	for _, v := range values {
		v.Analyte = NormalizeAnalyte(v.Analyte)
		if v.Analyte == "" || v.Unit == "" {
			return nil, errors.New("lab result needs analyte and unit")
		}
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
func (s *Store) QueryLabs(ctx context.Context, analyte string, since coach.LocalDate) ([]LabResult, error) {
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
	out := []LabResult{}
	for rows.Next() {
		var (
			r                LabResult
			collected, stamp string
			lab              sql.NullString
			low, high        sql.NullFloat64
		)
		if err := rows.Scan(&r.ID, &collected, &lab, &r.Analyte, &r.Value, &r.Unit, &low, &high, &r.Source, &stamp); err != nil {
			return nil, err
		}
		r.CollectedOn, r.Lab, r.RefLow, r.RefHigh, r.CreatedAt =
			coach.LocalDate(collected), lab.String, floatPtr(low), floatPtr(high), parseStamp(stamp)
		out = append(out, r)
	}
	return out, rows.Err()
}
