package tools

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

var memoryTools = []string{
	"profile_get", "profile_update", "targets_set", "health_item_upsert", "health_items_list",
	"labs_record", "labs_query", "preference_set", "preferences_get", "note_add", "notes_search",
}

type memClient struct {
	t  *testing.T
	cs *mcp.ClientSession
}

// memorySession serves the memory tools over an in-memory transport, with
// "now" at 2026-10-14 01:30 UTC = 2026-10-13 22:30 in São Paulo.
func memorySession(t *testing.T) memClient {
	t.Helper()
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	return memorySessionAt(t, time.Date(2026, 10, 14, 1, 30, 0, 0, time.UTC), loc)
}

func memorySessionAt(t *testing.T, at time.Time, loc *time.Location) memClient {
	t.Helper()
	ctx := context.Background()
	now := func() time.Time { return at }
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "coach.db"), now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	s := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "test"}, nil)
	RegisterMemory(s, MemoryDeps{Store: st, Now: now, Loc: loc})
	serverT, clientT := mcp.NewInMemoryTransports()
	if _, err := s.Connect(ctx, serverT, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "c", Version: "test"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return memClient{t, cs}
}

// ok calls a tool that must succeed and decodes its structured result into out.
func (c memClient) ok(name string, args map[string]any, out any) {
	c.t.Helper()
	res, err := c.cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		c.t.Fatalf("%s: protocol error %v", name, err)
	}
	if res.IsError {
		c.t.Fatalf("%s(%v) failed: %s", name, args, res.Content[0].(*mcp.TextContent).Text)
	}
	b, _ := json.Marshal(res.StructuredContent)
	// Reset first: Unmarshal keeps fields an omitempty result leaves out.
	reflect.ValueOf(out).Elem().SetZero()
	if err := json.Unmarshal(b, out); err != nil {
		c.t.Fatalf("%s: decode %s: %v", name, b, err)
	}
}

// rejection is how a call failed: before the handler (the SDK's schema check
// or argument decoding, plain text here since the server middleware that maps
// it to invalid_input is not installed), or in our code with the JSON contract.
type rejection struct {
	preHandler bool
	code       coach.Code
	text       string
}

func (c memClient) fails(name string, args map[string]any) rejection {
	c.t.Helper()
	res, err := c.cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		c.t.Fatalf("%s: protocol error %v", name, err)
	}
	if !res.IsError {
		c.t.Fatalf("%s(%v) succeeded, want an error", name, args)
	}
	text := res.Content[0].(*mcp.TextContent).Text
	var te coach.ToolError
	if json.Unmarshal([]byte(text), &te) == nil && te.Code != "" {
		return rejection{code: te.Code, text: text}
	}
	return rejection{preHandler: true, text: text}
}

func listTools(t *testing.T, c memClient) map[string]*mcp.Tool {
	t.Helper()
	res, err := c.cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*mcp.Tool{}
	for _, tool := range res.Tools {
		byName[tool.Name] = tool
	}
	return byName
}

func schemaOf(t *testing.T, v any) *jsonschema.Schema {
	t.Helper()
	b, _ := json.Marshal(v)
	var s jsonschema.Schema
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	return &s
}

