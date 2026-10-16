package auth

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

// fakeBrowser stands in for the user. open records the consent URL and, in
// the background, sends noise to the loopback port and then the redirect with
// query (state is filled in unless set). The test waits for it to finish, so
// nothing reports after the test ends.
type fakeBrowser struct {
	query url.Values

	mu         sync.Mutex
	consent    url.Values
	finalCode  int
	finalBody  string
	done       chan struct{}
	noiseCodes [2]int
}

func newBrowser(t *testing.T, query url.Values) *fakeBrowser {
	t.Helper()
	b := &fakeBrowser{query: query, done: make(chan struct{})}
	t.Cleanup(func() {
		select {
		case <-b.done:
		case <-time.After(10 * time.Second):
			t.Error("fake browser did not finish")
		}
	})
	return b
}

func (b *fakeBrowser) open(consent string) error {
	u, err := url.Parse(consent)
	if err != nil {
		close(b.done)
		return err
	}
	q := u.Query()
	b.mu.Lock()
	b.consent = q
	b.mu.Unlock()
	go func() {
		defer close(b.done)
		get := func(rawURL string) (int, string) {
			resp, err := http.Get(rawURL)
			if err != nil {
				return 0, err.Error()
			}
			defer resp.Body.Close()
			body, _ := io.ReadAll(resp.Body)
			return resp.StatusCode, string(body)
		}
		redirect := q.Get("redirect_uri")
		// Noise a real browser or a stale tab produces must not end the login.
		fav, _ := get(strings.TrimSuffix(redirect, "/") + "/favicon.ico")
		wrong, _ := get(redirect + "?code=stolen&state=wrong")
		final := url.Values{}
		for k, v := range b.query {
			final[k] = v
		}
		if !final.Has("state") {
			final.Set("state", q.Get("state"))
		}
		code, body := get(redirect + "?" + final.Encode())
		b.mu.Lock()
		b.noiseCodes, b.finalCode, b.finalBody = [2]int{fav, wrong}, code, body
		b.mu.Unlock()
	}()
	return nil
}

