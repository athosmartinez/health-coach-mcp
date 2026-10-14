package tools

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// MemoryDeps is what the coach memory tools need.
type MemoryDeps struct {
	Store *store.Store
	Now   func() time.Time
	// Loc defines "today" for the target in force and note dates.
	Loc *time.Location
}

func (d MemoryDeps) today() coach.LocalDate { return coach.Today(d.Now(), d.Loc) }

// medicalHint is attached wherever a value falls outside its reference (R3):
// the coach flags it and points to a doctor, never diagnoses or prescribes.
const medicalHint = "Out-of-range values are flags, not diagnoses. Mention them and suggest discussing them with a doctor; do not diagnose or recommend medication."

var (
	readOnly = &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true}
	// upsert: re-sending the same input leaves the store unchanged.
	upsert = &mcp.ToolAnnotations{IdempotentHint: true, DestructiveHint: ptr(false)}
	// appendOnly: each call adds a row.
	appendOnly = &mcp.ToolAnnotations{DestructiveHint: ptr(false)}
)

func ptr[T any](v T) *T { return &v }

// RegisterMemory adds the coach memory tools (CAPABILITY §4.2).
func RegisterMemory(s *mcp.Server, d MemoryDeps) {
	m := memory{d}

	Register(s, &mcp.Tool{
		Name: "profile_get",
		Description: "Returns what the coach knows about the user: profile (birth date, age, sex, height, goal, " +
			"training plan), the nutrition and training targets in force today, and stored preferences. " +
			"Call it before giving any advice. Missing fields mean the user has not told the coach yet.",
		Annotations: readOnly,
	}, m.profileGet)

	Register(s, &mcp.Tool{
		Name: "profile_update",
		Description: "Updates the user's profile with what they told you. Only the fields you send change; " +
			"goal and training_plan replace the whole object. List field names in clear to remove them. " +
			"The weekly sessions target is not part of the profile: use targets_set.",
		InputSchema: MustInputSchema[profileUpdateIn](map[string][]string{"clear": store.ProfileFields}),
		Annotations: upsert,
	}, m.profileUpdate)

	Register(s, &mcp.Tool{
		Name: "targets_set",
		Description: "Records a new version of the user's daily kcal, protein and weekly training sessions " +
			"targets, starting on effective_from. Only call it after the user explicitly confirmed the numbers; " +
			"you may suggest targets, but never save them on your own. Omitted fields keep the value in force; " +
			"list them in clear to remove them. Earlier versions are kept as history.",
		InputSchema: MustInputSchema[targetsSetIn](map[string][]string{"clear": store.TargetFields}),
		Annotations: upsert,
	}, m.targetsSet)

	Register(s, &mcp.Tool{
		Name: "health_item_upsert",
		Description: "Adds or updates an item of the user's health history: a condition, medication, " +
			"supplement, injury, allergy or dietary restriction. The same kind and name (case-insensitive) " +
			"updates the existing item; details and dates you omit are kept, list them in clear to erase them.",
		InputSchema: MustInputSchema[healthItemIn](map[string][]string{
			"kind": store.HealthItemKinds, "status": store.HealthItemStatuses, "clear": store.HealthItemFields,
		}),
		Annotations: upsert,
	}, m.healthItemUpsert)

	Register(s, &mcp.Tool{
		Name:        "health_items_list",
		Description: "Lists the user's health history, optionally filtered by kind and status.",
		InputSchema: MustInputSchema[healthItemsListIn](map[string][]string{
			"kind": store.HealthItemKinds, "status": store.HealthItemStatuses,
		}),
		Annotations: readOnly,
	}, m.healthItemsList)

	Register(s, &mcp.Tool{
		Name: "labs_record",
		Description: "Stores lab test results from one collection date (typed by the user, read from a PDF, " +
			"or from a file). Analyte names are normalized (\"Glucose Fasting\" becomes glucose_fasting); a result " +
			"for an analyte already recorded on that date replaces it. Returns the values outside their reference " +
			"range. " + medicalHint,
		InputSchema: MustInputSchema[labsRecordIn](map[string][]string{"source": store.LabSources}),
		Annotations: upsert,
	}, m.labsRecord)

	Register(s, &mcp.Tool{
		Name: "labs_query",
		Description: "Returns lab results as one series per analyte (oldest first), with the reference range " +
			"and an out-of-range flag per value. Filter by analyte and by a since date. " + medicalHint,
		Annotations: readOnly,
	}, m.labsQuery)

	Register(s, &mcp.Tool{
		Name: "preference_set",
		Description: "Stores one user preference as free JSON under a short key, e.g. foods_avoid " +
			"[\"lactose\"], training_time \"morning\", tone \"direct\". Setting a key again replaces it.",
		Annotations: upsert,
	}, m.preferenceSet)

	Register(s, &mcp.Tool{
		Name:        "preferences_get",
		Description: "Returns every stored user preference by key.",
		Annotations: readOnly,
	}, m.preferencesGet)

	Register(s, &mcp.Tool{
		Name: "note_add",
		Description: "Saves a coach note: an insight, a decision agreed with the user, a check-in, or a symptom " +
			"the user reported. Use related_date for the day it is about (default: none).",
		InputSchema: MustInputSchema[noteAddIn](map[string][]string{"kind": store.NoteKinds}),
		Annotations: appendOnly,
	}, m.noteAdd)

	Register(s, &mcp.Tool{
		Name: "notes_search",
		Description: "Finds coach notes, newest first. query matches whole words (all must appear; accents and " +
			"case are ignored; no prefix matching). more=true means older matches exist beyond limit.",
		InputSchema: MustInputSchema[notesSearchIn](map[string][]string{"kind": store.NoteKinds}),
		Annotations: readOnly,
	}, m.notesSearch)
}

