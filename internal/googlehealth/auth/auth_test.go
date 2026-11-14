package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// fakeGoogle is a token endpoint. Each test sets the responses it needs.
type fakeGoogle struct {
	*httptest.Server
	requests atomic.Int32
	mu       sync.Mutex
	last     url.Values
	// respond writes the response to a token request; the default renews with
	// a new access token and no refresh token, as Google does.
	respond func(w http.ResponseWriter, form url.Values)
}

func newFakeGoogle(t *testing.T) *fakeGoogle {
	t.Helper()
	g := &fakeGoogle{}
	g.respond = func(w http.ResponseWriter, _ url.Values) {
		writeJSON(w, http.StatusOK, map[string]any{"access_token": fmt.Sprintf("at-%d", g.requests.Load()), "token_type": "Bearer", "expires_in": 3600})
	}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.requests.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/token" {
			http.Error(w, "unexpected", http.StatusNotFound)
			return
		}
		if err := r.ParseForm(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		g.mu.Lock()
		g.last = r.PostForm
		respond := g.respond
		g.mu.Unlock()
		respond(w, r.PostForm)
	}))
	t.Cleanup(g.Close)
	return g
}

func (g *fakeGoogle) setRespond(f func(w http.ResponseWriter, form url.Values)) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.respond = f
}

func (g *fakeGoogle) lastForm() url.Values {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.last
}