// wait returns once the browser got the answer to its last request.
func (b *fakeBrowser) wait(t *testing.T) (noise [2]int, code int, body string) {
	t.Helper()
	select {
	case <-b.done:
	case <-time.After(10 * time.Second):
		t.Fatal("fake browser did not finish")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.noiseCodes, b.finalCode, b.finalBody
}

func (b *fakeBrowser) consentQuery() url.Values {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.consent
}

func TestLoginExchangesTheCodeWithPKCE(t *testing.T) {
	g := newFakeGoogle(t)
	b := newBrowser(t, url.Values{"code": {"code-synthetic"}})
	var exchanged []string
	g.setRespond(func(w http.ResponseWriter, form url.Values) {
		consent := b.consentQuery()
		exchanged = append(exchanged, form.Get("code"))
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
	tok, err := Login(context.Background(), g.config(), LoginOptions{Open: b.open, Out: &out, Timeout: 10 * time.Second})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if tok.AccessToken != "at-login" || tok.RefreshToken != "rt-login" {
		t.Errorf("token = %+v", tok)
	}
	noise, code, body := b.wait(t)
	if noise != [2]int{http.StatusNotFound, http.StatusBadRequest} || code != http.StatusOK || !strings.Contains(body, "Signed in") {
		t.Errorf("browser saw noise %v, then %d %q", noise, code, body)
	}
	// Only the real code was exchanged: the wrong-state request never got through.
	if len(exchanged) != 1 || exchanged[0] != "code-synthetic" {
		t.Errorf("exchanged codes = %v", exchanged)
	}
	consent := b.consentQuery()
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
	login := func(t *testing.T, g *fakeGoogle, query url.Values) (error, int, string) {
		t.Helper()
		b := newBrowser(t, query)
		_, err := Login(context.Background(), g.config(), LoginOptions{Open: b.open, Timeout: 10 * time.Second})
		_, code, body := b.wait(t)
		return err, code, body
	}
	t.Run("consent denied", func(t *testing.T) {
		g := newFakeGoogle(t)
		err, code, body := login(t, g, url.Values{"error": {"access_denied"}})
		if err == nil || !strings.Contains(err.Error(), "access_denied") || g.requests.Load() != 0 {
			t.Errorf("err = %v after %d token requests", err, g.requests.Load())
		}
		// The tab gets the failure page, not a reset connection.
		if code != http.StatusBadRequest || !strings.Contains(body, "Sign-in failed") {
			t.Errorf("browser got %d %q", code, body)
		}
	})
	t.Run("no code", func(t *testing.T) {
		g := newFakeGoogle(t)
		if err, _, _ := login(t, g, url.Values{}); err == nil || !strings.Contains(err.Error(), "no authorization code") {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("no refresh token", func(t *testing.T) {
		g := newFakeGoogle(t) // the default response carries no refresh token
		if err, _, _ := login(t, g, url.Values{"code": {"code-synthetic"}}); err == nil || !strings.Contains(err.Error(), "no refresh token") {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("exchange rejected", func(t *testing.T) {
		g := newFakeGoogle(t)
		g.setRespond(func(w http.ResponseWriter, _ url.Values) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_grant", "error_description": "body-text-that-must-not-leak"})
		})
		err, _, _ := login(t, g, url.Values{"code": {"code-synthetic"}})
		var ee *endpointError
		if !errors.As(err, &ee) || ee.Code != "invalid_grant" || ee.Status != http.StatusBadRequest {
			t.Errorf("err = %v", err)
		}
		if err != nil && strings.Contains(err.Error(), "body-text-that-must-not-leak") {
			t.Errorf("the endpoint's body reached the error: %v", err)
		}
	})
	t.Run("browser never answers", func(t *testing.T) {
		g := newFakeGoogle(t)
		var out strings.Builder
		_, err := Login(context.Background(), g.config(), LoginOptions{
			Open: func(string) error { return errors.New("xdg-open not found") }, Out: &out, Timeout: 50 * time.Millisecond,
		})
		if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "no answer from the browser") {
			t.Errorf("err = %v, want a deadline", err)
		}
		if !strings.Contains(out.String(), "xdg-open not found") || !strings.Contains(out.String(), "open the URL above by hand") {
			t.Errorf("out = %q, want the cause and the manual fallback", out.String())
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		g := newFakeGoogle(t)
		ctx, cancel := context.WithCancel(context.Background())
		var redirect string
		done := make(chan error, 1)
		go func() {
			_, err := Login(ctx, g.config(), LoginOptions{Open: func(u string) error {
				p, _ := url.Parse(u)
				redirect = p.Query().Get("redirect_uri")
				cancel() // Ctrl-C while the browser is open
				return nil
			}, Timeout: 10 * time.Second})
			done <- err
		}()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "sign-in cancelled") {
				t.Errorf("err = %v", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("Login ignored the cancellation")
		}
		// The listener is closed once Login returns.
		if resp, err := http.Get(redirect); err == nil {
			resp.Body.Close()
			t.Errorf("loopback port %s still answers after Login returned", redirect)
		}
	})
}

func TestCallbackHandlerAcceptsOnlyTheFirstAnswer(t *testing.T) {
	var got []callback
	var once sync.Once
	deliver := func(c callback) (first bool) {
		once.Do(func() { got = append(got, c); first = true })
		return first
	}
	h := callbackHandler("state-synthetic", deliver)
	call := func(query string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/?"+query, nil))
		return rec
	}
	if rec := call("code=first&state=state-synthetic"); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Signed in") {
		t.Errorf("first answer: %d %q", rec.Code, rec.Body.String())
	}
	if rec := call("code=second&state=state-synthetic"); !strings.Contains(rec.Body.String(), "already finished") {
		t.Errorf("second answer: %d %q", rec.Code, rec.Body.String())
	}
	if len(got) != 1 || got[0].code != "first" {
		t.Errorf("delivered = %+v", got)
	}
	// A long error value is cut before it reaches the terminal.
	var long []callback
	h = callbackHandler("s", func(c callback) bool { long = append(long, c); return true })
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/?state=s&error="+strings.Repeat("x", 500), nil))
	if len(long) != 1 || len(long[0].err.Error()) > 120 {
		t.Errorf("error value not truncated: %v", long)
	}
}