type memory struct{ MemoryDeps }

// --- profile ---

type profileGetIn struct{}

type profileView struct {
	Profile *store.Profile `json:"profile,omitempty"`
	// AgeYears is computed from birth_date on today's date.
	AgeYears    *int                       `json:"age_years,omitempty"`
	Targets     *store.Target              `json:"targets_in_force,omitempty"`
	Preferences map[string]json.RawMessage `json:"preferences"`
	Today       coach.LocalDate            `json:"today"`
}

func (m memory) profileGet(ctx context.Context, _ *mcp.CallToolRequest, _ profileGetIn) (profileView, error) {
	today := m.today()
	out := profileView{Today: today}
	p, err := m.Store.Profile(ctx)
	switch {
	case err == nil:
		out.Profile = &p
		out.AgeYears = age(p.BirthDate, today)
	case !errors.Is(err, store.ErrNotFound):
		return profileView{}, err
	}
	t, err := m.Store.TargetInForce(ctx, today)
	switch {
	case err == nil:
		out.Targets = &t
	case !errors.Is(err, store.ErrNotFound):
		return profileView{}, err
	}
	if out.Preferences, err = m.Store.Preferences(ctx); err != nil {
		return profileView{}, err
	}
	return out, nil
}

// age is full years between birth and today, or nil when unknown.
func age(birth, today coach.LocalDate) *int {
	b, err1 := time.Parse("2006-01-02", string(birth))
	t, err2 := time.Parse("2006-01-02", string(today))
	if err1 != nil || err2 != nil || t.Before(b) {
		return nil
	}
	years := t.Year() - b.Year()
	if t.Month() < b.Month() || (t.Month() == b.Month() && t.Day() < b.Day()) {
		years-- // birthday not reached yet this year
	}
	return &years
}

type goalIn struct {
	Type             string          `json:"type,omitempty" jsonschema:"e.g. cut, bulk, recomp, maintain, health"`
	TargetWeightKg   *float64        `json:"target_weight_kg,omitempty"`
	TargetBodyFatPct *float64        `json:"target_body_fat_pct,omitempty"`
	Deadline         coach.LocalDate `json:"deadline,omitempty"`
}

