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
	"path/filepath"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/config"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth/auth"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/server"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

type options struct {
	transport, addr string
	tlsCert, tlsKey string
}

func main() {
	// Subcommands come before the server flags, which they do not accept.
	if len(os.Args) > 1 && os.Args[1] == "auth" {
		os.Exit(authMain(os.Args[2:]))
	}
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

func serve(ctx context.Context, cfg config.Config, o options, log *slog.Logger) (err error) {
	// Validate every option before touching disk, so a typo in a flag never
	// creates the store.
	exposed, err := validate(cfg, o)
	if err != nil {
		return err
	}

	st, err := store.Open(ctx, filepath.Join(cfg.DataDir, "coach.db"), time.Now)
	if err != nil && ctx.Err() != nil {
		// A signal during startup is a normal shutdown. SQLite may report the
		// interrupted migration as its own error rather than context.Canceled;
		// its type is logged in case the failure was real and only coincided.
		log.Info("store open interrupted by shutdown", "error_types", coach.ErrorTypes(err))
		return nil
	}
	if err != nil {
		return err
	}
	defer func() {
		// The last close checkpoints the WAL; a failure there must not be silent.
		if cerr := st.Close(); cerr != nil {
			err = errors.Join(err, fmt.Errorf("close store: %w", cerr))
		}
	}()

	health, err := newHealth(ctx, cfg, st, log)
	if err != nil {
		return err
	}
	s, err := server.New(server.Deps{Cfg: cfg, Now: time.Now, Logger: log, Store: st, Health: health})
	if err != nil {
		return err
	}

	if o.transport == "stdio" {
		// A signal cancels ctx; that is a normal shutdown, not a failure.
		if err := s.Run(ctx, &mcp.StdioTransport{}); err != nil && !errors.Is(err, context.Canceled) {
			return err
		}
		return nil
	}
	return serveHTTP(ctx, s, cfg, o, exposed, log)
}

// newHealth reads nothing at startup: the OAuth client and sign-in load on the
// first Google Health call, so the memory tools work before setup is done.
func newHealth(ctx context.Context, cfg config.Config, st *store.Store, log *slog.Logger) (*healthdata.Data, error) {
	ts, err := auth.NewLazyTokenSource(ctx, cfg.ConfigDir, auth.Endpoint, log)
	if err != nil {
		return nil, err
	}
	api, err := googlehealth.New(ts, googlehealth.Options{TimeZone: cfg.TimeZone, Logger: log})
	if err != nil {
		return nil, err
	}
	return healthdata.New(api, st, cfg.TimeZone, time.Now, log)
}

// validate checks the options and reports whether HTTP would be exposed beyond loopback.
func validate(cfg config.Config, o options) (exposed bool, err error) {
	if cfg.TimeZone == nil {
		return false, errors.New("config: TimeZone is required")
	}
	if !filepath.IsAbs(cfg.DataDir) {
		return false, fmt.Errorf("config: DataDir %q must be an absolute path", cfg.DataDir)
	}
	if !filepath.IsAbs(cfg.ConfigDir) {
		return false, fmt.Errorf("config: ConfigDir %q must be an absolute path", cfg.ConfigDir)
	}
	switch o.transport {
	case "stdio":
		return false, nil
	case "http":
		if (o.tlsCert == "") != (o.tlsKey == "") {
			return false, errors.New("-tls-cert and -tls-key must be set together")
		}
		return server.CheckHTTPBind(o.addr, cfg.HTTPToken)
	default:
		return false, fmt.Errorf("unknown transport %q (want stdio or http)", o.transport)
	}
}

func serveHTTP(ctx context.Context, s *mcp.Server, cfg config.Config, o options, exposed bool, log *slog.Logger) error {
	useTLS := o.tlsCert != ""
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
	if err := srv.Shutdown(shutdownCtx); err != nil {
		if !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		// Streams still open at the deadline are cut so no handler outlives the store.
		log.Warn("shutdown deadline reached; closing remaining connections")
		_ = srv.Close()
	}
	if err := <-serveErr; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
