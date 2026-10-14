package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"
	"unicode/utf8"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/tools"
)

// logToolCalls records one line per tools/call with only the tool name, duration
// and outcome. Arguments, results and error messages are never logged: all of
// them may carry health data.
func logToolCalls(log *slog.Logger, now func() time.Time) mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if method != "tools/call" {
				return next(ctx, method, req)
			}
			tool := ""
			if p, ok := req.GetParams().(*mcp.CallToolParamsRaw); ok {
				tool = p.Name
			}
			start := now()
			res, err := next(tools.WithLogger(ctx, log), method, req)

			attrs := []any{"tool", tool, "duration_ms", now().Sub(start).Milliseconds()}
			if r, ok := res.(*mcp.CallToolResult); ok && r != nil {
				attrs = append(attrs, "is_error", r.IsError)
				if r.IsError {
					attrs = append(attrs, "code", errorCode(r))
				}
			} else {
				attrs = append(attrs, "is_error", true, "code", failureCode(ctx, err))
			}
			log.InfoContext(ctx, "tool_call", attrs...)
			return res, err
		}
	}
}

// errorCode extracts only the code of a coach error. Errors produced by the SDK
// itself (input validation, unknown tool) carry plain text and log as sdk_error.
func errorCode(r *mcp.CallToolResult) string {
	var we coach.WireError
	if errors.As(r.GetError(), &we) {
		return string(we.Code)
	}
	for _, c := range r.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			var payload struct {
				Code string `json:"code"`
			}
			if json.Unmarshal([]byte(tc.Text), &payload) == nil && payload.Code != "" {
				return payload.Code
			}
		}
	}
	return "sdk_error"
}

// failureCode classifies a call that produced no result at all.
func failureCode(ctx context.Context, err error) string {
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		return "canceled"
	}
	return "protocol_error"
}

// maxEchoedError bounds SDK validation text copied into an error message: it
// can quote the arguments the client sent.
const maxEchoedError = 500

// toolErrorContract rewrites the errors the SDK produces before a handler runs
// (argument validation and decoding) into the coach contract, so every tool
// error is JSON {code,message,hint}. Handler errors already are: tools.Register
// sends them as coach.WireError, so any other error result is an input problem.
func toolErrorContract() mcp.Middleware {
	return func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			res, err := next(ctx, method, req)
			r, ok := res.(*mcp.CallToolResult)
			if method != "tools/call" || !ok || r == nil || !r.IsError {
				return res, err
			}
			var we coach.WireError
			if errors.As(r.GetError(), &we) {
				return res, err
			}
			msg := "the arguments do not match the tool's input schema"
			if len(r.Content) > 0 {
				if tc, ok := r.Content[0].(*mcp.TextContent); ok && tc.Text != "" {
					msg = tc.Text
				}
			}
			fixed := &mcp.CallToolResult{}
			fixed.SetError(coach.WireError{ToolError: coach.ToolError{
				Code: coach.CodeInvalidInput, Message: capEchoed(msg), Hint: "check the tool's input schema and retry",
			}})
			return fixed, err
		}
	}
}

// capEchoed bounds msg to maxEchoedError bytes, cutting at a rune boundary so
// an accented character is never split.
func capEchoed(msg string) string {
	if len(msg) <= maxEchoedError {
		return msg
	}
	cut := maxEchoedError
	for cut > 0 && !utf8.RuneStart(msg[cut]) {
		cut--
	}
	return msg[:cut] + "…"
}