type planIn struct {
	Split string `json:"split,omitempty" jsonschema:"e.g. push/pull/legs, upper/lower, full body"`
	Notes string `json:"notes,omitempty"`
}

type profileUpdateIn struct {
	BirthDate    *coach.LocalDate `json:"birth_date,omitempty"`
	Sex          *string          `json:"sex,omitempty"`
	HeightCm     *float64         `json:"height_cm,omitempty"`
	Goal         *goalIn          `json:"goal,omitempty"`
	TrainingPlan *planIn          `json:"training_plan,omitempty"`
	Clear        []string         `json:"clear,omitempty" jsonschema:"fields to remove from the profile"`
}

func (m memory) profileUpdate(ctx context.Context, _ *mcp.CallToolRequest, in profileUpdateIn) (store.Profile, error) {
	patch := store.ProfilePatch{BirthDate: in.BirthDate, Sex: in.Sex, HeightCm: in.HeightCm, Clear: in.Clear}
	if g := in.Goal; g != nil {
		patch.Goal = &store.Goal{Type: g.Type, TargetWeightKg: g.TargetWeightKg, TargetBodyFatPct: g.TargetBodyFatPct, Deadline: g.Deadline}
	}
	if p := in.TrainingPlan; p != nil {
		patch.Plan = &store.TrainingPlan{Split: p.Split, Notes: p.Notes}
	}
	return m.Store.UpdateProfile(ctx, patch)
}

// --- targets ---

type targetsSetIn struct {
	EffectiveFrom  coach.LocalDate `json:"effective_from" jsonschema:"first day the targets apply"`
	Kcal           *int            `json:"kcal,omitempty" jsonschema:"daily energy target"`
	ProteinG       *int            `json:"protein_g,omitempty" jsonschema:"daily protein target in grams"`
	WeeklySessions *int            `json:"weekly_sessions,omitempty" jsonschema:"training sessions per ISO week (Mon-Sun)"`
	Clear          []string        `json:"clear,omitempty" jsonschema:"targets to remove instead of carrying forward"`
}

type targetsSetOut struct {
	Target store.Target `json:"target"`
	// Previous is the version that was in force on effective_from before this call.
	Previous *store.Target `json:"previous,omitempty"`
}

func (m memory) targetsSet(ctx context.Context, _ *mcp.CallToolRequest, in targetsSetIn) (targetsSetOut, error) {
	var out targetsSetOut
	if in.EffectiveFrom != "" {
		prev, err := m.Store.TargetInForce(ctx, in.EffectiveFrom)
		switch {
		case err == nil:
			out.Previous = &prev
		case !errors.Is(err, store.ErrNotFound):
			return targetsSetOut{}, err
		}
	}
	t, err := m.Store.SetTarget(ctx, store.Target{
		EffectiveFrom: in.EffectiveFrom, Kcal: in.Kcal, ProteinG: in.ProteinG, WeeklySessions: in.WeeklySessions, Clear: in.Clear,
	})
	if err != nil {
		return targetsSetOut{}, err
	}
	out.Target = t
	return out, nil
}

// --- health items ---

type healthItemIn struct {
	Kind      string          `json:"kind"`
	Name      string          `json:"name" jsonschema:"short name, e.g. knee, creatine, lactose"`
	Status    string          `json:"status"`
	Details   string          `json:"details,omitempty" jsonschema:"dose, side, severity, what the doctor said"`
	StartedOn coach.LocalDate `json:"started_on,omitempty"`
	EndedOn   coach.LocalDate `json:"ended_on,omitempty"`
	Clear     []string        `json:"clear,omitempty" jsonschema:"stored fields to erase"`
}

func (m memory) healthItemUpsert(ctx context.Context, _ *mcp.CallToolRequest, in healthItemIn) (store.HealthItem, error) {
	return m.Store.UpsertHealthItem(ctx, store.HealthItem{
		Kind: in.Kind, Name: in.Name, Status: in.Status, Details: in.Details,
		StartedOn: in.StartedOn, EndedOn: in.EndedOn, Clear: in.Clear,
	})
}

