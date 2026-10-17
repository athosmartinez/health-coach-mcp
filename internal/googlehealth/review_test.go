package googlehealth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth/auth"
)

func list(c *Client) error {
	_, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-07"))
	return err
}

func TestUnexpectedPageShapes(t *testing.T) {
	for body, wantErr := range map[string]bool{
		`{}`:                                      false, // the API omits an empty list
		`{"nextPageToken": ""}`:                   false,
		`null`:                                    true,
		`{"error": {"code": 500}}`:                true,
		`{"data_points": [{"a": 1}]}`:             true,
		`{"dataPoints": {}}`:                      true,
		`{"dataPoints": [], "nextPageToken": 7}`:  true,
		`{"dataPoints": [], "newField": 1}`:       false, // a field added by Google does not drop the data
		`{"dataPoints": [], "pageToken": "p2"}`:   true,  // a renamed continuation would end the range early
		`{"dataPoints": [], "nextCursor": "p2"}`:  true,
		`{"dataPoints": [], "next_page": "p2"}`:   true,
		`{"dataPoints": [], "hasMore": true}`:     true,
		`{"dataPoints": [], "continuation": "x"}`: true,
		`{"dataPoints": [], "OFFSET": 25}`:        true,
		`{"dataPoints": [], "truncated": true}`:   true,
		`{"dataPoints": [], "remaining": 3}`:      true,
	} {
		api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
			w.WriteHeader(200)
			_, _ = w.Write([]byte(body))
		})
		c, _ := newTestClient(t, api, &fakeTokens{})
		err := list(c)
		if wantErr != (err != nil) || (err != nil && coach.AsToolError(err).Code != coach.CodeUpstreamUnavailable) {
			t.Errorf("%s: err = %v, want error %v", body, err, wantErr)
		}
	}
}

func TestErrorsNeverQuoteTheBody(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 429, 500} {
		for _, grpc := range []string{"secret 72 bpm", "lowercase", strings.Repeat("A", 65)} {
			api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
				apiError(w, status, grpc, "secret message 72 bpm")
			})
			c, _ := newTestClient(t, api, &fakeTokens{})
			err := list(c)
			var se *StatusError
			if err == nil || !errors.As(err, &se) || se.Status != "" || se.HTTPStatus != status {
				t.Errorf("%d %q: err = %v, status error %+v", status, grpc, err, se)
				continue
			}
			te := coach.AsToolError(err)
			for _, text := range []string{err.Error(), te.Message, te.Hint} {
				if strings.Contains(text, "secret") || strings.Contains(text, "72") || strings.Contains(text, "AAAA") {
					t.Errorf("%d %q: the body reached %q", status, grpc, text)
				}
			}
		}
	}
}

func TestNetworkErrorTextHasNoURL(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close() // the connection drops before any answer
		}
	})
	c, waits := newTestClient(t, api, &fakeTokens{})
	err := list(c)
	if coach.AsToolError(err).Code != coach.CodeUpstreamUnavailable || len(*waits) != maxAttempts-1 {
		t.Fatalf("err = %v, waits %v", err, *waits)
	}
	for _, s := range []string{"filter", "pageSize", "2026", "dataPoints", api.URL} {
		if strings.Contains(err.Error(), s) {
			t.Errorf("error text quotes the request (%q): %v", s, err)
		}
	}
}

func TestDroppedConnectionAnd408Recover(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
		switch n {
		case 1:
			if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
				conn.Close()
			}
		case 2:
			apiError(w, 408, "DEADLINE_EXCEEDED", "")
		default:
			reply(w, 200, map[string]any{"dataPoints": points("a")})
		}
	})
	c, waits := newTestClient(t, api, &fakeTokens{})
	if err := list(c); err != nil || fmt.Sprint(*waits) != "[1s 2s]" {
		t.Errorf("err = %v, waits %v", err, *waits)
	}
}

