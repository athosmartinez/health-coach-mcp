package googlehealth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth/auth"
)

var saoPaulo = func() *time.Location {
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		panic(err)
	}
	return loc
}()

// fakeTokens hands out at-0, at-1, ... and renews after Invalidate of the
// current token, like auth.TokenSource.
type fakeTokens struct {
	mu          sync.Mutex
	n           int
	stale       bool
	invalidated []string
	err         error
}

func (f *fakeTokens) Token() (*oauth2.Token, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	if f.stale {
		f.n++
		f.stale = false
	}
	return &oauth2.Token{AccessToken: fmt.Sprintf("at-%d", f.n)}, nil
}

func (f *fakeTokens) Invalidate(rejected string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.invalidated = append(f.invalidated, rejected)
	if rejected == fmt.Sprintf("at-%d", f.n) {
		f.stale = true
	}
}

type request struct {
	method, path, auth string
	query              map[string]string
	body               map[string]any
}

// fakeAPI records every request and answers with the handler of the test.
type fakeAPI struct {
	*httptest.Server
	mu   sync.Mutex
	reqs []request
}

func newFakeAPI(t *testing.T, handle func(w http.ResponseWriter, n int, r request)) *fakeAPI {
	t.Helper()
	a := &fakeAPI{}
	a.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := request{method: r.Method, path: r.URL.Path, auth: r.Header.Get("Authorization"), query: map[string]string{}}
		for k := range r.URL.Query() {
			rec.query[k] = r.URL.Query().Get(k)
		}
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			if err := json.Unmarshal(b, &rec.body); err != nil {
				t.Errorf("request body is not JSON: %q", b)
			}
		}
		a.mu.Lock()
		a.reqs = append(a.reqs, rec)
		n := len(a.reqs)
		a.mu.Unlock()
		handle(w, n, rec)
	}))
	t.Cleanup(a.Close)
	return a
}

func (a *fakeAPI) requests() []request {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]request(nil), a.reqs...)
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, status int, grpcStatus, message string) {
	reply(w, status, map[string]any{"error": map[string]any{"code": status, "status": grpcStatus, "message": message}})
}

func points(ids ...string) []map[string]any {
	out := make([]map[string]any, len(ids))
	for i, id := range ids {
		out[i] = map[string]any{"name": "users/me/dataTypes/steps/dataPoints/" + id}
	}
	return out
}

func names(t *testing.T, raw []json.RawMessage) []string {
	t.Helper()
	out := make([]string, len(raw))
	for i, r := range raw {
		var p struct{ Name string }
		if err := json.Unmarshal(r, &p); err != nil {
			t.Fatal(err)
		}
		out[i] = p.Name[strings.LastIndexByte(p.Name, '/')+1:]
	}
	return out
}

// newTestClient waits no real time between attempts and records each wait.
func newTestClient(t *testing.T, api *fakeAPI, ts TokenSource) (*Client, *[]time.Duration) {
	t.Helper()
	c, err := New(ts, Options{BaseURL: api.URL, TimeZone: saoPaulo})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	waits := &[]time.Duration{}
	c.wait = func(ctx context.Context, d time.Duration) error {
		mu.Lock()
		*waits = append(*waits, d)
		mu.Unlock()
		return ctx.Err()
	}
	c.jitter = func(d time.Duration) time.Duration { return d }
	return c, waits
}

func day(s string) coach.LocalDate { return coach.LocalDate(s) }

func TestNewValidates(t *testing.T) {
	if _, err := New(nil, Options{TimeZone: saoPaulo}); err == nil {
		t.Error("nil token source accepted")
	}
	if _, err := New(&fakeTokens{}, Options{}); err == nil {
		t.Error("nil time zone accepted")
	}
	if _, err := New(&fakeTokens{}, Options{TimeZone: saoPaulo, BaseURL: "://bad"}); err == nil {
		t.Error("bad base URL accepted")
	}
	c, err := New(&fakeTokens{}, Options{TimeZone: saoPaulo})
	if err != nil || c.base != DefaultBaseURL || c.http.Timeout == 0 {
		t.Errorf("defaults: %+v, %v", c, err)
	}
}

