package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/oauth2"
)

// Credentials is the content of credentials.json.
type Credentials struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	TokenType    string    `json:"token_type,omitempty"`
	Expiry       time.Time `json:"expiry"`
	// Scopes are the scopes Google granted, which can be fewer than requested.
	Scopes []string `json:"scopes,omitempty"`
	// LoginAt is when the user signed in. In Testing mode Google expires the
	// refresh token about 7 days after it.
	LoginAt time.Time `json:"login_at"`
}

// NewCredentials builds the credentials of a fresh login. Google lists the
// granted scopes in the token response; without that list the requested ones
// are assumed.
func NewCredentials(tok *oauth2.Token, requested []string, now time.Time) Credentials {
	granted := requested
	if s, ok := tok.Extra("scope").(string); ok && strings.TrimSpace(s) != "" {
		granted = strings.Fields(s)
	}
	return Credentials{
		AccessToken:  tok.AccessToken,
		RefreshToken: tok.RefreshToken,
		TokenType:    tok.TokenType,
		Expiry:       tok.Expiry,
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

func decodeCredentials(f *os.File, path string) (Credentials, error) {
	var c Credentials
	// The decode error can quote the file, which holds the tokens; only the path is reported.
	if err := json.NewDecoder(f).Decode(&c); err != nil {
		return Credentials{}, fmt.Errorf("credentials %s are not valid JSON", path)
	}
	if c.RefreshToken == "" {
		return Credentials{}, fmt.Errorf("credentials %s hold no refresh token", path)
	}
	return c, nil
}

// WriteCredentials replaces credentials.json atomically with mode 0600, so a
// reader never sees a half-written file. The directory is created with 0700.
func WriteCredentials(path string, c Credentials) (err error) {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("encode credentials: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config dir: %w", err)
	}
	// CreateTemp opens the file with mode 0600.
	tmp, err := os.CreateTemp(dir, ".credentials-*.json")
	if err != nil {
		return fmt.Errorf("create credentials: %w", err)
	}
	defer func() {
		if err != nil {
			_ = os.Remove(tmp.Name())
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write credentials: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync credentials: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close credentials: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("replace credentials: %w", err)
	}
	return nil
}
