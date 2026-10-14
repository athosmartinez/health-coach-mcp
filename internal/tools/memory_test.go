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
	ctx := context.Background()
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	now := func() time.Time { return time.Date(2026, 10, 14, 1, 30, 0, 0, time.UTC) }
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

// fails calls a tool that must fail and returns the error text.
func (c memClient) fails(name string, args map[string]any) string {
	c.t.Helper()
	res, err := c.cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return err.Error()
	}
	if !res.IsError {
		c.t.Fatalf("%s(%v) succeeded, want an error", name, args)
	}
	return res.Content[0].(*mcp.TextContent).Text
}

func TestMemoryToolsAreListedWithEnums(t *testing.T) {
	c := memorySession(t)
	res, err := c.cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*mcp.Tool{}
	var names []string
	for _, tool := range res.Tools {
		byName[tool.Name] = tool
		names = append(names, tool.Name)
	}
	if !slices.Equal(slices.Sorted(slices.Values(names)), slices.Sorted(slices.Values(memoryTools))) {
		t.Fatalf("tools = %v, want %v", names, memoryTools)
	}

	enums := []struct {
		tool, prop string
		want       []string
	}{
		{"health_item_upsert", "kind", store.HealthItemKinds},
		{"health_item_upsert", "status", store.HealthItemStatuses},
		{"health_items_list", "kind", store.HealthItemKinds},
		{"labs_record", "source", store.LabSources},
		{"note_add", "kind", store.NoteKinds},
		{"notes_search", "kind", store.NoteKinds},
		{"profile_update", "clear", store.ProfileFields},
		{"targets_set", "clear", store.TargetFields},
	}
	for _, e := range enums {
		schema, _ := json.Marshal(byName[e.tool].InputSchema)
		for _, v := range e.want {
			if !strings.Contains(string(schema), `"`+v+`"`) {
				t.Errorf("%s.%s schema lacks enum value %q: %s", e.tool, e.prop, v, schema)
			}
		}
	}
	for _, name := range memoryTools {
		tool := byName[name]
		if tool.OutputSchema == nil || tool.Description == "" || tool.Annotations == nil {
			t.Errorf("%s: missing output schema, description or annotations", name)
			continue
		}
		readOnly := strings.HasSuffix(name, "_get") || strings.HasSuffix(name, "_list") ||
			strings.HasSuffix(name, "_query") || strings.HasSuffix(name, "_search")
		if tool.Annotations.ReadOnlyHint != readOnly {
			t.Errorf("%s: readOnlyHint = %v, want %v", name, tool.Annotations.ReadOnlyHint, readOnly)
		}
	}
	if !strings.Contains(byName["targets_set"].Description, "explicitly confirmed") {
		t.Error("targets_set must say it needs the user's explicit confirmation (Q3)")
	}
	for _, name := range []string{"labs_record", "labs_query"} {
		if !strings.Contains(byName[name].Description, "doctor") {
			t.Errorf("%s description lacks the medical guardrail", name)
		}
	}
}

