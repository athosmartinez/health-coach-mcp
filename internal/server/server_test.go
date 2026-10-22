package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/config"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
	"github.com/athosmartinez/health-coach-mcp/internal/tools"
	"github.com/athosmartinez/health-coach-mcp/internal/version"
)

func testDeps() Deps {
	return Deps{Cfg: config.Config{TimeZone: time.UTC}}
}

func newServer(t *testing.T, deps Deps) *mcp.Server {
	t.Helper()
	s, err := New(deps)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func connect(t *testing.T, s *mcp.Server) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	serverT, clientT := mcp.NewInMemoryTransports()
	if _, err := s.Connect(ctx, serverT, nil); err != nil {
		t.Fatalf("server connect: %v", err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "test"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func TestNewRequiresTimeZone(t *testing.T) {
	if _, err := New(Deps{}); err == nil {
		t.Fatal("New without a time zone must fail instead of panicking later")
	}
}

func TestServerInfoIsListed(t *testing.T) {
	cs := connect(t, newServer(t, testDeps()))
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("list tools: %v", err)
	}
	for _, tool := range res.Tools {
		if tool.Name == "server_info" {
			return
		}
	}
	t.Fatalf("server_info not listed; got %d tools", len(res.Tools))
}

func TestServerInfoReturnsNameAndVersion(t *testing.T) {
	cs := connect(t, newServer(t, testDeps()))
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "server_info"})
	if err != nil {
		t.Fatalf("call tool: %v", err)
	}
	if res.IsError {
		t.Fatalf("tool returned error: %+v", res.Content)
	}
	out, ok := res.StructuredContent.(map[string]any)
	if !ok {
		t.Fatalf("unexpected structured content type %T", res.StructuredContent)
	}
	if out["name"] != Name || out["version"] != version.Version {
		t.Fatalf("output = %v", out)
	}
}

// fakeClock advances 250ms on every reading.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(250 * time.Millisecond)
	return c.t
}

type logCapture struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (l *logCapture) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *logCapture) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

func (l *logCapture) records(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(l.String()), "\n") {
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("log line is not JSON: %s", line)
		}
		out = append(out, rec)
	}
	return out
}

const sentinel = "resting-hr-57"

type leakIn struct {
	Mode  string `json:"mode"`
	Probe string `json:"probe,omitempty"`
}

func leakTool(_ context.Context, _ *mcp.CallToolRequest, in leakIn) (map[string]string, error) {
	switch in.Mode {
	case "tool_error":
		return nil, coach.ToolError{Code: coach.CodeAuthExpired, Message: sentinel, Hint: sentinel}
	case "raw_error":
		return nil, fmt.Errorf("wrapped: %w", errors.New(sentinel))
	case "panic":
		panic(sentinel)
	}
	return map[string]string{"value": sentinel}, nil
}

func TestToolCallLogShapeAndNoLeaks(t *testing.T) {
	logs := &logCapture{}
	clock := &fakeClock{t: time.Unix(0, 0)}
	s := newServer(t, Deps{
		Cfg:    config.Config{TimeZone: time.UTC},
		Logger: slog.New(slog.NewJSONHandler(logs, nil)),
		Now:    clock.now,
	})
	tools.Register(s, &mcp.Tool{Name: "leak", Description: "test"}, leakTool)
	cs := connect(t, s)

	cases := []struct {
		args    map[string]any
		isError bool
		code    string
	}{
		{map[string]any{"mode": "ok", "probe": sentinel}, false, ""},
		{map[string]any{"mode": "tool_error", "probe": sentinel}, true, "auth_expired"},
		{map[string]any{"mode": "raw_error"}, true, "internal_error"},
		{map[string]any{"mode": "panic"}, true, "internal_error"},
		{map[string]any{"mode": "ok", "unexpected": sentinel}, true, "invalid_input"}, // SDK schema error, mapped
	}
	for _, c := range cases {
		if _, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "leak", Arguments: c.args}); err != nil {
			t.Fatalf("CallTool(%v): %v", c.args, err)
		}
	}
	if _, err := cs.ListTools(context.Background(), nil); err != nil {
		t.Fatal(err)
	}

	var calls []map[string]any
	faults := map[string]map[string]any{}
	for _, rec := range logs.records(t) {
		switch rec["msg"] {
		case "tool_call":
			calls = append(calls, rec)
		case "tool_internal_error", "tool_panic":
			faults[rec["msg"].(string)] = rec
		}
	}
	// Internal faults are logged with where they happened, never what they said.
	if f := faults["tool_internal_error"]; f == nil || f["tool"] != "leak" || f["error_types"] != "*fmt.wrapError > *errors.errorString" {
		t.Errorf("internal error log = %v", f)
	}
	if f := faults["tool_panic"]; f == nil || f["panic_type"] != "string" || !strings.Contains(fmt.Sprint(f["stack"]), "leakTool") {
		t.Errorf("panic log = %v", f)
	}
	if len(faults) != 2 {
		t.Errorf("only internal faults are logged as errors: %v", faults)
	}
	if len(calls) != len(cases) {
		t.Fatalf("got %d tool_call records, want %d (tools/list must not log)", len(calls), len(cases))
	}
	for i, rec := range calls {
		c := cases[i]
		wantKeys := []string{"time", "level", "msg", "tool", "duration_ms", "is_error"}
		if c.isError {
			wantKeys = append(wantKeys, "code")
		}
		if got := slices.Sorted(maps.Keys(rec)); !slices.Equal(got, slices.Sorted(slices.Values(wantKeys))) {
			t.Errorf("case %d: keys = %v, want %v", i, got, wantKeys)
		}
		if rec["tool"] != "leak" || rec["is_error"] != c.isError || rec["duration_ms"] != float64(250) {
			t.Errorf("case %d: record = %v", i, rec)
		}
		if c.isError && rec["code"] != c.code {
			t.Errorf("case %d: code = %v, want %s", i, rec["code"], c.code)
		}
	}
	if raw := logs.String(); strings.Contains(raw, sentinel) {
		t.Errorf("log leaked an argument, result or error message: %s", raw)
	}
}