func TestMemoryToolsListingSchemasAndAnnotations(t *testing.T) {
	byName := listTools(t, memorySession(t))
	var names []string
	for n := range byName {
		names = append(names, n)
	}
	if !slices.Equal(slices.Sorted(slices.Values(names)), slices.Sorted(slices.Values(memoryTools))) {
		t.Fatalf("tools = %v, want %v", names, memoryTools)
	}

	// Enums, checked on the property itself (or its items), not as a substring.
	enums := []struct {
		tool, prop string
		want       []string
		items      bool
	}{
		{"health_item_upsert", "kind", store.HealthItemKinds, false},
		{"health_item_upsert", "status", store.HealthItemStatuses, false},
		{"health_item_upsert", "clear", store.HealthItemFields, true},
		{"health_items_list", "kind", store.HealthItemKinds, false},
		{"health_items_list", "status", store.HealthItemStatuses, false},
		{"labs_record", "source", store.LabSources, false},
		{"note_add", "kind", store.NoteKinds, false},
		{"notes_search", "kind", store.NoteKinds, false},
		{"profile_update", "clear", store.ProfileFields, true},
		{"targets_set", "clear", store.TargetFields, true},
	}
	for _, e := range enums {
		ps := schemaOf(t, byName[e.tool].InputSchema).Properties[e.prop]
		if ps == nil {
			t.Errorf("%s.%s missing", e.tool, e.prop)
			continue
		}
		got := ps.Enum
		if e.items {
			got = ps.Items.Enum
		}
		for _, v := range e.want {
			if !slices.Contains(got, any(v)) {
				t.Errorf("%s.%s enum %v lacks %q", e.tool, e.prop, got, v)
			}
		}
	}

	// Required fields stay strict; optional ones also accept null and "".
	upsert := schemaOf(t, byName["health_item_upsert"].InputSchema)
	if k := upsert.Properties["kind"]; slices.Contains(k.Enum, any("")) || slices.Contains(k.Types, "null") {
		t.Errorf("required kind must not accept empty values: %+v", k)
	}
	list := schemaOf(t, byName["health_items_list"].InputSchema)
	if k := list.Properties["kind"]; !slices.Contains(k.Enum, any("")) || !slices.Contains(k.Enum, nil) {
		t.Errorf("optional kind filter must accept \"\" and null: %v", k.Enum)
	}

	type ann struct{ readOnly, idempotent, destructive bool }
	want := map[string]ann{
		"profile_get": {true, true, false}, "health_items_list": {true, true, false}, "labs_query": {true, true, false},
		"preferences_get": {true, true, false}, "notes_search": {true, true, false},
		"profile_update": {false, true, true}, "targets_set": {false, true, true}, "health_item_upsert": {false, true, true},
		"labs_record": {false, true, true}, "preference_set": {false, true, true},
		"note_add": {false, false, false},
	}
	for name, w := range want {
		a := byName[name].Annotations
		destructive := a.DestructiveHint == nil || *a.DestructiveHint // spec default is true
		if a.ReadOnlyHint != w.readOnly || a.IdempotentHint != w.idempotent || (!w.readOnly && destructive != w.destructive) {
			t.Errorf("%s annotations = %+v, want %+v", name, a, w)
		}
		if a.OpenWorldHint == nil || *a.OpenWorldHint {
			t.Errorf("%s: only touches the local store, openWorldHint must be false", name)
		}
		if byName[name].OutputSchema == nil {
			t.Errorf("%s: missing output schema", name)
		}
	}

	desc := func(name string) string { return byName[name].Description }
	if !strings.Contains(desc("targets_set"), "explicitly confirmed") {
		t.Error("targets_set must say it needs the user's explicit confirmation (Q3)")
	}
	for _, name := range []string{"labs_record", "labs_query"} {
		if !strings.Contains(desc(name), medicalHint) {
			t.Errorf("%s description lacks the medical guardrail", name)
		}
	}
	for _, name := range []string{"health_item_upsert", "health_items_list", "note_add"} {
		if !strings.Contains(desc(name), noAdvice) {
			t.Errorf("%s description lacks the no-dosing rule", name)
		}
	}
	for _, phrase := range []string{"not diagnoses", "supplement", "doctor", "promptly", "no_reference"} {
		if !strings.Contains(medicalHint, phrase) {
			t.Errorf("medicalHint lost %q", phrase)
		}
	}
}

// TestSchemasHaveNoBooleanProperties guards client interop: zod-based clients
// (the MCP Inspector among them) reject `true`/`false` as a property schema.
func TestSchemasHaveNoBooleanProperties(t *testing.T) {
	var walk func(path string, v any)
	walk = func(path string, v any) {
		m, ok := v.(map[string]any)
		if !ok {
			return
		}
		if props, ok := m["properties"].(map[string]any); ok {
			for name, p := range props {
				if _, isBool := p.(bool); isBool {
					t.Errorf("%s.properties.%s is a boolean schema", path, name)
				}
				walk(path+"."+name, p)
			}
		}
		for _, key := range []string{"items", "additionalProperties"} {
			walk(path+"."+key, m[key])
		}
	}
	for name, tool := range listTools(t, memorySession(t)) {
		for kind, schema := range map[string]any{"input": tool.InputSchema, "output": tool.OutputSchema} {
			b, _ := json.Marshal(schema)
			var v any
			_ = json.Unmarshal(b, &v)
			walk(name+"."+kind, v)
		}
	}
}

