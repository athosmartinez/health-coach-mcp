// Package server builds the MCP server and registers its tools.
package server

import (
	"context"
	"io"
	"log/slog"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/config"
	"github.com/athosmartinez/health-coach-mcp/internal/version"
)

const Name = "health-coach-mcp"

// Deps is everything tools may need. Later steps add fields (store, health data
// source) when their packages exist; tools whose dependency is nil are not registered.
type Deps struct {
	Cfg    config.Config
	Now    func() time.Time
	Logger *slog.Logger
}

func (d Deps) withDefaults() Deps {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Logger == nil {
		d.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return d
}

// New returns an MCP server with every tool registered. It is transport-agnostic:
// the caller decides whether to serve it over stdio or Streamable HTTP.
// Each feature adds one registerX(s, deps) line here.
func New(deps Deps) *mcp.Server {
	deps = deps.withDefaults()
	s := mcp.NewServer(&mcp.Implementation{Name: Name, Version: version.Version}, nil)
	s.AddReceivingMiddleware(logToolCalls(deps.Logger, deps.Now))

	registerServerInfo(s)

	return s
}

func registerServerInfo(s *mcp.Server) {
	mcp.AddTool(s, &mcp.Tool{
		Name:        "server_info",
		Description: "Returns the server name and version. Use it to check that the coach MCP is reachable.",
	}, serverInfo)
}

type ServerInfoInput struct{}

type ServerInfoOutput struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func serverInfo(_ context.Context, _ *mcp.CallToolRequest, _ ServerInfoInput) (*mcp.CallToolResult, ServerInfoOutput, error) {
	return nil, ServerInfoOutput{Name: Name, Version: version.Version}, nil
}
