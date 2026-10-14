package config

import (
	"errors"
	"strings"
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

func TestLoadOverrides(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"HCM_TZ":         "UTC",
		"HCM_DATA_DIR":   "~/data",
		"HCM_CONFIG_DIR": "/etc/hcm",
		"HCM_HTTP_TOKEN": "s3cret\n",
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
		t.Errorf("HTTPToken = %q, want surrounding whitespace trimmed", cfg.HTTPToken)
	}
}

func TestLoadDirs(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"~", "/home/test", true},
		{"~/", "/home/test", true},
		{"~/a/../b", "/home/test/b", true},
		{"/abs/~/x", "/abs/~/x", true},
		{"~user/x", "", false},
		{"~foo", "", false},
		{"data", "", false},
		{"./data", "", false},
	}
	for _, key := range []string{"HCM_DATA_DIR", "HCM_CONFIG_DIR"} {
		for _, c := range cases {
			cfg, err := Load(env(map[string]string{key: c.in}), home)
			if (err == nil) != c.ok {
				t.Errorf("%s=%q err = %v, want ok=%v", key, c.in, err, c.ok)
				continue
			}
			if !c.ok {
				if !strings.Contains(err.Error(), key) {
					t.Errorf("%s=%q error %q does not name the variable", key, c.in, err)
				}
				continue
			}
			got := cfg.DataDir
			if key == "HCM_CONFIG_DIR" {
				got = cfg.ConfigDir
			}
			if got != c.want {
				t.Errorf("%s=%q → %q, want %q", key, c.in, got, c.want)
			}
		}
	}
}

func TestLoadRejectsBadTimeZones(t *testing.T) {
	for _, tz := range []string{"Mars/Olympus", "Local", "local", " "} {
		_, err := Load(env(map[string]string{"HCM_TZ": tz}), home)
		if err == nil {
			t.Errorf("HCM_TZ=%q accepted", tz)
			continue
		}
		if !strings.Contains(err.Error(), "HCM_TZ") {
			t.Errorf("HCM_TZ=%q error %q does not name the variable", tz, err)
		}
	}
}

func TestLoadPropagatesHomeError(t *testing.T) {
	noHome := func() (string, error) { return "", errors.New("no home") }
	if _, err := Load(env(nil), noHome); err == nil {
		t.Fatal("expected error when home dir is unavailable")
	}
}