func TestEveryReadToolWorksOnAnEmptyStore(t *testing.T) {
	c := memorySession(t)
	for _, tc := range []struct {
		tool  string
		array string
	}{
		{"profile_get", "health_items"}, {"health_items_list", "items"}, {"labs_query", "series"},
		{"preferences_get", "preferences"}, {"notes_search", "notes"},
	} {
		var out map[string]any
		c.ok(tc.tool, nil, &out)
		if out[tc.array] == nil {
			t.Errorf("%s on an empty store: %q is %v, want an empty collection", tc.tool, tc.array, out[tc.array])
		}
	}
}

func TestProfileRoundTripAndTargetInForce(t *testing.T) {
	c := memorySession(t)

	var empty profileView
	c.ok("profile_get", nil, &empty)
	if empty.Profile != nil || empty.Targets != nil || empty.Today != "2026-10-13" || empty.Notice != dataNotice {
		t.Fatalf("empty profile_get = %+v (today must be the local day in São Paulo)", empty)
	}

	var up profileUpdateOut
	c.ok("profile_update", map[string]any{
		"birth_date": "1990-10-14", "height_cm": 180, "sex": "male",
		"goal":          map[string]any{"type": "recomp", "target_weight_kg": 76.5, "target_body_fat_pct": 12, "deadline": "2027-06-30"},
		"training_plan": map[string]any{"split": "upper/lower", "notes": "4x/week, morning"},
	}, &up)
	p := up.Profile
	if up.Previous != nil || *p.HeightCm != 180 || *p.Goal.TargetWeightKg != 76.5 || *p.Goal.TargetBodyFatPct != 12 ||
		p.Goal.Deadline != "2027-06-30" || p.Plan.Notes != "4x/week, morning" || p.Sex != "male" {
		t.Errorf("profile_update = %+v", up)
	}
	c.ok("profile_update", map[string]any{"clear": []string{"training_plan"}}, &up)
	if up.Profile.Plan != nil || up.Profile.Goal == nil || up.Previous == nil || up.Previous.Plan == nil {
		t.Errorf("clear + previous = %+v", up)
	}

	var ts targetsSetOut
	c.ok("targets_set", map[string]any{"effective_from": "2026-10-01", "kcal": 2400, "protein_g": 160, "weekly_sessions": 4}, &ts)
	if ts.Previous != nil {
		t.Errorf("first version has a previous: %+v", ts.Previous)
	}
	c.ok("targets_set", map[string]any{"effective_from": "2026-10-14", "kcal": 2200}, &ts)
	if ts.Previous == nil || *ts.Previous.Kcal != 2400 || *ts.Target.ProteinG != 160 {
		t.Errorf("second version = %+v (previous and carry-forward)", ts)
	}
	c.ok("targets_set", map[string]any{"effective_from": "2026-10-14", "clear": []string{"protein_g"}}, &ts)
	if ts.Previous.EffectiveFrom != "2026-10-14" || *ts.Previous.Kcal != 2200 || ts.Target.ProteinG != nil || *ts.Target.Kcal != 2200 {
		t.Errorf("same-date correction with clear = %+v", ts)
	}

	var got profileView
	c.ok("profile_get", nil, &got)
	// Local today is Oct 13, so the Oct 14 version is not in force yet.
	if got.Targets == nil || *got.Targets.Kcal != 2400 || got.Targets.EffectiveFrom != "2026-10-01" {
		t.Errorf("targets in force = %+v, want the 2026-10-01 version", got.Targets)
	}
	// The 36th birthday is Oct 14: still 35 on local Oct 13.
	if got.AgeYears == nil || *got.AgeYears != 35 {
		t.Errorf("age = %v, want 35", got.AgeYears)
	}
}