func TestListFiltersAndPageSizes(t *testing.T) {
	// The filter strings are the ones the Google Health CLI sends for the same
	// --from 2026-10-01 --to 2026-10-07 (its --dry-run output).
	for _, tc := range []struct {
		dt       DataType
		filter   string
		pageSize string
	}{
		{Sleep, `sleep.interval.civil_end_time >= "2026-10-01T00:00:00" AND sleep.interval.civil_end_time < "2026-10-08T00:00:00"`, "25"},
		{Exercise, `exercise.interval.civil_start_time >= "2026-10-01T00:00:00" AND exercise.interval.civil_start_time < "2026-10-08T00:00:00"`, "25"},
		{Steps, `steps.interval.civil_start_time >= "2026-10-01T00:00:00" AND steps.interval.civil_start_time < "2026-10-08T00:00:00"`, "10000"},
		{NutritionLog, `nutrition_log.interval.civil_start_time >= "2026-10-01T00:00:00" AND nutrition_log.interval.civil_start_time < "2026-10-08T00:00:00"`, "10000"},
		{ActiveZoneMinutes, `active_zone_minutes.interval.civil_start_time >= "2026-10-01T00:00:00" AND active_zone_minutes.interval.civil_start_time < "2026-10-08T00:00:00"`, "10000"},
		{Weight, `weight.sample_time.physical_time >= "2026-10-01T03:00:00Z" AND weight.sample_time.physical_time < "2026-10-08T03:00:00Z"`, "10000"},
		{BodyFat, `body_fat.sample_time.physical_time >= "2026-10-01T03:00:00Z" AND body_fat.sample_time.physical_time < "2026-10-08T03:00:00Z"`, "10000"},
		{HeartRateVariability, `heart_rate_variability.sample_time.physical_time >= "2026-10-01T03:00:00Z" AND heart_rate_variability.sample_time.physical_time < "2026-10-08T03:00:00Z"`, "10000"},
		{DailyRestingHeartRate, `daily_resting_heart_rate.date >= "2026-10-01" AND daily_resting_heart_rate.date < "2026-10-08"`, "10000"},
		{DailyHeartRateVariability, `daily_heart_rate_variability.date >= "2026-10-01" AND daily_heart_rate_variability.date < "2026-10-08"`, "10000"},
	} {
		api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { reply(w, 200, map[string]any{}) })
		c, _ := newTestClient(t, api, &fakeTokens{})
		got, err := c.List(context.Background(), tc.dt, day("2026-10-01"), day("2026-10-07"))
		if err != nil || len(got) != 0 {
			t.Fatalf("%s: List = %v, %v", tc.dt, got, err)
		}
		r := api.requests()[0]
		if r.method != http.MethodGet || r.path != "/users/me/dataTypes/"+string(tc.dt)+"/dataPoints" ||
			r.query["filter"] != tc.filter || r.query["pageSize"] != tc.pageSize || r.auth != "Bearer at-0" {
			t.Errorf("%s: request = %+v", tc.dt, r)
		}
	}
}

func TestPhysicalFilterFollowsTheZoneOffset(t *testing.T) {
	// Before 2019 São Paulo had daylight saving time (-02:00 in summer).
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { reply(w, 200, map[string]any{}) })
	c, _ := newTestClient(t, api, &fakeTokens{})
	if _, err := c.List(context.Background(), Weight, day("2018-12-01"), day("2018-12-01")); err != nil {
		t.Fatal(err)
	}
	want := `weight.sample_time.physical_time >= "2018-12-01T02:00:00Z" AND weight.sample_time.physical_time < "2018-12-02T02:00:00Z"`
	if got := api.requests()[0].query["filter"]; got != want {
		t.Errorf("filter = %s\nwant      %s", got, want)
	}
}

func TestListFollowsPages(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, r request) {
		switch r.query["pageToken"] {
		case "":
			reply(w, 200, map[string]any{"dataPoints": points("a", "b"), "nextPageToken": "p2"})
		case "p2":
			reply(w, 200, map[string]any{"dataPoints": points("c"), "nextPageToken": "p3"})
		case "p3":
			reply(w, 200, map[string]any{"dataPoints": points("d")})
		default:
			t.Errorf("unexpected page token %q", r.query["pageToken"])
		}
	})
	c, _ := newTestClient(t, api, &fakeTokens{})
	got, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-07"))
	if err != nil {
		t.Fatal(err)
	}
	if n := names(t, got); strings.Join(n, ",") != "a,b,c,d" {
		t.Errorf("points = %v", n)
	}
	reqs := api.requests()
	if len(reqs) != 3 {
		t.Fatalf("%d requests, want 3", len(reqs))
	}
	for _, r := range reqs { // every page repeats the filter and the page size
		if r.query["filter"] != reqs[0].query["filter"] || r.query["pageSize"] != "10000" {
			t.Errorf("page request = %+v", r)
		}
	}
}