func TestRedirectsAreRefused(t *testing.T) {
	var reached atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Store(true)
		reply(w, 200, map[string]any{})
	}))
	t.Cleanup(other.Close)
	for _, target := range []string{other.URL + "/elsewhere", "/users/me/dataTypes/steps/dataPoints"} {
		api := newFakeAPI(t, func(w http.ResponseWriter, n int, r request) {
			if n > 1 {
				t.Errorf("the redirect was followed to %s", r.path)
			}
			loc := target
			if strings.HasPrefix(loc, "/") {
				loc += "?again=1"
			}
			w.Header().Set("Location", loc)
			w.WriteHeader(http.StatusTemporaryRedirect)
		})
		c, _ := newTestClient(t, api, &fakeTokens{})
		if err := list(c); err == nil {
			t.Errorf("redirect to %s: no error", target)
		}
	}
	// A caller's HTTP client gets the same policy, without being changed.
	caller := &http.Client{}
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
		w.Header().Set("Location", other.URL)
		w.WriteHeader(http.StatusFound)
	})
	c, err := New(&fakeTokens{}, Options{BaseURL: api.URL, TimeZone: saoPaulo, HTTPClient: caller})
	if err != nil {
		t.Fatal(err)
	}
	if err := list(c); err == nil || caller.CheckRedirect != nil {
		t.Errorf("err = %v, caller client changed: %v", err, caller.CheckRedirect != nil)
	}
	if reached.Load() {
		t.Error("a redirect reached the other server")
	}
}

func TestBaseURLRules(t *testing.T) {
	for base, ok := range map[string]bool{
		"https://health.googleapis.com/v4":  true,
		"https://health.googleapis.com/v4/": true,
		"http://127.0.0.1:8080":             true,
		"http://localhost:8080/v4":          true,
		"http://[::1]:8080":                 true,
		"http://health.googleapis.com/v4":   false,
		"http://192.168.0.10:8080":          false,
		"ftp://health.googleapis.com":       false,
		"https://user:pw@health.example":    false,
		"https://health.example/v4?key=x":   false,
		"https://health.example/v4#frag":    false,
		"https:///v4":                       false,
	} {
		_, err := New(&fakeTokens{}, Options{BaseURL: base, TimeZone: saoPaulo})
		if ok != (err == nil) {
			t.Errorf("%s: err = %v", base, err)
		}
		if err != nil && strings.Contains(err.Error(), "pw") {
			t.Errorf("%s: error echoes the URL: %v", base, err)
		}
	}
	// A trailing slash does not double the path separator.
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { reply(w, 200, map[string]any{}) })
	c, err := New(&fakeTokens{}, Options{BaseURL: api.URL + "/", TimeZone: saoPaulo})
	if err != nil || list(c) != nil || api.requests()[0].path != "/users/me/dataTypes/steps/dataPoints" {
		t.Errorf("trailing slash: %v, %+v", err, api.requests())
	}
}

func TestPermanentNetworkErrorsFailFast(t *testing.T) {
	// A TLS server whose certificate no system root signs.
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { reply(w, 200, map[string]any{}) }))
	srv.Config.ErrorLog = log.New(io.Discard, "", 0) // the failed handshake is the point
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c, err := New(&fakeTokens{}, Options{BaseURL: srv.URL, TimeZone: saoPaulo})
	if err != nil {
		t.Fatal(err)
	}
	var waits int
	c.wait = func(context.Context, time.Duration) error { waits++; return nil }
	err = list(c)
	if te := coach.AsToolError(err); te.Code != coach.CodeUpstreamUnavailable || !strings.Contains(te.Message, "verified") || waits != 0 {
		t.Errorf("err = %v after %d waits", err, waits)
	}
	if !permanent(&net.DNSError{Err: "no such host", Name: "health.invalid", IsNotFound: true}) || permanent(errors.New("connection reset")) ||
		permanent(&net.DNSError{Err: "server misbehaving", Name: "health.invalid", IsTemporary: true}) {
		t.Error("permanent() misclassifies")
	}
}

func TestQuotaForbiddenIsRetried(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
		if n == 1 {
			apiError(w, 403, "RESOURCE_EXHAUSTED", "Quota exceeded")
			return
		}
		reply(w, 200, map[string]any{"dataPoints": points("a")})
	})
	ts := &fakeTokens{}
	c, waits := newTestClient(t, api, ts)
	if err := list(c); err != nil || len(*waits) != 1 || len(ts.invalidated) != 0 {
		t.Errorf("err = %v, waits %v, invalidated %v", err, *waits, ts.invalidated)
	}
}

func TestRenewalDoesNotUseARetry(t *testing.T) {
	for name, seq := range map[string][]int{
		"401 first":  {401, 503, 503, 503, 200},
		"401 middle": {503, 401, 503, 503, 200},
	} {
		api := newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
			if seq[n-1] == 200 {
				reply(w, 200, map[string]any{"dataPoints": points("a")})
				return
			}
			apiError(w, seq[n-1], "X", "")
		})
		c, waits := newTestClient(t, api, &fakeTokens{})
		if err := list(c); err != nil || fmt.Sprint(*waits) != "[1s 2s 4s]" || len(api.requests()) != 5 {
			t.Errorf("%s: err = %v, waits %v, %d requests", name, err, *waits, len(api.requests()))
		}
	}
}

