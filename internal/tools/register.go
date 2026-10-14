package tools

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// Handler is a tool body: it returns the output or an error, never a raw result.
type Handler[In, Out any] func(ctx context.Context, req *mcp.CallToolRequest, in In) (Out, error)

// Register adds a typed tool. Every tool goes through it (never mcp.AddTool
// directly) because it guarantees the error contract:
//   - any error reaches the client as the JSON {code,message,hint}; errors that
//     are not coach.ToolError become internal_error, so their text (which may
//     carry health values) is never sent or logged;
//   - errors skip output-schema validation, which a zero Envelope would fail;
//   - a panic becomes internal_error instead of killing the process, since the
//     SDK runs handlers without recover.
//
// When t.InputSchema is nil it is inferred with the domain schemas (date pattern).
func Register[In, Out any](s *mcp.Server, t *mcp.Tool, h Handler[In, Out]) {
	tt := *t
	if tt.InputSchema == nil {
		tt.InputSchema = MustInputSchema[In](nil)
	}
	mcp.AddTool(s, &tt, func(ctx context.Context, req *mcp.CallToolRequest, in In) (res *mcp.CallToolResult, out Out, err error) {
		defer func() {
			if r := recover(); r != nil {
				var zero Out
				res, out, err = nil, zero, coach.ToWire(nil)
			}
		}()
		out, err = h(ctx, req, in)
		if err != nil {
			var zero Out
			return nil, zero, coach.ToWire(err)
		}
		return nil, out, nil
	})
}
