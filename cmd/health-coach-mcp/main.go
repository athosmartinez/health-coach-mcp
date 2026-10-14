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

type options struct {
	transport, addr string
	tlsCert, tlsKey string
}

func main() {
	var o options
	flag.StringVar(&o.transport, "transport", "stdio", "stdio | http")
	flag.StringVar(&o.addr, "addr", "127.0.0.1:8787", "listen address for -transport=http")
	flag.StringVar(&o.tlsCert, "tls-cert", "", "TLS certificate file for -transport=http")
	flag.StringVar(&o.tlsKey, "tls-key", "", "TLS key file for -transport=http")
	flag.Parse()
	os.Exit(run(o))
}

// run returns the exit code, so deferred cleanup runs before os.Exit.
func run(o options) int {
	// stdout carries the JSON-RPC stream in stdio mode, so logs must go to stderr.
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load(os.Getenv, os.UserHomeDir)
	if err != nil {
		log.Error("invalid configuration", "err", err)
		return 1
	}
	if err := serve(ctx, cfg, o, log); err != nil {
		log.Error("server stopped", "err", err)
		return 1
	}
	return 0
}

func serve(ctx context.Context, cfg config.Config, o options, log *slog.Logger) error {
	s, err := server.New(server.Deps{Cfg: cfg, Now: time.Now, Logger: log})
	if err != nil {
		return err
	}

	switch o.transport {
	case "stdio":
		// A signal cancels ctx; that is a normal shutdown, not a failure.
		if err := s.Run(ctx, &mcp.StdioTransport{}); err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
		return nil
	case "http":
		return serveHTTP(ctx, s, cfg, o, log)
	default:
		return fmt.Errorf("unknown transport %q (want stdio or http)", o.transport)
	}
}

func serveHTTP(ctx context.Context, s *mcp.Server, cfg config.Config, o options, log *slog.Logger) error {
	if (o.tlsCert == "") != (o.tlsKey == "") {
		return errors.New("-tls-cert and -tls-key must be set together")
	}
	useTLS := o.tlsCert != ""

	exposed, err := server.CheckHTTPBind(o.addr, cfg.HTTPToken)
	if err != nil {
		return err
	}
	if exposed && !useTLS {
		log.Warn("serving health data over plain HTTP beyond loopback; the bearer token and responses can be sniffed on the network. Use -tls-cert/-tls-key, a TLS proxy or a private tunnel")
	}

	srv := server.NewHTTPServer(o.addr, s, cfg.HTTPToken, log)
	serveErr := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", o.addr, "tls", useTLS)
		if useTLS {
			serveErr <- srv.ListenAndServeTLS(o.tlsCert, o.tlsKey)
		} else {
			serveErr <- srv.ListenAndServe()
		}
	}()

	select {
	case err := <-serveErr:
		return err // failed to start (port in use, bad cert)
	case <-ctx.Done():
	}

	// Wait for in-flight requests; long-lived SSE streams are cut at the deadline.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
