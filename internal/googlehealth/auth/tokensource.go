package auth

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"golang.org/x/oauth2"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// refreshTimeout bounds a call to the token endpoint, so a hung connection
// cannot stall every tool call waiting on the token lock.
const refreshTimeout = 30 * time.Second

// TokenSource is an oauth2.TokenSource backed by credentials.json. It renews
// an expired access token, saves every renewal and picks up a new login made
// while the server runs. It is safe for concurrent use.
type TokenSource struct {
	path string
	conf *oauth2.Config
	ctx  context.Context // carries the HTTP client used for renewals
	log  *slog.Logger

	mu    sync.Mutex
	creds Credentials
	file  os.FileInfo // of the file creds were read from or last written to; nil = not loaded
}

// NewTokenSource reads credentials lazily, on the first Token call. ctx is
// used for renewals and may carry an *http.Client under oauth2.HTTPClient;
// without one, a client with a timeout is used. A nil log discards warnings.
func NewTokenSource(ctx context.Context, path string, conf *oauth2.Config, log *slog.Logger) *TokenSource {
	if _, ok := ctx.Value(oauth2.HTTPClient).(*http.Client); !ok {
		ctx = context.WithValue(ctx, oauth2.HTTPClient, &http.Client{Timeout: refreshTimeout})
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &TokenSource{path: path, conf: conf, ctx: ctx, log: log}
}

// Token returns a valid access token. Errors are coach.ToolErrors: auth_expired
// when the user must sign in again, upstream_unavailable when Google's token
// service cannot be reached.
func (s *TokenSource) Token() (*oauth2.Token, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.reload(); err != nil {
		return nil, err
	}
	tok := s.creds.token()
	if tok.Valid() {
		return tok, nil
	}
	tok.Expiry = time.Unix(1, 0) // a zero expiry means "never expires" to oauth2; force the renewal
	fresh, err := s.conf.TokenSource(s.ctx, tok).Token()
	if err != nil {
		return nil, renewalError(err)
	}
	next := s.creds
	next.AccessToken, next.Expiry = fresh.AccessToken, fresh.Expiry
	if fresh.TokenType != "" {
		next.TokenType = fresh.TokenType
	}
	// Google usually omits the refresh token on renewal; the stored one stays valid.
	if fresh.RefreshToken != "" {
		next.RefreshToken = fresh.RefreshToken
	}
	s.creds = next
	s.save()
	return next.token(), nil
}

// reload reads credentials.json when it is not loaded yet or was replaced
// (another process ran auth login). The file is opened once, so the stat and
// the content always describe the same version.
func (s *TokenSource) reload() error {
	f, err := os.Open(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		s.file = nil
		return coach.ToolError{Code: coach.CodeAuthExpired, Message: "not signed in to Google Health", Hint: "run " + LoginCommand}
	}
	if err != nil {
		return fmt.Errorf("open credentials: %w", err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return fmt.Errorf("stat credentials: %w", err)
	}
	if s.file != nil && sameVersion(s.file, fi) {
		return nil
	}
	c, err := decodeCredentials(f, s.path)
	if err != nil {
		return fmt.Errorf("%w: %w", coach.ToolError{
			Code: coach.CodeAuthExpired, Message: "the stored Google sign-in cannot be read", Hint: "run " + LoginCommand,
		}, err)
	}
	s.creds, s.file = c, fi
	return nil
}

// save persists a renewal. A failure keeps the token in memory (the file still
// holds a valid refresh token), so it is logged rather than failing the call.
func (s *TokenSource) save() {
	if err := WriteCredentials(s.path, s.creds); err != nil {
		s.log.Warn("could not save the renewed Google token; it is kept in memory", "err", err)
		return
	}
	if fi, err := os.Stat(s.path); err == nil {
		s.file = fi
	} else {
		// The next call re-reads the file, which holds the renewal just written.
		s.file = nil
	}
}

// sameVersion reports whether a and b describe the same credentials file. An
// atomic replace creates a new file, so the identity check alone catches a new
// login; size and mtime also catch an in-place edit.
func sameVersion(a, b os.FileInfo) bool {
	return os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}

// renewalError maps a failed renewal to a stable code. The token endpoint's
// response body never reaches the message.
func renewalError(err error) error {
	var re *oauth2.RetrieveError
	if errors.As(err, &re) {
		switch {
		case re.ErrorCode == "invalid_grant":
			return fmt.Errorf("%w: %w", coach.ToolError{
				Code:    coach.CodeAuthExpired,
				Message: "the Google sign-in expired or was revoked",
				Hint:    "run " + LoginCommand + " (in Testing mode Google expires it about 7 days after sign-in)",
			}, err)
		case re.Response != nil && re.Response.StatusCode >= 500:
			return fmt.Errorf("%w: %w", unavailable(), err)
		default:
			return fmt.Errorf("%w: %w", coach.ToolError{
				Code:    coach.CodeAuthExpired,
				Message: "Google rejected the token renewal",
				Hint:    "check " + ClientSecretFile + " is the Desktop client used to sign in, then run " + LoginCommand,
			}, err)
		}
	}
	return fmt.Errorf("%w: %w", unavailable(), err)
}

func unavailable() coach.ToolError {
	return coach.ToolError{
		Code:    coach.CodeUpstreamUnavailable,
		Message: "Google's token service could not be reached",
		Hint:    "try again in a few minutes",
	}
}
