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

	if err := run(ctx, *transport, *addr, log); err != nil {
		log.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, transport, addr string, log *slog.Logger) error {
	s := server.New()

	switch transport {
	case "stdio":
		return s.Run(ctx, &mcp.StdioTransport{})
	case "http":
		// No auth yet: keep the default loopback bind until an auth layer exists.
		h := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s }, nil)
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
