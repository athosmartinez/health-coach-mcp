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
)

const (
	dateLayout = "2006-01-02"
	timeLayout = time.RFC3339Nano
)

//go:embed migrations/*.sql
var migrations embed.FS

// Store wraps the database. It is safe for concurrent use.
type Store struct {
	db  *sql.DB
	now func() time.Time
}

// Open creates (if needed) and migrates the database at path. The directory is
// created 0700 and the file chmod 0600: it holds health history and lab results,
// and SQLite gives the -wal/-shm files the same permissions as the database.
func Open(ctx context.Context, path string, now func() time.Time) (*Store, error) {
	if now == nil {
		now = time.Now
	}
	if strings.ContainsRune(path, '?') {
		return nil, fmt.Errorf("store path %q must not contain '?'", path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create store dir: %w", err)
	}
	// Pragmas in the DSN apply to every pooled connection, not just the first.
	dsn := path + "?_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}
	s := &Store{db: db, now: now}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open store: %w", err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("restrict store permissions: %w", err)
	}
	if err := s.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close releases the database.
func (s *Store) Close() error { return s.db.Close() }

// migrate applies every embedded migration not yet recorded, each in its own
// transaction together with its schema_migrations row.
func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, f := range files {
		version, err := migrationVersion(f)
		if err != nil {
			return err
		}
		if err := s.applyMigration(ctx, f, version); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) applyMigration(ctx context.Context, file string, version int) error {
	body, err := migrations.ReadFile(file)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var applied int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, version).Scan(&applied); err != nil {
		return err
	}
	if applied > 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, string(body)); err != nil {
		return fmt.Errorf("migration %s: %w", file, err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
		version, s.stamp()); err != nil {
		return err
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

func parseStamp(v string) time.Time {
	t, _ := time.Parse(timeLayout, v)
	return t
}

// ErrNotFound is returned by single-row getters when nothing matches.
var ErrNotFound = errors.New("store: not found")

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