type healthItemsListIn struct {
	Kind   string `json:"kind,omitempty"`
	Status string `json:"status,omitempty"`
}

type healthItemsOut struct {
	Items []store.HealthItem `json:"items"`
}

func (m memory) healthItemsList(ctx context.Context, _ *mcp.CallToolRequest, in healthItemsListIn) (healthItemsOut, error) {
	items, err := m.Store.HealthItems(ctx, in.Kind, in.Status)
	return healthItemsOut{Items: items}, err
}

// --- labs ---

type labIn struct {
	Analyte string   `json:"analyte" jsonschema:"test name as on the report, e.g. LDL, HbA1c, TSH"`
	Value   float64  `json:"value"`
	Unit    string   `json:"unit" jsonschema:"unit as on the report, e.g. mg/dL, %, mUI/L"`
	RefLow  *float64 `json:"ref_low,omitempty" jsonschema:"lower bound of the report's reference range"`
	RefHigh *float64 `json:"ref_high,omitempty" jsonschema:"upper bound of the report's reference range"`
}

type labsRecordIn struct {
	CollectedOn coach.LocalDate `json:"collected_on" jsonschema:"date the sample was collected"`
	Source      string          `json:"source,omitempty" jsonschema:"where the values came from (default chat)"`
	Lab         string          `json:"lab,omitempty" jsonschema:"laboratory name"`
	Results     []labIn         `json:"results"`
}

// outOfRange is one flagged value (R3).
type outOfRange struct {
	Analyte       string   `json:"analyte"`
	Value         float64  `json:"value"`
	Unit          string   `json:"unit"`
	RefLow        *float64 `json:"ref_low,omitempty"`
	RefHigh       *float64 `json:"ref_high,omitempty"`
	Direction     string   `json:"direction" jsonschema:"low or high"`
	ReferToDoctor bool     `json:"refer_to_doctor"`
}

type labsRecordOut struct {
	Recorded   []store.LabResult `json:"recorded"`
	OutOfRange []outOfRange      `json:"out_of_range"`
	Guidance   string            `json:"guidance,omitempty"`
}

func (m memory) labsRecord(ctx context.Context, _ *mcp.CallToolRequest, in labsRecordIn) (labsRecordOut, error) {
	source := in.Source
	if source == "" {
		source = "chat"
	}
	values := make([]store.LabValue, len(in.Results))
	for i, r := range in.Results {
		values[i] = store.LabValue{Analyte: r.Analyte, Value: r.Value, Unit: r.Unit, RefLow: r.RefLow, RefHigh: r.RefHigh}
	}
	recorded, err := m.Store.RecordLabs(ctx, in.CollectedOn, in.Lab, source, values)
	if err != nil {
		return labsRecordOut{}, err
	}
	out := labsRecordOut{Recorded: recorded, OutOfRange: []outOfRange{}}
	for _, r := range recorded {
		if f, ok := flag(r); ok {
			out.OutOfRange = append(out.OutOfRange, f)
		}
	}
	if len(out.OutOfRange) > 0 {
		out.Guidance = medicalHint
	}
	return out, nil
}

func flag(r store.LabResult) (outOfRange, bool) {
	if !r.OutOfRange() {
		return outOfRange{}, false
	}
	dir := "high"
	if r.RefLow != nil && r.Value < *r.RefLow {
		dir = "low"
	}
	return outOfRange{
		Analyte: r.Analyte, Value: r.Value, Unit: r.Unit, RefLow: r.RefLow, RefHigh: r.RefHigh,
		Direction: dir, ReferToDoctor: true,
	}, true
}

type labsQueryIn struct {
	Analyte string          `json:"analyte,omitempty" jsonschema:"one analyte (any spelling); omit for all"`
	Since   coach.LocalDate `json:"since,omitempty"`
}

type labPoint struct {
	CollectedOn coach.LocalDate `json:"collected_on"`
	Value       float64         `json:"value"`
	Unit        string          `json:"unit"`
	RefLow      *float64        `json:"ref_low,omitempty"`
	RefHigh     *float64        `json:"ref_high,omitempty"`
	OutOfRange  bool            `json:"out_of_range"`
	Lab         string          `json:"lab,omitempty"`
}

