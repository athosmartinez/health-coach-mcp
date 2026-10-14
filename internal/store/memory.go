package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// Size and count limits keep one bad tool call (or a loop) from bloating the
// store or flooding the model's context.
const (
	maxNameLen        = 200
	maxDetailsLen     = 4 << 10
	maxPrefKeyLen     = 100
	maxPrefValue      = 16 << 10
	maxPreferences    = 200
	maxProfileText    = 2 << 10
	maxHealthItems    = 500
	maxKcal           = 10_000
	maxProteinG       = 1_000
	maxWeeklySessions = 21
	minHeightCm       = 50
	maxHeightCm       = 280
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

// replaces reports whether the patch overwrites or clears field, so a corrupt
// stored value for it does not block the update.
func (p ProfilePatch) replaces(field string) bool {
	switch {
	case slices.Contains(p.Clear, field):
		return true
	case field == "goal":
		return p.Goal != nil
	case field == "training_plan":
		return p.Plan != nil
	}
	return false
}

// Profile returns the profile, or an ErrNotFound error before the first update.
func (s *Store) Profile(ctx context.Context) (p Profile, err error) {
	defer wrapErr("profile", &err)
	p, corrupt, err := getProfile(ctx, s.db)
	if err != nil {
		return Profile{}, err
	}
	if len(corrupt) > 0 {
		return Profile{}, corrupt[0]
	}
	return p, nil
}

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// corruptField is a JSON column that no longer decodes.
type corruptField struct {
	field string
	err   error
}

func (c corruptField) Error() string {
	return fmt.Sprintf("stored %s is corrupt (set or clear it to repair): %v", c.field, c.err)
}

func (c corruptField) Unwrap() error { return c.err }

// getProfile reads the profile. JSON columns that fail to decode are reported
// separately so UpdateProfile can still overwrite them.
func getProfile(ctx context.Context, q querier) (Profile, []corruptField, error) {
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
		return Profile{}, nil, ErrNotFound
	}
	if err != nil {
		return Profile{}, nil, err
	}
	p.BirthDate, p.Sex, p.HeightCm, p.UpdatedAt = coach.LocalDate(birth.String), sex.String, floatPtr(height), time.Time(updated)
	var corrupt []corruptField
	if goal.Valid {
		p.Goal = &Goal{}
		if err := json.Unmarshal([]byte(goal.String), p.Goal); err != nil {
			p.Goal = nil
			corrupt = append(corrupt, corruptField{"goal", err})
		}
	}
	if pl.Valid {
		p.Plan = &TrainingPlan{}
		if err := json.Unmarshal([]byte(pl.String), p.Plan); err != nil {
			p.Plan = nil
			corrupt = append(corrupt, corruptField{"training_plan", err})
		}
	}
	return p, corrupt, nil
}

type numField struct {
	name     string
	v        *float64
	min, max float64
}

func (p ProfilePatch) validate(today coach.LocalDate) error {
	for _, f := range p.Clear {
		if !slices.Contains(ProfileFields, f) {
			return invalid("cannot clear %q; fields are %s", f, strings.Join(ProfileFields, ", "))
		}
	}
	if p.BirthDate != nil {
		if err := validDate("birth_date", *p.BirthDate, false); err != nil {
			return err
		}
		if *p.BirthDate < "1900-01-01" || *p.BirthDate > today {
			return invalid("birth_date must be between 1900-01-01 and today")
		}
	}
	if p.Sex != nil && len(*p.Sex) > maxNameLen {
		return invalid("sex is too long")
	}
	nums := []numField{{"height_cm", p.HeightCm, minHeightCm, maxHeightCm}}
	if g := p.Goal; g != nil {
		if len(g.Type) > maxNameLen {
			return invalid("goal type is too long")
		}
		nums = append(nums,
			numField{"goal target_weight_kg", g.TargetWeightKg, 20, 400},
			numField{"goal target_body_fat_pct", g.TargetBodyFatPct, 2, 70})
		if err := validDate("goal deadline", g.Deadline, true); err != nil {
			return err
		}
	}
	for _, n := range nums {
		if n.v != nil && (!finite(*n.v) || *n.v < n.min || *n.v > n.max) {
			return invalid("%s must be between %g and %g", n.name, n.min, n.max)
		}
	}
	if pl := p.Plan; pl != nil && (len(pl.Split) > maxNameLen || len(pl.Notes) > maxProfileText) {
		return invalid("training plan is too long")
	}
	return nil
}

