package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// Goal is the body-composition goal stored as profile.goal_json.
type Goal struct {
	Type             string          `json:"type,omitempty"`
	TargetWeightKg   *float64        `json:"target_weight_kg,omitempty"`
	TargetBodyFatPct *float64        `json:"target_body_fat_pct,omitempty"`
	Deadline         coach.LocalDate `json:"deadline,omitempty"`
}

// TrainingPlan is stored as profile.plan_json. The weekly sessions target is
// deliberately absent: it lives only in targets.
type TrainingPlan struct {
	Split string `json:"split,omitempty"`
	Notes string `json:"notes,omitempty"`
}

// Profile is the singleton user profile (R1).
type Profile struct {
	BirthDate coach.LocalDate `json:"birth_date,omitempty"`
	Sex       string          `json:"sex,omitempty"`
	HeightCm  *float64        `json:"height_cm,omitempty"`
	Goal      *Goal           `json:"goal,omitempty"`
	Plan      *TrainingPlan   `json:"training_plan,omitempty"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// ProfilePatch updates only its non-nil fields; Goal and Plan replace the whole object.
type ProfilePatch struct {
	BirthDate *coach.LocalDate
	Sex       *string
	HeightCm  *float64
	Goal      *Goal
	Plan      *TrainingPlan
}

// Profile returns the profile, or ErrNotFound before the first update.
func (s *Store) Profile(ctx context.Context) (Profile, error) {
	return getProfile(ctx, s.db)
}

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func getProfile(ctx context.Context, q querier) (Profile, error) {
	var (
		p                    Profile
		birth, sex, goal, pl sql.NullString
		height               sql.NullFloat64
		updated              string
	)
	err := q.QueryRowContext(ctx,
		`SELECT birth_date, sex, height_cm, goal_json, plan_json, updated_at FROM profile WHERE id = 1`).
		Scan(&birth, &sex, &height, &goal, &pl, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Profile{}, ErrNotFound
	}
	if err != nil {
		return Profile{}, err
	}
	p.BirthDate, p.Sex, p.HeightCm, p.UpdatedAt = coach.LocalDate(birth.String), sex.String, floatPtr(height), parseStamp(updated)
	if goal.Valid {
		p.Goal = &Goal{}
		if err := json.Unmarshal([]byte(goal.String), p.Goal); err != nil {
			return Profile{}, fmt.Errorf("profile goal_json: %w", err)
		}
	}
	if pl.Valid {
		p.Plan = &TrainingPlan{}
		if err := json.Unmarshal([]byte(pl.String), p.Plan); err != nil {
			return Profile{}, fmt.Errorf("profile plan_json: %w", err)
		}
	}
	return p, nil
}

// UpdateProfile merges patch into the stored profile (creating it if needed).
func (s *Store) UpdateProfile(ctx context.Context, patch ProfilePatch) (Profile, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Profile{}, err
	}
	defer func() { _ = tx.Rollback() }()

	p, err := getProfile(ctx, tx)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Profile{}, err
	}
	if patch.BirthDate != nil {
		p.BirthDate = *patch.BirthDate
	}
	if patch.Sex != nil {
		p.Sex = *patch.Sex
	}
	if patch.HeightCm != nil {
		p.HeightCm = patch.HeightCm
	}
	if patch.Goal != nil {
		p.Goal = patch.Goal
	}
	if patch.Plan != nil {
		p.Plan = patch.Plan
	}
	goal, err := jsonOrNull(p.Goal)
	if err != nil {
		return Profile{}, err
	}
	plan, err := jsonOrNull(p.Plan)
	if err != nil {
		return Profile{}, err
	}
	stamp := s.stamp()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO profile (id, birth_date, sex, height_cm, goal_json, plan_json, updated_at)
		VALUES (1, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET birth_date = excluded.birth_date, sex = excluded.sex,
			height_cm = excluded.height_cm, goal_json = excluded.goal_json,
			plan_json = excluded.plan_json, updated_at = excluded.updated_at`,
		nullString(string(p.BirthDate)), nullString(p.Sex), nullFloat(p.HeightCm), goal, plan, stamp); err != nil {
		return Profile{}, err
	}
	if err := tx.Commit(); err != nil {
		return Profile{}, err
	}
	p.UpdatedAt = parseStamp(stamp)
	return p, nil
}

func jsonOrNull[T any](v *T) (sql.NullString, error) {
	if v == nil {
		return sql.NullString{}, nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return sql.NullString{}, err
	}
	return sql.NullString{String: string(b), Valid: true}, nil
}

// Target is one version of the user's targets (I6): a new version starts on
// EffectiveFrom and earlier versions are kept for history.
type Target struct {
	EffectiveFrom  coach.LocalDate `json:"effective_from"`
	Kcal           *int            `json:"kcal,omitempty"`
	ProteinG       *int            `json:"protein_g,omitempty"`
	WeeklySessions *int            `json:"weekly_sessions,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
}

// SetTarget stores a target version. Setting the same EffectiveFrom again
// replaces that version (a correction), never an earlier one.
func (s *Store) SetTarget(ctx context.Context, t Target) (Target, error) {
	if _, err := coach.ParseDate(string(t.EffectiveFrom)); err != nil {
		return Target{}, fmt.Errorf("target effective_from: %w", err)
	}
	if t.Kcal == nil && t.ProteinG == nil && t.WeeklySessions == nil {
		return Target{}, errors.New("target needs at least one of kcal, protein_g, weekly_sessions")
	}
	stamp := s.stamp()
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO targets (effective_from, kcal, protein_g, weekly_sessions, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (effective_from) DO UPDATE SET kcal = excluded.kcal, protein_g = excluded.protein_g,
			weekly_sessions = excluded.weekly_sessions, created_at = excluded.created_at`,
		string(t.EffectiveFrom), nullInt(t.Kcal), nullInt(t.ProteinG), nullInt(t.WeeklySessions), stamp); err != nil {
		return Target{}, err
	}
	t.CreatedAt = parseStamp(stamp)
	return t, nil
}

