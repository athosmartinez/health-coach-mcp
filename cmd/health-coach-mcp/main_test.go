package main

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/config"
)

var (
	discard = slog.New(slog.NewTextHandler(io.Discard, nil))
	testCfg = config.Config{TimeZone: time.UTC}
)

func TestServeRejectsBadOptions(t *testing.T) {
	cases := map[string]options{
		"unknown transport":   {transport: "grpc"},
		"exposed, no token":   {transport: "http", addr: "0.0.0.0:0"},
		"half TLS config":     {transport: "http", addr: "127.0.0.1:0", tlsCert: "cert.pem"},
		"missing cert files":  {transport: "http", addr: "127.0.0.1:0", tlsCert: "/nonexistent.pem", tlsKey: "/nonexistent.key"},
		"unparseable address": {transport: "http", addr: "nope"},
	}
	for name, o := range cases {
		if err := serve(context.Background(), testCfg, o, discard); err == nil {
			t.Errorf("%s: serve returned nil", name)
		}
	}
}

func TestServeRequiresTimeZone(t *testing.T) {
	err := serve(context.Background(), config.Config{}, options{transport: "stdio"}, discard)
	if err == nil || !strings.Contains(err.Error(), "TimeZone") {
		t.Fatalf("err = %v, want missing TimeZone", err)
	}
}

func TestServeHTTPShutsDownCleanly(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serve(ctx, testCfg, options{transport: "http", addr: "127.0.0.1:0"}, discard) }()

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