func (g *fakeGoogle) config() *oauth2.Config {
	return &oauth2.Config{
		ClientID: "client-synthetic", ClientSecret: "secret-synthetic", Scopes: Scopes,
		Endpoint: oauth2.Endpoint{AuthURL: "https://accounts.invalid/auth", TokenURL: g.URL + "/token", AuthStyle: oauth2.AuthStyleInParams},
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func saved(t *testing.T, dir string, c Credentials) string {
	t.Helper()
	path := filepath.Join(dir, CredentialsFile)
	if _, err := WriteCredentials(path, c); err != nil {
		t.Fatal(err)
	}
	return path
}

func expired() Credentials {
	return Credentials{AccessToken: "at-old", RefreshToken: "rt-synthetic", TokenType: "Bearer", Expiry: time.Now().Add(-time.Hour), Scopes: Scopes}
}

func toolCode(err error) coach.Code { return coach.AsToolError(err).Code }

func TestLoadConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ClientSecretFile)

	_, err := LoadConfig(path, Endpoint)
	if te := coach.AsToolError(err); te.Code != coach.CodeAuthExpired || !strings.Contains(te.Hint, path) {
		t.Errorf("missing client = %+v, want auth_expired with the path in the hint", te)
	}

	write := func(s string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A file that exists but cannot be used is actionable, never internal_error.
	unusable := func(name string, want string) {
		t.Helper()
		_, err := LoadConfig(path, Endpoint)
		te := coach.AsToolError(err)
		if te.Code != coach.CodeAuthExpired || !strings.Contains(te.Message, want) || !strings.Contains(te.Hint, path) ||
			strings.Contains(err.Error(), "secret-synthetic") {
			t.Errorf("%s: err = %v (%+v)", name, err, te)
		}
	}
	write(`{"installed": {"client_secret": "secret-synthetic"`)
	unusable("broken JSON", "not valid JSON")
	write(`{"web": {"client_id": "id", "client_secret": "secret-synthetic"}}`)
	unusable("web client", "Desktop")
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() != 0 { // root reads it anyway
		unusable("unreadable", "cannot be read")
	}
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	write(`{"installed": {"client_id": "id-synthetic", "client_secret": "secret-synthetic", "redirect_uris": ["http://localhost"]}}`)
	conf, err := LoadConfig(path, Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if conf.ClientID != "id-synthetic" || conf.ClientSecret != "secret-synthetic" || conf.RedirectURL != "" ||
		conf.Endpoint != Endpoint || len(conf.Scopes) != len(Scopes) {
		t.Errorf("config = %+v", conf)
	}
	conf.Scopes[0] = "changed"
	if Scopes[0] == "changed" {
		t.Error("LoadConfig shares the Scopes slice")
	}
}

func TestScopesAreReadOnly(t *testing.T) {
	// Only the categories of the data types the coach reads; a sign-in that
	// also held other scopes (location, ECG, irregular rhythm) still passes.
	want := []string{"activity_and_fitness", "health_metrics_and_measurements", "sleep", "nutrition"}
	if len(Scopes) != len(want) {
		t.Errorf("Scopes = %v, want the categories %v", Scopes, want)
	}
	for i, c := range want {
		if i < len(Scopes) && Scopes[i] != scopePrefix+c+".readonly" {
			t.Errorf("Scopes[%d] = %q, want %s", i, Scopes[i], c)
		}
	}
	if got := MissingScopes(append(slices.Clone(Scopes), scopePrefix+"location.readonly")); got != nil {
		t.Errorf("MissingScopes(with an extra scope) = %v", got)
	}
	for _, s := range Scopes {
		if !strings.HasPrefix(s, scopePrefix) || !strings.HasSuffix(s, ".readonly") {
			t.Errorf("scope %q is not a read-only Google Health scope", s)
		}
	}
	if got := MissingScopes(Scopes[1:]); len(got) != 1 || got[0] != Scopes[0] {
		t.Errorf("MissingScopes = %v", got)
	}
	if got := MissingScopes(Scopes); got != nil {
		t.Errorf("MissingScopes(all) = %v", got)
	}
}

func TestWriteCredentials(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config")
	want := expired()
	want.LoginAt = time.Date(2026, 10, 15, 10, 0, 0, 0, time.UTC)
	path := saved(t, dir, want)

	for p, mode := range map[string]fs.FileMode{dir: 0o700, path: 0o600} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != mode {
			t.Errorf("%s mode = %v, want %v", p, fi.Mode().Perm(), mode)
		}
	}
	got, err := ReadCredentials(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.AccessToken != want.AccessToken || got.RefreshToken != want.RefreshToken || !got.Expiry.Equal(want.Expiry) ||
		!got.LoginAt.Equal(want.LoginAt) || len(got.Scopes) != len(Scopes) {
		t.Errorf("round trip = %+v, want %+v", got, want)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Errorf("temp files left behind: %v", entries)
	}

	if err := os.WriteFile(path, []byte(`{"access_token": "at-synthetic"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCredentials(path); err == nil || strings.Contains(err.Error(), "at-synthetic") {
		t.Errorf("no refresh token: err = %v", err)
	}
	if _, err := ReadCredentials(filepath.Join(dir, "nope.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("missing file: err = %v", err)
	}
}

func TestNewCredentialsUsesGrantedScopes(t *testing.T) {
	now := time.Date(2026, 10, 15, 10, 0, 0, 0, time.UTC)
	tok := (&oauth2.Token{AccessToken: "a", RefreshToken: "r"}).WithExtra(map[string]any{"scope": Scopes[0] + " " + Scopes[2]})
	tok.Expiry = now.Add(30 * time.Minute)
	c := NewCredentials(tok, now)
	if len(c.Scopes) != 2 || c.Scopes[1] != Scopes[2] || !c.LoginAt.Equal(now) || c.RefreshToken != "r" || !c.Expiry.Equal(tok.Expiry) {
		t.Errorf("credentials = %+v", c)
	}
	// No scope list: unknown, never assumed granted. No expiry: an hour, never "forever".
	c = NewCredentials(&oauth2.Token{AccessToken: "a", RefreshToken: "r"}, now)
	if c.Scopes != nil || !c.Expiry.Equal(now.Add(time.Hour)) {
		t.Errorf("without scope list and expiry: %+v", c)
	}
}

func TestWriteCredentialsTightensExistingModes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, CredentialsFile)
	if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	fi, err := WriteCredentials(path, expired())
	if err != nil {
		t.Fatal(err)
	}
	for p, mode := range map[string]fs.FileMode{dir: 0o700, path: 0o600} {
		if got, _ := os.Stat(p); got.Mode().Perm() != mode {
			t.Errorf("%s mode = %v, want %v", p, got.Mode().Perm(), mode)
		}
	}
	// The returned version is the file now at path.
	if now, _ := os.Stat(path); !sameVersion(fi, now) {
		t.Error("WriteCredentials returned a different version than the one on disk")
	}
}

func TestTokenSourceReloadsAnInPlaceEdit(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	c := expired()
	c.Expiry = time.Now().Add(time.Hour)
	path := saved(t, dir, c)
	ts := NewTokenSource(context.Background(), path, g.config(), nil)
	if _, err := ts.Token(); err != nil {
		t.Fatal(err)
	}
	edit := func(access string, mtime time.Time) {
		t.Helper()
		c.AccessToken = access
		data, _ := json.Marshal(c)
		if err := os.WriteFile(path, data, 0o600); err != nil { // same inode
			t.Fatal(err)
		}
		if err := os.Chtimes(path, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	// Same inode and a different size.
	edit("at-edited-longer", time.Now().Add(time.Minute))
	if tok, _ := ts.Token(); tok.AccessToken != "at-edited-longer" {
		t.Errorf("after an in-place edit, Token = %q", tok.AccessToken)
	}
	// Same inode and same size: only the mtime tells.
	edit("at-edited-LONGER", time.Now().Add(2*time.Minute))
	if tok, _ := ts.Token(); tok.AccessToken != "at-edited-LONGER" {
		t.Errorf("after a same-size edit, Token = %q", tok.AccessToken)
	}
}

func TestTokenSourceSendsTheRotatedRefreshTokenNextTime(t *testing.T) {
	g := newFakeGoogle(t)
	// expires_in 1 is inside oauth2's expiry margin, so every call renews.
	g.setRespond(func(w http.ResponseWriter, _ url.Values) {
		writeJSON(w, http.StatusOK, map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 1})
	})
	ts := NewTokenSource(context.Background(), saved(t, t.TempDir(), expired()), g.config(), nil)
	for range 2 {
		if _, err := ts.Token(); err != nil {
			t.Fatal(err)
		}
	}
	if g.requests.Load() != 2 || g.lastForm().Get("refresh_token") != "rt-rotated" {
		t.Errorf("after %d renewals the last one sent %q, want rt-rotated", g.requests.Load(), g.lastForm().Get("refresh_token"))
	}
}

func TestTokenSourceAssumesAnHourWithoutExpiresIn(t *testing.T) {
	g := newFakeGoogle(t)
	g.setRespond(func(w http.ResponseWriter, _ url.Values) {
		writeJSON(w, http.StatusOK, map[string]any{"access_token": "at-new"})
	})
	path := saved(t, t.TempDir(), expired())
	if _, err := NewTokenSource(context.Background(), path, g.config(), nil).Token(); err != nil {
		t.Fatal(err)
	}
	c, _ := ReadCredentials(path)
	if left := time.Until(c.Expiry); left < 55*time.Minute || left > time.Hour {
		t.Errorf("saved expiry is %v away, want about an hour", left)
	}
}

func TestTokenSourceLetsALoginDuringTheRenewalWin(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	path := filepath.Join(dir, CredentialsFile)
	relogin := expired()
	relogin.AccessToken, relogin.RefreshToken, relogin.Expiry = "at-relogin", "rt-relogin", time.Now().Add(time.Hour)
	relogin.LoginAt = time.Date(2026, 10, 15, 21, 0, 0, 0, time.UTC)
	g.setRespond(func(w http.ResponseWriter, _ url.Values) {
		// auth login finishes while the renewal is in flight.
		if _, err := WriteCredentials(path, relogin); err != nil {
			t.Error(err)
		}
		writeJSON(w, http.StatusOK, map[string]any{"access_token": "at-renewed", "expires_in": 3600})
	})
	saved(t, dir, expired())
	ts := NewTokenSource(context.Background(), path, g.config(), nil)

	tok, err := ts.Token()
	if err != nil || tok.AccessToken != "at-relogin" {
		t.Fatalf("Token = %+v, %v; want the new login's token", tok, err)
	}
	c, _ := ReadCredentials(path)
	if c.RefreshToken != "rt-relogin" || !c.LoginAt.Equal(relogin.LoginAt) {
		t.Errorf("the renewal overwrote the new login: %+v", c)
	}
}

func TestTokenSourceKeepsAValidTokenWithoutCallingGoogle(t *testing.T) {
	g := newFakeGoogle(t)
	c := expired()
	c.Expiry = time.Now().Add(time.Hour)
	ts := NewTokenSource(context.Background(), saved(t, t.TempDir(), c), g.config(), nil)
	for range 3 {
		tok, err := ts.Token()
		if err != nil || tok.AccessToken != "at-old" {
			t.Fatalf("Token = %+v, %v", tok, err)
		}
	}
	if n := g.requests.Load(); n != 0 {
		t.Errorf("token endpoint called %d times for a valid token", n)
	}
}

func TestTokenSourceRenewalKeepsTheRefreshTokenAndSaves(t *testing.T) {
	g := newFakeGoogle(t)
	path := saved(t, t.TempDir(), expired())
	ts := NewTokenSource(context.Background(), path, g.config(), nil)

	tok, err := ts.Token()
	if err != nil || tok.AccessToken != "at-1" {
		t.Fatalf("Token = %+v, %v", tok, err)
	}
	if f := g.lastForm(); f.Get("grant_type") != "refresh_token" || f.Get("refresh_token") != "rt-synthetic" || f.Get("client_id") != "client-synthetic" {
		t.Errorf("renewal request = %v", f)
	}
	onDisk, err := ReadCredentials(path)
	if err != nil {
		t.Fatal(err)
	}
	if onDisk.AccessToken != "at-1" || onDisk.RefreshToken != "rt-synthetic" || !onDisk.Expiry.After(time.Now()) || len(onDisk.Scopes) != len(Scopes) {
		t.Errorf("saved = %+v; want the new access token with the old refresh token and scopes", onDisk)
	}
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode after renewal = %v", fi.Mode().Perm())
	}
	// The renewal written by the source itself is not mistaken for a new login.
	if tok, err := ts.Token(); err != nil || tok.AccessToken != "at-1" || g.requests.Load() != 1 {
		t.Errorf("second Token = %+v, %v after %d requests", tok, err, g.requests.Load())
	}
}

func TestTokenSourceSavesARotatedRefreshToken(t *testing.T) {
	g := newFakeGoogle(t)
	g.setRespond(func(w http.ResponseWriter, _ url.Values) {
		writeJSON(w, http.StatusOK, map[string]any{"access_token": "at-new", "refresh_token": "rt-rotated", "expires_in": 3600})
	})
	path := saved(t, t.TempDir(), expired())
	if _, err := NewTokenSource(context.Background(), path, g.config(), nil).Token(); err != nil {
		t.Fatal(err)
	}
	if c, _ := ReadCredentials(path); c.RefreshToken != "rt-rotated" {
		t.Errorf("refresh token on disk = %q, want the rotated one", c.RefreshToken)
	}
}

func TestTokenSourceRenewalErrors(t *testing.T) {
	const secretBody = "body-text-that-must-not-leak"
	cases := []struct {
		name    string
		status  int
		body    string
		want    coach.Code
		wantMsg string
	}{
		{"invalid_grant", http.StatusBadRequest, `{"error": "invalid_grant", "error_description": "` + secretBody + `"}`, coach.CodeAuthExpired, "expired or was revoked"},
		{"invalid_client", http.StatusUnauthorized, `{"error": "invalid_client", "error_description": "` + secretBody + `"}`, coach.CodeAuthExpired, "rejected the token renewal (token endpoint replied HTTP 401 (invalid_client))"},
		{"invalid_request", http.StatusBadRequest, `{"error": "invalid_request"}`, coach.CodeAuthExpired, "HTTP 400 (invalid_request)"},
		{"odd error code", http.StatusBadRequest, `{"error": "<script>` + secretBody + `"}`, coach.CodeAuthExpired, "replied HTTP 400)"},
		{"rate limited", http.StatusTooManyRequests, `{"error": "rate_limit_exceeded"}`, coach.CodeUpstreamUnavailable, "unavailable (token endpoint replied HTTP 429 (rate_limit_exceeded))"},
		{"request timeout", http.StatusRequestTimeout, `{}`, coach.CodeUpstreamUnavailable, "HTTP 408"},
		{"server error", http.StatusServiceUnavailable, `{"error": "backend_error"}`, coach.CodeUpstreamUnavailable, "HTTP 503"},
		{"html 502", http.StatusBadGateway, `<html>` + secretBody + `</html>`, coach.CodeUpstreamUnavailable, "HTTP 502"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := newFakeGoogle(t)
			g.setRespond(func(w http.ResponseWriter, _ url.Values) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			})
			_, err := NewTokenSource(context.Background(), saved(t, t.TempDir(), expired()), g.config(), nil).Token()
			te := coach.AsToolError(err)
			if te.Code != c.want || !strings.Contains(te.Message, c.wantMsg) {
				t.Errorf("err = %+v, want %s containing %q", te, c.want, c.wantMsg)
			}
			if c.want == coach.CodeAuthExpired && !strings.Contains(te.Hint, LoginCommand) {
				t.Errorf("hint %q does not name the login command", te.Hint)
			}
			// The whole error, not just the ToolError, is what a caller may log.
			if strings.Contains(err.Error(), "rt-synthetic") || strings.Contains(err.Error(), secretBody) {
				t.Errorf("the error carries a token or the endpoint's body: %v", err)
			}
			// A fixed AuthStyle means one request, not a probe and a retry.
			if n := g.requests.Load(); n != 1 {
				t.Errorf("token endpoint called %d times, want 1", n)
			}
		})
	}
}

func TestTokenSourceUnreachableEndpoint(t *testing.T) {
	g := newFakeGoogle(t)
	conf := g.config()
	g.Close()
	_, err := NewTokenSource(context.Background(), saved(t, t.TempDir(), expired()), conf, nil).Token()
	if got := toolCode(err); got != coach.CodeUpstreamUnavailable {
		t.Errorf("code = %s, want upstream_unavailable (err %v)", got, err)
	}
}

func TestTokenSourceWithoutUsableCredentials(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	path := filepath.Join(dir, CredentialsFile)
	ts := NewTokenSource(context.Background(), path, g.config(), nil)

	_, err := ts.Token()
	if te := coach.AsToolError(err); te.Code != coach.CodeAuthExpired || !strings.Contains(te.Message, "not signed in") {
		t.Errorf("missing file: %+v", te)
	}
	if err := os.WriteFile(path, []byte(`{"refresh_token": "rt-synthetic", `), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = ts.Token()
	if toolCode(err) != coach.CodeAuthExpired || strings.Contains(err.Error(), "rt-synthetic") {
		t.Errorf("corrupt file: err = %v", err)
	}
	// Signing out (deleting the file) while running stops the source.
	saved(t, dir, expired())
	if _, err := ts.Token(); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := ts.Token(); toolCode(err) != coach.CodeAuthExpired {
		t.Errorf("after the file is removed: err = %v", err)
	}
}

func TestTokenSourcePicksUpANewLogin(t *testing.T) {
	g := newFakeGoogle(t)
	dir := t.TempDir()
	c := expired()
	c.Expiry = time.Now().Add(time.Hour)
	ts := NewTokenSource(context.Background(), saved(t, dir, c), g.config(), nil)
	if tok, err := ts.Token(); err != nil || tok.AccessToken != "at-old" {
		t.Fatalf("Token = %+v, %v", tok, err)
	}
	c.AccessToken, c.RefreshToken = "at-relogin", "rt-relogin"
	saved(t, dir, c) // what auth login does in another process
	if tok, err := ts.Token(); err != nil || tok.AccessToken != "at-relogin" || tok.RefreshToken != "rt-relogin" {
		t.Errorf("after a new login, Token = %+v, %v", tok, err)
	}
}

func TestTokenSourceRenewsOnceUnderConcurrency(t *testing.T) {
	g := newFakeGoogle(t)
	ts := NewTokenSource(context.Background(), saved(t, t.TempDir(), expired()), g.config(), nil)
	var wg sync.WaitGroup
	tokens := make([]string, 16)
	for i := range tokens {
		wg.Go(func() {
			if tok, err := ts.Token(); err == nil {
				tokens[i] = tok.AccessToken
			}
		})
	}
	wg.Wait()
	for i, tok := range tokens {
		if tok != "at-1" {
			t.Errorf("goroutine %d got %q, want at-1", i, tok)
		}
	}
	if n := g.requests.Load(); n != 1 {
		t.Errorf("token endpoint called %d times, want 1", n)
	}
}

func TestTokenSourceKeepsTheRenewalWhenSavingFails(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	g := newFakeGoogle(t)
	dir := t.TempDir()
	path := saved(t, dir, expired())
	var logs bytes.Buffer
	ts := NewTokenSource(context.Background(), path, g.config(), slog.New(slog.NewTextHandler(&logs, nil)))
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })

	tok, err := ts.Token()
	if err != nil || tok.AccessToken != "at-1" {
		t.Fatalf("Token = %+v, %v", tok, err)
	}
	if !strings.Contains(logs.String(), "could not save the renewed Google token") || strings.Contains(logs.String(), "at-1") {
		t.Errorf("log = %q, want a warning without the token", logs.String())
	}
	// The unchanged file is not reloaded over the renewal kept in memory.
	if tok, err := ts.Token(); err != nil || tok.AccessToken != "at-1" || g.requests.Load() != 1 {
		t.Errorf("second Token = %+v, %v after %d requests", tok, err, g.requests.Load())
	}
}

func TestTokenSourceTimeoutAndCancellation(t *testing.T) {
	release := make(chan struct{})
	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(release); hang.Close() })
	conf := &oauth2.Config{ClientID: "c", Endpoint: oauth2.Endpoint{TokenURL: hang.URL, AuthStyle: oauth2.AuthStyleInParams}}

	ctx := context.WithValue(context.Background(), oauth2.HTTPClient, &http.Client{Timeout: 50 * time.Millisecond})
	_, err := NewTokenSource(ctx, saved(t, t.TempDir(), expired()), conf, nil).Token()
	if te := coach.AsToolError(err); te.Code != coach.CodeUpstreamUnavailable || !strings.Contains(te.Message, "in time") {
		t.Errorf("timeout: %+v (%v)", te, err)
	}

	// A cancelled server context is a shutdown, not an outage at Google.
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = NewTokenSource(cancelled, saved(t, t.TempDir(), expired()), conf, nil).Token()
	if !errors.Is(err, context.Canceled) || toolCode(err) != coach.CodeInternal {
		t.Errorf("cancelled: err = %v, code %s", err, toolCode(err))
	}
}

func TestTokenSourceAfterAFailedSaveANewLoginStillWins(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	g := newFakeGoogle(t)
	dir := t.TempDir()
	path := saved(t, dir, expired())
	ts := NewTokenSource(context.Background(), path, g.config(), nil)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	if tok, err := ts.Token(); err != nil || tok.AccessToken != "at-1" {
		t.Fatalf("Token = %+v, %v", tok, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	relogin := expired()
	relogin.AccessToken, relogin.Expiry = "at-relogin", time.Now().Add(time.Hour)
	saved(t, dir, relogin)
	if tok, err := ts.Token(); err != nil || tok.AccessToken != "at-relogin" || g.requests.Load() != 1 {
		t.Errorf("Token = %+v, %v after %d requests; want the new login without a renewal", tok, err, g.requests.Load())
	}
}

func TestSafeCode(t *testing.T) {
	for in, want := range map[string]string{
		"invalid_grant": "invalid_grant", "rate-limit.v2": "rate-limit.v2", "": "",
		"<b>x</b>": "", "has space": "", strings.Repeat("a", 65): "",
	} {
		if got := safeCode(in); got != want {
			t.Errorf("safeCode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTokenSourceInvalidate(t *testing.T) {
	g := newFakeGoogle(t)
	c := expired()
	c.Expiry = time.Now().Add(time.Hour)
	ts := NewTokenSource(context.Background(), saved(t, t.TempDir(), c), g.config(), nil)

	if ts.Invalidate("at-old") { // before the first Token call: nothing loaded, nothing to drop
		t.Error("Invalidate before any Token call reported a change")
	}
	tok, err := ts.Token()
	if err != nil || tok.AccessToken != "at-old" || g.requests.Load() != 0 {
		t.Fatalf("Token = %+v, %v after %d renewals", tok, err, g.requests.Load())
	}
	// A token the API rejected is renewed on the next call, though its expiry is ahead.
	if !ts.Invalidate("at-old") || ts.Invalidate("") {
		t.Error("Invalidate result is wrong")
	}
	if tok, err = ts.Token(); err != nil || tok.AccessToken != "at-1" {
		t.Fatalf("Token after Invalidate = %+v, %v", tok, err)
	}
	// A rejection of a token already replaced is stale: the new one stays.
	if ts.Invalidate("at-old") {
		t.Error("a stale Invalidate reported a change")
	}
	if tok, err = ts.Token(); err != nil || tok.AccessToken != "at-1" || g.requests.Load() != 1 {
		t.Errorf("stale Invalidate: Token = %+v, %v after %d renewals", tok, err, g.requests.Load())
	}
}

func TestTokenSourceInvalidateConcurrent(t *testing.T) {
	g := newFakeGoogle(t)
	c := expired()
	c.Expiry = time.Now().Add(time.Hour)
	ts := NewTokenSource(context.Background(), saved(t, t.TempDir(), c), g.config(), nil)
	if _, err := ts.Token(); err != nil {
		t.Fatal(err)
	}
	// Several requests see the same 401: the token is renewed once, not once per request.
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			ts.Invalidate("at-old")
			if _, err := ts.Token(); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if n := g.requests.Load(); n != 1 {
		t.Errorf("%d renewals for one rejected token, want 1", n)
	}
}