// TargetInForce returns the latest version that started on or before day.
func (s *Store) TargetInForce(ctx context.Context, day coach.LocalDate) (Target, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT effective_from, kcal, protein_g, weekly_sessions, created_at FROM targets
		WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`, string(day))
	if err != nil {
		return Target{}, err
	}
	ts, err := scanTargets(rows)
	if err != nil {
		return Target{}, err
	}
	if len(ts) == 0 {
		return Target{}, ErrNotFound
	}
	return ts[0], nil
}

// Targets lists every version, newest first.
func (s *Store) Targets(ctx context.Context) ([]Target, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT effective_from, kcal, protein_g, weekly_sessions, created_at FROM targets ORDER BY effective_from DESC`)
	if err != nil {
		return nil, err
	}
	return scanTargets(rows)
}

func scanTargets(rows *sql.Rows) ([]Target, error) {
	defer rows.Close()
	out := []Target{}
	for rows.Next() {
		var (
			t                       Target
			from, created           string
			kcal, protein, sessions sql.NullInt64
		)
		if err := rows.Scan(&from, &kcal, &protein, &sessions, &created); err != nil {
			return nil, err
		}
		t.EffectiveFrom, t.Kcal, t.ProteinG, t.WeeklySessions, t.CreatedAt =
			coach.LocalDate(from), intPtr(kcal), intPtr(protein), intPtr(sessions), parseStamp(created)
		out = append(out, t)
	}
	return out, rows.Err()
}

// Health item kinds and statuses, mirrored by the schema CHECK constraints.
var (
	HealthItemKinds    = []string{"condition", "medication", "supplement", "injury", "allergy", "restriction"}
	HealthItemStatuses = []string{"active", "resolved", "paused"}
)

// HealthItem is one entry of the health history, unique by (Kind, Name).
type HealthItem struct {
	ID        int64           `json:"id"`
	Kind      string          `json:"kind"`
	Name      string          `json:"name"`
	Status    string          `json:"status"`
	Details   string          `json:"details,omitempty"`
	StartedOn coach.LocalDate `json:"started_on,omitempty"`
	EndedOn   coach.LocalDate `json:"ended_on,omitempty"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// UpsertHealthItem creates the item or replaces the one with the same kind and name.
func (s *Store) UpsertHealthItem(ctx context.Context, it HealthItem) (HealthItem, error) {
	if it.Name == "" {
		return HealthItem{}, errors.New("health item name is required")
	}
	stamp := s.stamp()
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO health_items (kind, name, status, details, started_on, ended_on, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (kind, name) DO UPDATE SET status = excluded.status, details = excluded.details,
			started_on = excluded.started_on, ended_on = excluded.ended_on, updated_at = excluded.updated_at
		RETURNING id`,
		it.Kind, it.Name, it.Status, nullString(it.Details), nullString(string(it.StartedOn)),
		nullString(string(it.EndedOn)), stamp).Scan(&it.ID)
	if err != nil {
		return HealthItem{}, err
	}
	it.UpdatedAt = parseStamp(stamp)
	return it, nil
}

// HealthItems lists items, optionally filtered by kind and status ("" = any).
func (s *Store) HealthItems(ctx context.Context, kind, status string) ([]HealthItem, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, kind, name, status, details, started_on, ended_on, updated_at FROM health_items
		WHERE (? = '' OR kind = ?) AND (? = '' OR status = ?) ORDER BY kind, name`,
		kind, kind, status, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HealthItem{}
	for rows.Next() {
		var (
			it                      HealthItem
			details, started, ended sql.NullString
			updated                 string
		)
		if err := rows.Scan(&it.ID, &it.Kind, &it.Name, &it.Status, &details, &started, &ended, &updated); err != nil {
			return nil, err
		}
		it.Details, it.StartedOn, it.EndedOn, it.UpdatedAt =
			details.String, coach.LocalDate(started.String), coach.LocalDate(ended.String), parseStamp(updated)
		out = append(out, it)
	}
	return out, rows.Err()
}

// SetPreference stores a free-form JSON value under key.
func (s *Store) SetPreference(ctx context.Context, key string, value json.RawMessage) error {
	if key == "" {
		return errors.New("preference key is required")
	}
	if !json.Valid(value) {
		return fmt.Errorf("preference %q: value is not valid JSON", key)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		key, string(value), s.stamp())
	return err
}

// Preferences returns every preference by key.
func (s *Store) Preferences(ctx context.Context) (map[string]json.RawMessage, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value_json FROM preferences ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]json.RawMessage{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = json.RawMessage(v)
	}
	return out, rows.Err()
}
