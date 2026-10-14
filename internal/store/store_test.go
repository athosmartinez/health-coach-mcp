package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

var ctx = context.Background()

// fixedClock returns the same instant every call, so stored timestamps are exact.
func fixedClock() time.Time { return time.Date(2026, 10, 14, 12, 0, 0, 0, time.UTC) }

func openTest(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "nested", "coach.db")
	s, err := Open(ctx, path, fixedClock)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s, path
}

// --- open and files ---

func TestOpenCreatesPrivateFiles(t *testing.T) {
	s, path := openTest(t)
	// Writing creates the -wal and -shm sidecars, which must inherit 0600.
	if _, err := s.AddNote(ctx, Note{Kind: "checkin", Text: "x"}); err != nil {
		t.Fatal(err)
	}
	dir, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if perm := dir.Mode().Perm(); perm != 0o700 {
		t.Errorf("dir perm = %o, want 700", perm)
	}
	for _, f := range []string{path, path + "-wal", path + "-shm"} {
		fi, err := os.Stat(f)
		if err != nil {
			t.Errorf("%s: %v", filepath.Base(f), err)
			continue
		}
		if perm := fi.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s perm = %o, want 600", filepath.Base(f), perm)
		}
	}
}

func TestOpenRejectsUnsafePaths(t *testing.T) {
	dir := t.TempDir()
	if _, err := Open(ctx, filepath.Join(dir, "x.db?mode=ro"), fixedClock); err == nil {
		t.Error("a '?' would be parsed as DSN options")
	}
	if _, err := Open(ctx, "coach.db", fixedClock); err == nil {
		t.Error("a relative path would depend on the working directory")
	}

	victim := filepath.Join(dir, "victim")
	if err := os.WriteFile(victim, []byte("not a db"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link.db")
	if err := os.Symlink(victim, link); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, link, fixedClock); err == nil {
		t.Error("a symlinked db path must be refused")
	}
	if fi, _ := os.Stat(victim); fi.Mode().Perm() != 0o644 {
		t.Errorf("symlink target was chmod'ed to %o", fi.Mode().Perm())
	}

	shared := filepath.Join(dir, "shared")
	if err := os.Mkdir(shared, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(shared, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, filepath.Join(shared, "coach.db"), fixedClock); err == nil || !strings.Contains(err.Error(), "chmod 700") {
		t.Errorf("world-writable dir err = %v", err)
	}
	if fi, _ := os.Stat(shared); fi.Mode().Perm() != 0o777 {
		t.Error("the dir must not be chmod'ed on the user's behalf")
	}
}

func TestOpenTightensExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "coach.db")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(ctx, path, fixedClock)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
		t.Errorf("existing file perm = %o, want 600", fi.Mode().Perm())
	}
}

