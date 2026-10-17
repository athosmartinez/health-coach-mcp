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
// Adapted from google-health-cli pkg/client/client.go (Do, isStaleScopeError,
// parseRetryAfter) and cmd/data.go (list and rollup pagination). Changes: read
// operations only, behind a method and path allowlist; context-aware waits with
// jitter and a cap on Retry-After; one token refresh shared by 401 and the
// stale-token 403; errors carry the HTTP status and Google's status enum, never
// the response body; responses read through a size limit; a page cap or a
// repeated page token is an error instead of a truncated result.

// Package googlehealth is a read-only client for the Google Health API v4.
package googlehealth

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/oauth2"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth/auth"
)

// DefaultBaseURL is the Google Health API v4 endpoint.
const DefaultBaseURL = "https://health.googleapis.com/v4"

const (
	// maxAttempts bounds the requests of one call that keeps failing with
	// 429, 5xx or a network error: the first try plus three retries.
	maxAttempts = 4
	// firstBackoff doubles on each retry: 1s, 2s, 4s.
	firstBackoff = time.Second
	// maxRetryAfter is the longest server-requested wait honored; a longer
	// one fails the call instead of stalling a tool call for minutes.
	maxRetryAfter = 8 * time.Second
	// maxResponseBytes bounds one response body.
	maxResponseBytes = 32 << 20
	// defaultMaxPages bounds pagination against a server that never stops
	// returning a next page token.
	defaultMaxPages = 200
	// maxTotalBytes bounds the responses of one call across all its pages.
	maxTotalBytes  = 64 << 20
	requestTimeout = 30 * time.Second
)

// TokenSource supplies access tokens. Invalidate reports a token the API
// rejected, so the next Token call renews it, and says whether it did: a token
// already replaced is left alone (auth.TokenSource).
type TokenSource interface {
	Token() (*oauth2.Token, error)
	Invalidate(rejected string) bool
}

// Options configures a Client. TimeZone is required: local days are turned
// into UTC instants for physical-time filters.
type Options struct {
	BaseURL    string       // default DefaultBaseURL
	HTTPClient *http.Client // default: a client with a 30s timeout
	TimeZone   *time.Location
	Logger     *slog.Logger // nil discards
}

// Client reads data points. It is safe for concurrent use.
type Client struct {
	base          string
	http          *http.Client
	ts            TokenSource
	loc           *time.Location
	log           *slog.Logger
	maxPages      int
	maxTotalBytes int
	// Swappable so tests run the retry loop without real time.
	wait   func(ctx context.Context, d time.Duration) error
	jitter func(time.Duration) time.Duration
}

// New returns a client. It makes no request and reads no file.
func New(ts TokenSource, opts Options) (*Client, error) {
	if ts == nil {
		return nil, errors.New("googlehealth: nil token source")
	}
	if opts.TimeZone == nil {
		return nil, errors.New("googlehealth: nil time zone")
	}
	base := opts.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	if err := checkBaseURL(base); err != nil {
		return nil, err
	}
	hc := &http.Client{Timeout: requestTimeout}
	if opts.HTTPClient != nil {
		cp := *opts.HTTPClient
		hc = &cp
	}
	// The API never redirects; following one could carry the bearer token to
	// another path, a subdomain or plain http on the same host.
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	log := opts.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Client{
		base: strings.TrimSuffix(base, "/"), http: hc, ts: ts, loc: opts.TimeZone, log: log,
		maxPages: defaultMaxPages, maxTotalBytes: maxTotalBytes, wait: sleepCtx, jitter: equalJitter,
	}, nil
}

// checkBaseURL accepts https, or http only on a loopback host (a local test
// server): over http the bearer token would travel in cleartext.
func checkBaseURL(base string) error {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("googlehealth: invalid base URL (want scheme://host[/path], no user, query or fragment)")
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if h := u.Hostname(); h == "localhost" || net.ParseIP(h).IsLoopback() {
			return nil
		}
		return errors.New("googlehealth: base URL must use https outside loopback")
	default:
		return errors.New("googlehealth: base URL must use https")
	}
}