func TestRenewalBudgetIsPerPage(t *testing.T) {
	// A token can expire in the middle of a long fetch: each page may renew once.
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, r request) {
		switch {
		case r.query["pageToken"] == "":
			reply(w, 200, map[string]any{"dataPoints": points("a"), "nextPageToken": "p2"})
		case r.auth == "Bearer at-0":
			apiError(w, 401, "UNAUTHENTICATED", "")
		case r.query["pageToken"] == "p2":
			reply(w, 200, map[string]any{"dataPoints": points("b"), "nextPageToken": "p3"})
		default:
			reply(w, 200, map[string]any{"dataPoints": points("c")})
		}
	})
	ts := &fakeTokens{}
	c, _ := newTestClient(t, api, ts)
	got, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-07"))
	if err != nil || strings.Join(names(t, got), ",") != "a,b,c" || fmt.Sprint(ts.invalidated) != "[at-0]" {
		t.Errorf("points %v, err %v, invalidated %v", got, err, ts.invalidated)
	}
	if last := api.requests()[len(api.requests())-1]; last.auth != "Bearer at-1" {
		t.Errorf("last page sent %s", last.auth)
	}
}

func TestRetryAfterLimits(t *testing.T) {
	for _, tc := range []struct {
		status     int
		header     string
		waits      string
		requests   int
		wantFailed bool
	}{
		{429, "8", "[8s]", 2, false},
		{429, "9", "[]", 1, true},
		{503, "9", "[]", 1, true},
		{503, "5", "[5s 2s]", 3, false}, // the next wait is the plain backoff again
		{503, time.Now().Add(time.Hour).UTC().Format(http.TimeFormat), "[]", 1, true},
	} {
		api := newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
			switch n {
			case 1:
				w.Header().Set("Retry-After", tc.header)
				apiError(w, tc.status, "UNAVAILABLE", "")
			case 2:
				apiError(w, 503, "UNAVAILABLE", "")
			default:
				reply(w, 200, map[string]any{})
			}
		})
		c, waits := newTestClient(t, api, &fakeTokens{})
		if tc.waits == "[8s]" { // only one failure in this case
			api = newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
				if n == 1 {
					w.Header().Set("Retry-After", tc.header)
					apiError(w, tc.status, "RESOURCE_EXHAUSTED", "")
					return
				}
				reply(w, 200, map[string]any{})
			})
			c, waits = newTestClient(t, api, &fakeTokens{})
		}
		err := list(c)
		if (err != nil) != tc.wantFailed || fmt.Sprint(*waits) != tc.waits || len(api.requests()) != tc.requests {
			t.Errorf("%d Retry-After %s: err = %v, waits %v, %d requests", tc.status, tc.header, err, *waits, len(api.requests()))
		}
	}
}

func TestCancelInFlight(t *testing.T) {
	release := make(chan struct{})
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) { <-release })
	t.Cleanup(func() { close(release) }) // runs before the server's Close, which waits for the handler
	c, waits := newTestClient(t, api, &fakeTokens{})
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	_, err := c.List(ctx, Steps, day("2026-10-01"), day("2026-10-01"))
	if !errors.Is(err, context.Canceled) || len(*waits) != 0 || len(api.requests()) != 1 {
		t.Errorf("err = %v, waits %v, %d requests", err, *waits, len(api.requests()))
	}
}

func TestTotalBytesCap(t *testing.T) {
	var n atomic.Int32
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
		reply(w, 200, map[string]any{"dataPoints": points("x"), "nextPageToken": fmt.Sprint("p", n.Add(1))})
	})
	c, _ := newTestClient(t, api, &fakeTokens{})
	page, _ := json.Marshal(map[string]any{"dataPoints": points("x"), "nextPageToken": "p1"})
	c.maxTotalBytes = 2*(len(page)+1) + 1 // two pages (Encode adds a newline) fit, the third does not
	err := list(c)
	if te := coach.AsToolError(err); te.Code != coach.CodeInvalidInput || len(api.requests()) != 3 {
		t.Errorf("err = %v after %d requests", err, len(api.requests()))
	}
}