func TestOpenFailures(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, filepath.Join(blocker, "coach.db"), nil); err == nil {
		t.Error("Open under a regular file must fail to create the dir")
	}
	dir := filepath.Join(t.TempDir(), "isdir.db")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, dir, nil); err == nil {
		t.Error("Open on a directory must fail")
	}
	notDB := filepath.Join(t.TempDir(), "junk.db")
	if err := os.WriteFile(notDB, []byte(strings.Repeat("junk", 1024)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(ctx, notDB, nil); err == nil {
		t.Error("Open on a non-SQLite file must fail")
	}
}

func TestOpenDefaultsClock(t *testing.T) {
	s, err := Open(ctx, filepath.Join(t.TempDir(), "coach.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	before := time.Now()
	n, err := s.AddNote(ctx, Note{Kind: "checkin", Text: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if n.CreatedAt.Before(before.Add(-time.Second)) || n.CreatedAt.After(time.Now().Add(time.Second)) {
		t.Errorf("nil clock must default to time.Now, got %v", n.CreatedAt)
	}
}

// --- retry on a locked database ---

func TestRetryBusy(t *testing.T) {
	busy := errors.New("database is locked (5) (SQLITE_BUSY)")

	calls := 0
	err := retryBusy(ctx, 5, func() error {
		calls++
		if calls < 3 {
			return busy
		}
		return nil
	})
	if err != nil || calls != 3 {
		t.Errorf("busy twice then ok: err %v after %d calls, want nil after 3", err, calls)
	}

	calls = 0
	other := errors.New("disk I/O error")
	if err := retryBusy(ctx, 5, func() error { calls++; return other }); !errors.Is(err, other) || calls != 1 {
		t.Errorf("non-busy error: %v after %d calls, want it after 1", err, calls)
	}

	calls = 0
	if err := retryBusy(ctx, 3, func() error { calls++; return busy }); !errors.Is(err, busy) || calls != 3 || !strings.Contains(err.Error(), "3 attempts") {
		t.Errorf("always busy: %v after %d calls", err, calls)
	}

	short, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancel()
	start := time.Now()
	err = retryBusy(short, 20, func() error { return busy })
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "locked") {
		t.Errorf("cancelled wait err = %v, want deadline plus the last busy error", err)
	}
	if time.Since(start) > time.Second {
		t.Error("retry did not stop when the context ended")
	}
}

func TestOpenWaitsForALockedFreshDatabase(t *testing.T) {
	// Another process holds the write lock on a brand-new file while we open it.
	path := filepath.Join(t.TempDir(), "coach.db")
	other, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	conn, err := other.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(ctx, `BEGIN EXCLUSIVE`); err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		time.Sleep(150 * time.Millisecond)
		_, _ = conn.ExecContext(ctx, `COMMIT`)
		_ = conn.Close()
		close(released)
	}()
	s, err := Open(ctx, path, fixedClock)
	<-released
	if err != nil {
		t.Fatalf("Open while another connection held the lock: %v", err)
	}
	defer s.Close()
	if _, err := s.Profile(ctx); !errors.Is(err, ErrNotFound) {
		t.Errorf("store unusable after waiting: %v", err)
	}
}

func TestConcurrentFirstOpen(t *testing.T) {
	// Two MCP clients may each spawn a server on a fresh install.
	path := filepath.Join(t.TempDir(), "coach.db")
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := Open(ctx, path, fixedClock)
			if err == nil {
				err = s.Close()
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent Open: %v", err)
		}
	}
	s, err := Open(ctx, path, fixedClock)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&n); err != nil || n != 1 {
		t.Errorf("migration applied %d times (%v)", n, err)
	}
}

func TestConcurrentWrites(t *testing.T) {
	s, _ := openTest(t)
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := s.AddNote(ctx, Note{Kind: "checkin", Text: "concurrent note"})
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Errorf("concurrent write failed (busy_timeout?): %v", err)
		}
	}
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes`).Scan(&n); err != nil || n != 20 {
		t.Errorf("notes = %d (%v), want 20", n, err)
	}
}

// --- migrations ---

func TestMigrationIsIdempotent(t *testing.T) {
	s, path := openTest(t)
	if err := s.PutMetric(ctx, Metric{Date: "2026-10-10", Key: "steps", Value: 8000, AlgoVersion: 1}); err != nil {
		t.Fatal(err)
	}
	_ = s.Close()

	s2, err := Open(ctx, path, fixedClock)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	var versions int
	if err := s2.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	if versions != 1 {
		t.Errorf("schema_migrations has %d rows, want 1", versions)
	}
	if _, err := s2.GetMetric(ctx, "2026-10-10", "steps", 1); err != nil {
		t.Errorf("data lost on reopen: %v", err)
	}
}

func TestMigrationUpgradeKeepsData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "coach.db")
	v1 := fstest.MapFS{"migrations/0001_init.sql": {Data: []byte(`CREATE TABLE a (x INTEGER); INSERT INTO a VALUES (42);`)}}
	s, err := open(ctx, path, fixedClock, v1)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Close()

	v2 := fstest.MapFS{
		"migrations/0001_init.sql":  v1["migrations/0001_init.sql"],
		"migrations/0002_add_b.sql": {Data: []byte(`ALTER TABLE a ADD COLUMN y TEXT; CREATE TABLE b (z INTEGER);`)},
	}
	s, err = open(ctx, path, fixedClock, v2)
	if err != nil {
		t.Fatalf("upgrade: %v", err)
	}
	defer s.Close()
	var x, versions, tables int
	_ = s.db.QueryRowContext(ctx, `SELECT x FROM a`).Scan(&x)
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&versions)
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE name IN ('a', 'b')`).Scan(&tables)
	if x != 42 || versions != 2 || tables != 2 {
		t.Errorf("after upgrade: x=%d versions=%d tables=%d; want 42, 2, 2", x, versions, tables)
	}
}

