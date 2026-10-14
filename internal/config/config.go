// Package config loads runtime settings from the environment.
package config

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultTimeZone = "America/Sao_Paulo"
	appName         = "health-coach-mcp"
)

// Config holds every setting the server reads at startup.
type Config struct {
	// TimeZone defines what a "day" means: every daily aggregate is bucketed by local midnight.
	TimeZone *time.Location
	// DataDir holds the SQLite store (coach memory and cache).
	DataDir string
	// ConfigDir holds the OAuth client secret and token.
	ConfigDir string
	// HTTPToken is the bearer token required when the HTTP transport binds beyond loopback.
	HTTPToken string
}

// Load reads HCM_TZ, HCM_DATA_DIR, HCM_CONFIG_DIR and HCM_HTTP_TOKEN, applying defaults.
// getenv and homeDir are injected so tests do not depend on the real environment.
func Load(getenv func(string) string, homeDir func() (string, error)) (Config, error) {
	home, err := homeDir()
	if err != nil {
		return Config{}, fmt.Errorf("resolve home dir: %w", err)
	}

	tzName := or(getenv("HCM_TZ"), defaultTimeZone)
	loc, err := time.LoadLocation(tzName)
	if err != nil {
		return Config{}, fmt.Errorf("HCM_TZ %q: %w", tzName, err)
	}

	return Config{
		TimeZone:  loc,
		DataDir:   expandHome(or(getenv("HCM_DATA_DIR"), filepath.Join("~", ".local", "share", appName)), home),
		ConfigDir: expandHome(or(getenv("HCM_CONFIG_DIR"), filepath.Join("~", ".config", appName)), home),
		HTTPToken: getenv("HCM_HTTP_TOKEN"),
	}, nil
}

func or(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func expandHome(p, home string) string {
	if p == "~" {
		return home
	}
	if rest, ok := strings.CutPrefix(p, "~/"); ok {
		return filepath.Join(home, rest)
	}
	return p
}
