package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/oauth2"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/config"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth/auth"
)

const authUsage = `usage: health-coach-mcp auth <command>

  login    sign in to Google Health in the browser and save the token
  status   show the saved sign-in (scopes, expiry); never prints a token`

// testingModeLifetime is how long Google keeps a refresh token issued by an
// OAuth app in Testing mode.
const testingModeLifetime = 7 * 24 * time.Hour

// authEnv is what the auth subcommands touch, so tests can swap Google and the browser.
type authEnv struct {
	endpoint       oauth2.Endpoint
	open           func(url string) error
	now            func() time.Time
	stdout, stderr io.Writer
}

// authMain runs `health-coach-mcp auth ...` and returns the exit code.
func authMain(args []string) int {
	cfg, err := config.Load(os.Getenv, os.UserHomeDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid configuration:", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runAuth(ctx, args, cfg, authEnv{
		endpoint: auth.Endpoint, open: openBrowser, now: time.Now, stdout: os.Stdout, stderr: os.Stderr,
	})
}

func runAuth(ctx context.Context, args []string, cfg config.Config, env authEnv) int {
	if len(args) != 1 {
		fmt.Fprintln(env.stderr, authUsage)
		return 2
	}
	var err error
	switch args[0] {
	case "login":
		err = authLogin(ctx, cfg, env)
	case "status":
		err = authStatus(cfg, env)
	default:
		fmt.Fprintln(env.stderr, authUsage)
		return 2
	}
	if err != nil {
		printAuthError(env.stderr, err)
		return 1
	}
	return 0
}

func authLogin(ctx context.Context, cfg config.Config, env authEnv) error {
	conf, err := auth.LoadConfig(filepath.Join(cfg.ConfigDir, auth.ClientSecretFile), env.endpoint)
	if err != nil {
		return err
	}
	tok, err := auth.Login(ctx, conf, auth.LoginOptions{Open: env.open, Out: env.stderr})
	if err != nil {
		return err
	}
	creds := auth.NewCredentials(tok, conf.Scopes, env.now())
	path := filepath.Join(cfg.ConfigDir, auth.CredentialsFile)
	if err := auth.WriteCredentials(path, creds); err != nil {
		return err
	}
	fmt.Fprintf(env.stdout, "Signed in. Credentials saved to %s.\n", path)
	if missing := auth.MissingScopes(creds.Scopes); len(missing) > 0 {
		fmt.Fprintf(env.stdout, "Google did not grant %s. Tools that need them return scope_missing; run %s again and tick every box.\n",
			strings.Join(shortScopes(missing), ", "), auth.LoginCommand)
	}
	return nil
}

func authStatus(cfg config.Config, env authEnv) error {
	path := filepath.Join(cfg.ConfigDir, auth.CredentialsFile)
	c, err := auth.ReadCredentials(path)
	if errors.Is(err, fs.ErrNotExist) {
		return coach.ToolError{Code: coach.CodeAuthExpired, Message: "not signed in to Google Health", Hint: "run " + auth.LoginCommand}
	}
	if err != nil {
		return err
	}
	at := func(t time.Time) string { return t.In(cfg.TimeZone).Format("2006-01-02 15:04 MST") }
	w := env.stdout

	fmt.Fprintf(w, "Credentials:   %s\n", path)
	if _, err := os.Stat(filepath.Join(cfg.ConfigDir, auth.ClientSecretFile)); err != nil {
		fmt.Fprintf(w, "OAuth client:  missing %s (renewals will fail)\n", auth.ClientSecretFile)
	}
	if c.LoginAt.IsZero() {
		fmt.Fprintln(w, "Signed in:     unknown")
	} else {
		fmt.Fprintf(w, "Signed in:     %s\n", at(c.LoginAt))
	}
	missing := auth.MissingScopes(c.Scopes)
	fmt.Fprintf(w, "Scopes:        %d of %d granted", len(auth.Scopes)-len(missing), len(auth.Scopes))
	if len(missing) > 0 {
		fmt.Fprintf(w, " (missing: %s)", strings.Join(shortScopes(missing), ", "))
	}
	fmt.Fprintln(w)
	if c.Expiry.After(env.now()) {
		fmt.Fprintf(w, "Access token:  valid until %s (renewed automatically)\n", at(c.Expiry))
	} else {
		fmt.Fprintln(w, "Access token:  expired (renewed on the next call)")
	}
	fmt.Fprintln(w, "Refresh token: present")
	if !c.LoginAt.IsZero() {
		fmt.Fprintf(w, "\nWhile the OAuth app is in Testing mode, Google ends the sign-in about 7 days after it\n(around %s). Run %s again when a tool returns auth_expired.\n",
			at(c.LoginAt.Add(testingModeLifetime)), auth.LoginCommand)
	}
	return nil
}

// printAuthError shows a ToolError as its message and hint; other errors as they are.
func printAuthError(w io.Writer, err error) {
	var te coach.ToolError
	if errors.As(err, &te) {
		fmt.Fprintln(w, "error:", te.Message)
		if te.Hint != "" {
			fmt.Fprintln(w, "hint: ", te.Hint)
		}
		return
	}
	fmt.Fprintln(w, "error:", err)
}

// shortScopes turns full scope URLs into their category, e.g. "sleep".
func shortScopes(scopes []string) []string {
	out := make([]string, len(scopes))
	for i, s := range scopes {
		_, name, _ := strings.Cut(s, "/googlehealth.")
		out[i] = strings.TrimSuffix(name, ".readonly")
	}
	return out
}

// openBrowser opens url in the default browser. The URL is an argument, never
// shell input.
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