func TestMigrationOrderIsNumeric(t *testing.T) {
	// "10_" sorts before "2_" as text; it must run after.
	migs := fstest.MapFS{
		"migrations/10_second.sql": {Data: []byte(`INSERT INTO log VALUES ('10');`)},
		"migrations/2_first.sql":   {Data: []byte(`CREATE TABLE log (v TEXT); INSERT INTO log VALUES ('2');`)},
	}
	s, err := open(ctx, filepath.Join(t.TempDir(), "coach.db"), fixedClock, migs)
	if err != nil {
		t.Fatalf("numeric order: %v", err)
	}
	defer s.Close()
}

func TestBadMigrationSets(t *testing.T) {
	cases := map[string]fstest.MapFS{
		"empty": {},
		"duplicate version": {
			"migrations/0001_a.sql": {Data: []byte(`CREATE TABLE a (x INTEGER);`)},
			"migrations/0001_b.sql": {Data: []byte(`CREATE TABLE b (x INTEGER);`)},
		},
		"bad name": {"migrations/init.sql": {Data: []byte(`SELECT 1;`)}},
	}
	for name, migs := range cases {
		if _, err := open(ctx, filepath.Join(t.TempDir(), "coach.db"), fixedClock, migs); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestNewerSchemaIsRefused(t *testing.T) {
	path := filepath.Join(t.TempDir(), "coach.db")
	v2 := fstest.MapFS{
		"migrations/0001_a.sql": {Data: []byte(`CREATE TABLE a (x INTEGER);`)},
		"migrations/0002_b.sql": {Data: []byte(`CREATE TABLE b (x INTEGER);`)},
	}
	s, err := open(ctx, path, fixedClock, v2)
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	v1 := fstest.MapFS{"migrations/0001_a.sql": v2["migrations/0001_a.sql"]}
	if _, err := open(ctx, path, fixedClock, v1); err == nil || !strings.Contains(err.Error(), "newer than this binary") {
		t.Errorf("older binary on a newer schema: err = %v", err)
	}
}

func TestFailedMigrationRollsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "coach.db")
	bad := fstest.MapFS{
		"migrations/0001_ok.sql":  {Data: []byte(`CREATE TABLE a (x INTEGER);`)},
		"migrations/0002_bad.sql": {Data: []byte(`CREATE TABLE b (x INTEGER); THIS IS NOT SQL;`)},
	}
	if _, err := open(ctx, path, fixedClock, bad); err == nil {
		t.Fatal("broken migration accepted")
	}
	good := fstest.MapFS{"migrations/0001_ok.sql": bad["migrations/0001_ok.sql"]}
	s, err := open(ctx, path, fixedClock, good)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var versions, tableB int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations`).Scan(&versions)
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE name = 'b'`).Scan(&tableB)
	if versions != 1 || tableB != 0 {
		t.Errorf("after failed 0002: %d versions recorded, table b exists=%d; want 1 and 0", versions, tableB)
	}
}

