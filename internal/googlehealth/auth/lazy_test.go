package auth

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

func TestLazyTokenSourceWaitsForTheClientFile(t *testing.T) {
	dir := t.TempDir()
	g := newFakeGoogle(t)
	l, err := NewLazyTokenSource(context.Background(), dir, g.config().Endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	if l.Invalidate("anything") {
		t.Error("Invalidate before loading reported a change")
	}
	_, err = l.Token()
	if te := coach.AsToolError(err); te.Code != coach.CodeAuthExpired || te.Hint == "" {
		t.Fatalf("no client file: %+v", te)
	}
	// Adding the file and signing in works without a new source.
	secret := `{"installed": {"client_id": "client-synthetic", "client_secret": "secret-synthetic"}}`
	if err := os.WriteFile(filepath.Join(dir, ClientSecretFile), []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Token(); coach.AsToolError(err).Code != coach.CodeAuthExpired {
		t.Errorf("client file but no sign-in: %v", err)
	}
	c := expired()
	c.Expiry = time.Now().Add(time.Hour)
	saved(t, dir, c)
	tok, err := l.Token()
	if err != nil || tok.AccessToken != "at-old" {
		t.Fatalf("Token = %+v, %v", tok, err)
	}
	if !l.Invalidate("at-old") {
		t.Error("Invalidate did not reach the loaded source")
	}
	if tok, err := l.Token(); err != nil || tok.AccessToken != "at-1" {
		t.Errorf("after Invalidate: %+v, %v", tok, err)
	}
}

func TestLazyTokenSourceRejectsRelativeDir(t *testing.T) {
	for _, dir := range []string{"", "config", "./x"} {
		if _, err := NewLazyTokenSource(context.Background(), dir, newFakeGoogle(t).config().Endpoint, nil); err == nil {
			t.Errorf("dir %q accepted", dir)
		}
	}
}

// Concurrent first calls load the client once; run under -race.
func TestLazyTokenSourceConcurrentLoad(t *testing.T) {
	dir := t.TempDir()
	g := newFakeGoogle(t)
	secret := `{"installed": {"client_id": "client-synthetic", "client_secret": "secret-synthetic"}}`
	if err := os.WriteFile(filepath.Join(dir, ClientSecretFile), []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	c := expired()
	c.Expiry = time.Now().Add(time.Hour)
	saved(t, dir, c)
	l, err := NewLazyTokenSource(context.Background(), dir, g.config().Endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	sources := make([]*TokenSource, 8)
	for i := range sources {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := l.Token(); err != nil {
				t.Error(err)
			}
			sources[i], _ = l.source()
		}()
	}
	wg.Wait()
	for _, s := range sources[1:] {
		if s != sources[0] {
			t.Fatal("the client was loaded more than once")
		}
	}
}
