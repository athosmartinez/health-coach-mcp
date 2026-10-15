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
// aborting, context timeout, no refresh token treated as a failed login.

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
	srv := &http.Server{Handler: callbackHandler(state, results), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }() // returns ErrServerClosed once Close runs
	defer srv.Close()

	url := c.AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.SetAuthURLParam("prompt", "consent"),
		oauth2.S256ChallengeOption(verifier))
	fmt.Fprintf(out, "Open this URL in your browser to sign in to Google Health:\n\n  %s\n\nWaiting for the browser (up to %s)...\n", url, timeout)
	if opts.Open != nil {
		if err := opts.Open(url); err != nil {
			fmt.Fprintln(out, "Could not open a browser; open the URL above by hand.")
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
		return nil, fmt.Errorf("no answer from the browser: %w", wait.Err())
	}

	exchange, cancelExchange := context.WithTimeout(ctx, exchangeTimeout)
	defer cancelExchange()
	tok, err := c.Exchange(exchange, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return nil, fmt.Errorf("exchange the authorization code: %w", err)
	}
	if tok.RefreshToken == "" {
		return nil, errors.New("google returned no refresh token; remove the app at https://myaccount.google.com/permissions and sign in again")
	}
	return tok, nil
}

// callbackHandler accepts the first redirect that carries the right state.
// Other requests (a favicon fetch, a stale tab, another local process) get an
// error page and do not end the login.
func callbackHandler(state string, results chan<- callback) http.Handler {
	var once sync.Once
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
		once.Do(func() { results <- res })
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if res.err != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprintln(w, "Sign-in failed. See the terminal for details.")
			return
		}
		fmt.Fprintln(w, "Signed in to health-coach-mcp. You can close this tab.")
	})
}
