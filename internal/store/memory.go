package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// Size limits keep one bad tool call from bloating the store or the context.
const (
	maxNameLen     = 200
	maxDetailsLen  = 4 << 10
	maxPrefKeyLen  = 100
	maxPrefValue   = 16 << 10
	maxProfileText = 2 << 10
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

// ProfileFields are the names accepted by ProfilePatch.Clear.
var ProfileFields = []string{"birth_date", "sex", "height_cm", "goal", "training_plan"}

// ProfilePatch sets its non-nil fields and then clears the fields named in
// Clear; everything else is left unchanged. Goal and Plan replace the whole object.
type ProfilePatch struct {
	BirthDate *coach.LocalDate
	Sex       *string
	HeightCm  *float64
	Goal      *Goal
	Plan      *TrainingPlan
	Clear     []string
}

// Profile returns the profile, or an ErrNotFound error before the first update.
func (s *Store) Profile(ctx context.Context) (p Profile, err error) {
	defer wrapErr("profile", &err)
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
		updated              stampCol
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
	p.BirthDate, p.Sex, p.HeightCm, p.UpdatedAt = coach.LocalDate(birth.String), sex.String, floatPtr(height), time.Time(updated)
	if goal.Valid {
		p.Goal = &Goal{}
		if err := json.Unmarshal([]byte(goal.String), p.Goal); err != nil {
			return Profile{}, errors.New("goal_json is corrupt")
		}
	}
	if pl.Valid {
		p.Plan = &TrainingPlan{}
		if err := json.Unmarshal([]byte(pl.String), p.Plan); err != nil {
			return Profile{}, errors.New("plan_json is corrupt")
		}
	}
	return p, nil
}

func (p ProfilePatch) validate() error {
	for _, f := range p.Clear {
		if !slices.Contains(ProfileFields, f) {
			return invalid("cannot clear %q; fields are %s", f, strings.Join(ProfileFields, ", "))
		}
	}
	if p.BirthDate != nil {
		if _, err := coach.ParseDate(string(*p.BirthDate)); err != nil {
			return invalid("birth_date must be YYYY-MM-DD")
		}
	}
	if p.Sex != nil && len(*p.Sex) > maxNameLen {
		return invalid("sex is too long")
	}
	if p.HeightCm != nil && (!finite(*p.HeightCm) || *p.HeightCm <= 0) {
		return invalid("height_cm must be a positive number")
	}
	if g := p.Goal; g != nil {
		if len(g.Type) > maxNameLen {
			return invalid("goal type is too long")
		}
		for name, v := range map[string]*float64{"target_weight_kg": g.TargetWeightKg, "target_body_fat_pct": g.TargetBodyFatPct} {
			if v != nil && (!finite(*v) || *v <= 0) {
				return invalid("goal %s must be a positive number", name)
			}
		}
		if g.Deadline != "" {
			if _, err := coach.ParseDate(string(g.Deadline)); err != nil {
				return invalid("goal deadline must be YYYY-MM-DD")
			}
		}
	}
	if pl := p.Plan; pl != nil && (len(pl.Split) > maxNameLen || len(pl.Notes) > maxProfileText) {
		return invalid("training plan is too long")
	}
	return nil
}

// UpdateProfile merges patch into the stored profile (creating it if needed).
func (s *Store) UpdateProfile(ctx context.Context, patch ProfilePatch) (p Profile, err error) {
	defer wrapErr("update profile", &err)
	if err := patch.validate(); err != nil {
		return Profile{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Profile{}, err
	}
	defer func() { _ = tx.Rollback() }()

	p, err = getProfile(ctx, tx)
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
		h := *patch.HeightCm // copy: the result must not alias the caller's value
		p.HeightCm = &h
	}
	if patch.Goal != nil {
		g := *patch.Goal
		p.Goal = &g
	}
	if patch.Plan != nil {
		pl := *patch.Plan
		p.Plan = &pl
	}
	for _, f := range patch.Clear {
		switch f {
		case "birth_date":
			p.BirthDate = ""
		case "sex":
			p.Sex = ""
		case "height_cm":
			p.HeightCm = nil
		case "goal":
			p.Goal = nil
		case "training_plan":
			p.Plan = nil
		}
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

// SetTarget stores a target version. Fields left nil are carried forward from
// the version in force on EffectiveFrom, so changing only kcal keeps the
// protein and sessions targets. Setting the same EffectiveFrom again replaces
// that version (a correction), never an earlier one.
func (s *Store) SetTarget(ctx context.Context, t Target) (out Target, err error) {
	defer wrapErr("set target", &err)
	if _, err := coach.ParseDate(string(t.EffectiveFrom)); err != nil {
		return Target{}, invalid("effective_from must be YYYY-MM-DD")
	}
	if t.Kcal == nil && t.ProteinG == nil && t.WeeklySessions == nil {
		return Target{}, invalid("set at least one of kcal, protein_g, weekly_sessions")
	}
	for name, v := range map[string]*int{"kcal": t.Kcal, "protein_g": t.ProteinG, "weekly_sessions": t.WeeklySessions} {
		if v != nil && *v < 0 {
			return Target{}, invalid("%s must not be negative", name)
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Target{}, err
	}
	defer func() { _ = tx.Rollback() }()

	prev, err := scanTargets(tx.QueryContext(ctx, targetInForceSQL, string(t.EffectiveFrom)))
	if err != nil {
		return Target{}, err
	}
	if len(prev) == 1 {
		t.Kcal = cmpOr(t.Kcal, prev[0].Kcal)
		t.ProteinG = cmpOr(t.ProteinG, prev[0].ProteinG)
		t.WeeklySessions = cmpOr(t.WeeklySessions, prev[0].WeeklySessions)
	}
	stamp := s.stamp()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO targets (effective_from, kcal, protein_g, weekly_sessions, created_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (effective_from) DO UPDATE SET kcal = excluded.kcal, protein_g = excluded.protein_g,
			weekly_sessions = excluded.weekly_sessions, created_at = excluded.created_at`,
		string(t.EffectiveFrom), nullInt(t.Kcal), nullInt(t.ProteinG), nullInt(t.WeeklySessions), stamp); err != nil {
		return Target{}, err
	}
	if err := tx.Commit(); err != nil {
		return Target{}, err
	}
	t.CreatedAt = parseStamp(stamp)
	return t, nil
}

func cmpOr(v, fallback *int) *int {
	if v != nil {
		return v
	}
	return fallback
}

const targetInForceSQL = `
	SELECT effective_from, kcal, protein_g, weekly_sessions, created_at FROM targets
	WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`

// TargetInForce returns the latest version that started on or before day.
func (s *Store) TargetInForce(ctx context.Context, day coach.LocalDate) (t Target, err error) {
	defer wrapErr("target in force on "+string(day), &err)
	ts, err := scanTargets(s.db.QueryContext(ctx, targetInForceSQL, string(day)))
	if err != nil {
		return Target{}, err
	}
	if len(ts) == 0 {
		return Target{}, ErrNotFound
	}
	return ts[0], nil
}

// Targets lists every version, newest first.
func (s *Store) Targets(ctx context.Context) (ts []Target, err error) {
	defer wrapErr("targets", &err)
	return scanTargets(s.db.QueryContext(ctx,
		`SELECT effective_from, kcal, protein_g, weekly_sessions, created_at FROM targets ORDER BY effective_from DESC`))
}

func scanTargets(rows *sql.Rows, err error) ([]Target, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Target{}
	for rows.Next() {
		var (
			t                       Target
			from                    string
			created                 stampCol
			kcal, protein, sessions sql.NullInt64
		)
		if err := rows.Scan(&from, &kcal, &protein, &sessions, &created); err != nil {
			return nil, err
		}
		t.EffectiveFrom, t.Kcal, t.ProteinG, t.WeeklySessions, t.CreatedAt =
			coach.LocalDate(from), intPtr(kcal), intPtr(protein), intPtr(sessions), time.Time(created)
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

func (it HealthItem) validate() error {
	if !slices.Contains(HealthItemKinds, it.Kind) {
		return invalid("kind must be one of %s", strings.Join(HealthItemKinds, ", "))
	}
	if !slices.Contains(HealthItemStatuses, it.Status) {
		return invalid("status must be one of %s", strings.Join(HealthItemStatuses, ", "))
	}
	if it.Name == "" || len(it.Name) > maxNameLen {
		return invalid("name is required (max %d characters)", maxNameLen)
	}
	if len(it.Details) > maxDetailsLen {
		return invalid("details exceed %d bytes", maxDetailsLen)
	}
	for name, d := range map[string]coach.LocalDate{"started_on": it.StartedOn, "ended_on": it.EndedOn} {
		if d != "" {
			if _, err := coach.ParseDate(string(d)); err != nil {
				return invalid("%s must be YYYY-MM-DD", name)
			}
		}
	}
	return nil
}

// UpsertHealthItem creates the item or replaces the one with the same kind and
// name. The name is trimmed so "knee " and "knee" are the same item.
func (s *Store) UpsertHealthItem(ctx context.Context, it HealthItem) (out HealthItem, err error) {
	defer wrapErr("upsert health item", &err)
	it.Name = strings.TrimSpace(it.Name)
	if err := it.validate(); err != nil {
		return HealthItem{}, err
	}
	stamp := s.stamp()
	err = s.db.QueryRowContext(ctx, `
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
func (s *Store) HealthItems(ctx context.Context, kind, status string) (out []HealthItem, err error) {
	defer wrapErr("health items", &err)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, kind, name, status, details, started_on, ended_on, updated_at FROM health_items
		WHERE (? = '' OR kind = ?) AND (? = '' OR status = ?) ORDER BY kind, name`,
		kind, kind, status, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out = []HealthItem{}
	for rows.Next() {
		var (
			it                      HealthItem
			details, started, ended sql.NullString
			updated                 stampCol
		)
		if err := rows.Scan(&it.ID, &it.Kind, &it.Name, &it.Status, &details, &started, &ended, &updated); err != nil {
			return nil, err
		}
		it.Details, it.StartedOn, it.EndedOn, it.UpdatedAt =
			details.String, coach.LocalDate(started.String), coach.LocalDate(ended.String), time.Time(updated)
		out = append(out, it)
	}
	return out, rows.Err()
}

// SetPreference stores a free-form JSON value under key.
func (s *Store) SetPreference(ctx context.Context, key string, value json.RawMessage) (err error) {
	defer wrapErr("set preference", &err)
	key = strings.TrimSpace(key)
	if key == "" || len(key) > maxPrefKeyLen {
		return invalid("preference key is required (max %d characters)", maxPrefKeyLen)
	}
	if len(value) > maxPrefValue {
		return invalid("preference %q exceeds %d bytes", key, maxPrefValue)
	}
	if !json.Valid(value) {
		return invalid("preference %q: value is not valid JSON", key)
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		key, string(value), s.stamp())
	return err
}

// Preferences returns every preference by key.
func (s *Store) Preferences(ctx context.Context) (out map[string]json.RawMessage, err error) {
	defer wrapErr("preferences", &err)
	rows, err := s.db.QueryContext(ctx, `SELECT key, value_json FROM preferences ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out = map[string]json.RawMessage{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = json.RawMessage(v)
	}
	return out, rows.Err()
}
