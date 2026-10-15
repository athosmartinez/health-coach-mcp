package auth

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

// browser stands in for the user: it parses the consent URL and calls the
// loopback redirect with the given query (state is filled in unless set).
func browser(t *testing.T, query url.Values, got *url.Values) func(string) error {
	t.Helper()
	return func(consent string) error {
		u, err := url.Parse(consent)
		if err != nil {
			return err
		}
		*got = u.Query()
		redirect := got.Get("redirect_uri")
		go func() {
			get := func(rawURL string) int {
				resp, err := http.Get(rawURL)
				if err != nil {
					t.Errorf("GET %s: %v", rawURL, err)
					return 0
				}
				resp.Body.Close()
				return resp.StatusCode
			}
			// Noise a real browser or a stale tab produces must not end the login.
			if code := get(strings.TrimSuffix(redirect, "/") + "/favicon.ico"); code != http.StatusNotFound {
				t.Errorf("favicon status = %d", code)
			}
			if code := get(redirect + "?code=stolen&state=wrong"); code != http.StatusBadRequest {
				t.Errorf("wrong state status = %d", code)
			}
			q := url.Values{}
			for k, v := range query {
				q[k] = v
			}
			if !q.Has("state") {
				q.Set("state", got.Get("state"))
			}
			get(redirect + "?" + q.Encode())
		}()
		return nil
	}
}

func TestLoginExchangesTheCodeWithPKCE(t *testing.T) {
	g := newFakeGoogle(t)
	var consent url.Values
	g.setRespond(func(w http.ResponseWriter, form url.Values) {
		if form.Get("grant_type") != "authorization_code" || form.Get("code") != "code-synthetic" ||
			form.Get("redirect_uri") != consent.Get("redirect_uri") ||
			oauth2.S256ChallengeFromVerifier(form.Get("code_verifier")) != consent.Get("code_challenge") {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"access_token": "at-login", "refresh_token": "rt-login", "expires_in": 3600, "scope": strings.Join(Scopes, " "),
		})
	})
	var out strings.Builder
	tok, err := Login(context.Background(), g.config(), LoginOptions{
		Open: browser(t, url.Values{"code": {"code-synthetic"}}, &consent), Out: &out, Timeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if tok.AccessToken != "at-login" || tok.RefreshToken != "rt-login" {
		t.Errorf("token = %+v", tok)
	}
	for k, want := range map[string]string{"access_type": "offline", "prompt": "consent", "code_challenge_method": "S256", "response_type": "code"} {
		if consent.Get(k) != want {
			t.Errorf("consent %s = %q, want %q", k, consent.Get(k), want)
		}
	}
	if !strings.HasPrefix(consent.Get("redirect_uri"), "http://127.0.0.1:") {
		t.Errorf("redirect_uri = %q, want a 127.0.0.1 loopback port", consent.Get("redirect_uri"))
	}
	if consent.Get("scope") != strings.Join(Scopes, " ") || len(consent.Get("state")) < 20 {
		t.Errorf("scope = %q, state = %q", consent.Get("scope"), consent.Get("state"))
	}
	if !strings.Contains(out.String(), "accounts.invalid/auth") {
		t.Errorf("the consent URL is not printed: %q", out.String())
	}
	if strings.Contains(out.String(), "at-login") || strings.Contains(out.String(), "rt-login") {
		t.Errorf("a token reached the output: %q", out.String())
	}
}

func TestLoginFailures(t *testing.T) {
	t.Run("consent denied", func(t *testing.T) {
		g := newFakeGoogle(t)
		var consent url.Values
		_, err := Login(context.Background(), g.config(), LoginOptions{
			Open: browser(t, url.Values{"error": {"access_denied"}}, &consent), Timeout: 10 * time.Second,
		})
		if err == nil || !strings.Contains(err.Error(), "access_denied") || g.requests.Load() != 0 {
			t.Errorf("err = %v after %d token requests", err, g.requests.Load())
		}
	})
	t.Run("no refresh token", func(t *testing.T) {
		g := newFakeGoogle(t) // the default response carries no refresh token
		var consent url.Values
		_, err := Login(context.Background(), g.config(), LoginOptions{
			Open: browser(t, url.Values{"code": {"code-synthetic"}}, &consent), Timeout: 10 * time.Second,
		})
		if err == nil || !strings.Contains(err.Error(), "no refresh token") {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("exchange rejected", func(t *testing.T) {
		g := newFakeGoogle(t)
		g.setRespond(func(w http.ResponseWriter, _ url.Values) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant"})
		})
		var consent url.Values
		_, err := Login(context.Background(), g.config(), LoginOptions{
			Open: browser(t, url.Values{"code": {"code-synthetic"}}, &consent), Timeout: 10 * time.Second,
		})
		var re *oauth2.RetrieveError
		if !errors.As(err, &re) || re.ErrorCode != "invalid_grant" {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("browser never answers", func(t *testing.T) {
		g := newFakeGoogle(t)
		var out strings.Builder
		_, err := Login(context.Background(), g.config(), LoginOptions{
			Open: func(string) error { return errors.New("no browser") }, Out: &out, Timeout: 50 * time.Millisecond,
		})
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("err = %v, want a deadline", err)
		}
		if !strings.Contains(out.String(), "open the URL above by hand") {
			t.Errorf("out = %q, want the manual fallback", out.String())
		}
	})
}