func TestReconcile(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, r request) {
		if r.query["pageToken"] == "" {
			reply(w, 200, map[string]any{"dataPoints": points("a"), "nextPageToken": "p2"})
			return
		}
		reply(w, 200, map[string]any{"dataPoints": points("b")})
	})
	c, _ := newTestClient(t, api, &fakeTokens{})
	got, err := c.Reconcile(context.Background(), Steps, day("2026-10-01"), day("2026-10-07"))
	if err != nil || strings.Join(names(t, got), ",") != "a,b" {
		t.Fatalf("Reconcile = %v, %v", got, err)
	}
	r := api.requests()[1]
	if r.method != http.MethodGet || r.path != "/users/me/dataTypes/steps/dataPoints:reconcile" ||
		!strings.HasPrefix(r.query["filter"], "steps.interval.civil_start_time >=") || r.query["pageToken"] != "p2" {
		t.Errorf("request = %+v", r)
	}
}

func civil(y, m, d int) map[string]any {
	return map[string]any{"date": map[string]any{"year": float64(y), "month": float64(m), "day": float64(d)}}
}

func TestDailyRollupBodyAndPages(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, r request) {
		if r.body["pageToken"] == nil {
			reply(w, 200, map[string]any{"rollupDataPoints": []map[string]any{{"civilStartTime": "a"}}, "nextPageToken": "p2"})
			return
		}
		reply(w, 200, map[string]any{"rollupDataPoints": []map[string]any{{"civilStartTime": "b"}}})
	})
	c, _ := newTestClient(t, api, &fakeTokens{})
	got, err := c.DailyRollup(context.Background(), Steps, day("2026-10-01"), day("2026-10-07"))
	if err != nil || len(got) != 2 {
		t.Fatalf("DailyRollup = %s, %v", got, err)
	}
	reqs := api.requests()
	want := map[string]any{"start": civil(2026, 10, 1), "end": civil(2026, 10, 8)}
	for i, r := range reqs {
		if r.method != http.MethodPost || r.path != "/users/me/dataTypes/steps/dataPoints:dailyRollUp" ||
			fmt.Sprint(r.body["range"]) != fmt.Sprint(want) || r.body["windowSizeDays"] != float64(1) || r.body["pageSize"] != float64(10000) {
			t.Errorf("request %d = %+v", i, r)
		}
	}
	if reqs[1].body["pageToken"] != "p2" {
		t.Errorf("second page body = %v", reqs[1].body)
	}
}

func TestDailyRollupSplitsLongRanges(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
		reply(w, 200, map[string]any{"rollupDataPoints": []map[string]any{{"chunk": n}}})
	})
	c, _ := newTestClient(t, api, &fakeTokens{})
	// total-calories allows 14 days per request: 28 days are two requests.
	got, err := c.DailyRollup(context.Background(), TotalCalories, day("2026-09-10"), day("2026-10-07"))
	if err != nil || len(got) != 2 {
		t.Fatalf("DailyRollup = %s, %v", got, err)
	}
	reqs := api.requests()
	if len(reqs) != 2 ||
		fmt.Sprint(reqs[0].body["range"]) != fmt.Sprint(map[string]any{"start": civil(2026, 9, 10), "end": civil(2026, 9, 24)}) ||
		fmt.Sprint(reqs[1].body["range"]) != fmt.Sprint(map[string]any{"start": civil(2026, 9, 24), "end": civil(2026, 10, 8)}) {
		t.Errorf("requests = %+v", reqs)
	}
	// Other types allow 90 days.
	api = newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { reply(w, 200, map[string]any{}) })
	c, _ = newTestClient(t, api, &fakeTokens{})
	if _, err := c.DailyRollup(context.Background(), Steps, day("2026-01-01"), day("2026-03-31")); err != nil || len(api.requests()) != 1 {
		t.Errorf("90 days of steps: %d requests, %v", len(api.requests()), err)
	}
	if _, err := c.DailyRollup(context.Background(), Steps, day("2026-01-01"), day("2026-04-01")); err != nil || len(api.requests()) != 3 {
		t.Errorf("91 days of steps: %d requests in all, %v", len(api.requests()), err)
	}
}

