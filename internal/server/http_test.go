package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCheckHTTPBind(t *testing.T) {
	cases := []struct {
		addr, token string
		ok          bool
	}{
		{"127.0.0.1:8787", "", true},
		{"localhost:8787", "", true},
		{"[::1]:8787", "", true},
		{"0.0.0.0:8787", "", false},
		{":8787", "", false},
		{"192.168.0.10:8787", "", false},
		{"0.0.0.0:8787", "tok", true},
		{"not-an-addr", "", false},
	}
	for _, c := range cases {
		err := CheckHTTPBind(c.addr, c.token)
		if (err == nil) != c.ok {
			t.Errorf("CheckHTTPBind(%q, token=%v) err = %v, want ok=%v", c.addr, c.token != "", err, c.ok)
		}
	}
}

func TestBearerAuth(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	h := BearerAuth("tok", next)

	cases := map[string]int{
		"":           http.StatusUnauthorized,
		"Bearer bad": http.StatusUnauthorized,
		"tok":        http.StatusUnauthorized,
		"Bearer tok": http.StatusNoContent,
	}
	for header, want := range cases {
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		if header != "" {
			req.Header.Set("Authorization", header)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("Authorization %q → %d, want %d", header, rec.Code, want)
		}
	}
}

func TestBearerAuthDisabledWithoutToken(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	rec := httptest.NewRecorder()
	BearerAuth("", next).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/", nil))
	if rec.Code != http.StatusNoContent {
		t.Errorf("no token configured should pass through, got %d", rec.Code)
	}
}