func TestRollupPagesWithinChunks(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, n int, r request) {
		start := fmt.Sprint(r.body["range"].(map[string]any)["start"])
		switch {
		case strings.Contains(start, "day:10") && r.body["pageToken"] == nil:
			reply(w, 200, map[string]any{"rollupDataPoints": []map[string]any{{"p": "1a"}}, "nextPageToken": "c1p2"})
		case strings.Contains(start, "day:10"):
			reply(w, 200, map[string]any{"rollupDataPoints": []map[string]any{{"p": "1b"}}})
		default:
			if r.body["pageToken"] != nil {
				t.Errorf("chunk 2 carried a page token from chunk 1: %v", r.body)
			}
			reply(w, 200, map[string]any{"rollupDataPoints": []map[string]any{{"p": "2a"}}})
		}
	})
	c, _ := newTestClient(t, api, &fakeTokens{})
	got, err := c.DailyRollup(context.Background(), TotalCalories, day("2026-09-10"), day("2026-10-07"))
	if err != nil || fmt.Sprintf("%s", got) != `[{"p":"1a"} {"p":"1b"} {"p":"2a"}]` || len(api.requests()) != 3 {
		t.Errorf("points %s, err %v, %d requests", got, err, len(api.requests()))
	}
	// A failure in a later chunk returns nothing, not the earlier chunks.
	api = newFakeAPI(t, func(w http.ResponseWriter, n int, _ request) {
		if n == 1 {
			reply(w, 200, map[string]any{"rollupDataPoints": []map[string]any{{"p": "1a"}}})
			return
		}
		apiError(w, 400, "INVALID_ARGUMENT", "")
	})
	c, _ = newTestClient(t, api, &fakeTokens{})
	if got, err := c.DailyRollup(context.Background(), TotalCalories, day("2026-09-10"), day("2026-10-07")); err == nil || got != nil {
		t.Errorf("partial result %s, err %v", got, err)
	}
}

func TestRollupChunkBoundaries(t *testing.T) {
	ranges := func(dt DataType, from, to string) string {
		t.Helper()
		chunks, err := rollupChunks(typeTable[dt], day(from), day(to))
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, ch := range chunks {
			s, e := ch.Range.Start.Date, ch.Range.End.Date
			out = append(out, fmt.Sprintf("%04d-%02d-%02d..%04d-%02d-%02d", s.Year, s.Month, s.Day, e.Year, e.Month, e.Day))
		}
		return strings.Join(out, " ")
	}
	for _, tc := range []struct {
		dt       DataType
		from, to string
		want     string
	}{
		{TotalCalories, "2026-10-01", "2026-10-01", "2026-10-01..2026-10-02"},
		{TotalCalories, "2026-10-01", "2026-10-14", "2026-10-01..2026-10-15"},
		{TotalCalories, "2026-10-01", "2026-10-15", "2026-10-01..2026-10-15 2026-10-15..2026-10-16"},
		{TotalCalories, "2026-12-25", "2027-01-10", "2026-12-25..2027-01-08 2027-01-08..2027-01-11"},
		{TotalCalories, "2028-02-20", "2028-03-05", "2028-02-20..2028-03-05 2028-03-05..2028-03-06"},
		{Steps, "2026-01-01", "2026-04-01", "2026-01-01..2026-04-01 2026-04-01..2026-04-02"},
	} {
		if got := ranges(tc.dt, tc.from, tc.to); got != tc.want {
			t.Errorf("%s %s..%s = %s\nwant %s", tc.dt, tc.from, tc.to, got, tc.want)
		}
	}
}

func TestTypeTable(t *testing.T) {
	const L, R, D = opList, opReconcile, opDailyRollup
	want := map[DataType]struct {
		kind      filterKind
		ops       operation
		page, cap int
	}{
		Sleep:                     {civilEnd, L | R, 25, 0},
		HeartRateVariability:      {physical, L | R, 10000, 0},
		DailyHeartRateVariability: {date, L | R, 10000, 0},
		DailyRestingHeartRate:     {date, L | R, 10000, 0},
		Steps:                     {civilStart, L | R | D, 10000, 90},
		ActiveZoneMinutes:         {civilStart, L | R | D, 10000, 90},
		Exercise:                  {civilStart, L | R, 25, 0},
		NutritionLog:              {civilStart, L | R | D, 10000, 90},
		TotalCalories:             {civilStart, D, 10000, 14},
		Weight:                    {physical, L | R | D, 10000, 90},
		BodyFat:                   {physical, L | R | D, 10000, 90},
	}
	if len(typeTable) != len(want) {
		t.Errorf("%d types, want %d", len(typeTable), len(want))
	}
	for dt, w := range want {
		got := typeTable[dt]
		if got.kind != w.kind || got.ops != w.ops || got.pageSize != w.page || got.rollupDays != w.cap ||
			got.filterName != strings.ReplaceAll(string(dt), "-", "_") {
			t.Errorf("%s = %+v, want %+v", dt, got, w)
		}
		if (w.ops&D != 0) != (w.cap > 0) {
			t.Errorf("%s: a rollup type needs a range cap", dt)
		}
	}
}

