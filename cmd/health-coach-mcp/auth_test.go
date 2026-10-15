package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"

	"github.com/athosmartinez/health-coach-mcp/internal/config"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth/auth"
)

var authNow = time.Date(2026, 10, 15, 13, 0, 0, 0, time.UTC)

type authRun struct {
	code           int
	stdout, stderr string
}

func runAuthTest(t *testing.T, cfg config.Config, env authEnv, args ...string) authRun {
	t.Helper()
	var out, errOut strings.Builder
	env.stdout, env.stderr = &out, &errOut
	if env.now == nil {
		env.now = func() time.Time { return authNow }
	}
	code := runAuth(context.Background(), args, cfg, env)
	return authRun{code, out.String(), errOut.String()}
}

func authConfig(t *testing.T) config.Config {
	t.Helper()
	cfg := testConfig(t)
	cfg.ConfigDir = filepath.Join(t.TempDir(), "config")
	sp, _ := time.LoadLocation("America/Sao_Paulo")
	cfg.TimeZone = sp
	return cfg
}

// fakeTokenEndpoint grants the given scopes on a code exchange.
func fakeTokenEndpoint(t *testing.T, scopes []string) oauth2.Endpoint {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.PostForm.Get("code") != "code-synthetic" || r.PostForm.Get("code_verifier") == "" {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-cli-synthetic", "refresh_token": "rt-cli-synthetic", "expires_in": 3600, "scope": strings.Join(scopes, " "),
		})
	}))
	t.Cleanup(srv.Close)
	return oauth2.Endpoint{AuthURL: "https://accounts.invalid/auth", TokenURL: srv.URL, AuthStyle: oauth2.AuthStyleInParams}
}

// approve plays the user granting consent in the browser.
func approve(t *testing.T) func(string) error {
	return func(consent string) error {
		u, err := url.Parse(consent)
		if err != nil {
			return err
		}
		q := u.Query()
		go func() {
			resp, err := http.Get(q.Get("redirect_uri") + "?" + url.Values{"code": {"code-synthetic"}, "state": {q.Get("state")}}.Encode())
			if err != nil {
				t.Errorf("redirect: %v", err)
				return
			}
			resp.Body.Close()
		}()
		return nil
	}
}