func TestOperationsAreCheckedLocally(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { t.Error("a request was sent") })
	c, _ := newTestClient(t, api, &fakeTokens{})
	ctx := context.Background()
	for name, call := range map[string]func() error{
		"rollup of sleep":  func() error { _, err := c.DailyRollup(ctx, Sleep, day("2026-10-01"), day("2026-10-01")); return err },
		"list of calories": func() error { _, err := c.List(ctx, TotalCalories, day("2026-10-01"), day("2026-10-01")); return err },
		"unknown type": func() error {
			_, err := c.List(ctx, DataType("heart-rate"), day("2026-10-01"), day("2026-10-01"))
			return err
		},
		"path in the type": func() error {
			_, err := c.List(ctx, DataType("steps/../x"), day("2026-10-01"), day("2026-10-01"))
			return err
		},
		"to before from":   func() error { _, err := c.List(ctx, Steps, day("2026-10-02"), day("2026-10-01")); return err },
		"invalid date":     func() error { _, err := c.Reconcile(ctx, Steps, day("2026-13-01"), day("2026-10-01")); return err },
		"rollup bad dates": func() error { _, err := c.DailyRollup(ctx, Steps, day("2026-10-02"), day("2026-10-01")); return err },
		"reconcile of rollup-only": func() error {
			_, err := c.Reconcile(ctx, TotalCalories, day("2026-10-01"), day("2026-10-01"))
			return err
		},
	} {
		if err := call(); err == nil {
			t.Errorf("%s: no error", name)
		} else if code := coach.AsToolError(err).Code; code != coach.CodeInternal {
			t.Errorf("%s: code %s, want internal_error (a caller bug, not the user's input)", name, code)
		}
	}
}

func TestRetriesTooManyRequestsAndServerErrors(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
		switch n {
		case 1:
			w.Header().Set("Retry-After", "2")
			apiError(w, 429, "RESOURCE_EXHAUSTED", "quota")
		case 2:
			apiError(w, 503, "UNAVAILABLE", "backend")
		default:
			reply(w, 200, map[string]any{"dataPoints": points("a")})
		}
	})
	c, waits := newTestClient(t, api, &fakeTokens{})
	got, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	if err != nil || len(got) != 1 {
		t.Fatalf("List = %v, %v", got, err)
	}
	// Retry-After (2s) beats the first backoff (1s); then the backoff doubles.
	if fmt.Sprint(*waits) != "[2s 2s]" {
		t.Errorf("waits = %v", *waits)
	}
}

func TestRetriesGiveUp(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
		apiError(w, 500, "INTERNAL", "secret-body-text 72 bpm")
	})
	c, waits := newTestClient(t, api, &fakeTokens{})
	_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	if coach.AsToolError(err).Code != coach.CodeUpstreamUnavailable || len(api.requests()) != maxAttempts {
		t.Errorf("err = %v after %d requests", err, len(api.requests()))
	}
	if fmt.Sprint(*waits) != "[1s 2s 4s]" {
		t.Errorf("waits = %v", *waits)
	}
	if strings.Contains(err.Error(), "secret-body-text") || strings.Contains(err.Error(), "72") {
		t.Errorf("the response body reached the error: %v", err)
	}
	var se *StatusError
	if !errors.As(err, &se) || se.HTTPStatus != 500 || se.Status != "INTERNAL" {
		t.Errorf("status error = %+v", se)
	}
}

func TestLongRetryAfterFailsFast(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
		w.Header().Set("Retry-After", "3600")
		apiError(w, 429, "RESOURCE_EXHAUSTED", "quota")
	})
	c, waits := newTestClient(t, api, &fakeTokens{})
	_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	if coach.AsToolError(err).Code != coach.CodeUpstreamUnavailable || len(api.requests()) != 1 || len(*waits) != 0 {
		t.Errorf("err = %v after %d requests and waits %v", err, len(api.requests()), *waits)
	}
}

func TestUnauthorizedRefreshesOnce(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, r request) {
		if r.auth != "Bearer at-1" {
			apiError(w, 401, "UNAUTHENTICATED", "expired")
			return
		}
		reply(w, 200, map[string]any{"dataPoints": points("a")})
	})
	ts := &fakeTokens{}
	c, waits := newTestClient(t, api, ts)
	got, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	if err != nil || len(got) != 1 {
		t.Fatalf("List = %v, %v", got, err)
	}
	if fmt.Sprint(ts.invalidated) != "[at-0]" || len(*waits) != 0 {
		t.Errorf("invalidated %v, waits %v; want one immediate refresh", ts.invalidated, *waits)
	}
}

