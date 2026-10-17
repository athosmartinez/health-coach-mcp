package auth

import (
	"context"
	"log/slog"
	"path/filepath"
	"sync"

	"golang.org/x/oauth2"
)

// LazyTokenSource loads the OAuth client on the first Token call instead of
// at startup, so the server (and its memory tools) runs without
// client_secret.json. While the file is missing every call returns
// auth_expired with the setup hint, and adding it needs no restart.
type LazyTokenSource struct {
	ctx      context.Context
	dir      string
	endpoint oauth2.Endpoint
	log      *slog.Logger

	mu sync.Mutex
	ts *TokenSource
}

// NewLazyTokenSource reads <configDir>/client_secret.json and credentials.json
// when first needed; see NewTokenSource for ctx and log.
func NewLazyTokenSource(ctx context.Context, configDir string, endpoint oauth2.Endpoint, log *slog.Logger) *LazyTokenSource {
	return &LazyTokenSource{ctx: ctx, dir: configDir, endpoint: endpoint, log: log}
}

func (l *LazyTokenSource) source() (*TokenSource, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ts != nil {
		return l.ts, nil
	}
	conf, err := LoadConfig(filepath.Join(l.dir, ClientSecretFile), l.endpoint)
	if err != nil {
		return nil, err
	}
	l.ts = NewTokenSource(l.ctx, filepath.Join(l.dir, CredentialsFile), conf, l.log)
	return l.ts, nil
}

// Token returns a valid access token (see TokenSource.Token).
func (l *LazyTokenSource) Token() (*oauth2.Token, error) {
	ts, err := l.source()
	if err != nil {
		return nil, err
	}
	return ts.Token()
}

// Invalidate passes the rejection on; before the client is loaded no token
// was handed out, so there is nothing to invalidate.
func (l *LazyTokenSource) Invalidate(rejected string) bool {
	l.mu.Lock()
	ts := l.ts
	l.mu.Unlock()
	return ts != nil && ts.Invalidate(rejected)
}
