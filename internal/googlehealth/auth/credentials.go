package auth

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

// assumedTokenLifetime stands in for a missing expires_in. Google access
// tokens last an hour; a zero expiry would mean "never renew" to oauth2.
const assumedTokenLifetime = time.Hour

// Credentials is the content of credentials.json.
type Credentials struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	TokenType    string    `json:"token_type,omitempty"`
	Expiry       time.Time `json:"expiry"`
	// Scopes are the scopes Google granted, which can be fewer than requested.
	// Empty means Google did not say.
	Scopes []string `json:"scopes,omitempty"`
	// LoginAt is when the user signed in. In Testing mode Google expires the
	// refresh token about 7 days after it.
	LoginAt time.Time `json:"login_at"`
}

// NewCredentials builds the credentials of a fresh login from the token
// response, which normally lists the granted scopes. Without that list the
// scopes stay unknown rather than assumed granted.
func NewCredentials(tok *oauth2.Token, now time.Time) Credentials {
	var granted []string
	if s, ok := tok.Extra("scope").(string); ok {
		granted = strings.Fields(s)
	}
	expiry := tok.Expiry
	if expiry.IsZero() {
		expiry = now.Add(assumedTokenLifetime)
	}
	return Credentials{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		TokenType:    tok.TokenType,
		Expiry:       expiry,
		Scopes:       granted,
		LoginAt:      now,
	}
}

func (c Credentials) token() *oauth2.Token {
	return &oauth2.Token{AccessToken: c.AccessToken, RefreshToken: c.RefreshToken, TokenType: c.TokenType, Expiry: c.Expiry}
}

// ReadCredentials reads credentials.json. A missing file wraps fs.ErrNotExist.
func ReadCredentials(path string) (Credentials, error) {
	f, err := os.Open(path)
	if err != nil {
		return Credentials{}, err
	}
	defer f.Close()
	return decodeCredentials(f, path)
}

func decodeCredentials(r io.Reader, path string) (Credentials, error) {
	var c Credentials
	// The decode error can quote the file, which holds the tokens; only the path is reported.
	if err := json.NewDecoder(r).Decode(&c); err != nil {
		return Credentials{}, fmt.Errorf("credentials %s are not valid JSON", path)
	}
	if c.RefreshToken == "" {
		return Credentials{}, fmt.Errorf("credentials %s hold no refresh token", path)
	}
	return c, nil
}

// WriteCredentials replaces credentials.json atomically with mode 0600, so a
// reader never sees a half-written file, and returns the version written. The
// directory is created with 0700, and an existing one open to group or others
// is narrowed to its owner.
func WriteCredentials(path string, c Credentials) (_ os.FileInfo, err error) {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encode credentials: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create config dir: %w", err)
	}
	if fi, err := os.Stat(dir); err == nil && fi.Mode().Perm()&0o077 != 0 {
		if err := os.Chmod(dir, fi.Mode().Perm()&0o700); err != nil {
			return nil, fmt.Errorf("restrict config dir: %w", err)
		}
	}
	// CreateTemp opens the file with mode 0600.
	tmp, err := os.CreateTemp(dir, ".credentials-*.json")
	if err != nil {
		return nil, fmt.Errorf("create credentials: %w", err)
	}
	defer func() {
		if err != nil {
			_ = os.Remove(tmp.Name()) // best effort: the temp file is 0600 and never read
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return nil, fmt.Errorf("write credentials: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return nil, fmt.Errorf("sync credentials: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return nil, fmt.Errorf("close credentials: %w", err)
	}
	// Stat before the rename: it keeps the file's identity and mtime, and a stat
	// afterwards could see a file another process wrote in between.
	fi, err := os.Stat(tmp.Name())
	if err != nil {
		return nil, fmt.Errorf("stat credentials: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return nil, fmt.Errorf("replace credentials: %w", err)
	}
	return fi, nil
}
