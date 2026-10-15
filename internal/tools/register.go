package tools

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"runtime/debug"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// Handler is a tool body: it returns the output or an error, never a raw result.
type Handler[In, Out any] func(ctx context.Context, req *mcp.CallToolRequest, in In) (Out, error)

// Register adds a typed tool. Every tool goes through it (never mcp.AddTool
// directly) because it guarantees the error contract:
//   - any error reaches the client as the JSON {code,message,hint}; errors that
//     are not coach.ToolError become internal_error, so their text (which may
//     carry health values) is never sent or logged. Internal errors are logged
//     with the tool name and the error's type chain, panics with the stack;
//   - errors skip output-schema validation, which a zero Envelope would fail;
//   - a panic becomes internal_error instead of killing the process, since the
//     SDK runs handlers without recover.
//
// Nil input and output schemas are inferred with the domain schemas (date
// pattern, raw JSON as any value).
func Register[In, Out any](s *mcp.Server, t *mcp.Tool, h Handler[In, Out]) {
	tt := *t
	if tt.InputSchema == nil {
		tt.InputSchema = MustInputSchema[In](nil)
	}
	if tt.OutputSchema == nil {
		out, err := OutputSchema[Out]()
		if err != nil {
			panic(fmt.Errorf("tool %s: %w", t.Name, err)) // static definition: caught by registration tests
		}
		tt.OutputSchema = out
	}
	mcp.AddTool(s, &tt, func(ctx context.Context, req *mcp.CallToolRequest, in In) (res *mcp.CallToolResult, out Out, err error) {
		defer func() {
			if r := recover(); r != nil {
				// The panic value may quote data: only its type and the stack are logged.
				loggerFrom(ctx).ErrorContext(ctx, "tool_panic", "tool", tt.Name,
					"panic_type", fmt.Sprintf("%T", r), "stack", string(debug.Stack()))
				var zero Out
				res, out, err = nil, zero, coach.ToWire(nil)
			}
		}()
		out, err = h(ctx, req, in)
		if err != nil {
			wire := coach.ToWire(err)
			if wire.Code == coach.CodeInternal {
				loggerFrom(ctx).ErrorContext(ctx, "tool_internal_error", "tool", tt.Name, "error_types", errorTypes(err))
			}
			var zero Out
			return nil, zero, wire
		}
		return nil, out, nil
	})
}

type loggerKey struct{}

// WithLogger returns ctx carrying the logger Register uses for internal errors
// and panics; the server's tool-call middleware sets it.
func WithLogger(ctx context.Context, log *slog.Logger) context.Context {
	return context.WithValue(ctx, loggerKey{}, log)
}

var discardLogger = slog.New(slog.NewTextHandler(io.Discard, nil))

func loggerFrom(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(loggerKey{}).(*slog.Logger); ok && l != nil {
		return l
	}
	return discardLogger
}

// errorTypes names the types along an error chain ("*fmt.wrapError > *sqlite.Error"):
// enough to tell a database fault from a bug without logging any message text.
func errorTypes(err error) string {
	var types []string
	for err != nil && len(types) < 8 {
		types = append(types, fmt.Sprintf("%T", err))
		switch u := err.(type) {
		case interface{ Unwrap() []error }:
			if errs := u.Unwrap(); len(errs) > 0 {
				err = errs[0]
				continue
			}
			err = nil
		default:
			err = errors.Unwrap(err)
		}
	}
	return strings.Join(types, " > ")
}