type labSeries struct {
	Analyte string     `json:"analyte"`
	Points  []labPoint `json:"points"`
	// Latest is the most recent point, the one to compare against the reference.
	Latest labPoint `json:"latest"`
}

type labsQueryOut struct {
	Series   []labSeries `json:"series"`
	Guidance string      `json:"guidance,omitempty"`
}

func (m memory) labsQuery(ctx context.Context, _ *mcp.CallToolRequest, in labsQueryIn) (labsQueryOut, error) {
	results, err := m.Store.QueryLabs(ctx, in.Analyte, in.Since)
	if err != nil {
		return labsQueryOut{}, err
	}
	out := labsQueryOut{Series: []labSeries{}}
	flagged := false
	for _, r := range results { // ordered by analyte, then date
		p := labPoint{CollectedOn: r.CollectedOn, Value: r.Value, Unit: r.Unit, RefLow: r.RefLow, RefHigh: r.RefHigh, OutOfRange: r.OutOfRange(), Lab: r.Lab}
		flagged = flagged || p.OutOfRange
		if n := len(out.Series); n == 0 || out.Series[n-1].Analyte != r.Analyte {
			out.Series = append(out.Series, labSeries{Analyte: r.Analyte})
		}
		cur := &out.Series[len(out.Series)-1]
		cur.Points = append(cur.Points, p)
		cur.Latest = p
	}
	if flagged {
		out.Guidance = medicalHint
	}
	return out, nil
}

// --- preferences ---

type preferenceSetIn struct {
	Key   string `json:"key" jsonschema:"short snake_case key, e.g. foods_avoid"`
	Value any    `json:"value" jsonschema:"any JSON value"`
}

type preferenceOut struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

func (m memory) preferenceSet(ctx context.Context, _ *mcp.CallToolRequest, in preferenceSetIn) (preferenceOut, error) {
	value, err := json.Marshal(in.Value)
	if err != nil {
		return preferenceOut{}, err
	}
	if err := m.Store.SetPreference(ctx, in.Key, value); err != nil {
		return preferenceOut{}, err
	}
	return preferenceOut{Key: in.Key, Value: value}, nil
}

type preferencesGetIn struct{}

type preferencesOut struct {
	Preferences map[string]json.RawMessage `json:"preferences"`
}

func (m memory) preferencesGet(ctx context.Context, _ *mcp.CallToolRequest, _ preferencesGetIn) (preferencesOut, error) {
	prefs, err := m.Store.Preferences(ctx)
	return preferencesOut{Preferences: prefs}, err
}

// --- notes ---

type noteAddIn struct {
	Kind        string          `json:"kind"`
	Text        string          `json:"text"`
	Tags        []string        `json:"tags,omitempty"`
	RelatedDate coach.LocalDate `json:"related_date,omitempty" jsonschema:"the day the note is about"`
}

func (m memory) noteAdd(ctx context.Context, _ *mcp.CallToolRequest, in noteAddIn) (store.Note, error) {
	return m.Store.AddNote(ctx, store.Note{Kind: in.Kind, Text: in.Text, Tags: in.Tags, RelatedDate: in.RelatedDate})
}

type notesSearchIn struct {
	Kind  string          `json:"kind,omitempty"`
	Since coach.LocalDate `json:"since,omitempty" jsonschema:"notes about (or written on) this day or later"`
	Query string          `json:"query,omitempty" jsonschema:"words that must all appear"`
	Limit int             `json:"limit,omitempty" jsonschema:"max notes (default 50, max 200)"`
}

func (m memory) notesSearch(ctx context.Context, _ *mcp.CallToolRequest, in notesSearchIn) (store.NoteResults, error) {
	return m.Store.SearchNotes(ctx, store.NoteFilter{Kind: in.Kind, Since: in.Since, Loc: m.Loc, Query: in.Query, Limit: in.Limit})
}
