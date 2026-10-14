// Package store is the local SQLite store: coach memory (profile, targets,
// health history, labs, preferences, notes) and the daily metrics cache.
package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	// Pure-Go driver: keeps the build cgo-free for cross-compiling.
	_ "modernc.org/sqlite"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

const (
	dateLayout = "2006-01-02"
	// timeLayout is fixed-width (always 9 fractional digits, UTC) so stamps
	// sort and compare correctly as text; RFC3339Nano drops trailing zeros.
	timeLayout = "2006-01-02T15:04:05.000000000Z"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Store wraps the database. It is safe for concurrent use.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

// Open creates (if needed) and migrates the database at path. The directory is
// created 0700 and the file 0600 before SQLite touches it: it holds health
// history and lab results, and SQLite gives the -wal/-shm files the same mode.
func Open(ctx context.Context, path string, now func() time.Time) (*Store, error) {
	return open(ctx, path, now, migrations)
}

func open(ctx context.Context, path string, now func() time.Time, migs fs.FS) (*Store, error) {
	if now == nil {
		now = time.Now
	}
	if strings.ContainsRune(path, '?') {
		return nil, fmt.Errorf("store path %q must not contain '?'", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create store dir: %w", err)
	}
	// Create the file with its final mode, so it is never readable by others,
	// then repair the mode of a file created by an older version.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create store file: %w", err)
	}
	_ = f.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, fmt.Errorf("restrict store permissions: %w", err)
	}

	// Pragmas in the DSN apply to every pooled connection. busy_timeout comes
	// first so later pragmas wait on locks; _txlock=immediate takes the write
	// lock at BEGIN, because a deferred read-then-write transaction fails with
	// SQLITE_BUSY at the upgrade without consulting busy_timeout.
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}
	s := &Store{db: db, now: now}
	// Switching a fresh file to WAL does not wait on busy_timeout, so two
	// processes starting at once can collide here; retry briefly.
	if err := retryBusy(ctx, func() error {
		if err := db.PingContext(ctx); err != nil {
			return err
		}
		return s.migrate(ctx, migs)
	}); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func retryBusy(ctx context.Context, fn func() error) error {
	var err error
	for attempt := range 20 {
		if err = fn(); err == nil || !isBusy(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 25 * time.Millisecond):
		}
	}
	return err
}

func isBusy(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "database is locked") || strings.Contains(msg, "SQLITE_BUSY")
}

// Close releases the database.
func (s *Store) Close() error { return s.db.Close() }

// migrate applies every migration not yet recorded, each in its own
// transaction together with its schema_migrations row.
func (s *Store) migrate(ctx context.Context, migs fs.FS) error {
	if _, err := s.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	files, err := fs.Glob(migs, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, f := range files {
		version, err := migrationVersion(f)
		if err != nil {
			return err
		}
		if err := s.applyMigration(ctx, migs, f, version); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) applyMigration(ctx context.Context, migs fs.FS, file string, version int) error {
	body, err := fs.ReadFile(migs, file)
	if err != nil {
		return err
	}
	// Immediate transaction: the applied check and the apply happen under the
	// write lock, so two processes never both apply the same version.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("migration %s: %w", file, err)
	}
	defer func() { _ = tx.Rollback() }()

	var applied int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&applied); err != nil {
		return fmt.Errorf("migration %s: %w", file, err)
	}
	if applied > 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, string(body)); err != nil {
		return fmt.Errorf("migration %s: %w", file, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
		version, s.stamp()); err != nil {
		return fmt.Errorf("migration %s: %w", file, err)
	}
	return tx.Commit()
}

// migrationVersion parses the leading number of "migrations/0001_init.sql".
func migrationVersion(file string) (int, error) {
	base := filepath.Base(file)
	num, _, ok := strings.Cut(base, "_")
	if !ok {
		return 0, fmt.Errorf("migration %s: want NNNN_name.sql", base)
	}
	v, err := strconv.Atoi(num)
	if err != nil {
		return 0, fmt.Errorf("migration %s: %w", base, err)
	}
	return v, nil
}

func (s *Store) stamp() string { return s.now().UTC().Format(timeLayout) }

// stampCol scans a stored timestamp and fails on a corrupt value instead of
// silently returning the zero time.
type stampCol time.Time

func (c *stampCol) Scan(v any) error {
	var str string
	switch x := v.(type) {
	case string:
		str = x
	case []byte:
		str = string(x)
	default:
		return fmt.Errorf("timestamp column has type %T", v)
	}
	t, err := time.Parse(timeLayout, str)
	if err != nil {
		return fmt.Errorf("corrupt timestamp %q: %w", str, err)
	}
	*c = stampCol(t)
	return nil
}

func parseStamp(v string) time.Time {
	t, _ := time.Parse(timeLayout, v) // only for stamps this package just formatted
	return t
}

// ErrNotFound is returned (wrapped with context) when nothing matches.
var ErrNotFound = errors.New("not found")

// invalid builds the error a tool shows the model for a rejected value. The
// message names fields and allowed values, never stored health values.
func invalid(format string, args ...any) error {
	return coach.ToolError{Code: coach.CodeInvalidInput, Message: fmt.Sprintf(format, args...)}
}

// wrapErr prefixes err with the operation, keeping it matchable with errors.Is/As.
func wrapErr(op string, err *error) {
	if *err != nil {
		*err = fmt.Errorf("%s: %w", op, *err)
	}
}

// nullString maps "" to NULL so optional text columns stay NULL, not empty.
func nullString(v string) sql.NullString { return sql.NullString{String: v, Valid: v != ""} }

func nullFloat(v *float64) sql.NullFloat64 {
	if v == nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: *v, Valid: true}
}

func nullInt(v *int) sql.NullInt64 {
	if v == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: int64(*v), Valid: true}
}

func floatPtr(v sql.NullFloat64) *float64 {
	if !v.Valid {
		return nil
	}
	return &v.Float64
}

func intPtr(v sql.NullInt64) *int {
	if !v.Valid {
		return nil
	}
	n := int(v.Int64)
	return &n
}
