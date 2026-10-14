package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// logToolCalls records one line per tools/call with only the tool name, duration
// and outcome. Arguments and results are never logged: both carry health data.
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
			switch r := res.(type) {
			case *mcp.CallToolResult:
				attrs = append(attrs, "is_error", r.IsError)
				if r.IsError {
					attrs = append(attrs, "code", errorCode(r))
				}
			case nil:
				attrs = append(attrs, "is_error", true, "code", "protocol_error")
			}
			log.InfoContext(ctx, "tool_call", attrs...)
			return res, err
		}
	}
}

// errorCode extracts only the code field of a coach error payload.
func errorCode(r *mcp.CallToolResult) string {
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
	return "unknown"
}
