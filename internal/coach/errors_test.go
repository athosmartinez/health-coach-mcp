package coach

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func decode(t *testing.T, res *mcp.CallToolResult) map[string]string {
	t.Helper()
	if !res.IsError {
		t.Fatal("IsError = false")
	}
	if res.StructuredContent != nil {
		t.Fatal("StructuredContent must be nil so it cannot violate the tool output schema")
	}
	if len(res.Content) != 1 {
		t.Fatalf("want 1 content block, got %d", len(res.Content))
	}
	text, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("content is %T, want *mcp.TextContent", res.Content[0])
	}
	var out map[string]string
	if err := json.Unmarshal([]byte(text.Text), &out); err != nil {
		t.Fatalf("error text is not JSON: %v", err)
	}
	return out
}

func TestErrorResultFromToolError(t *testing.T) {
	err := fmt.Errorf("fetching sleep: %w", ToolError{Code: CodeAuthExpired, Message: "token expired", Hint: "health-coach-mcp auth login"})
	out := decode(t, ErrorResult(err))
	if out["code"] != "auth_expired" || out["hint"] != "health-coach-mcp auth login" || out["message"] != "token expired" {
		t.Errorf("unexpected payload %v", out)
	}
}

func TestErrorResultAcceptsPointerToolError(t *testing.T) {
	out := decode(t, ErrorResult(&ToolError{Code: CodeNoData, Message: "no sleep recorded"}))
	if out["code"] != "no_data" {
		t.Errorf("code = %q, want no_data", out["code"])
	}
}

func TestErrorResultHidesUnknownErrorDetails(t *testing.T) {
	out := decode(t, ErrorResult(errors.New("resting hr 57 failed to parse")))
	if out["code"] != "internal_error" {
		t.Errorf("code = %q, want internal_error", out["code"])
	}
	if out["message"] == "resting hr 57 failed to parse" {
		t.Error("raw error text may carry health data and must not be echoed")
	}
}

func TestWireErrorIsJSONAndUnwraps(t *testing.T) {
	w := ToWire(fmt.Errorf("wrapped: %w", ToolError{Code: CodeScopeMissing, Message: "missing sleep scope"}))
	var payload ToolError
	if err := json.Unmarshal([]byte(w.Error()), &payload); err != nil {
		t.Fatalf("Error() is not JSON: %v", err)
	}
	if payload.Code != CodeScopeMissing {
		t.Errorf("code = %q", payload.Code)
	}
	var te ToolError
	if !errors.As(w, &te) || te.Code != CodeScopeMissing {
		t.Error("WireError must unwrap to its ToolError")
	}
}

func TestErrorTypes(t *testing.T) {
	base := &json.SyntaxError{}
	wrapped := fmt.Errorf("read: %w", errors.Join(base, errors.New("second")))
	if got, want := ErrorTypes(wrapped), "*fmt.wrapError > *errors.joinError > *json.SyntaxError"; got != want {
		t.Errorf("ErrorTypes = %q, want %q", got, want)
	}
	if got := ErrorTypes(nil); got != "" {
		t.Errorf("ErrorTypes(nil) = %q", got)
	}
}
