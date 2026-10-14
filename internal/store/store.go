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
	"slices"
	"strconv"
	"strings"
	"syscall"
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
	if !filepath.IsAbs(path) || strings.ContainsRune(path, '?') {
		return nil, fmt.Errorf("store path %q must be absolute and must not contain '?'", path)
	}
	if err := prepareFile(path); err != nil {
		return nil, err
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
	if err := retryBusy(ctx, 20, func() error {
		if err := db.PingContext(ctx); err != nil {
			return err
		}
		return s.migrate(ctx, migs)
	}); err != nil {
		_ = db.Close() // the open error is the one worth reporting
		return nil, err
	}
	return s, nil
}

// prepareFile makes sure the directory is not writable by others and that path
// is a regular file with mode 0600, created with that mode so it is never
// readable by others. A symlink is refused rather than followed: it could point
// the store (and the chmod) at another file.
func prepareFile(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create store dir: %w", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("store dir: %w", err)
	}
	// Not chmod'ed on the user's behalf: the dir may be shared on purpose.
	if perm := info.Mode().Perm(); perm&0o022 != 0 {
		return fmt.Errorf("store dir %s is writable by other users (mode %o); run chmod 700 on it", dir, perm)
	}
	if fi, err := os.Lstat(path); err == nil && !fi.Mode().IsRegular() {
		return fmt.Errorf("store path %s is not a regular file", path)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return fmt.Errorf("create store file: %w", err)
	}
	defer f.Close()
	// Repairs the mode of a file created by an older version, on the open
	// descriptor so it cannot be swapped between check and chmod.
	if err := f.Chmod(0o600); err != nil {
		return fmt.Errorf("restrict store permissions: %w", err)
	}
	return nil
}

// retryBusy runs fn until it succeeds, fails with a non-busy error, or attempts
// run out. Each attempt backs off a little longer.
func retryBusy(ctx context.Context, attempts int, fn func() error) error {
	var err error
	for attempt := range attempts {
		if err = fn(); err == nil || !isBusy(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w (while waiting for a locked database: %v)", ctx.Err(), err)
		case <-time.After(time.Duration(attempt+1) * 25 * time.Millisecond):
		}
	}
	return fmt.Errorf("database still locked after %d attempts: %w", attempts, err)
}

// isBusy matches modernc's SQLITE_BUSY text ("database is locked (5)" or (517)).
func isBusy(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "database is locked") || strings.Contains(msg, "SQLITE_BUSY")
}

// Close releases the database; the last close checkpoints and removes the WAL.
func (s *Store) Close() error { return s.db.Close() }

type migration struct {
	version int
	file    string
}

// migrate applies every migration not yet recorded, in version order, each in
// its own transaction together with its schema_migrations row.
func (s *Store) migrate(ctx context.Context, migs fs.FS) error {
	if _, err := s.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	list, err := listMigrations(migs)
	if err != nil {
		return err
	}

	// A database migrated by a newer binary has a schema this one does not know.
	var newest sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_migrations`).Scan(&newest); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if known := list[len(list)-1].version; newest.Valid && int(newest.Int64) > known {
		return fmt.Errorf("database schema version %d is newer than this binary supports (%d); upgrade health-coach-mcp", newest.Int64, known)
	}

	for _, m := range list {
		if err := s.applyMigration(ctx, migs, m); err != nil {
			return err
		}
	}
	return nil
}

// listMigrations returns the migrations sorted by numeric version, rejecting
// an empty set and duplicate versions (the second would be skipped as applied).
func listMigrations(migs fs.FS) ([]migration, error) {
	files, err := fs.Glob(migs, "migrations/*.sql")
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, errors.New("no migrations found")
	}
	list := make([]migration, 0, len(files))
	seen := map[int]string{}
	for _, f := range files {
		v, err := migrationVersion(f)
		if err != nil {
			return nil, err
		}
		if prev, dup := seen[v]; dup {
			return nil, fmt.Errorf("migrations %s and %s share version %d", prev, f, v)
		}
		seen[v] = f
		list = append(list, migration{version: v, file: f})
	}
	slices.SortFunc(list, func(a, b migration) int { return a.version - b.version })
	return list, nil
}

func (s *Store) applyMigration(ctx context.Context, migs fs.FS, m migration) error {
	body, err := fs.ReadFile(migs, m.file)
	if err != nil {
		return err
	}
	// Immediate transaction: the applied check and the apply happen under the
	// write lock, so two processes never both apply the same version.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("migration %s: %w", m.file, err)
	}
	defer func() { _ = tx.Rollback() }() // no-op after Commit

	var applied int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, m.version).Scan(&applied); err != nil {
		return fmt.Errorf("migration %s: %w", m.file, err)
	}
	if applied > 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, string(body)); err != nil {
		return fmt.Errorf("migration %s: %w", m.file, err)
	}
	appliedAt, _ := s.stamp()
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
		m.version, appliedAt); err != nil {
		return fmt.Errorf("migration %s: %w", m.file, err)
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

// stamp returns the current instant formatted for storage and as a value, so
// callers never re-parse what they just wrote.
func (s *Store) stamp() (string, time.Time) {
	t := s.now().UTC()
	return t.Format(timeLayout), t
}

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

// ErrNotFound is returned (wrapped with context) when nothing is stored yet.
// It is a no_data ToolError, so tools report "nothing recorded" to the model
// instead of an internal error.
var ErrNotFound error = coach.ToolError{Code: coach.CodeNoData, Message: "nothing recorded yet"}

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

// rowsResult drops rows scanned before a failure: a partial list returned
// next to an error is easy to use by mistake.
func rowsResult[T any](out []T, err error) ([]T, error) {
	if err != nil {
		return nil, err
	}
	return out, nil
}

func validDate(name string, d coach.LocalDate, optional bool) error {
	if d == "" && optional {
		return nil
	}
	if _, err := coach.ParseDate(string(d)); err != nil {
		return invalid("%s must be YYYY-MM-DD", name)
	}
	return nil
}

func oneOf(name, v string, allowed []string, optional bool) error {
	if (v == "" && optional) || slices.Contains(allowed, v) {
		return nil
	}
	return invalid("%s must be one of %s", name, strings.Join(allowed, ", "))
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
