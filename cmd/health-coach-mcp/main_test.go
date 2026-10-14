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

func TestServeHTTPShutsDownCleanly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	cfg := testConfig(t)
	go func() { done <- serve(ctx, cfg, options{transport: "http", addr: "127.0.0.1:0"}, discard) }()

	time.Sleep(100 * time.Millisecond)
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

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg, options{transport: "http", addr: "127.0.0.1:0"}, discard) }()
	time.Sleep(100 * time.Millisecond)
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cfg.DataDir + "/coach.db"); err != nil {
		t.Fatalf("coach.db not created in DataDir: %v", err)
	}
}
