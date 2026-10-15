// Package auth signs in to the Google Health API with an OAuth Desktop client
// and keeps the token fresh in <ConfigDir>/credentials.json.
package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"slices"

	"golang.org/x/oauth2"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// File names inside the config directory.
const (
	ClientSecretFile = "client_secret.json"
	CredentialsFile  = "credentials.json"
)

// LoginCommand is what the user runs to sign in again; error hints quote it.
const LoginCommand = "health-coach-mcp auth login"

const scopePrefix = "https://www.googleapis.com/auth/googlehealth."

// Scopes are the read-only Google Health scopes the coach asks for. No write
// scope is ever requested.
var Scopes = []string{
	scopePrefix + "activity_and_fitness.readonly",
	scopePrefix + "health_metrics_and_measurements.readonly",
	scopePrefix + "sleep.readonly",
	scopePrefix + "nutrition.readonly",
	scopePrefix + "profile.readonly",
	scopePrefix + "settings.readonly",
	scopePrefix + "location.readonly",
	scopePrefix + "ecg.readonly",
	scopePrefix + "irn.readonly",
}

// Endpoint is Google's OAuth endpoint. Client credentials go in the request
// body: Google accepts both styles, and a fixed style avoids the extra probe
// request oauth2 sends when it has to guess.
var Endpoint = oauth2.Endpoint{
	AuthURL:   "https://accounts.google.com/o/oauth2/v2/auth",
	TokenURL:  "https://oauth2.googleapis.com/token",
	AuthStyle: oauth2.AuthStyleInParams,
}

// LoadConfig reads the Desktop client JSON downloaded from the Cloud console
// and returns an oauth2 config with the coach scopes. RedirectURL stays empty:
// Login sets it to its own loopback port.
func LoadConfig(path string, endpoint oauth2.Endpoint) (*oauth2.Config, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, coach.ToolError{
			Code:    coach.CodeAuthExpired,
			Message: "no OAuth client is configured",
			Hint:    fmt.Sprintf("save the Desktop app client JSON from the Cloud console as %s, then run %s", path, LoginCommand),
		}
	}
	if err != nil {
		return nil, fmt.Errorf("read OAuth client: %w", err)
	}
	// Only the fields are read; the file content never goes into an error.
	var file struct {
		Installed *struct {
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
		} `json:"installed"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("parse OAuth client %s: not valid JSON", path)
	}
	if file.Installed == nil || file.Installed.ClientID == "" {
		return nil, fmt.Errorf("OAuth client %s is not a Desktop app client (no \"installed\" client_id)", path)
	}
	return &oauth2.Config{
		ClientID:     file.Installed.ClientID,
		ClientSecret: file.Installed.ClientSecret,
		Endpoint:     endpoint,
		Scopes:       slices.Clone(Scopes),
	}, nil
}

// MissingScopes lists the coach scopes not in granted, in Scopes order. Google
// lets the user untick scopes on the consent screen.
func MissingScopes(granted []string) []string {
	var missing []string
	for _, s := range Scopes {
		if !slices.Contains(granted, s) {
			missing = append(missing, s)
		}
	}
	return missing
}