func TestFailureCode(t *testing.T) {
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if got := failureCode(canceled, nil); got != "canceled" {
		t.Errorf("canceled ctx → %q", got)
	}
	if got := failureCode(context.Background(), context.DeadlineExceeded); got != "canceled" {
		t.Errorf("deadline → %q", got)
	}
	if got := failureCode(context.Background(), errors.New("boom")); got != "protocol_error" {
		t.Errorf("other → %q", got)
	}
}

func toolNames(t *testing.T, cs *mcp.ClientSession) []string {
	t.Helper()
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
	}
	return slices.Sorted(slices.Values(names))
}

func TestMemoryToolsNeedAStore(t *testing.T) {
	if got := toolNames(t, connect(t, newServer(t, testDeps()))); !slices.Equal(got, []string{"server_info"}) {
		t.Errorf("without a store: %v, want only server_info", got)
	}

	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "coach.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	deps := testDeps()
	deps.Store = st
	got := toolNames(t, connect(t, newServer(t, deps)))
	want := slices.Sorted(slices.Values([]string{
		"server_info", "profile_get", "profile_update", "targets_set", "health_item_upsert", "health_items_list",
		"labs_record", "labs_query", "preference_set", "preferences_get", "note_add", "notes_search",
	}))
	if !slices.Equal(got, want) {
		t.Errorf("with a store: %v, want %v", got, want)
	}
}

// noHealth is a healthdata.Source with no data at all.
type noHealth struct{}

func (noHealth) Recovery(context.Context, coach.LocalDate, coach.LocalDate) (healthdata.Recovery, error) {
	return healthdata.Recovery{}, nil
}
func (noHealth) Activity(context.Context, coach.LocalDate, coach.LocalDate) (healthdata.Activity, error) {
	return healthdata.Activity{}, nil
}
func (noHealth) Body(context.Context, coach.LocalDate, coach.LocalDate) (healthdata.Body, error) {
	return healthdata.Body{}, nil
}
func (noHealth) Exercises(context.Context, coach.LocalDate, coach.LocalDate, bool) (healthdata.Exercises, error) {
	return healthdata.Exercises{}, nil
}
func (noHealth) Nutrition(context.Context, coach.LocalDate, coach.LocalDate) (healthdata.Nutrition, error) {
	return healthdata.Nutrition{}, nil
}

func TestCoachToolsNeedAHealthSource(t *testing.T) {
	deps := testDeps()
	deps.Health = noHealth{}
	cs := connect(t, newServer(t, deps))
	if got := toolNames(t, cs); !slices.Equal(got, []string{"metric_series", "morning_briefing", "nutrition_day", "server_info", "weekly_report", "workout_review"}) {
		t.Errorf("with a health source: %v", got)
	}
	// Without a store the workout review still works, with no target.
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "workout_review"})
	if err != nil || res.IsError {
		t.Fatalf("workout_review without a store: %v %+v", err, res)
	}
	b, _ := json.Marshal(res.StructuredContent)
	if !strings.Contains(string(b), `"weekly_sessions_target":null`) {
		t.Errorf("result %s", b)
	}
}

