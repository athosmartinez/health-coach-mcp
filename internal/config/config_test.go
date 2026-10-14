package config

import (
	"errors"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func home() (string, error) { return "/home/test", nil }

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(nil), home)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := cfg.TimeZone.String(); got != "America/Sao_Paulo" {
		t.Errorf("TimeZone = %q, want America/Sao_Paulo", got)
	}
	if cfg.DataDir != "/home/test/.local/share/health-coach-mcp" {
		t.Errorf("DataDir = %q", cfg.DataDir)
	}
	if cfg.ConfigDir != "/home/test/.config/health-coach-mcp" {
		t.Errorf("ConfigDir = %q", cfg.ConfigDir)
	}
	if cfg.HTTPToken != "" {
		t.Errorf("HTTPToken = %q, want empty", cfg.HTTPToken)
	}
}

func TestLoadOverridesAndTildeExpansion(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"HCM_TZ":         "UTC",
		"HCM_DATA_DIR":   "~/data",
		"HCM_CONFIG_DIR": "/etc/hcm",
		"HCM_HTTP_TOKEN": "s3cret",
	}), home)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.TimeZone.String() != "UTC" {
		t.Errorf("TimeZone = %q", cfg.TimeZone)
	}
	if cfg.DataDir != "/home/test/data" {
		t.Errorf("DataDir = %q, want ~ expanded", cfg.DataDir)
	}
	if cfg.ConfigDir != "/etc/hcm" {
		t.Errorf("ConfigDir = %q", cfg.ConfigDir)
	}
	if cfg.HTTPToken != "s3cret" {
		t.Errorf("HTTPToken = %q", cfg.HTTPToken)
	}
}

func TestLoadRejectsInvalidTimeZone(t *testing.T) {
	if _, err := Load(env(map[string]string{"HCM_TZ": "Mars/Olympus"}), home); err == nil {
		t.Fatal("expected error for unknown time zone")
	}
}

func TestLoadPropagatesHomeError(t *testing.T) {
	noHome := func() (string, error) { return "", errors.New("no home") }
	if _, err := Load(env(nil), noHome); err == nil {
		t.Fatal("expected error when home dir is unavailable")
	}
}
