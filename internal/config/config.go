// Package config loads runtime settings from the environment.
package config

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"
	// Embedded zone database: minimal containers and Windows have no zoneinfo,
	// and the default zone must load everywhere.
	_ "time/tzdata"
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

	loc, err := loadZone(getenv("HCM_TZ"))
	if err != nil {
		return Config{}, err
	}
	dataDir, err := dir("HCM_DATA_DIR", getenv("HCM_DATA_DIR"), filepath.Join("~", ".local", "share", appName), home)
	if err != nil {
		return Config{}, err
	}
	configDir, err := dir("HCM_CONFIG_DIR", getenv("HCM_CONFIG_DIR"), filepath.Join("~", ".config", appName), home)
	if err != nil {
		return Config{}, err
	}

	return Config{
		TimeZone:  loc,
		DataDir:   dataDir,
		ConfigDir: configDir,
		// Secrets read from files often end in a newline that the client never sends.
		HTTPToken: strings.TrimSpace(getenv("HCM_HTTP_TOKEN")),
	}, nil
}

// loadZone rejects "Local": it makes the meaning of a day depend on the host.
func loadZone(name string) (*time.Location, error) {
	if name == "" {
		name = defaultTimeZone
	}
	if strings.EqualFold(strings.TrimSpace(name), "local") {
		return nil, fmt.Errorf("HCM_TZ %q: use an IANA zone such as %s, not the host zone", name, defaultTimeZone)
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, fmt.Errorf("HCM_TZ %q: %w", name, err)
	}
	return loc, nil
}

// dir expands ~ and requires an absolute result, so the store never lands in
// whatever directory the server was started from (possibly inside a git repo).
func dir(name, v, fallback, home string) (string, error) {
	if v == "" {
		v = fallback
	}
	p := v
	switch {
	case p == "~":
		p = home
	case strings.HasPrefix(p, "~/"):
		p = filepath.Join(home, p[2:])
	case strings.HasPrefix(p, "~"):
		return "", fmt.Errorf("%s %q: ~user paths are not supported", name, v)
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("%s %q: must be an absolute path", name, v)
	}
	return filepath.Clean(p), nil
}