func TestCoachToolsGetTheConfiguredZoneAndClock(t *testing.T) {
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	deps := testDeps()
	deps.Cfg.TimeZone, deps.Health = loc, noHealth{}
	// 01:00 UTC on the 17th is still the 16th in São Paulo.
	deps.Now = func() time.Time { return time.Date(2026, 10, 17, 1, 0, 0, 0, time.UTC) }
	cs := connect(t, newServer(t, deps))
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "workout_review"})
	if err != nil || res.IsError {
		t.Fatalf("workout_review: %v %+v", err, res)
	}
	b, _ := json.Marshal(res.StructuredContent)
	if !strings.Contains(string(b), `"date":"2026-10-16"`) || !strings.Contains(string(b), `"week_start":"2026-10-12"`) {
		t.Errorf("result %s", b)
	}
	// The night on the 17th is after today there.
	res, err = cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "morning_briefing", Arguments: map[string]any{"date": "2026-10-17"}})
	if err != nil || !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "invalid_input") {
		t.Errorf("briefing for the 17th: %v %+v", err, res)
	}
}

func TestSchemaErrorsFollowTheToolErrorContract(t *testing.T) {
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "coach.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	deps := testDeps()
	deps.Store, deps.Health = st, noHealth{}
	cs := connect(t, newServer(t, deps))

	cases := []map[string]any{
		{"name": "nutrition_day", "args": map[string]any{"date": "14/10/2026"}},                                                 // pattern
		{"name": "metric_series", "args": map[string]any{"metric": "heart_rate_raw", "from": "2026-10-01", "to": "2026-10-02"}}, // enum
		{"name": "metric_series", "args": map[string]any{"metric": "steps", "to": "2026-10-02"}},                                // missing required field
		{"name": "targets_set", "args": map[string]any{"kcal": 2000}},                                                           // missing required field
		{"name": "note_add", "args": map[string]any{"kind": "rant", "text": "x"}},                                               // enum
		{"name": "targets_set", "args": map[string]any{"effective_from": "2026-02-30", "kcal": 1}},                              // decode
		{"name": "preference_set", "args": map[string]any{"key": strings.Repeat("k", 5000), "value": 1}},                        // store
	}
	for _, c := range cases {
		res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: c["name"].(string), Arguments: c["args"]})
		if err != nil {
			t.Fatalf("%v: %v", c, err)
		}
		text := res.Content[0].(*mcp.TextContent).Text
		var te coach.ToolError
		if !res.IsError || json.Unmarshal([]byte(text), &te) != nil || te.Code != coach.CodeInvalidInput || te.Hint == "" {
			t.Errorf("%s: %s, want the invalid_input JSON contract", c["name"], text)
		}
		if len(te.Message) > maxEchoedError+len("…") || !utf8.ValidString(te.Message) {
			t.Errorf("%s: message not bounded or split a rune (%d bytes)", c["name"], len(te.Message))
		}
	}

	// An SDK error quoting a long accented argument is cut, at a rune boundary.
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "note_add",
		Arguments: map[string]any{"kind": strings.Repeat("é", 3000), "text": "x"}})
	if err != nil {
		t.Fatal(err)
	}
	var te coach.ToolError
	if err := json.Unmarshal([]byte(res.Content[0].(*mcp.TextContent).Text), &te); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(te.Message, "…") || len(te.Message) > maxEchoedError+len("…") || !utf8.ValidString(te.Message) ||
		te.Hint != "check the tool's input schema and retry" {
		t.Errorf("long SDK error = %d bytes, %+v", len(te.Message), te)
	}
}

func TestCapEchoedKeepsRunesWhole(t *testing.T) {
	for _, prefix := range []string{"", "a"} { // both parities of the cut
		msg := prefix + strings.Repeat("é", maxEchoedError)
		got := capEchoed(msg)
		if !utf8.ValidString(got) || !strings.HasSuffix(got, "…") || len(got) > maxEchoedError+len("…") {
			t.Errorf("prefix %q: capEchoed = %d bytes, valid=%v", prefix, len(got), utf8.ValidString(got))
		}
	}
	if got := capEchoed("short"); got != "short" {
		t.Errorf("short message changed: %q", got)
	}
}
