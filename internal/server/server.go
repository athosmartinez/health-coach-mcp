// Package server builds the MCP server and registers its tools.
package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/config"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
	"github.com/athosmartinez/health-coach-mcp/internal/tools"
	"github.com/athosmartinez/health-coach-mcp/internal/version"
)

const Name = "health-coach-mcp"

// Deps is everything tools may need. Later steps add fields (store, health data
// source) when their packages exist; New registers a tool only when its
// dependencies are set.
type Deps struct {
	Cfg    config.Config
	Now    func() time.Time
	Logger *slog.Logger
	// Store holds the coach memory and metrics cache; memory tools need it.
	Store *store.Store
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

func (d Deps) validate() error {
	// No default zone: a silent fallback would shift every daily aggregate.
	if d.Cfg.TimeZone == nil {
		return errors.New("server: Deps.Cfg.TimeZone is required")
	}
	return nil
}

// New returns an MCP server with every tool registered. It is transport-agnostic:
// the caller decides whether to serve it over stdio or Streamable HTTP.
// Each feature adds one registerX(s, deps) line here.
func New(deps Deps) (*mcp.Server, error) {
	deps = deps.withDefaults()
	if err := deps.validate(); err != nil {
		return nil, err
	}
	s := mcp.NewServer(&mcp.Implementation{Name: Name, Version: version.Version}, nil)
	// Applied right to left: the contract fixes errors before logging sees their code.
	s.AddReceivingMiddleware(logToolCalls(deps.Logger, deps.Now), toolErrorContract())

	registerServerInfo(s)
	if deps.Store != nil {
		tools.RegisterMemory(s, tools.MemoryDeps{Store: deps.Store, Now: deps.Now, Loc: deps.Cfg.TimeZone})
	}

	return s, nil
}

func registerServerInfo(s *mcp.Server) {
	tools.Register(s, &mcp.Tool{
		Name:        "server_info",
		Description: "Returns the server name and version. Use it to check that the coach MCP is reachable.",
	}, serverInfo)
}

type ServerInfoInput struct{}

type ServerInfoOutput struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func serverInfo(_ context.Context, _ *mcp.CallToolRequest, _ ServerInfoInput) (ServerInfoOutput, error) {
	return ServerInfoOutput{Name: Name, Version: version.Version}, nil
}