func TestTodayFollowsTheConfiguredZone(t *testing.T) {
	// 23:30 UTC on Oct 13 is already Oct 14 in Tokyo, and still Oct 13 in UTC.
	tokyo, _ := time.LoadLocation("Asia/Tokyo")
	at := time.Date(2026, 10, 13, 23, 30, 0, 0, time.UTC)
	for loc, want := range map[*time.Location]coach.LocalDate{tokyo: "2026-10-14", time.UTC: "2026-10-13"} {
		var pv profileView
		memorySessionAt(t, at, loc).ok("profile_get", nil, &pv)
		if pv.Today != want {
			t.Errorf("%s: today = %s, want %s", loc, pv.Today, want)
		}
	}
}

func TestProfileGetIncludesActiveHealthHistory(t *testing.T) {
	c := memorySession(t)
	var it healthItemOut
	c.ok("health_item_upsert", map[string]any{"kind": "allergy", "name": "lactose", "status": "active"}, &it)
	c.ok("health_item_upsert", map[string]any{"kind": "medication", "name": "metformin", "status": "paused"}, &it)
	c.ok("health_item_upsert", map[string]any{"kind": "injury", "name": "ankle", "status": "resolved"}, &it)
	var pv profileView
	c.ok("profile_get", nil, &pv)
	var names []string
	for _, h := range pv.HealthItems {
		names = append(names, h.Name)
	}
	if !slices.Equal(names, []string{"lactose", "metformin"}) {
		t.Errorf("profile_get health items = %v, want the active and paused ones", names)
	}
}

func TestMemoryToolsRejectBadInput(t *testing.T) {
	c := memorySession(t)
	// Rejected before the handler runs.
	schema := []struct {
		tool string
		args map[string]any
	}{
		{"health_item_upsert", map[string]any{"kind": "hobby", "name": "x", "status": "active"}},
		{"health_items_list", map[string]any{"status": "gone"}},
		{"labs_record", map[string]any{"collected_on": "2026-09-01", "source": "fax", "results": []any{}}},
		{"note_add", map[string]any{"kind": "rant", "text": "x"}},
		{"profile_update", map[string]any{"clear": []string{"weight"}}},
		{"targets_set", map[string]any{"effective_from": "13/10/2026", "kcal": 1}},
		{"targets_set", map[string]any{"effective_from": "2026-02-30", "kcal": 1}}, // pattern ok, not a real day
		{"profile_get", map[string]any{"unexpected": true}},
		{"preference_set", map[string]any{"key": "x"}},
	}
	for _, tc := range schema {
		if r := c.fails(tc.tool, tc.args); !r.preHandler {
			t.Errorf("%s(%v): want a schema rejection, got %+v", tc.tool, tc.args, r)
		}
	}
	// Pass the schema, rejected by the store with the invalid_input contract.
	stored := []struct {
		tool string
		args map[string]any
	}{
		{"targets_set", map[string]any{"effective_from": "2026-10-01"}},
		{"targets_set", map[string]any{"effective_from": "2026-10-01", "kcal": 2000, "clear": []string{"kcal"}}},
		{"labs_record", map[string]any{"collected_on": "2026-09-01", "results": []any{}}},
		{"notes_search", map[string]any{"query": "   "}},
		{"preference_set", map[string]any{"key": " ", "value": 1}},
		{"health_item_upsert", map[string]any{"kind": "injury", "name": "x", "status": "active", "details": "d", "clear": []string{"details"}}},
	}
	for _, tc := range stored {
		if r := c.fails(tc.tool, tc.args); r.code != coach.CodeInvalidInput {
			t.Errorf("%s(%v): want invalid_input, got %+v", tc.tool, tc.args, r)
		}
	}
}

