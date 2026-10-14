package coach

import (
	"encoding/json"
	"errors"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Code is a stable, machine-readable error identifier agents can branch on.
type Code string

const (
	CodeAuthExpired         Code = "auth_expired"
	CodeScopeMissing        Code = "scope_missing"
	CodeUpstreamUnavailable Code = "upstream_unavailable"
	CodeNoData              Code = "no_data"
	CodeInvalidInput        Code = "invalid_input"
	CodeInternal            Code = "internal_error"
)

// ToolError is an error meant to reach the model. Message and Hint must never
// contain health values: they may be logged or shown outside the conversation.
type ToolError struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
}

func (e ToolError) Error() string { return string(e.Code) + ": " + e.Message }

// ErrorResult converts err into a tool error result. The payload goes in text
// content, not StructuredContent, because the SDK validates structured content
// against the tool's success output schema. Errors that are not ToolErrors are
// reported generically since their text may carry health data.
func ErrorResult(err error) *mcp.CallToolResult {
	var te ToolError
	if !errors.As(err, &te) {
		te = ToolError{Code: CodeInternal, Message: "unexpected internal error"}
	}
	body, _ := json.Marshal(te)
	return &mcp.CallToolResult{
		IsError: true,
		Content: []mcp.Content{&mcp.TextContent{Text: string(body)}},
	}
}
