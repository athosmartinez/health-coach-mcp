package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MinTokenLen is the shortest bearer token accepted on a non-loopback bind. At
// 32 random characters online guessing is hopeless, so no rate limiter is needed.
const MinTokenLen = 32

// CheckHTTPBind refuses to expose the server beyond loopback without a strong
// bearer token: every tool returns personal health data. exposed reports whether
// addr is reachable from other machines, so the caller can require or warn about TLS.
func CheckHTTPBind(addr, token string) (exposed bool, err error) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false, fmt.Errorf("invalid -addr %q: %w", addr, err)
	}
	if isLoopback(host) {
		return false, nil
	}
	if token == "" {
		return true, fmt.Errorf("-addr %q is reachable beyond this machine; set HCM_HTTP_TOKEN or bind to 127.0.0.1", addr)
	}
	if len(token) < MinTokenLen {
		return true, fmt.Errorf("HCM_HTTP_TOKEN must be at least %d characters to bind %q beyond loopback", MinTokenLen, addr)
	}
	return true, nil
}

// isLoopback trusts the name "localhost" without resolving it.
func isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// BearerAuth requires "Authorization: Bearer <token>" when token is set. The
// scheme is case-insensitive (RFC 7235). Tokens are compared as SHA-256 digests
// so the comparison is constant-time and does not reveal the token length.
// Failures are logged with the remote address only, never the header.
func BearerAuth(token string, log *slog.Logger, next http.Handler) http.Handler {
	if token == "" {
		return next
	}
	want := sha256.Sum256([]byte(token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scheme, cred, ok := strings.Cut(r.Header.Get("Authorization"), " ")
		got := sha256.Sum256([]byte(cred))
		if !ok || !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare(got[:], want[:]) != 1 {
			log.WarnContext(r.Context(), "auth_failed", "remote_addr", r.RemoteAddr)
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// NewHTTPServer serves s over Streamable HTTP behind BearerAuth. The SDK's DNS
// rebinding protection stays on (it rejects non-loopback Host headers on
// loopback connections). There is no WriteTimeout: it would cut SSE streams.
func NewHTTPServer(addr string, s *mcp.Server, token string, log *slog.Logger) *http.Server {
	mcpHandler := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return s },
		&mcp.StreamableHTTPOptions{SessionTimeout: 30 * time.Minute},
	)
	return &http.Server{
		Addr:              addr,
		Handler:           BearerAuth(token, log, mcpHandler),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
}
