// Command health-coach-mcp serves the coach MCP over stdio (local clients)
// or Streamable HTTP (remote agents, cron jobs, chat bridges).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/config"
	"github.com/athosmartinez/health-coach-mcp/internal/server"
)

func main() {
	transport := flag.String("transport", "stdio", "stdio | http")
	addr := flag.String("addr", "127.0.0.1:8787", "listen address for -transport=http")
	flag.Parse()

	// stdout carries the JSON-RPC stream in stdio mode, so logs must go to stderr.
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load(os.Getenv, os.UserHomeDir)
	if err != nil {
		log.Error("invalid configuration", "err", err)
		os.Exit(1)
	}

	if err := run(ctx, cfg, *transport, *addr, log); err != nil {
		log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, cfg config.Config, transport, addr string, log *slog.Logger) error {
	s := server.New(server.Deps{Cfg: cfg, Now: time.Now, Logger: log})

	switch transport {
	case "stdio":
		return s.Run(ctx, &mcp.StdioTransport{})
	case "http":
		if err := server.CheckHTTPBind(addr, cfg.HTTPToken); err != nil {
			return err
		}
		h := server.BearerAuth(cfg.HTTPToken,
			mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, nil))
		srv := &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second}

		go func() {
			<-ctx.Done()
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = srv.Shutdown(shutdownCtx)
		}()

		log.Info("listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	default:
		return fmt.Errorf("unknown transport %q (want stdio or http)", transport)
	}
}
