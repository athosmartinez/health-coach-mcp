package coach

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

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

// AsToolError returns the ToolError in err's chain (value or pointer). Any other
// error becomes a generic internal_error, since its text may carry health data.
func AsToolError(err error) ToolError {
	var te ToolError
	if errors.As(err, &te) {
		return te
	}
	var pte *ToolError
	if errors.As(err, &pte) && pte != nil {
		return *pte
	}
	return ToolError{Code: CodeInternal, Message: "unexpected internal error"}
}

// WireError is the error a tool handler returns to the SDK. The SDK writes
// err.Error() as the result's only text content, so Error() is the JSON payload
// {code,message,hint}. Returning an error instead of a result also skips the
// SDK's output-schema validation, which would reject a zero Envelope.
type WireError struct{ ToolError }

func (e WireError) Error() string {
	// Marshal cannot fail: ToolError holds only strings.
	b, _ := json.Marshal(e.ToolError)
	return string(b)
}

func (e WireError) Unwrap() error { return e.ToolError }

// ToWire converts any error into a WireError (see AsToolError).
func ToWire(err error) WireError { return WireError{AsToolError(err)} }

// ErrorResult builds an error result directly, for low-level handlers that
// return *mcp.CallToolResult themselves. The payload goes in text content, never
// StructuredContent, which the SDK validates against the success output schema.
func ErrorResult(err error) *mcp.CallToolResult {
	res := &mcp.CallToolResult{}
	res.SetError(ToWire(err))
	return res
}

// ErrorTypes names the types along an error chain ("*fmt.wrapError > *sqlite.Error"):
// enough to tell a database fault from a bug without logging any message text.
// Every branch of a multi-%w or joined error is walked, depth first.
func ErrorTypes(err error) string {
	const maxTypes = 8
	var types []string
	var walk func(error)
	walk = func(err error) {
		if err == nil || len(types) == maxTypes {
			return
		}
		types = append(types, fmt.Sprintf("%T", err))
		switch u := err.(type) {
		case interface{ Unwrap() []error }:
			for _, e := range u.Unwrap() {
				walk(e)
			}
		case interface{ Unwrap() error }:
			walk(u.Unwrap())
		}
	}
	walk(err)
	return strings.Join(types, " > ")
}