// List returns the data points of the local days [from, to].
func (c *Client) List(ctx context.Context, dt DataType, from, to coach.LocalDate) ([]json.RawMessage, error) {
	return c.listLike(ctx, dt, opList, "/dataPoints", from, to)
}

// Reconcile returns the data points of [from, to] with overlapping sources
// merged by the API (steps from the watch and the phone counted once).
func (c *Client) Reconcile(ctx context.Context, dt DataType, from, to coach.LocalDate) ([]json.RawMessage, error) {
	return c.listLike(ctx, dt, opReconcile, "/dataPoints:reconcile", from, to)
}

func (c *Client) listLike(ctx context.Context, dt DataType, op operation, suffix string, from, to coach.LocalDate) ([]json.RawMessage, error) {
	info, err := lookup(dt, op)
	if err != nil {
		return nil, err
	}
	f, err := filter(info, from, to, c.loc)
	if err != nil {
		return nil, err
	}
	path := "/users/me/dataTypes/" + string(dt) + suffix
	return c.collect(dt, "dataPoints", func(token string) ([]byte, error) {
		q := url.Values{"filter": {f}, "pageSize": {strconv.Itoa(info.pageSize)}}
		if token != "" {
			q.Set("pageToken", token)
		}
		return c.do(ctx, http.MethodGet, path, q, nil)
	})
}

// DailyRollup returns one aggregate per local day of [from, to]. Ranges longer
// than the API allows per request are split and merged in order.
func (c *Client) DailyRollup(ctx context.Context, dt DataType, from, to coach.LocalDate) ([]json.RawMessage, error) {
	info, err := lookup(dt, opDailyRollup)
	if err != nil {
		return nil, err
	}
	chunks, err := rollupChunks(info, from, to)
	if err != nil {
		return nil, err
	}
	path := "/users/me/dataTypes/" + string(dt) + "/dataPoints:dailyRollUp"
	var all []json.RawMessage
	for _, chunk := range chunks {
		pts, err := c.collect(dt, "rollupDataPoints", func(token string) ([]byte, error) {
			chunk.PageToken = token
			body, err := json.Marshal(chunk)
			if err != nil {
				return nil, err
			}
			return c.do(ctx, http.MethodPost, path, nil, body)
		})
		if err != nil {
			return nil, err
		}
		all = append(all, pts...)
	}
	return all, nil
}

// collect follows next page tokens and concatenates the items under key.
func (c *Client) collect(dt DataType, key string, fetch func(token string) ([]byte, error)) ([]json.RawMessage, error) {
	var all []json.RawMessage
	seen := map[string]bool{}
	token := ""
	total := 0
	for range c.maxPages {
		body, err := fetch(token)
		if err != nil {
			return nil, err
		}
		if total += len(body); total > c.maxTotalBytes {
			return nil, tooMuch(dt)
		}
		var page map[string]json.RawMessage
		if err := json.Unmarshal(body, &page); err != nil || page == nil {
			return nil, badResponse(dt)
		}
		// The API omits an empty list, so {} is a page with no points. Any
		// other key (an error object, a renamed field) means the response is
		// not what this client understands, and reading it as "no data"
		// would hide that.
		for k := range page {
			if k != key && k != "nextPageToken" {
				c.log.Warn("google health response has an unexpected field", "data_type", string(dt), "field", truncate(k, 40))
				return nil, badResponse(dt)
			}
		}
		var items []json.RawMessage
		if raw, ok := page[key]; ok {
			if err := json.Unmarshal(raw, &items); err != nil {
				return nil, badResponse(dt)
			}
		}
		var next string
		if raw, ok := page["nextPageToken"]; ok {
			if err := json.Unmarshal(raw, &next); err != nil {
				return nil, badResponse(dt)
			}
		}
		all = append(all, items...)
		if next == "" {
			return all, nil
		}
		if seen[next] { // the same page again would loop until the page cap
			return nil, badResponse(dt)
		}
		seen[next] = true
		token = next
	}
	return nil, tooMuch(dt)
}

