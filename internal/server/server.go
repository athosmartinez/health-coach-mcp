// Package server builds the MCP server and registers its tools.
package server

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/version"
)

const Name = "health-coach-mcp"

// New returns an MCP server with every tool registered. It is transport-agnostic:
// the caller decides whether to serve it over stdio or Streamable HTTP.
func New() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: Name, Version: version.Version}, nil)

	mcp.AddTool(s, &mcp.Tool{
		Name:        "server_info",
		Description: "Returns the server name and version. Use it to check that the coach MCP is reachable.",
	}, serverInfo)

	return s
}

type ServerInfoInput struct{}

type ServerInfoOutput struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

func serverInfo(_ context.Context, _ *mcp.CallToolRequest, _ ServerInfoInput) (*mcp.CallToolResult, ServerInfoOutput, error) {
	return nil, ServerInfoOutput{Name: Name, Version: version.Version}, nil
}
