package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/config"
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
		return nil, errors.New(sentinel)
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
		{map[string]any{"mode": "ok", "unexpected": sentinel}, true, "sdk_error"},
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
	for _, rec := range logs.records(t) {
		if rec["msg"] == "tool_call" {
			calls = append(calls, rec)
		}
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