// tooMuch is a range whose data exceeds the page or byte budget.
func tooMuch(dt DataType) error {
	return coach.ToolError{
		Code:    coach.CodeInvalidInput,
		Message: fmt.Sprintf("the date range holds more %s data than one call reads", dt),
		Hint:    "use a shorter date range",
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func badResponse(dt DataType) error {
	return coach.ToolError{
		Code:    coach.CodeUpstreamUnavailable,
		Message: fmt.Sprintf("Google Health returned an unreadable %s response", dt),
		Hint:    "try again in a few minutes",
	}
}

// StatusError is a non-2xx answer: the HTTP status and Google's status enum
// (e.g. PERMISSION_DENIED). The response body is never kept, since it may
// quote request data.
type StatusError struct {
	HTTPStatus int
	Status     string
}

func (e *StatusError) Error() string {
	if e.Status == "" {
		return fmt.Sprintf("Google Health API returned HTTP %d", e.HTTPStatus)
	}
	return fmt.Sprintf("Google Health API returned HTTP %d (%s)", e.HTTPStatus, e.Status)
}

var (
	readPath   = regexp.MustCompile(`^/users/me/dataTypes/([a-z-]+)/dataPoints(:reconcile)?$`)
	rollupPath = regexp.MustCompile(`^/users/me/dataTypes/([a-z-]+)/dataPoints:dailyRollUp$`)
)

// allowed is the read-only guard: dailyRollUp is the only POST, and it reads.
func allowed(method, path string) (DataType, bool) {
	var m []string
	switch method {
	case http.MethodGet:
		m = readPath.FindStringSubmatch(path)
	case http.MethodPost:
		m = rollupPath.FindStringSubmatch(path)
	}
	if m == nil {
		return "", false
	}
	return DataType(m[1]), true
}

// do sends one logical request: it retries 429, 408, 5xx and network errors
// with backoff, and renews the token once on a 401 or a stale-token 403.
func (c *Client) do(ctx context.Context, method, path string, q url.Values, body []byte) ([]byte, error) {
	dt, ok := allowed(method, path)
	if !ok {
		return nil, fmt.Errorf("googlehealth: read-only client refuses %s %s", method, path)
	}
	target := c.base + path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	refreshed := false
	var last error
	for failures := 0; ; {
		tok, err := c.ts.Token()
		if err != nil {
			return nil, err // already a ToolError (auth_expired or upstream_unavailable)
		}
		status, header, respBody, err := c.send(ctx, method, target, tok.AccessToken, body)
		var wait time.Duration // server-requested, from Retry-After
		switch {
		case err != nil:
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			if errors.Is(err, errTooLarge) {
				return nil, fmt.Errorf("%w: %w", tooMuch(dt), err)
			}
			if permanent(err) {
				c.log.Warn("google health API host cannot be used", "data_type", string(dt), "cause", fmt.Sprintf("%T", err))
				return nil, fmt.Errorf("%w: %w", unavailable("Google Health API host could not be found or verified"), err)
			}
			c.log.Warn("google health request did not complete", "data_type", string(dt), "cause", fmt.Sprintf("%T", err))
			last = fmt.Errorf("%w: %w", unavailable("Google Health API could not be reached"), err)
		case status >= 200 && status < 300:
			return respBody, nil
		case !refreshed && (status == http.StatusUnauthorized || (status == http.StatusForbidden && staleScope(respBody))):
			refreshed = true
			if c.ts.Invalidate(tok.AccessToken) {
				c.log.Warn("google health token rejected; renewing", "data_type", string(dt), "http_status", status)
			}
			continue // a renewal is not a failure: no backoff, no attempt used
		case status == http.StatusUnauthorized:
			return nil, fmt.Errorf("%w: %w", coach.ToolError{
				Code:    coach.CodeAuthExpired,
				Message: "Google Health rejected the sign-in",
				Hint:    "run " + auth.LoginCommand,
			}, statusError(status, respBody))
		case status == http.StatusForbidden && statusError(status, respBody).Status != "RESOURCE_EXHAUSTED":
			return nil, fmt.Errorf("%w: %w", coach.ToolError{
				Code:    coach.CodeScopeMissing,
				Message: fmt.Sprintf("Google Health denied access to %s data", dt),
				Hint:    "run " + auth.LoginCommand + " and allow every permission; check the Google Health API is enabled in the Cloud project",
			}, statusError(status, respBody))
		case status == http.StatusTooManyRequests || status == http.StatusRequestTimeout || status >= 500 ||
			status == http.StatusForbidden: // a quota 403 (RESOURCE_EXHAUSTED) is a rate limit
			last = fmt.Errorf("%w: %w", unavailable("Google Health API is unavailable"), statusError(status, respBody))
			if wait = retryAfter(header, time.Now()); wait > maxRetryAfter {
				return nil, last
			}
		default:
			return nil, fmt.Errorf("googlehealth: %s request rejected: %w", dt, statusError(status, respBody))
		}
		if failures++; failures >= maxAttempts {
			return nil, last
		}
		d := max(c.jitter(firstBackoff<<(failures-1)), wait)
		c.log.Warn("google health request failed; retrying", "data_type", string(dt), "http_status", status, "retry", failures, "wait", d)
		if err := c.wait(ctx, d); err != nil {
			return nil, err
		}
	}
}

func (c *Client) send(ctx context.Context, method, target, token string, body []byte) (int, http.Header, []byte, error) {
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body) // rebuilt per attempt, so a retry resends it whole
	}
	req, err := http.NewRequestWithContext(ctx, method, target, r)
	if err != nil {
		return 0, nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		// url.Error's text quotes the request URL (dates, page token); keep only the cause.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return 0, nil, nil, err
	}
	if len(data) > maxResponseBytes {
		return 0, nil, nil, errTooLarge
	}
	return resp.StatusCode, resp.Header, data, nil
}

