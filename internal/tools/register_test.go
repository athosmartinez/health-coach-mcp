package tools

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

type probeIn struct {
	Mode string          `json:"mode"`
	Day  coach.LocalDate `json:"day,omitempty"`
}

type probeData struct {
	Steps int `json:"steps"`
}

// probe exercises every outcome a real coach tool can have.
func probe(_ context.Context, _ *mcp.CallToolRequest, in probeIn) (coach.Envelope[probeData], error) {
	switch in.Mode {
	case "tool_error":
		return coach.Envelope[probeData]{}, coach.ToolError{Code: coach.CodeNoData, Message: "no steps recorded"}
	case "raw_error":
		return coach.Envelope[probeData]{}, errors.New("resting hr 57 failed to parse")
	case "panic":
		panic("resting hr 57")
	}
	return coach.NewEnvelope(probeData{Steps: 8000}, 7, []string{"fitbit"}, nil, time.Unix(0, 0).UTC()), nil
}

func probeSession(t *testing.T) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	s := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "test"}, nil)
	Register(s, &mcp.Tool{
		Name:        "probe",
		Description: "test tool",
		InputSchema: MustInputSchema[probeIn](map[string][]string{"mode": {"ok", "tool_error", "raw_error", "panic"}}),
	}, probe)

	serverT, clientT := mcp.NewInMemoryTransports()
	if _, err := s.Connect(ctx, serverT, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "c", Version: "test"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func call(t *testing.T, cs *mcp.ClientSession, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "probe", Arguments: args})
	if err != nil {
		t.Fatalf("CallTool(%v) protocol error: %v", args, err)
	}
	return res
}

func errorPayload(t *testing.T, res *mcp.CallToolResult) coach.ToolError {
	t.Helper()
	if !res.IsError {
		t.Fatalf("IsError = false, content %+v", res.Content)
	}
	if res.StructuredContent != nil {
		t.Errorf("StructuredContent = %v, want nil on errors", res.StructuredContent)
	}
	if len(res.Content) != 1 {
		t.Fatalf("want 1 content block, got %d", len(res.Content))
	}
	var te coach.ToolError
	if err := json.Unmarshal([]byte(res.Content[0].(*mcp.TextContent).Text), &te); err != nil {
		t.Fatalf("error content is not the JSON contract: %v", err)
	}
	return te
}

func TestRegisterSuccess(t *testing.T) {
	res := call(t, probeSession(t), map[string]any{"mode": "ok"})
	if res.IsError {
		t.Fatalf("unexpected error: %+v", res.Content)
	}
	out, _ := json.Marshal(res.StructuredContent)
	if !strings.Contains(string(out), `"steps":8000`) {
		t.Errorf("structured content = %s", out)
	}
}

func TestRegisterToolErrorReachesClient(t *testing.T) {
	te := errorPayload(t, call(t, probeSession(t), map[string]any{"mode": "tool_error"}))
	if te.Code != coach.CodeNoData || te.Message != "no steps recorded" {
		t.Errorf("payload = %+v", te)
	}
}

func TestRegisterHidesRawErrorsAndPanics(t *testing.T) {
	cs := probeSession(t)
	for _, mode := range []string{"raw_error", "panic"} {
		res := call(t, cs, map[string]any{"mode": mode})
		te := errorPayload(t, res)
		if te.Code != coach.CodeInternal {
			t.Errorf("%s: code = %q, want internal_error", mode, te.Code)
		}
		if text := res.Content[0].(*mcp.TextContent).Text; strings.Contains(text, "57") {
			t.Errorf("%s: health value leaked: %s", mode, text)
		}
	}
	// The server must survive the panic.
	if res := call(t, cs, map[string]any{"mode": "ok"}); res.IsError {
		t.Fatalf("server unusable after panic: %+v", res.Content)
	}
}

func TestRegisterEnforcesInputSchema(t *testing.T) {
	cs := probeSession(t)
	bad := []map[string]any{
		{"mode": "not-a-mode"},
		{"mode": "ok", "day": "garbage"},
		{"mode": "ok", "day": "2026-02-30"}, // matches the pattern, fails UnmarshalText
	}
	for _, args := range bad {
		if res := call(t, cs, args); !res.IsError {
			t.Errorf("args %v accepted", args)
		}
	}
	if res := call(t, cs, map[string]any{"mode": "ok", "day": "2026-10-13"}); res.IsError {
		t.Errorf("valid date rejected: %+v", res.Content)
	}
}
