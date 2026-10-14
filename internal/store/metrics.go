package store

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// MetricKeys is the closed list of cacheable daily scalars (CAPABILITY §5.3).
var MetricKeys = []string{
	"sleep_asleep_min", "sleep_awake_min", "sleep_in_bed_min", "sleep_deep_min", "sleep_light_min",
	"sleep_rem_min", "sleep_start_min_of_day", "hrv_rmssd_ms", "resting_hr_bpm", "steps", "azm_min",
	"total_calories_kcal", "weight_kg", "body_fat_pct",
}

// Metric is one cached daily value. The cache is disposable: deciding what to
// cache (settled days only, never null or partial) is the caller's job.
type Metric struct {
	Date        coach.LocalDate `json:"date"`
	Key         string          `json:"metric"`
	Value       float64         `json:"value"`
	NSamples    *int            `json:"n_samples,omitempty"`
	Source      string          `json:"source,omitempty"`
	AlgoVersion int             `json:"algo_version"`
	FetchedAt   time.Time       `json:"fetched_at"`
}

// PutMetric stores or replaces the value for (date, metric).
func (s *Store) PutMetric(ctx context.Context, m Metric) (err error) {
	defer wrapErr("put metric", &err)
	if !slices.Contains(MetricKeys, m.Key) {
		return invalid("metric must be one of %s", strings.Join(MetricKeys, ", "))
	}
	if _, err := coach.ParseDate(string(m.Date)); err != nil {
		return invalid("metric date must be YYYY-MM-DD")
	}
	// Never echo the value: it is a health measurement.
	if !finite(m.Value) {
		return invalid("metric %s on %s: value is not finite", m.Key, m.Date)
	}
	fetched := m.FetchedAt
	if fetched.IsZero() {
		fetched = s.now()
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO daily_metrics (date, metric, value, n_samples, source, algo_version, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (date, metric) DO UPDATE SET value = excluded.value, n_samples = excluded.n_samples,
			source = excluded.source, algo_version = excluded.algo_version, fetched_at = excluded.fetched_at`,
		string(m.Date), m.Key, m.Value, nullInt(m.NSamples), nullString(m.Source), m.AlgoVersion,
		fetched.UTC().Format(timeLayout))
	return err
}

// GetMetric returns the cached value. A row computed by a different
// algo_version counts as a miss (ErrNotFound), so it gets recomputed.
func (s *Store) GetMetric(ctx context.Context, day coach.LocalDate, key string, algoVersion int) (Metric, error) {
	ms, err := s.MetricRange(ctx, key, day, day, algoVersion)
	if err != nil {
		return Metric{}, err
	}
	if len(ms) == 0 {
		return Metric{}, fmt.Errorf("metric %s on %s: %w", key, day, ErrNotFound)
	}
	return ms[0], nil
}

// MetricRange returns cached values for key on [from, to], oldest first,
// skipping rows from another algo_version.
func (s *Store) MetricRange(ctx context.Context, key string, from, to coach.LocalDate, algoVersion int) (out []Metric, err error) {
	defer wrapErr("metric range", &err)
	rows, err := s.db.QueryContext(ctx, `
		SELECT date, value, n_samples, source, fetched_at FROM daily_metrics
		WHERE metric = ? AND date >= ? AND date <= ? AND algo_version = ? ORDER BY date`,
		key, string(from), string(to), algoVersion)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out = []Metric{}
	for rows.Next() {
		var (
			m      = Metric{Key: key, AlgoVersion: algoVersion}
			day    string
			stamp  stampCol
			n      sql.NullInt64
			source sql.NullString
		)
		if err := rows.Scan(&day, &m.Value, &n, &source, &stamp); err != nil {
			return nil, err
		}
		m.Date, m.NSamples, m.Source, m.FetchedAt = coach.LocalDate(day), intPtr(n), source.String, time.Time(stamp)
		out = append(out, m)
	}
	return out, rows.Err()
}

// ClearMetrics empties the cache; the source of truth is the API.
func (s *Store) ClearMetrics(ctx context.Context) (err error) {
	defer wrapErr("clear metrics", &err)
	_, err = s.db.ExecContext(ctx, `DELETE FROM daily_metrics`)
	return err
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