// UpdateProfile merges patch into the stored profile (creating it if needed).
// A stored goal or plan that no longer decodes blocks the update unless the
// patch sets or clears it, which is how it gets repaired.
func (s *Store) UpdateProfile(ctx context.Context, patch ProfilePatch) (p Profile, err error) {
	defer wrapErr("update profile", &err)
	stamp, at := s.stamp()
	// One day of slack: "today" in UTC can be yesterday in the user's zone.
	tomorrow, _ := coach.DateOf(at, time.UTC).AddDays(1)
	if err := patch.validate(tomorrow); err != nil {
		return Profile{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Profile{}, err
	}
	defer func() { _ = tx.Rollback() }()

	p, corrupt, err := getProfile(ctx, tx)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return Profile{}, err
	}
	for _, c := range corrupt {
		if !patch.replaces(c.field) {
			return Profile{}, c
		}
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
	p.UpdatedAt = at
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

// TargetFields are the names accepted by Target.Clear.
var TargetFields = []string{"kcal", "protein_g", "weekly_sessions"}

// Target is one version of the user's targets (I6): a new version starts on
// EffectiveFrom and earlier versions are kept for history.
type Target struct {
	EffectiveFrom  coach.LocalDate `json:"effective_from"`
	Kcal           *int            `json:"kcal,omitempty"`
	ProteinG       *int            `json:"protein_g,omitempty"`
	WeeklySessions *int            `json:"weekly_sessions,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	// Clear names fields to drop instead of carrying them forward (input only).
	Clear []string `json:"-"`
}

type intField struct {
	name string
	v    *int
	max  int
}

func (t Target) validate() error {
	if err := validDate("effective_from", t.EffectiveFrom, false); err != nil {
		return err
	}
	for _, f := range t.Clear {
		if !slices.Contains(TargetFields, f) {
			return invalid("cannot clear %q; fields are %s", f, strings.Join(TargetFields, ", "))
		}
	}
	if t.Kcal == nil && t.ProteinG == nil && t.WeeklySessions == nil && len(t.Clear) == 0 {
		return invalid("set or clear at least one of %s", strings.Join(TargetFields, ", "))
	}
	for _, f := range []intField{
		{"kcal", t.Kcal, maxKcal}, {"protein_g", t.ProteinG, maxProteinG}, {"weekly_sessions", t.WeeklySessions, maxWeeklySessions},
	} {
		if f.v != nil && (*f.v < 0 || *f.v > f.max) {
			return invalid("%s must be between 0 and %d", f.name, f.max)
		}
	}
	return nil
}

// SetTarget stores a target version. Fields left nil are carried forward from
// the version in force on EffectiveFrom (the same date's row when correcting
// it), so changing only kcal keeps the protein and sessions targets; fields in
// Clear are dropped instead. Setting the same EffectiveFrom again replaces that
// version, never an earlier or later one.
func (s *Store) SetTarget(ctx context.Context, t Target) (out Target, err error) {
	defer wrapErr("set target", &err)
	if err := t.validate(); err != nil {
		return Target{}, err
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
	for _, f := range t.Clear {
		switch f {
		case "kcal":
			t.Kcal = nil
		case "protein_g":
			t.ProteinG = nil
		case "weekly_sessions":
			t.WeeklySessions = nil
		}
	}
	t.Clear = nil
	stamp, at := s.stamp()
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
	t.CreatedAt = at
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
	defer wrapErr("target in force", &err)
	if err := validDate("day", day, false); err != nil {
		return Target{}, err
	}
	ts, err := scanTargets(s.db.QueryContext(ctx, targetInForceSQL, string(day)))
	if err != nil {
		return Target{}, err
	}
	if len(ts) == 0 {
		return Target{}, fmt.Errorf("no target on or before %s: %w", day, ErrNotFound)
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
	return rowsResult(out, rows.Err())
}

// Health item kinds and statuses, mirrored by the schema CHECK constraints.
var (
	HealthItemKinds    = []string{"condition", "medication", "supplement", "injury", "allergy", "restriction"}
	HealthItemStatuses = []string{"active", "resolved", "paused"}
	// HealthItemFields are the names accepted by HealthItem.Clear.
	HealthItemFields = []string{"details", "started_on", "ended_on"}
)

// HealthItem is one entry of the health history, unique by (Kind, Name), with
// Name compared case-insensitively.
type HealthItem struct {
	ID        int64           `json:"id"`
	Kind      string          `json:"kind"`
	Name      string          `json:"name"`
	Status    string          `json:"status"`
	Details   string          `json:"details,omitempty"`
	StartedOn coach.LocalDate `json:"started_on,omitempty"`
	EndedOn   coach.LocalDate `json:"ended_on,omitempty"`
	UpdatedAt time.Time       `json:"updated_at"`
	// Clear names optional fields to erase on update (input only).
	Clear []string `json:"-"`
}

func (it HealthItem) validate() error {
	if err := oneOf("kind", it.Kind, HealthItemKinds, false); err != nil {
		return err
	}
	if err := oneOf("status", it.Status, HealthItemStatuses, false); err != nil {
		return err
	}
	if it.Name == "" || len(it.Name) > maxNameLen {
		return invalid("name is required (max %d characters)", maxNameLen)
	}
	if len(it.Details) > maxDetailsLen {
		return invalid("details exceed %d bytes", maxDetailsLen)
	}
	for _, f := range it.Clear {
		if !slices.Contains(HealthItemFields, f) {
			return invalid("cannot clear %q; fields are %s", f, strings.Join(HealthItemFields, ", "))
		}
	}
	if err := validDate("started_on", it.StartedOn, true); err != nil {
		return err
	}
	if err := validDate("ended_on", it.EndedOn, true); err != nil {
		return err
	}
	if it.StartedOn != "" && it.EndedOn != "" && it.EndedOn < it.StartedOn {
		return invalid("ended_on is before started_on")
	}
	return nil
}

// UpsertHealthItem creates the item or updates the one with the same kind and
// name (trimmed, case-insensitive). On update, status always changes but
// details and dates keep their stored value unless given or listed in Clear,
// so marking an injury resolved does not erase its history.
func (s *Store) UpsertHealthItem(ctx context.Context, it HealthItem) (out HealthItem, err error) {
	defer wrapErr("upsert health item", &err)
	it.Name = strings.TrimSpace(it.Name)
	if err := it.validate(); err != nil {
		return HealthItem{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return HealthItem{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var exists, count int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FILTER (WHERE kind = ? AND name = ?), COUNT(*) FROM health_items`, it.Kind, it.Name).Scan(&exists, &count); err != nil {
		return HealthItem{}, err
	}
	if exists == 0 && count >= maxHealthItems {
		return HealthItem{}, invalid("health history is full (%d items); resolve or merge old items first", maxHealthItems)
	}

	clear := func(f string) bool { return slices.Contains(it.Clear, f) }
	stamp, at := s.stamp()
	var details, started, ended sql.NullString
	err = tx.QueryRowContext(ctx, `
		INSERT INTO health_items (kind, name, status, details, started_on, ended_on, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (kind, name) DO UPDATE SET status = excluded.status,
			details    = CASE WHEN ? THEN NULL ELSE COALESCE(excluded.details, details) END,
			started_on = CASE WHEN ? THEN NULL ELSE COALESCE(excluded.started_on, started_on) END,
			ended_on   = CASE WHEN ? THEN NULL ELSE COALESCE(excluded.ended_on, ended_on) END,
			updated_at = excluded.updated_at
		RETURNING id, name, details, started_on, ended_on`,
		it.Kind, it.Name, it.Status, nullString(it.Details), nullString(string(it.StartedOn)),
		nullString(string(it.EndedOn)), stamp, clear("details"), clear("started_on"), clear("ended_on")).
		Scan(&it.ID, &it.Name, &details, &started, &ended)
	if err != nil {
		return HealthItem{}, err
	}
	it.Details, it.StartedOn, it.EndedOn = details.String, coach.LocalDate(started.String), coach.LocalDate(ended.String)
	if it.StartedOn != "" && it.EndedOn != "" && it.EndedOn < it.StartedOn {
		// The merged row is inconsistent (e.g. a new ended_on before the stored
		// started_on); returning before Commit rolls the upsert back.
		return HealthItem{}, invalid("ended_on is before the stored started_on")
	}
	if err := tx.Commit(); err != nil {
		return HealthItem{}, err
	}
	it.UpdatedAt, it.Clear = at, nil
	return it, nil
}

// HealthItems lists items, optionally filtered by kind and status ("" = any).
func (s *Store) HealthItems(ctx context.Context, kind, status string) (out []HealthItem, err error) {
	defer wrapErr("health items", &err)
	if err := oneOf("kind", kind, HealthItemKinds, true); err != nil {
		return nil, err
	}
	if err := oneOf("status", status, HealthItemStatuses, true); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, kind, name, status, details, started_on, ended_on, updated_at FROM health_items
		WHERE (? = '' OR kind = ?) AND (? = '' OR status = ?) ORDER BY kind, name LIMIT ?`,
		kind, kind, status, status, maxHealthItems)
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
	return rowsResult(out, rows.Err())
}

// SetPreference stores a free-form JSON value under key (trimmed).
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
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var exists, count int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FILTER (WHERE key = ?), COUNT(*) FROM preferences`, key).Scan(&exists, &count); err != nil {
		return err
	}
	if exists == 0 && count >= maxPreferences {
		return invalid("at most %d preferences; reuse or overwrite an existing key", maxPreferences)
	}
	stamp, _ := s.stamp()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO preferences (key, value_json, updated_at) VALUES (?, ?, ?)
		ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
		key, string(value), stamp); err != nil {
		return err
	}
	return tx.Commit()
}

// Preferences returns every preference by key (at most maxPreferences exist).
func (s *Store) Preferences(ctx context.Context) (out map[string]json.RawMessage, err error) {
	defer wrapErr("preferences", &err)
	rows, err := s.db.QueryContext(ctx, `SELECT key, value_json FROM preferences ORDER BY key LIMIT ?`, maxPreferences)
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