func writeClientSecret(t *testing.T, cfg config.Config) {
	t.Helper()
	if err := os.MkdirAll(cfg.ConfigDir, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := `{"installed": {"client_id": "id-synthetic", "client_secret": "secret-synthetic"}}`
	if err := os.WriteFile(filepath.Join(cfg.ConfigDir, auth.ClientSecretFile), []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestAuthLoginThenStatus(t *testing.T) {
	cfg := authConfig(t)
	writeClientSecret(t, cfg)
	env := authEnv{endpoint: fakeTokenEndpoint(t, auth.Scopes), open: approve(t)}

	r := runAuthTest(t, cfg, env, "login")
	if r.code != 0 || !strings.Contains(r.stdout, "Signed in") || strings.Contains(r.stdout, "did not grant") {
		t.Fatalf("login = %+v", r)
	}
	path := filepath.Join(cfg.ConfigDir, auth.CredentialsFile)
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("credentials file: %v, %v", fi, err)
	}
	c, err := auth.ReadCredentials(path)
	if err != nil || c.RefreshToken != "rt-cli-synthetic" || !c.LoginAt.Equal(authNow) {
		t.Fatalf("saved credentials = %+v, %v", c, err)
	}

	r = runAuthTest(t, cfg, env, "status")
	if r.code != 0 {
		t.Fatalf("status = %+v", r)
	}
	for _, want := range []string{
		path, "Signed in:     2026-10-15 10:00 -03", "9 of 9 granted", "Refresh token: present",
		"around 2026-10-22 10:00 -03", auth.LoginCommand,
	} {
		if !strings.Contains(r.stdout, want) {
			t.Errorf("status is missing %q:\n%s", want, r.stdout)
		}
	}
	for _, out := range []string{r.stdout, r.stderr} {
		if strings.Contains(out, "at-cli-synthetic") || strings.Contains(out, "rt-cli-synthetic") || strings.Contains(out, "secret-synthetic") {
			t.Errorf("a secret reached the output:\n%s", out)
		}
	}
}

func TestAuthLoginReportsUngrantedScopes(t *testing.T) {
	cfg := authConfig(t)
	writeClientSecret(t, cfg)
	env := authEnv{endpoint: fakeTokenEndpoint(t, auth.Scopes[2:]), open: approve(t)}
	r := runAuthTest(t, cfg, env, "login")
	if r.code != 0 || !strings.Contains(r.stdout, "did not grant activity_and_fitness, health_metrics_and_measurements") {
		t.Fatalf("login = %+v", r)
	}
	r = runAuthTest(t, cfg, env, "status")
	if !strings.Contains(r.stdout, "7 of 9 granted (missing: activity_and_fitness, health_metrics_and_measurements)") {
		t.Errorf("status:\n%s", r.stdout)
	}
}

func TestAuthStatusEdgeCases(t *testing.T) {
	cfg := authConfig(t)
	r := runAuthTest(t, cfg, authEnv{}, "status")
	if r.code != 1 || !strings.Contains(r.stderr, "not signed in") || !strings.Contains(r.stderr, auth.LoginCommand) {
		t.Errorf("status before login = %+v", r)
	}
	path := filepath.Join(cfg.ConfigDir, auth.CredentialsFile)
	// A valid access token, shown in the configured zone.
	if err := auth.WriteCredentials(path, auth.Credentials{
		AccessToken: "at-synthetic", RefreshToken: "rt-synthetic", Expiry: authNow.Add(time.Hour), Scopes: auth.Scopes, LoginAt: authNow,
	}); err != nil {
		t.Fatal(err)
	}
	if r = runAuthTest(t, cfg, authEnv{}, "status"); !strings.Contains(r.stdout, "valid until 2026-10-15 11:00 -03") {
		t.Errorf("valid token status:\n%s", r.stdout)
	}
	// An expired access token, no login time and no client secret.
	if err := auth.WriteCredentials(path, auth.Credentials{
		AccessToken: "at-synthetic", RefreshToken: "rt-synthetic", Expiry: authNow.Add(-time.Minute), Scopes: auth.Scopes,
	}); err != nil {
		t.Fatal(err)
	}
	r = runAuthTest(t, cfg, authEnv{}, "status")
	for _, want := range []string{"expired (renewed on the next call)", "Signed in:     unknown", "missing client_secret.json"} {
		if r.code != 0 || !strings.Contains(r.stdout, want) {
			t.Errorf("status is missing %q: %+v", want, r)
		}
	}
	if strings.Contains(r.stdout, "Testing mode") {
		t.Errorf("no login time, but a Testing-mode date is shown:\n%s", r.stdout)
	}
}

func TestAuthCommandErrors(t *testing.T) {
	cfg := authConfig(t)
	for _, args := range [][]string{nil, {"logout"}, {"login", "extra"}} {
		if r := runAuthTest(t, cfg, authEnv{}, args...); r.code != 2 || !strings.Contains(r.stderr, "usage:") {
			t.Errorf("auth %v = %+v, want usage and exit 2", args, r)
		}
	}
	r := runAuthTest(t, cfg, authEnv{endpoint: auth.Endpoint}, "login")
	if r.code != 1 || !strings.Contains(r.stderr, "no OAuth client is configured") || !strings.Contains(r.stderr, "hint:") {
		t.Errorf("login without a client = %+v", r)
	}
	if _, err := os.Stat(filepath.Join(cfg.ConfigDir, auth.CredentialsFile)); !os.IsNotExist(err) {
		t.Errorf("a failed login wrote credentials: %v", err)
	}
}