func TestMigrationVersion(t *testing.T) {
	if v, err := migrationVersion("migrations/0012_add.sql"); err != nil || v != 12 {
		t.Errorf("got %d, %v", v, err)
	}
	for _, bad := range []string{"migrations/init.sql", "migrations/x1_init.sql"} {
		if _, err := migrationVersion(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

// --- schema ---

func TestSchemaObjectsExist(t *testing.T) {
	s, _ := openTest(t)
	want := []string{
		"profile", "targets", "health_items", "lab_results", "preferences", "notes", "notes_fts",
		"daily_metrics", "schema_migrations", "notes_ai", "notes_ad", "notes_au",
	}
	for _, name := range want {
		var n int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE name = ?`, name).Scan(&n); err != nil || n != 1 {
			t.Errorf("schema object %s missing (n=%d, err=%v)", name, n, err)
		}
	}
	var mode string
	if err := s.db.QueryRowContext(ctx, `PRAGMA journal_mode`).Scan(&mode); err != nil || mode != "wal" {
		t.Errorf("journal_mode = %q, %v; want wal", mode, err)
	}
	var fk int
	if err := s.db.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
		t.Errorf("foreign_keys = %d, %v; want 1", fk, err)
	}
}

func TestSchemaConstraints(t *testing.T) {
	s, _ := openTest(t)
	stamp, _ := s.stamp()
	exec := func(q string) error {
		_, err := s.db.ExecContext(ctx, strings.ReplaceAll(q, "$T", "'"+stamp+"'"))
		return err
	}
	// Each valid control proves the statement shape; the bad twin breaks one rule.
	cases := []struct{ name, ok, bad, want string }{
		{"health item kind",
			`INSERT INTO health_items (kind, name, status, updated_at) VALUES ('injury', 'k1', 'active', $T)`,
			`INSERT INTO health_items (kind, name, status, updated_at) VALUES ('hobby', 'k2', 'active', $T)`, "CHECK constraint failed"},
		{"health item status",
			`INSERT INTO health_items (kind, name, status, updated_at) VALUES ('injury', 's1', 'paused', $T)`,
			`INSERT INTO health_items (kind, name, status, updated_at) VALUES ('injury', 's2', 'gone', $T)`, "CHECK constraint failed"},
		{"health item unique, case-insensitive",
			`INSERT INTO health_items (kind, name, status, updated_at) VALUES ('allergy', 'Peanut', 'active', $T)`,
			`INSERT INTO health_items (kind, name, status, updated_at) VALUES ('allergy', 'peanut', 'active', $T)`, "UNIQUE constraint failed"},
		{"lab source",
			`INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at) VALUES ('2026-10-01', 'ldl', 1, 'mg/dL', 'pdf', $T)`,
			`INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at) VALUES ('2026-10-02', 'ldl', 1, 'mg/dL', 'fax', $T)`, "CHECK constraint failed"},
		{"lab unique per date and analyte",
			`INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at) VALUES ('2026-10-03', 'hdl', 1, 'mg/dL', 'chat', $T)`,
			`INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at) VALUES ('2026-10-03', 'hdl', 2, 'mg/dL', 'chat', $T)`, "UNIQUE constraint failed"},
		{"note kind",
			`INSERT INTO notes (kind, text, created_at) VALUES ('insight', 'x', $T)`,
			`INSERT INTO notes (kind, text, created_at) VALUES ('rant', 'x', $T)`, "CHECK constraint failed"},
		{"single profile",
			`INSERT INTO profile (id, updated_at) VALUES (1, $T)`,
			`INSERT INTO profile (id, updated_at) VALUES (2, $T)`, "CHECK constraint failed"},
	}
	for _, c := range cases {
		if err := exec(c.ok); err != nil {
			t.Errorf("%s: valid control failed: %v", c.name, err)
		}
		if err := exec(c.bad); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: err = %v, want %q", c.name, err, c.want)
		}
	}
}

// --- metrics cache ---

func TestMetricsCache(t *testing.T) {
	s, _ := openTest(t)
	n := 3
	m := Metric{Date: "2026-10-10", Key: "resting_hr_bpm", Value: 57, NSamples: &n, Source: "fitbit_air", AlgoVersion: 1}
	if err := s.PutMetric(ctx, m); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetMetric(ctx, "2026-10-10", "resting_hr_bpm", 1)
	if err != nil {
		t.Fatal(err)
	}
	if got.Value != 57 || *got.NSamples != 3 || got.Source != "fitbit_air" || !got.FetchedAt.Equal(fixedClock()) {
		t.Errorf("got %+v", got)
	}
	_, err = s.GetMetric(ctx, "2026-10-10", "resting_hr_bpm", 2)
	if !errors.Is(err, ErrNotFound) || !isCode(err, coach.CodeNoData) || !strings.Contains(err.Error(), "2026-10-10") {
		t.Errorf("different algo_version must miss with context, got %v", err)
	}
	if _, err := s.GetMetric(ctx, "2026-10-11", "resting_hr_bpm", 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing day must miss, got %v", err)
	}

	// A recompute with a new algo_version replaces the row: v1 misses, v2 hits.
	m.Value, m.AlgoVersion = 58, 2
	if err := s.PutMetric(ctx, m); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetMetric(ctx, "2026-10-10", "resting_hr_bpm", 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("old algo_version still served: %v", err)
	}
	if v2, _ := s.GetMetric(ctx, "2026-10-10", "resting_hr_bpm", 2); v2.Value != 58 {
		t.Errorf("v2 = %+v", v2)
	}

	// Explicit fetched_at is preserved; nil n_samples and empty source round-trip.
	fetched := time.Date(2026, 10, 9, 8, 0, 0, 123, time.UTC)
	for _, d := range []coach.LocalDate{"2026-10-08", "2026-10-12", "2026-10-13"} {
		if err := s.PutMetric(ctx, Metric{Date: d, Key: "resting_hr_bpm", Value: 60, AlgoVersion: 2, FetchedAt: fetched}); err != nil {
			t.Fatal(err)
		}
	}
	rng, err := s.MetricRange(ctx, "resting_hr_bpm", "2026-10-08", "2026-10-12", 2)
	if err != nil {
		t.Fatal(err)
	}
	var days []coach.LocalDate
	for _, r := range rng {
		days = append(days, r.Date)
	}
	if fmt.Sprint(days) != "[2026-10-08 2026-10-10 2026-10-12]" {
		t.Errorf("range days = %v, want both endpoints included", days)
	}
	if !rng[0].FetchedAt.Equal(fetched) || rng[0].NSamples != nil || rng[0].Source != "" {
		t.Errorf("round trip = %+v", rng[0])
	}
}

func TestMetricRangeValidation(t *testing.T) {
	s, _ := openTest(t)
	bad := []struct{ key, from, to string }{
		{"mood", "2026-10-01", "2026-10-02"},
		{"steps", "garbage", "2026-10-02"},
		{"steps", "2026-10-01", "2026-13-01"},
		{"steps", "2026-10-02", "2026-10-01"},
		{"steps", "2026-01-01", "2027-03-01"},
	}
	for _, b := range bad {
		if _, err := s.MetricRange(ctx, b.key, coach.LocalDate(b.from), coach.LocalDate(b.to), 1); !isInvalidInput(err) {
			t.Errorf("MetricRange(%s, %s, %s) err = %v, want invalid_input", b.key, b.from, b.to, err)
		}
	}
	last, _ := coach.LocalDate("2026-01-01").AddDays(maxRangeDays - 1)
	if _, err := s.MetricRange(ctx, "steps", "2026-01-01", last, 1); err != nil {
		t.Errorf("range of exactly %d days rejected: %v", maxRangeDays, err)
	}
}

func TestPutMetricRejectsBadInput(t *testing.T) {
	s, _ := openTest(t)
	bad := []Metric{
		{Date: "2026-10-10", Key: "mood", Value: 1, AlgoVersion: 1},
		{Date: "garbage", Key: "steps", Value: 1, AlgoVersion: 1},
		{Date: "2026-10-10", Key: "steps", Value: math.NaN(), AlgoVersion: 1},
		{Date: "2026-10-10", Key: "steps", Value: math.Inf(1), AlgoVersion: 1},
	}
	for _, m := range bad {
		if err := s.PutMetric(ctx, m); !isInvalidInput(err) {
			t.Errorf("PutMetric(%+v) err = %v, want invalid_input", m, err)
		}
	}
}

func TestClearMetricsTouchesOnlyTheCache(t *testing.T) {
	s, _ := openTest(t)
	if err := s.PutMetric(ctx, Metric{Date: "2026-10-10", Key: "steps", Value: 1, AlgoVersion: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpdateProfile(ctx, ProfilePatch{Sex: ptr("m")}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddNote(ctx, Note{Kind: "checkin", Text: "keep me"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RecordLabs(ctx, "2026-10-01", "", "chat", []LabValue{{Analyte: "ldl", Value: 1, Unit: "mg/dL"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.ClearMetrics(ctx); err != nil {
		t.Fatal(err)
	}
	if rng, _ := s.MetricRange(ctx, "steps", "2026-10-01", "2026-10-31", 1); len(rng) != 0 {
		t.Errorf("cache not cleared: %+v", rng)
	}
	if _, err := s.Profile(ctx); err != nil {
		t.Errorf("profile lost: %v", err)
	}
	if res, _ := s.SearchNotes(ctx, NoteFilter{}); len(res.Notes) != 1 {
		t.Errorf("notes lost: %+v", res)
	}
	if labs, _ := s.QueryLabs(ctx, "", ""); len(labs) != 1 {
		t.Errorf("labs lost: %+v", labs)
	}
}

// --- errors ---

func TestClosedStoreReturnsErrors(t *testing.T) {
	s, _ := openTest(t)
	_ = s.Close()
	checks := map[string]error{}
	_, checks["Profile"] = s.Profile(ctx)
	_, checks["UpdateProfile"] = s.UpdateProfile(ctx, ProfilePatch{})
	_, checks["SetTarget"] = s.SetTarget(ctx, Target{EffectiveFrom: "2026-10-01", Kcal: ptr(1)})
	_, checks["TargetInForce"] = s.TargetInForce(ctx, "2026-10-01")
	_, checks["Targets"] = s.Targets(ctx)
	_, checks["UpsertHealthItem"] = s.UpsertHealthItem(ctx, HealthItem{Kind: "injury", Name: "x", Status: "active"})
	_, checks["HealthItems"] = s.HealthItems(ctx, "", "")
	checks["SetPreference"] = s.SetPreference(ctx, "k", []byte(`1`))
	_, checks["Preferences"] = s.Preferences(ctx)
	_, checks["RecordLabs"] = s.RecordLabs(ctx, "2026-10-01", "", "chat", []LabValue{{Analyte: "ldl", Value: 1, Unit: "x"}})
	_, checks["QueryLabs"] = s.QueryLabs(ctx, "", "")
	_, checks["AddNote"] = s.AddNote(ctx, Note{Kind: "checkin", Text: "x"})
	_, checks["SearchNotes"] = s.SearchNotes(ctx, NoteFilter{})
	checks["PutMetric"] = s.PutMetric(ctx, Metric{Date: "2026-10-01", Key: "steps", Value: 1})
	_, checks["GetMetric"] = s.GetMetric(ctx, "2026-10-01", "steps", 1)
	checks["ClearMetrics"] = s.ClearMetrics(ctx)
	for name, err := range checks {
		if err == nil {
			t.Errorf("%s on a closed store returned nil", name)
			continue
		}
		if !strings.Contains(err.Error(), "database is closed") {
			t.Errorf("%s: err = %v, want the closed-database cause", name, err)
		}
	}
}

func TestCorruptRowsFailWholeList(t *testing.T) {
	s, _ := openTest(t)
	for _, d := range []coach.LocalDate{"2026-10-01", "2026-10-02"} {
		if _, err := s.SetTarget(ctx, Target{EffectiveFrom: d, Kcal: ptr(2000)}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AddNote(ctx, Note{Kind: "checkin", Text: "x"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE targets SET created_at = 'yesterday' WHERE effective_from = '2026-10-01'`); err != nil {
		t.Fatal(err)
	}
	if ts, err := s.Targets(ctx); err == nil || ts != nil {
		t.Errorf("corrupt row: got %d targets and err %v; want nil and an error", len(ts), err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE notes SET created_at = 'yesterday'`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SearchNotes(ctx, NoteFilter{}); err == nil {
		t.Error("corrupt created_at silently read as zero time")
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE notes SET created_at = ?, tags = '[bad'`, fixedClock().Format(timeLayout)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SearchNotes(ctx, NoteFilter{}); err == nil || !strings.Contains(err.Error(), "tags are corrupt") {
		t.Errorf("corrupt tags err = %v", err)
	}
	var c stampCol
	if err := c.Scan(42); err == nil {
		t.Error("non-text timestamp accepted")
	}
	if err := c.Scan([]byte("2026-10-14T12:00:00.000000000Z")); err != nil {
		t.Errorf("[]byte timestamp rejected: %v", err)
	}
}

func TestNotFoundIsNoData(t *testing.T) {
	s, _ := openTest(t)
	_, err := s.TargetInForce(ctx, "2026-10-10")
	if !errors.Is(err, ErrNotFound) || !isCode(err, coach.CodeNoData) || err.Error() == ErrNotFound.Error() {
		t.Errorf("err = %v, want wrapped no_data with context", err)
	}
	if got := coach.AsToolError(err); got.Code != coach.CodeNoData {
		t.Errorf("tools would report %q, want no_data", got.Code)
	}
}
