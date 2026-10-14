package server

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func connect(t *testing.T, deps Deps) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	serverT, clientT := mcp.NewInMemoryTransports()

	if _, err := New(deps).Connect(ctx, serverT, nil); err != nil {
		t.Fatalf("server connect: %v", err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "test"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func TestServerInfoIsListed(t *testing.T) {
	cs := connect(t, Deps{})

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

func TestServerInfoReturnsName(t *testing.T) {
	cs := connect(t, Deps{})

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
	if out["name"] != Name {
		t.Fatalf("name = %v, want %q", out["name"], Name)
	}
}

func TestToolCallLogOmitsArgumentsAndResults(t *testing.T) {
	var buf bytes.Buffer
	deps := Deps{Logger: slog.New(slog.NewJSONHandler(&buf, nil)), Now: time.Now}
	cs := connect(t, deps)

	// The extra argument may be rejected by input-schema validation; either way the
	// call must be logged without echoing what was sent.
	_, _ = cs.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "server_info",
		Arguments: map[string]any{"probe": "resting-hr-57"},
	})

	logs := buf.String()
	if !strings.Contains(logs, `"tool":"server_info"`) || !strings.Contains(logs, `"duration_ms"`) {
		t.Fatalf("expected a tool_call record, got: %s", logs)
	}
	for _, leaked := range []string{"resting-hr-57", "probe"} {
		if strings.Contains(logs, leaked) {
			t.Errorf("log leaked argument %q: %s", leaked, logs)
		}
	}
	if strings.Contains(logs, `"version"`) {
		t.Errorf("log leaked tool result: %s", logs)
	}
}