// errTooLarge is not retried: the same range returns the same size again.
var errTooLarge = fmt.Errorf("response larger than %d bytes", maxResponseBytes)

func unavailable(msg string) coach.ToolError {
	return coach.ToolError{Code: coach.CodeUpstreamUnavailable, Message: msg, Hint: "try again in a few minutes"}
}

var statusEnum = regexp.MustCompile(`^[A-Z][A-Z_]{0,63}$`)

// statusError keeps the error.status enum of an error body, and only when it
// is enum-shaped, so free text from the body never reaches an error.
func statusError(httpStatus int, body []byte) *StatusError {
	var e struct {
		Error struct {
			Status string `json:"status"`
		} `json:"error"`
	}
	se := &StatusError{HTTPStatus: httpStatus}
	if json.Unmarshal(body, &e) == nil && statusEnum.MatchString(e.Error.Status) {
		se.Status = e.Error.Status
	}
	return se
}

// permanent reports a network error that repeats on every attempt: the host
// does not exist or its certificate does not verify.
func permanent(err error) bool {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
		return true
	}
	var certErr *tls.CertificateVerificationError
	var unknownCA x509.UnknownAuthorityError
	var hostErr x509.HostnameError
	return errors.As(err, &certErr) || errors.As(err, &unknownCA) || errors.As(err, &hostErr)
}

// staleScope reports a 403 of the "insufficient authentication scopes" kind.
// An access token can pass the local validity check yet be expired at Google
// (oauth2 allows some clock skew), and the API then answers this 403 instead
// of a 401. A real scope gap repeats after a renewal, so one renewal tells the
// two apart.
func staleScope(body []byte) bool {
	s := string(body)
	return strings.Contains(s, "ACCESS_TOKEN_SCOPE_INSUFFICIENT") ||
		strings.Contains(strings.ToLower(s), "insufficient authentication scopes")
}

// retryAfter parses a Retry-After header in seconds or HTTP-date form; 0 when
// absent or unparseable.
func retryAfter(h http.Header, now time.Time) time.Duration {
	v := strings.TrimSpace(h.Get("Retry-After"))
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(min(max(secs, 0), 86400)) * time.Second // capped: no overflow
	} else if errors.Is(err, strconv.ErrRange) && !strings.HasPrefix(v, "-") {
		return maxRetryAfter + time.Second // too large to parse is too long to wait
	}
	if t, err := http.ParseTime(v); err == nil && t.After(now) {
		return t.Sub(now)
	}
	return 0
}

// equalJitter spreads d over [d/2, d], so clients that failed together do not
// retry together.
func equalJitter(d time.Duration) time.Duration {
	half := d / 2
	return half + rand.N(half+1)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
