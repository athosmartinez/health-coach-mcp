// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Adapted from google-health-cli pkg/auth/auth.go (InteractiveLogin). Changes:
// PKCE on the loopback flow, prompt=consent, stray requests ignored instead of
// aborting, context timeout and cancellation, graceful shutdown so the browser
// gets its page, redacted token endpoint errors, no refresh token treated as a
// failed login.

package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"golang.org/x/oauth2"
)

// LoginOptions configures the browser sign-in.
type LoginOptions struct {
	// Open shows the consent page; nil only prints the URL.
	Open func(url string) error
	// Out receives the URL and progress messages (stderr in the CLI).
	Out io.Writer
	// Timeout bounds the wait for the browser; zero means 5 minutes.
	Timeout time.Duration
}

const (
	defaultLoginTimeout = 5 * time.Minute
	exchangeTimeout     = 30 * time.Second
	// shutdownGrace lets the callback finish writing its page before the
	// listener closes; without it the tab can show a connection reset.
	shutdownGrace = 2 * time.Second
)

type callback struct {
	code string
	err  error
}

// Login runs the OAuth loopback flow: it listens on 127.0.0.1 on a free port
// (Desktop clients accept any loopback port), sends the user to Google's
// consent page and exchanges the returned code with PKCE. access_type=offline
// and prompt=consent make Google issue a refresh token on every login. ctx may
// carry an *http.Client under oauth2.HTTPClient for the exchange.
func Login(ctx context.Context, conf *oauth2.Config, opts LoginOptions) (*oauth2.Token, error) {
	out := opts.Out
	if out == nil {
		out = io.Discard
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultLoginTimeout
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("listen on loopback: %w", err)
	}
	c := *conf
	c.RedirectURL = fmt.Sprintf("http://127.0.0.1:%d/", ln.Addr().(*net.TCPAddr).Port)

	state := rand.Text()
	verifier := oauth2.GenerateVerifier()
	results := make(chan callback, 1)
	var once sync.Once
	deliver := func(r callback) (first bool) {
		once.Do(func() { results <- r; first = true })
		return first
	}
	srv := &http.Server{Handler: callbackHandler(state, deliver), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			deliver(callback{err: fmt.Errorf("loopback server stopped: %w", err)})
		}
	}()
	defer func() {
		sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if srv.Shutdown(sctx) != nil {
			_ = srv.Close() // the grace period ran out; drop what is left
		}
	}()

	url := c.AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.SetAuthURLParam("prompt", "consent"),
		oauth2.S256ChallengeOption(verifier))
	fmt.Fprintf(out, "Open this URL in your browser to sign in to Google Health:\n\n  %s\n\nWaiting for the browser (up to %s)...\n", url, timeout)
	if opts.Open != nil {
		if err := opts.Open(url); err != nil {
			fmt.Fprintf(out, "Could not open a browser (%v); open the URL above by hand.\n", err)
		}
	}

	wait, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var code string
	select {
	case r := <-results:
		if r.err != nil {
			return nil, r.err
		}
		code = r.code
	case <-wait.Done():
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("sign-in cancelled: %w", err)
		}
		return nil, fmt.Errorf("no answer from the browser within %s: %w", timeout, wait.Err())
	}

	exchange, cancelExchange := context.WithTimeout(ctx, exchangeTimeout)
	defer cancelExchange()
	tok, err := c.Exchange(exchange, code, oauth2.VerifierOption(verifier))
	if err != nil {
		cause, _ := redact(err)
		return nil, fmt.Errorf("exchange the authorization code: %w", cause)
	}
	if tok.RefreshToken == "" {
		return nil, errors.New("google returned no refresh token; remove the app at https://myaccount.google.com/permissions and sign in again")
	}
	return tok, nil
}

// callbackHandler hands the first redirect that carries the right state to
// deliver. Other requests (a favicon fetch, a stale tab, another local
// process) get an error page and do not end the login.
func callbackHandler(state string, deliver func(callback) bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		if subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(state)) != 1 {
			http.Error(w, "Unexpected sign-in response. Finish the sign-in in the tab health-coach-mcp opened.", http.StatusBadRequest)
			return
		}
		var res callback
		switch {
		case q.Get("error") != "":
			res.err = fmt.Errorf("google sign-in failed: %.64q", q.Get("error"))
		case q.Get("code") == "":
			res.err = errors.New("google sent no authorization code")
		default:
			res.code = q.Get("code")
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		switch {
		case !deliver(res):
			fmt.Fprintln(w, "This sign-in already finished. You can close this tab.")
		case res.err != nil:
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintln(w, "Sign-in failed. See the terminal for details.")
		default:
			fmt.Fprintln(w, "Signed in to health-coach-mcp. You can close this tab.")
		}
	})
}