func TestUnauthorizedTwiceIsAuthExpired(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { apiError(w, 401, "UNAUTHENTICATED", "revoked") })
	ts := &fakeTokens{}
	c, _ := newTestClient(t, api, ts)
	_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	if te := coach.AsToolError(err); te.Code != coach.CodeAuthExpired || !strings.Contains(te.Hint, "auth login") {
		t.Errorf("err = %+v", te)
	}
	if len(api.requests()) != 2 || len(ts.invalidated) != 1 {
		t.Errorf("%d requests, invalidated %v", len(api.requests()), ts.invalidated)
	}
}

func TestForbidden(t *testing.T) {
	t.Run("scope missing", func(t *testing.T) {
		api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
			apiError(w, 403, "PERMISSION_DENIED", "Request had insufficient authentication scopes.")
		})
		ts := &fakeTokens{}
		c, _ := newTestClient(t, api, ts)
		_, err := c.List(context.Background(), Sleep, day("2026-10-01"), day("2026-10-01"))
		te := coach.AsToolError(err)
		if te.Code != coach.CodeScopeMissing || !strings.Contains(te.Message, "sleep") || !strings.Contains(te.Hint, "auth login") {
			t.Errorf("err = %+v", te)
		}
		// One refresh rules out a stale token; the second 403 is the real answer.
		if len(api.requests()) != 2 || len(ts.invalidated) != 1 {
			t.Errorf("%d requests, invalidated %v", len(api.requests()), ts.invalidated)
		}
	})
	t.Run("stale token", func(t *testing.T) {
		api := newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
			if n == 1 {
				apiError(w, 403, "PERMISSION_DENIED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT")
				return
			}
			reply(w, 200, map[string]any{})
		})
		c, _ := newTestClient(t, api, &fakeTokens{})
		if _, err := c.List(context.Background(), Sleep, day("2026-10-01"), day("2026-10-01")); err != nil {
			t.Errorf("err = %v", err)
		}
	})
	t.Run("policy denial", func(t *testing.T) {
		api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
			apiError(w, 403, "PERMISSION_DENIED", "Health API has not been used in project 123")
		})
		ts := &fakeTokens{}
		c, _ := newTestClient(t, api, ts)
		_, err := c.List(context.Background(), Sleep, day("2026-10-01"), day("2026-10-01"))
		if te := coach.AsToolError(err); te.Code != coach.CodeScopeMissing || len(api.requests()) != 1 || len(ts.invalidated) != 0 {
			t.Errorf("err = %+v after %d requests", te, len(api.requests()))
		}
	})
	t.Run("401 then 403 share one refresh", func(t *testing.T) {
		api := newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
			if n == 1 {
				apiError(w, 401, "UNAUTHENTICATED", "expired")
				return
			}
			apiError(w, 403, "PERMISSION_DENIED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT")
		})
		ts := &fakeTokens{}
		c, _ := newTestClient(t, api, ts)
		_, err := c.List(context.Background(), Sleep, day("2026-10-01"), day("2026-10-01"))
		if te := coach.AsToolError(err); te.Code != coach.CodeScopeMissing || len(api.requests()) != 2 || len(ts.invalidated) != 1 {
			t.Errorf("err = %+v after %d requests, invalidated %v", te, len(api.requests()), ts.invalidated)
		}
	})
}

func TestOtherClientErrorsAreNotRetried(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
		apiError(w, 400, "INVALID_ARGUMENT", "INVALID_DATA_POINT_FILTER near 2026-10-01")
	})
	c, waits := newTestClient(t, api, &fakeTokens{})
	_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	var se *StatusError
	if !errors.As(err, &se) || se.HTTPStatus != 400 || se.Status != "INVALID_ARGUMENT" || len(api.requests()) != 1 || len(*waits) != 0 {
		t.Errorf("err = %v after %d requests", err, len(api.requests()))
	}
	if coach.AsToolError(err).Code != coach.CodeInternal || strings.Contains(err.Error(), "near") {
		t.Errorf("err = %v; want an internal error without the body", err)
	}
}

func TestTokenErrorsPassThrough(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { t.Error("a request was sent") })
	want := coach.ToolError{Code: coach.CodeAuthExpired, Message: "not signed in to Google Health", Hint: "run login"}
	c, waits := newTestClient(t, api, &fakeTokens{err: want})
	_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	if coach.AsToolError(err) != want || len(*waits) != 0 {
		t.Errorf("err = %v, waits %v", err, *waits)
	}
}

