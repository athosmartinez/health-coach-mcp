package server

import (
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"strings"
)

// CheckHTTPBind refuses to expose the server beyond loopback without a bearer
// token: every tool returns personal health data.
func CheckHTTPBind(addr, token string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("invalid -addr %q: %w", addr, err)
	}
	if token != "" || isLoopback(host) {
		return nil
	}
	return fmt.Errorf("-addr %q is reachable beyond this machine; set HCM_HTTP_TOKEN or bind to 127.0.0.1", addr)
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// BearerAuth requires "Authorization: Bearer <token>" when token is set.
func BearerAuth(token string, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	want := []byte(token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || subtle.ConstantTimeCompare([]byte(got), want) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
