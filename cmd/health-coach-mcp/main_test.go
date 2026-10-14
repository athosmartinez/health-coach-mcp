package main

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/config"
)

var discard = slog.New(slog.NewTextHandler(io.Discard, nil))

// testConfig keeps the store in a temp dir, never in the working directory.
func testConfig(t *testing.T) config.Config {
	return config.Config{TimeZone: time.UTC, DataDir: t.TempDir()}
}

func TestServeRejectsBadOptions(t *testing.T) {
	cases := map[string]options{
		"unknown transport":   {transport: "grpc"},
		"exposed, no token":   {transport: "http", addr: "0.0.0.0:0"},
		"half TLS config":     {transport: "http", addr: "127.0.0.1:0", tlsCert: "cert.pem"},
		"missing cert files":  {transport: "http", addr: "127.0.0.1:0", tlsCert: "/nonexistent.pem", tlsKey: "/nonexistent.key"},
		"unparseable address": {transport: "http", addr: "nope"},
	}
	for name, o := range cases {
		if err := serve(context.Background(), testConfig(t), o, discard); err == nil {
			t.Errorf("%s: serve returned nil", name)
		}
	}
}

func TestServeRequiresTimeZone(t *testing.T) {
	err := serve(context.Background(), config.Config{DataDir: t.TempDir()}, options{transport: "stdio"}, discard)
	if err == nil || !strings.Contains(err.Error(), "TimeZone") {
		t.Fatalf("err = %v, want missing TimeZone", err)
	}
}

// waitFor polls until cond holds, instead of sleeping a fixed time.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition not met within 10s")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func runUntilCancelled(t *testing.T, cfg config.Config, o options, cancelWhen func() bool) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg, o, discard) }()
	waitFor(t, cancelWhen)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("shutdown returned %v, want nil", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("serve did not return after cancel")
	}
}

func TestServeHTTPShutsDownCleanly(t *testing.T) {
	cfg := testConfig(t)
	runUntilCancelled(t, cfg, options{transport: "http", addr: "127.0.0.1:0"}, func() bool {
		_, err := os.Stat(cfg.DataDir + "/coach.db")
		return err == nil
	})
}

func TestSignalDuringStartupIsCleanShutdown(t *testing.T) {
	// Cancelled before the store finishes opening: still exit 0, not an error.
	runUntilCancelled(t, testConfig(t), options{transport: "http", addr: "127.0.0.1:0"}, func() bool { return true })
}

func TestServeRejectsRelativeDataDir(t *testing.T) {
	err := serve(context.Background(), config.Config{TimeZone: time.UTC, DataDir: "data"}, options{transport: "stdio"}, discard)
	if err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("err = %v, want absolute DataDir required", err)
	}
}

func TestServeFailsWhenStoreCannotOpen(t *testing.T) {
	blocker := t.TempDir() + "/file"
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{TimeZone: time.UTC, DataDir: blocker}
	if err := serve(context.Background(), cfg, options{transport: "stdio"}, discard); err == nil {
		t.Fatal("serve must fail when the store cannot be opened")
	}
}

func TestServeCreatesStoreOnlyForValidOptions(t *testing.T) {
	cfg := testConfig(t)
	for _, o := range []options{
		{transport: "grpc"},
		{transport: "http", addr: "0.0.0.0:0"},
		{transport: "http", addr: "127.0.0.1:0", tlsCert: "c.pem"},
	} {
		if err := serve(context.Background(), cfg, o, discard); err == nil {
			t.Fatalf("%+v accepted", o)
		}
	}
	if _, err := os.Stat(cfg.DataDir + "/coach.db"); !os.IsNotExist(err) {
		t.Fatalf("invalid options created the store (stat err %v)", err)
	}

	created := func() bool {
		_, err := os.Stat(cfg.DataDir + "/coach.db")
		return err == nil
	}
	runUntilCancelled(t, cfg, options{transport: "http", addr: "127.0.0.1:0"}, created)
	if !created() {
		t.Fatal("coach.db not created in DataDir")
	}
}