func TestRequestHeaders(t *testing.T) {
	var accept, ctype []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accept, ctype = append(accept, r.Header.Get("Accept")), append(ctype, r.Header.Get("Content-Type"))
		reply(w, 200, map[string]any{})
	}))
	t.Cleanup(srv.Close)
	c, err := New(&fakeTokens{}, Options{BaseURL: srv.URL, TimeZone: saoPaulo})
	if err != nil {
		t.Fatal(err)
	}
	_ = list(c)
	_, _ = c.DailyRollup(context.Background(), Steps, day("2026-10-01"), day("2026-10-01"))
	if fmt.Sprint(accept) != "[application/json application/json]" || fmt.Sprint(ctype) != "[ application/json]" {
		t.Errorf("Accept %q, Content-Type %q", accept, ctype)
	}
}

func TestWithTheRealTokenSource(t *testing.T) {
	setup := func(t *testing.T, accept string) (*Client, *atomic.Int32, *fakeAPI) {
		var renewals atomic.Int32
		tokenEndpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			renewals.Add(1)
			reply(w, 200, map[string]any{"access_token": "at-new", "token_type": "Bearer", "expires_in": 3600})
		}))
		t.Cleanup(tokenEndpoint.Close)
		path := filepath.Join(t.TempDir(), auth.CredentialsFile)
		if _, err := auth.WriteCredentials(path, auth.Credentials{
			AccessToken: "at-old", RefreshToken: "rt-synthetic", TokenType: "Bearer", Expiry: time.Now().Add(time.Hour), Scopes: auth.Scopes,
		}); err != nil {
			t.Fatal(err)
		}
		conf := &oauth2.Config{ClientID: "id-synthetic", Endpoint: oauth2.Endpoint{TokenURL: tokenEndpoint.URL, AuthStyle: oauth2.AuthStyleInParams}}
		ts := auth.NewTokenSource(context.Background(), path, conf, nil)
		api := newFakeAPI(t, func(w http.ResponseWriter, _ int, r request) {
			if r.auth != "Bearer "+accept {
				apiError(w, 401, "UNAUTHENTICATED", "")
				return
			}
			reply(w, 200, map[string]any{"dataPoints": points("a")})
		})
		c, _ := newTestClient(t, api, ts)
		return c, &renewals, api
	}
	t.Run("revoked token renewed", func(t *testing.T) {
		c, renewals, api := setup(t, "at-new")
		if err := list(c); err != nil || renewals.Load() != 1 || len(api.requests()) != 2 {
			t.Errorf("err = %v, %d renewals, %d requests", err, renewals.Load(), len(api.requests()))
		}
	})
	t.Run("renewed token rejected too", func(t *testing.T) {
		c, renewals, _ := setup(t, "never")
		if err := list(c); coach.AsToolError(err).Code != coach.CodeAuthExpired || renewals.Load() != 1 {
			t.Errorf("err = %v, %d renewals", err, renewals.Load())
		}
	})
}

// A rejected request is logged with its HTTP status and Google's enum, never
// the body.
func TestRejectedRequestIsLogged(t *testing.T) {
	api := newFakeAPI(t, func(w http.ResponseWriter, _ int, _ request) {
		apiError(w, 400, "INVALID_ARGUMENT", "filter near 2026-10-01")
	})
	c, _ := newTestClient(t, api, &fakeTokens{})
	var buf bytes.Buffer
	c.log = slog.New(slog.NewTextHandler(&buf, nil))
	if _, err := c.List(context.Background(), Steps, day("2026-10-01"), day("2026-10-01")); err == nil {
		t.Fatal("no error")
	}
	out := buf.String()
	for _, want := range []string{"request rejected", "data_type=steps", "http_status=400", "google_status=INVALID_ARGUMENT"} {
		if !strings.Contains(out, want) {
			t.Errorf("log %q lacks %q", out, want)
		}
	}
	if strings.Contains(out, "near") {
		t.Errorf("log quotes the body: %q", out)
	}
}