func TestOptionalFieldsAcceptNullAndEmpty(t *testing.T) {
	c := memorySession(t)
	var n store.Note
	c.ok("note_add", map[string]any{"kind": "checkin", "text": "ok", "related_date": nil, "tags": nil}, &n)
	if n.RelatedDate != "" {
		t.Errorf("null related_date = %q", n.RelatedDate)
	}
	var items healthItemsOut
	c.ok("health_items_list", map[string]any{"kind": "", "status": nil}, &items)
	var notes notesOut
	c.ok("notes_search", map[string]any{"since": "", "kind": nil, "query": nil, "limit": nil}, &notes)
	if len(notes.Notes) != 1 {
		t.Errorf("empty filters must mean no filter: %+v", notes)
	}
	var labs labsQueryOut
	c.ok("labs_query", map[string]any{"since": nil, "analyte": ""}, &labs)
	var rec labsRecordOut
	c.ok("labs_record", map[string]any{"collected_on": "2026-09-01", "source": "", "lab": nil,
		"results": []any{map[string]any{"analyte": "hdl", "value": 50, "unit": "mg/dL", "ref_low": nil, "ref_text": ""}}}, &rec)
	if rec.Recorded[0].Source != "chat" {
		t.Errorf(`source "" must default to chat, got %q`, rec.Recorded[0].Source)
	}
	var up profileUpdateOut
	c.ok("profile_update", map[string]any{"goal": map[string]any{"type": "cut", "deadline": ""}, "sex": nil}, &up)
	if up.Profile.Goal.Deadline != "" || up.Profile.Sex != "" {
		t.Errorf("empty nested deadline / null sex = %+v", up.Profile)
	}
}

func TestHealthItems(t *testing.T) {
	c := memorySession(t)
	var it healthItemOut
	c.ok("health_item_upsert", map[string]any{"kind": "injury", "name": "Knee", "status": "active", "details": "ACL, left", "started_on": "2026-09-01"}, &it)
	if it.Previous != nil {
		t.Errorf("new item has a previous: %+v", it.Previous)
	}
	c.ok("health_item_upsert", map[string]any{"kind": "injury", "name": "knee", "status": "resolved", "ended_on": "2026-10-10"}, &it)
	if it.Item.Details != "ACL, left" || it.Item.StartedOn != "2026-09-01" || it.Item.Status != "resolved" || it.Previous.Status != "active" {
		t.Errorf("status update lost history or previous: %+v", it)
	}
	c.ok("health_item_upsert", map[string]any{"kind": "injury", "name": "knee", "status": "resolved", "clear": []string{"details"}}, &it)
	if it.Item.Details != "" || it.Item.StartedOn != "2026-09-01" {
		t.Errorf("clear details = %+v", it.Item)
	}
	c.ok("health_item_upsert", map[string]any{"kind": "supplement", "name": "creatine", "status": "active"}, &it)

	members := func(args map[string]any) []string {
		var list healthItemsOut
		c.ok("health_items_list", args, &list)
		if list.Notice != dataNotice {
			t.Error("health_items_list lacks the data notice")
		}
		var names []string
		for _, i := range list.Items {
			names = append(names, i.Name)
		}
		return names
	}
	for _, tc := range []struct {
		args map[string]any
		want []string
	}{
		{map[string]any{"kind": "injury"}, []string{"Knee"}}, // keeps the casing it was created with
		{map[string]any{"kind": "supplement"}, []string{"creatine"}},
		{map[string]any{"status": "active"}, []string{"creatine"}},
		{nil, []string{"Knee", "creatine"}},
	} {
		if got := members(tc.args); !slices.Equal(got, tc.want) {
			t.Errorf("health_items_list(%v) = %v, want %v", tc.args, got, tc.want)
		}
	}
}