func TestNetworkErrors(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {})
	api.Close() // nothing listens any more
	c, waits := newTestClient(t, api, &fakeTokens{})
	_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	if coach.AsToolError(err).Code != coach.CodeUpstreamUnavailable || len(*waits) != maxAttempts-1 {
		t.Errorf("err = %v, waits %v", err, *waits)
	}
}

func TestBadResponses(t *testing.T) {
	for name, body := range map[string]string{
		"not JSON":       `<html>proxy error</html>`,
		"repeated token": `{"dataPoints": [], "nextPageToken": "same"}`,
	} {
		api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
			w.WriteHeader(200)
			_, _ = io.WriteString(w, body)
		})
		c, _ := newTestClient(t, api, &fakeTokens{})
		_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
		if err == nil || coach.AsToolError(err).Code != coach.CodeUpstreamUnavailable || strings.Contains(err.Error(), "proxy error") {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestPageCap(t *testing.T) {
	var n atomic.Int32
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
		reply(w, 200, map[string]any{"dataPoints": points("x"), "nextPageToken": fmt.Sprint("p", n.Add(1))})
	})
	c, _ := newTestClient(t, api, &fakeTokens{})
	c.maxPages = 4
	_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	// More pages than allowed is an error, never a silently short result.
	if err == nil || coach.AsToolError(err).Code != coach.CodeInternal || len(api.requests()) != 4 {
		t.Errorf("err = %v after %d requests", err, len(api.requests()))
	}
}

func TestCancelDuringBackoff(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { apiError(w, 503, "UNAVAILABLE", "") })
	c, err := New(&fakeTokens{}, Options{BaseURL: api.URL, TimeZone: saoPaulo})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	start := time.Now()
	_, err = c.List(ctx, Steps, day("2026-10-01"), day("2026-10-01"))
	if !errors.Is(err, context.Canceled) || time.Since(start) > 400*time.Millisecond {
		t.Errorf("err = %v after %v; want the cancellation, before the first backoff ends", err, time.Since(start))
	}
}

func TestJitterStaysWithinTheBackoff(t *testing.T) {
	for range 100 {
		if d := equalJitter(time.Second); d < time.Second/2 || d > time.Second {
			t.Fatalf("jitter(1s) = %v", d)
		}
	}
}

func TestOnlyReadRequestsLeaveTheClient(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { t.Error("a request was sent") })
	c, _ := newTestClient(t, api, &fakeTokens{})
	for _, r := range []struct{ method, path string }{
		{http.MethodPost, "/users/me/dataTypes/steps/dataPoints"},
		{http.MethodPost, "/users/me/dataTypes/steps/dataPoints:batchDelete"},
		{http.MethodPatch, "/users/me/dataTypes/steps/dataPoints/x"},
		{http.MethodDelete, "/users/me/dataTypes/steps/dataPoints/x"},
		{http.MethodGet, "/users/me/dataTypes/steps/dataPoints:dailyRollUp"},
		{http.MethodPost, "/users/me/dataTypes/steps/dataPoints:rollUp"},
		{http.MethodGet, "/users/me/profile"},
	} {
		if _, err := c.do(context.Background(), r.method, r.path, nil, nil); err == nil || !strings.Contains(err.Error(), "read-only") {
			t.Errorf("%s %s: err = %v", r.method, r.path, err)
		}
	}
}

func TestRetryAfter(t *testing.T) {
	now := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	for v, want := range map[string]time.Duration{
		"":                              0,
		"3":                             3 * time.Second,
		"-5":                            0,
		"soon":                          0,
		"Fri, 16 Oct 2026 12:00:04 GMT": 4 * time.Second,
		"Fri, 16 Oct 2026 11:00:00 GMT": 0, // already past
		"99999999999999999999":          0, // not an int: unparseable
		"9999999999":                    86400 * time.Second,
	} {
		h := http.Header{}
		h.Set("Retry-After", v)
		if got := retryAfter(h, now); got != want {
			t.Errorf("Retry-After %q = %v, want %v", v, got, want)
		}
	}
}

func TestOversizedResponse(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
		_, _ = io.WriteString(w, `{"dataPoints": [`+strings.Repeat(`{},`, maxResponseBytes/3)+`{}]}`)
	})
	c, waits := newTestClient(t, api, &fakeTokens{})
	_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	if coach.AsToolError(err).Code != coach.CodeUpstreamUnavailable || len(*waits) != 0 || len(api.requests()) != 1 {
		t.Errorf("err = %v, waits %v", err, *waits)
	}
}

// The sign-in's token source is what main passes to New.
var _ TokenSource = (*auth.TokenSource)(nil)
