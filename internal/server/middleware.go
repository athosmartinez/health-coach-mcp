package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
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
			res, err := next(ctx, method, req)

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