func lab(analyte string, value float64, unit string, extra map[string]any) map[string]any {
	m := map[string]any{"analyte": analyte, "value": value, "unit": unit}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func TestLabsStatusesAndFlags(t *testing.T) {
	c := memorySession(t)
	var rec labsRecordOut
	c.ok("labs_record", map[string]any{"collected_on": "2026-09-01", "lab": "LabX", "results": []any{
		lab("LDL", 145, "mg/dL", map[string]any{"ref_high": 130, "report_flag": "H", "ref_text": "< 130 desejável"}),
		lab("Vitamin D", 18, "ng/mL", map[string]any{"ref_low": 30}), // only a lower bound
		lab("HDL", 40, "mg/dL", map[string]any{"ref_low": 40}),       // exactly on an inclusive bound
		lab("HbA1c", 5.7, "%", map[string]any{"ref_high": 5.7, "ref_high_exclusive": true}),
		lab("Ferritin", 900, "ng/mL", nil), // no range on the report
	}}, &rec)

	status := map[string]string{}
	for _, r := range rec.Recorded {
		status[r.Analyte] = r.Status
	}
	want := map[string]string{"ldl": "high", "vitamin_d": "low", "hdl": "in_range", "hba1c": "high", "ferritin": "no_reference"}
	if !reflect.DeepEqual(status, want) {
		t.Errorf("statuses = %v, want %v", status, want)
	}
	dirs := map[string]string{}
	for _, f := range rec.OutOfRange {
		if !f.ReferToDoctor {
			t.Errorf("%s not referred to a doctor", f.Analyte)
		}
		dirs[f.Analyte] = f.Direction
	}
	if !reflect.DeepEqual(dirs, map[string]string{"ldl": "high", "vitamin_d": "low", "hba1c": "high"}) {
		t.Errorf("out_of_range = %v", dirs)
	}
	if rec.OutOfRange[0].ReportFlag != "H" || rec.Recorded[0].RefText != "< 130 desejável" || rec.Recorded[0].Lab != "LabX" {
		t.Errorf("report_flag/ref_text/lab not passed through: %+v / %+v", rec.OutOfRange[0], rec.Recorded[0])
	}
	if !slices.Equal(rec.NoReference, []string{"ferritin"}) || rec.Guidance != medicalHint {
		t.Errorf("no_reference = %v, guidance = %q", rec.NoReference, rec.Guidance)
	}
	if rec.Recorded[0].Source != "chat" {
		t.Errorf("default source = %q, want chat", rec.Recorded[0].Source)
	}

	// Only in-range values: no guidance.
	c.ok("labs_record", map[string]any{"collected_on": "2026-10-01", "source": "pdf", "results": []any{
		lab("ldl", 120, "mg/dL", map[string]any{"ref_high": 130}),
	}}, &rec)
	if len(rec.OutOfRange) != 0 || len(rec.NoReference) != 0 || rec.Guidance != "" {
		t.Errorf("in-range batch flagged: %+v", rec)
	}
}

func TestLabsReplacementsAndUnits(t *testing.T) {
	c := memorySession(t)
	var rec labsRecordOut
	c.ok("labs_record", map[string]any{"collected_on": "2025-09-01", "results": []any{lab("glucose", 100, "mg/dL", map[string]any{"ref_low": 70, "ref_high": 99})}}, &rec)
	c.ok("labs_record", map[string]any{"collected_on": "2026-09-01", "lab": "LabB", "results": []any{lab("glucose", 5.5, "mmol/L", map[string]any{"ref_low": 3.9, "ref_high": 5.5})}}, &rec)
	if len(rec.UnitChanges) != 1 || rec.UnitChanges[0].PreviousUnit != "mg/dL" || !strings.Contains(rec.Guidance, unitHint) {
		t.Errorf("unit change not reported: %+v", rec)
	}
	c.ok("labs_record", map[string]any{"collected_on": "2026-09-01", "results": []any{lab("glucose", 5.4, "mmol/L", map[string]any{"ref_low": 3.9, "ref_high": 5.5})}}, &rec)
	if len(rec.Replaced) != 1 || rec.Replaced[0].PreviousValue != 5.5 || rec.Replaced[0].PreviousLab != "LabB" {
		t.Errorf("replacement not reported: %+v", rec.Replaced)
	}

	var q labsQueryOut
	c.ok("labs_query", map[string]any{"analyte": "Glucose"}, &q)
	s := q.Series[0]
	if len(s.Points) != 2 || !s.MixedUnits || !slices.Equal(s.Units, []string{"mg/dL", "mmol/L"}) ||
		s.Latest.Value != 5.4 || s.Points[0].Status != "high" || s.Latest.Status != "in_range" || q.Truncated {
		t.Errorf("glucose series = %+v", q)
	}
	if !strings.Contains(q.Guidance, unitHint) || !strings.Contains(q.Guidance, medicalHint) {
		t.Errorf("guidance = %q, want both the unit and the medical hint", q.Guidance)
	}
	c.ok("labs_query", map[string]any{"since": "2026-01-01"}, &q)
	if len(q.Series) != 1 || q.Series[0].MixedUnits || q.Guidance != "" {
		t.Errorf("since filter = %+v", q)
	}
}

func TestPreferences(t *testing.T) {
	c := memorySession(t)
	values := map[string]string{ // raw JSON, compared byte for byte
		"training_time": `"morning"`,
		"foods_avoid":   `["lactose","pork"]`,
		"macros":        `{"carbs_pct":40}`,
		// Integers beyond 2^53 are not listed: the SDK decodes arguments into
		// float64 while validating the schema, before the handler sees them.
		"big_int_safe": `9007199254740991`,
		"vegan":        `false`,
		"nothing":      `null`,
	}
	for k, v := range values {
		var out preferenceOut
		c.ok("preference_set", map[string]any{"key": " " + k + " ", "value": json.RawMessage(v)}, &out)
		if out.Key != k || string(out.Value) != v || out.Previous != nil {
			t.Errorf("preference_set(%s) = %+v", k, out)
		}
	}
	var out preferenceOut
	c.ok("preference_set", map[string]any{"key": "training_time", "value": "evening"}, &out)
	if string(out.Previous) != `"morning"` {
		t.Errorf("previous = %s, want \"morning\"", out.Previous)
	}
	values["training_time"] = `"evening"`

	var all preferencesOut
	c.ok("preferences_get", nil, &all)
	for k, v := range values {
		if string(all.Preferences[k]) != v {
			t.Errorf("preference %s = %s, want %s", k, all.Preferences[k], v)
		}
	}
	if all.Notice != dataNotice {
		t.Error("preferences_get lacks the data notice")
	}
}

func TestNotes(t *testing.T) {
	c := memorySession(t)
	var n store.Note
	c.ok("note_add", map[string]any{"kind": "symptom", "text": "dor no joelho depois do agachamento", "tags": []string{"joelho", "treino"}, "related_date": "2026-10-12"}, &n)
	if n.ID == 0 || n.RelatedDate != "2026-10-12" || !slices.Equal(n.Tags, []string{"joelho", "treino"}) {
		t.Errorf("note_add = %+v", n)
	}
	for range 3 {
		c.ok("note_add", map[string]any{"kind": "checkin", "text": "dormi bem"}, &n)
	}

	var res notesOut
	c.ok("notes_search", map[string]any{"query": "joelho agachamento"}, &res)
	if len(res.Notes) != 1 || res.Notes[0].Kind != "symptom" || res.More || res.Notice != dataNotice {
		t.Errorf("search = %+v", res)
	}
	c.ok("notes_search", map[string]any{"kind": "symptom"}, &res)
	if len(res.Notes) != 1 || res.Notes[0].Kind != "symptom" {
		t.Errorf("kind filter = %+v", res.Notes)
	}
	c.ok("notes_search", map[string]any{"kind": "checkin", "limit": 2}, &res)
	if len(res.Notes) != 2 || !res.More {
		t.Errorf("limit 2 of 3 = %d notes, more=%v", len(res.Notes), res.More)
	}
	// Notes created "now" (local Oct 13) match since Oct 13 but not Oct 14.
	c.ok("notes_search", map[string]any{"kind": "checkin", "since": "2026-10-14"}, &res)
	if len(res.Notes) != 0 {
		t.Errorf("since uses the configured zone: %+v", res.Notes)
	}
	c.ok("notes_search", map[string]any{"kind": "checkin", "since": "2026-10-13"}, &res)
	if len(res.Notes) != 3 {
		t.Errorf("since Oct 13 = %d notes, want 3", len(res.Notes))
	}
}

func TestAge(t *testing.T) {
	cases := []struct {
		birth, today coach.LocalDate
		want         int
		ok           bool
	}{
		{"1990-10-14", "2026-10-13", 35, true},
		{"1990-10-14", "2026-10-14", 36, true},
		{"1990-12-25", "2026-10-14", 35, true}, // birthday month still ahead
		{"1990-02-28", "2026-03-01", 36, true},
		{"2000-02-29", "2026-02-28", 25, true}, // leap-day birthday not reached yet
		{"2000-02-29", "2026-03-01", 26, true},
		{"2026-10-14", "2026-10-14", 0, true},
		{"", "2026-10-14", 0, false},
		{"2027-01-01", "2026-10-14", 0, false},
	}
	for _, c := range cases {
		got := age(c.birth, c.today)
		if (got != nil) != c.ok || (got != nil && *got != c.want) {
			t.Errorf("age(%s, %s) = %v, want %d (ok=%v)", c.birth, c.today, got, c.want, c.ok)
		}
	}
}