func TestProfileRoundTripAndTargetInForce(t *testing.T) {
	c := memorySession(t)

	var empty profileView
	c.ok("profile_get", nil, &empty)
	if empty.Profile != nil || empty.Targets != nil || empty.Preferences == nil || empty.Today != "2026-10-13" {
		t.Fatalf("empty profile_get = %+v (today must be the local day in São Paulo)", empty)
	}

	var p store.Profile
	c.ok("profile_update", map[string]any{
		"birth_date": "1990-10-14", "height_cm": 180,
		"goal":          map[string]any{"type": "recomp", "target_body_fat_pct": 12, "deadline": "2027-06-30"},
		"training_plan": map[string]any{"split": "upper/lower"},
	}, &p)
	if *p.HeightCm != 180 || p.Goal.Type != "recomp" || p.Plan.Split != "upper/lower" {
		t.Errorf("profile_update = %+v", p)
	}
	c.ok("profile_update", map[string]any{"sex": "male", "clear": []string{"training_plan"}}, &p)
	if p.Sex != "male" || p.Plan != nil || p.Goal == nil {
		t.Errorf("partial update + clear = %+v", p)
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
	if got.Profile.Sex != "male" || got.Profile.Goal.Deadline != "2027-06-30" {
		t.Errorf("stored profile = %+v", got.Profile)
	}
}

func TestMemoryToolsRejectBadInput(t *testing.T) {
	c := memorySession(t)
	cases := []struct {
		tool string
		args map[string]any
		want string // substring of the error text
	}{
		{"health_item_upsert", map[string]any{"kind": "hobby", "name": "x", "status": "active"}, "kind"},
		{"health_items_list", map[string]any{"status": "gone"}, "status"},
		{"labs_record", map[string]any{"collected_on": "2026-09-01", "source": "fax", "results": []any{}}, "source"},
		{"note_add", map[string]any{"kind": "rant", "text": "x"}, "kind"},
		{"profile_update", map[string]any{"clear": []string{"weight"}}, "clear"},
		{"targets_set", map[string]any{"effective_from": "2026-02-30", "kcal": 1}, "2026-02-30"},
		{"profile_get", map[string]any{"unexpected": true}, "unexpected"},
		// Store validation surfaces as the invalid_input contract.
		{"targets_set", map[string]any{"effective_from": "2026-10-01"}, `"code":"invalid_input"`},
		{"labs_record", map[string]any{"collected_on": "2026-09-01", "results": []any{}}, `"code":"invalid_input"`},
		{"notes_search", map[string]any{"query": "   "}, `"code":"invalid_input"`},
	}
	for _, tc := range cases {
		if msg := c.fails(tc.tool, tc.args); !strings.Contains(msg, tc.want) {
			t.Errorf("%s(%v) error %q lacks %q", tc.tool, tc.args, msg, tc.want)
		}
	}
}

func TestHealthItems(t *testing.T) {
	c := memorySession(t)
	var it store.HealthItem
	c.ok("health_item_upsert", map[string]any{"kind": "injury", "name": "Knee", "status": "active", "details": "ACL, left", "started_on": "2026-09-01"}, &it)
	c.ok("health_item_upsert", map[string]any{"kind": "injury", "name": "knee", "status": "resolved", "ended_on": "2026-10-10"}, &it)
	if it.Details != "ACL, left" || it.StartedOn != "2026-09-01" || it.Status != "resolved" {
		t.Errorf("status update lost history: %+v", it)
	}
	c.ok("health_item_upsert", map[string]any{"kind": "supplement", "name": "creatine", "status": "active"}, &it)

	var list healthItemsOut
	c.ok("health_items_list", map[string]any{"status": "active"}, &list)
	if len(list.Items) != 1 || list.Items[0].Name != "creatine" {
		t.Errorf("active items = %+v", list.Items)
	}
	c.ok("health_items_list", nil, &list)
	if len(list.Items) != 2 {
		t.Errorf("all items = %+v", list.Items)
	}
}

func TestLabsFlagOutOfRangeAndGroupSeries(t *testing.T) {
	c := memorySession(t)
	var rec labsRecordOut
	c.ok("labs_record", map[string]any{
		"collected_on": "2026-09-01", "lab": "LabX",
		"results": []any{
			map[string]any{"analyte": "LDL", "value": 145, "unit": "mg/dL", "ref_high": 130},
			map[string]any{"analyte": "Vitamin D", "value": 18, "unit": "ng/mL", "ref_low": 30, "ref_high": 100},
			map[string]any{"analyte": "HDL", "value": 55, "unit": "mg/dL", "ref_low": 40},
		},
	}, &rec)
	if len(rec.Recorded) != 3 || len(rec.OutOfRange) != 2 || rec.Guidance == "" {
		t.Fatalf("labs_record = %+v", rec)
	}
	dirs := map[string]string{}
	for _, f := range rec.OutOfRange {
		if !f.ReferToDoctor {
			t.Errorf("%s not referred to a doctor", f.Analyte)
		}
		dirs[f.Analyte] = f.Direction
	}
	if dirs["ldl"] != "high" || dirs["vitamin_d"] != "low" {
		t.Errorf("directions = %v", dirs)
	}
	if rec.Recorded[0].Source != "chat" {
		t.Errorf("default source = %q, want chat", rec.Recorded[0].Source)
	}

	c.ok("labs_record", map[string]any{"collected_on": "2026-10-01", "source": "pdf",
		"results": []any{map[string]any{"analyte": "ldl", "value": 120, "unit": "mg/dL", "ref_high": 130}}}, &rec)
	if len(rec.OutOfRange) != 0 || rec.Guidance != "" {
		t.Errorf("in-range batch flagged: %+v", rec)
	}

	var q labsQueryOut
	c.ok("labs_query", map[string]any{"analyte": "LDL"}, &q)
	if len(q.Series) != 1 || len(q.Series[0].Points) != 2 || q.Series[0].Latest.CollectedOn != "2026-10-01" ||
		!q.Series[0].Points[0].OutOfRange || q.Series[0].Points[1].OutOfRange || q.Guidance == "" {
		t.Errorf("ldl series = %+v", q)
	}
	c.ok("labs_query", map[string]any{"since": "2026-09-15"}, &q)
	if len(q.Series) != 1 || q.Series[0].Analyte != "ldl" || q.Guidance != "" {
		t.Errorf("since filter = %+v", q)
	}
	c.ok("labs_query", nil, &q)
	if len(q.Series) != 3 {
		t.Errorf("all series = %d, want 3", len(q.Series))
	}
}

func TestPreferencesAcceptAnyJSON(t *testing.T) {
	c := memorySession(t)
	values := map[string]any{
		"training_time": "morning",
		"foods_avoid":   []any{"lactose", "pork"},
		"macros":        map[string]any{"carbs_pct": 40.0},
		"cheat_meals":   2.0,
		"vegan":         false,
	}
	for k, v := range values {
		var out preferenceOut
		c.ok("preference_set", map[string]any{"key": k, "value": v}, &out)
	}
	var all struct {
		Preferences map[string]any `json:"preferences"`
	}
	c.ok("preferences_get", nil, &all)
	for k, v := range values {
		got, _ := json.Marshal(all.Preferences[k])
		want, _ := json.Marshal(v)
		if string(got) != string(want) {
			t.Errorf("preference %s = %s, want %s", k, got, want)
		}
	}
	var pv profileView
	c.ok("profile_get", nil, &pv)
	if len(pv.Preferences) != len(values) {
		t.Errorf("profile_get preferences = %v", pv.Preferences)
	}
}

func TestNotes(t *testing.T) {
	c := memorySession(t)
	var n store.Note
	c.ok("note_add", map[string]any{"kind": "symptom", "text": "dor no joelho depois do agachamento", "tags": []string{"joelho"}, "related_date": "2026-10-12"}, &n)
	if n.ID == 0 || n.RelatedDate != "2026-10-12" {
		t.Errorf("note_add = %+v", n)
	}
	for range 3 {
		c.ok("note_add", map[string]any{"kind": "checkin", "text": "dormi bem"}, &n)
	}

	var res store.NoteResults
	c.ok("notes_search", map[string]any{"query": "joelho agachamento"}, &res)
	if len(res.Notes) != 1 || res.Notes[0].Kind != "symptom" || res.More {
		t.Errorf("search = %+v", res)
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
		{"1990-02-28", "2026-03-01", 36, true},
		{"2000-02-29", "2026-02-28", 25, true}, // leap-day birthday not reached yet
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

// TestSchemasHaveNoBooleanProperties guards client interop: zod-based clients
// (the MCP Inspector among them) reject `true`/`false` as a property schema.
func TestSchemasHaveNoBooleanProperties(t *testing.T) {
	c := memorySession(t)
	res, err := c.cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
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
	for _, tool := range res.Tools {
		for kind, schema := range map[string]any{"input": tool.InputSchema, "output": tool.OutputSchema} {
			b, _ := json.Marshal(schema)
			var v any
			_ = json.Unmarshal(b, &v)
			walk(tool.Name+"."+kind, v)
		}
	}
}
