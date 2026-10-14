package server

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/tools"
)

var strongToken = strings.Repeat("k", MinTokenLen)

func TestCheckHTTPBind(t *testing.T) {
	cases := []struct {
		addr, token string
		ok, exposed bool
	}{
		{"127.0.0.1:8787", "", true, false},
		{"127.0.0.2:8787", "", true, false},
		{"localhost:8787", "", true, false},
		{"LOCALHOST:8787", "", true, false},
		{"[::1]:8787", "", true, false},
		{"[::1]:0", "", true, false},
		{"[::ffff:127.0.0.1]:8787", "", true, false},
		{"0.0.0.0:8787", "", false, true},
		{":8787", "", false, true},
		{"[::]:8787", "", false, true},
		{"192.168.0.10:8787", "", false, true},
		{"[fe80::1%en0]:8787", "", false, true},
		{"myhost.local:8787", "", false, true},
		{"0.0.0.0:8787", "short", false, true},
		{"0.0.0.0:8787", strongToken, true, true},
		{"[::]:8787", strongToken, true, true},
		{"example.com:80", strongToken, true, true},
		{"not-an-addr", "", false, false},
		{"localhost", "", false, false},
		{"::1:8787", "", false, false},
	}
	for _, c := range cases {
		exposed, err := CheckHTTPBind(c.addr, c.token)
		if (err == nil) != c.ok || exposed != c.exposed {
			t.Errorf("CheckHTTPBind(%q, token len %d) = exposed %v, err %v; want ok=%v exposed=%v",
				c.addr, len(c.token), exposed, err, c.ok, c.exposed)
		}
		if err != nil && c.token != "" && strings.Contains(err.Error(), c.token) {
			t.Errorf("error echoes the token: %v", err)
		}
	}
}

func TestBearerAuth(t *testing.T) {
	logs := &logCapture{}
	calls := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusNoContent)
	})
	h := BearerAuth("tok", slog.New(slog.NewJSONHandler(logs, nil)), next)

	cases := []struct {
		headers []string
		ok      bool
	}{
		{nil, false},
		{[]string{"Bearer bad"}, false},
		{[]string{"tok"}, false},
		{[]string{"Bearer "}, false},
		{[]string{"Bearer  tok"}, false},
		{[]string{"Bearer tok "}, false},
		{[]string{"Basic tok"}, false},
		{[]string{"Bearer to"}, false},
		{[]string{"Bearer tokX"}, false},
		{[]string{"Bearer bad", "Bearer tok"}, false}, // only the first header counts
		{[]string{"Bearer tok"}, true},
		{[]string{"bearer tok"}, true},
		{[]string{"BEARER tok"}, true},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		for _, v := range c.headers {
			req.Header.Add("Authorization", v)
		}
		before := calls
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if c.ok {
			if rec.Code != http.StatusNoContent || calls != before+1 {
				t.Errorf("%q → %d (next called %d), want pass-through", c.headers, rec.Code, calls-before)
			}
			continue
		}
		if rec.Code != http.StatusUnauthorized || calls != before {
			t.Errorf("%q → %d (next called %d), want 401 without reaching next", c.headers, rec.Code, calls-before)
		}
		if rec.Header().Get("WWW-Authenticate") != "Bearer" {
			t.Errorf("%q: missing WWW-Authenticate", c.headers)
		}
	}
	if raw := logs.String(); !strings.Contains(raw, "auth_failed") || strings.Contains(raw, "Bearer") || strings.Contains(raw, "tok") {
		t.Errorf("auth failures must be logged without header contents: %s", raw)
	}
}

func TestBearerAuthDisabledWithoutToken(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	rec := httptest.NewRecorder()
	BearerAuth("", slog.New(slog.NewTextHandler(io.Discard, nil)), next).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec.Code != http.StatusNoContent {
		t.Errorf("no token configured should pass through, got %d", rec.Code)
	}
}

type authTransport struct{ token string }

func (a authTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if a.token != "" {
		r.Header.Set("Authorization", "Bearer "+a.token)
	}
	return http.DefaultTransport.RoundTrip(r)
}

// TestHTTPServerEndToEnd checks the real composition used by main: bearer auth
// in front of the Streamable HTTP handler.
func TestHTTPServerEndToEnd(t *testing.T) {
	srv := NewHTTPServer("127.0.0.1:0", newServer(t, testDeps()), strongToken, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if srv.WriteTimeout != 0 {
		t.Error("WriteTimeout would cut SSE streams")
	}
	if srv.ReadHeaderTimeout == 0 || srv.IdleTimeout == 0 || srv.MaxHeaderBytes == 0 {
		t.Errorf("timeouts not set: %+v", srv)
	}
	endpoint := serveReal(t, srv)

	dial := func(token string) (*mcp.ClientSession, error) {
		transport := &mcp.StreamableClientTransport{
			Endpoint:   endpoint,
			HTTPClient: &http.Client{Transport: authTransport{token}},
		}
		return mcp.NewClient(&mcp.Implementation{Name: "c", Version: "test"}, nil).Connect(context.Background(), transport, nil)
	}

	if cs, err := dial(""); err == nil {
		_ = cs.Close()
		t.Fatal("connected without a token")
	}

	cs, err := dial(strongToken)
	if err != nil {
		t.Fatalf("connect with token: %v", err)
	}
	defer cs.Close()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "server_info"})
	if err != nil || res.IsError {
		t.Fatalf("server_info over HTTP: %v %+v", err, res)
	}
}

// serveReal runs srv itself (not just its handler) so its timeouts apply.
func serveReal(t *testing.T, srv *http.Server) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return "http://" + ln.Addr().String()
}

type slowIn struct {
	Wait string `json:"wait"`
}

// TestHTTPServerDoesNotCancelLongToolCalls guards against server timeouts that
// cancel the request context while a handler is still working (ReadTimeout does
// this on HTTP/1.1: the background reader hits the deadline mid-handler).
func TestHTTPServerDoesNotCancelLongToolCalls(t *testing.T) {
	s := newServer(t, testDeps())
	tools.Register(s, &mcp.Tool{Name: "slow", Description: "test"}, func(ctx context.Context, _ *mcp.CallToolRequest, in slowIn) (map[string]string, error) {
		d, _ := time.ParseDuration(in.Wait)
		select {
		case <-time.After(d):
			return map[string]string{"ok": "yes"}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	})
	srv := NewHTTPServer("127.0.0.1:0", s, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	// Shrink every timeout so a deadline that cuts handlers would fire within the call.
	for _, d := range []*time.Duration{&srv.ReadTimeout, &srv.ReadHeaderTimeout, &srv.IdleTimeout} {
		if *d != 0 {
			*d = 300 * time.Millisecond
		}
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "c", Version: "test"}, nil).
		Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: serveReal(t, srv)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "slow", Arguments: map[string]any{"wait": "900ms"}})
	if err != nil || res.IsError {
		t.Fatalf("long tool call was cut by a server timeout: %v %+v", err, res)
	}
}
