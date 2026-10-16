package auth

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
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
	now  func() time.Time

	mu    sync.Mutex
	creds Credentials
	file  os.FileInfo // version of the file creds were read from or written to; nil = not loaded
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
	return &TokenSource{path: path, conf: conf, ctx: ctx, log: log, now: time.Now}
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
	// The deadline holds even when the caller's HTTP client has no timeout.
	ctx, cancel := context.WithTimeout(s.ctx, refreshTimeout)
	defer cancel()
	fresh, err := s.conf.TokenSource(ctx, tok).Token()
	if err != nil {
		return nil, renewalError(err)
	}
	next := s.creds
	next.AccessToken, next.Expiry = fresh.AccessToken, fresh.Expiry
	if next.Expiry.IsZero() {
		next.Expiry = s.now().Add(assumedTokenLifetime)
	}
	if fresh.TokenType != "" {
		next.TokenType = fresh.TokenType
	}
	// Google usually omits the refresh token on renewal; the stored one stays valid.
	if fresh.RefreshToken != "" {
		next.RefreshToken = fresh.RefreshToken
	}

	// auth login (another process) may have replaced the file during the
	// renewal. The new login wins: saving now would bring back the old sign-in.
	if s.replacedOnDisk() {
		if err := s.reload(); err != nil {
			return nil, err
		}
		if tok := s.creds.token(); tok.Valid() {
			return tok, nil
		}
		return next.token(), nil // valid for this call; the new file is left as written
	}
	s.creds = next
	s.save()
	return next.token(), nil
}

// reload reads credentials.json when it is not loaded yet or was replaced.
// The file is opened once, so the stat and the content describe the same version.
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

// replacedOnDisk reports whether the file is no longer the version s.creds
// came from (a stat failure counts as replaced, so reload decides).
func (s *TokenSource) replacedOnDisk() bool {
	fi, err := os.Stat(s.path)
	return err != nil || s.file == nil || !sameVersion(s.file, fi)
}

// save persists a renewal. A failure keeps the token in memory (the file still
// holds a valid refresh token), so it is logged rather than failing the call.
func (s *TokenSource) save() {
	fi, err := WriteCredentials(s.path, s.creds)
	if err != nil {
		s.log.Warn("could not save the renewed Google token; it is kept in memory", "path", s.path, "err", err)
		return
	}
	s.file = fi
}

// sameVersion reports whether a and b describe the same credentials file. An
// atomic replace creates a new file, so the identity check alone catches a new
// login; size and mtime also catch an in-place edit.
func sameVersion(a, b os.FileInfo) bool {
	return os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}

// endpointError stands in for an *oauth2.RetrieveError, whose text quotes the
// token endpoint's response body. It keeps only the error code and status.
type endpointError struct {
	Code   string
	Status int
}

func (e *endpointError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("token endpoint replied HTTP %d", e.Status)
	}
	return fmt.Sprintf("token endpoint replied HTTP %d (%s)", e.Status, e.Code)
}

// redact replaces a RetrieveError in err with an endpointError; other errors
// (network, timeout) are returned as they are.
func redact(err error) (error, *endpointError) {
	var re *oauth2.RetrieveError
	if !errors.As(err, &re) {
		return err, nil
	}
	ee := &endpointError{Code: safeCode(re.ErrorCode)}
	if re.Response != nil {
		ee.Status = re.Response.StatusCode
	}
	return ee, ee
}

// safeCode keeps an OAuth error code only when it looks like one (RFC 6749
// codes are short ASCII words), so arbitrary response text never gets through.
func safeCode(code string) string {
	if len(code) > 64 {
		return ""
	}
	for _, r := range code {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-' && r != '.' {
			return ""
		}
	}
	return code
}

// renewalError maps a failed renewal to a stable code; the endpoint's
// response body is dropped (see redact).
func renewalError(err error) error {
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("token renewal cancelled: %w", err)
	}
	cause, ee := redact(err)
	if ee == nil {
		var ne net.Error
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
			return fmt.Errorf("%w: %w", unavailable("Google's token service did not answer in time"), cause)
		}
		return fmt.Errorf("%w: %w", unavailable("Google's token service could not be reached"), cause)
	}
	switch {
	case ee.Code == "invalid_grant":
		return fmt.Errorf("%w: %w", coach.ToolError{
			Code:    coach.CodeAuthExpired,
			Message: "the Google sign-in expired or was revoked",
			Hint:    "run " + LoginCommand + " (in Testing mode Google expires it about 7 days after sign-in)",
		}, cause)
	case ee.Status == http.StatusRequestTimeout || ee.Status == http.StatusTooManyRequests || ee.Status >= 500:
		return fmt.Errorf("%w: %w", unavailable("Google's token service is unavailable ("+ee.Error()+")"), cause)
	default:
		return fmt.Errorf("%w: %w", coach.ToolError{
			Code:    coach.CodeAuthExpired,
			Message: "Google rejected the token renewal (" + ee.Error() + ")",
			Hint:    "check " + ClientSecretFile + " is the Desktop client used to sign in, then run " + LoginCommand,
		}, cause)
	}
}

func unavailable(msg string) coach.ToolError {
	return coach.ToolError{Code: coach.CodeUpstreamUnavailable, Message: msg, Hint: "try again in a few minutes"}
}
