package store

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sync"
	"testing"
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

func TestOpenCreatesPrivateFiles(t *testing.T) {
	_, path := openTest(t)
	dir, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if perm := dir.Mode().Perm(); perm != 0o700 {
		t.Errorf("dir perm = %o, want 700", perm)
	}
	file, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := file.Mode().Perm(); perm != 0o600 {
		t.Errorf("db perm = %o, want 600", perm)
	}
}

func TestOpenRejectsQueryInPath(t *testing.T) {
	if _, err := Open(ctx, filepath.Join(t.TempDir(), "x.db?mode=ro"), fixedClock); err == nil {
		t.Fatal("a '?' would be parsed as DSN options")
	}
}

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

func TestCheckConstraintsRejectBadValues(t *testing.T) {
	s, _ := openTest(t)
	stamp := s.stamp()
	bad := map[string]string{
		"health item kind":   `INSERT INTO health_items (kind, name, status, updated_at) VALUES ('hobby', 'x', 'active', '` + stamp + `')`,
		"health item status": `INSERT INTO health_items (kind, name, status, updated_at) VALUES ('injury', 'x', 'gone', '` + stamp + `')`,
		"lab source":         `INSERT INTO lab_results (collected_on, analyte, value, unit, source, created_at) VALUES ('2026-10-01', 'ldl', 1, 'mg/dL', 'fax', '` + stamp + `')`,
		"note kind":          `INSERT INTO notes (kind, text, created_at) VALUES ('rant', 'x', '` + stamp + `')`,
		"second profile":     `INSERT INTO profile (id, updated_at) VALUES (2, '` + stamp + `')`,
	}
	for name, stmt := range bad {
		if _, err := s.db.ExecContext(ctx, stmt); err == nil {
			t.Errorf("%s: CHECK did not reject", name)
		}
	}
}

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
	if _, err := s.GetMetric(ctx, "2026-10-10", "resting_hr_bpm", 2); !errors.Is(err, ErrNotFound) {
		t.Errorf("different algo_version must miss, got %v", err)
	}
	if _, err := s.GetMetric(ctx, "2026-10-11", "resting_hr_bpm", 1); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing day must miss, got %v", err)
	}

	m.Value = 58
	if err := s.PutMetric(ctx, m); err != nil {
		t.Fatal(err)
	}
	for _, d := range []coach.LocalDate{"2026-10-08", "2026-10-12"} {
		if err := s.PutMetric(ctx, Metric{Date: d, Key: "resting_hr_bpm", Value: 60, AlgoVersion: 1}); err != nil {
			t.Fatal(err)
		}
	}
	rng, err := s.MetricRange(ctx, "resting_hr_bpm", "2026-10-09", "2026-10-12", 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(rng) != 2 || rng[0].Date != "2026-10-10" || rng[0].Value != 58 || rng[1].Date != "2026-10-12" {
		t.Errorf("range = %+v, want 10th (replaced, 58) and 12th", rng)
	}

	if err := s.ClearMetrics(ctx); err != nil {
		t.Fatal(err)
	}
	if rng, _ := s.MetricRange(ctx, "resting_hr_bpm", "2026-01-01", "2026-12-31", 1); len(rng) != 0 {
		t.Errorf("cache not cleared: %+v", rng)
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
		if err := s.PutMetric(ctx, m); err == nil {
			t.Errorf("PutMetric(%+v) accepted", m)
		}
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
}

func TestOpenDefaultsClock(t *testing.T) {
	s, err := Open(ctx, filepath.Join(t.TempDir(), "coach.db"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if s.now == nil {
		t.Fatal("nil clock must default to time.Now")
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
		}
	}
}

func TestProfileRejectsCorruptJSON(t *testing.T) {
	s, _ := openTest(t)
	if _, err := s.UpdateProfile(ctx, ProfilePatch{Sex: ptr("m")}); err != nil {
		t.Fatal(err)
	}
	for _, col := range []string{"goal_json", "plan_json"} {
		if _, err := s.db.ExecContext(ctx, `UPDATE profile SET `+col+` = '{bad'`); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Profile(ctx); err == nil {
			t.Errorf("corrupt %s not reported", col)
		}
		if _, err := s.UpdateProfile(ctx, ProfilePatch{}); err == nil {
			t.Errorf("UpdateProfile over corrupt %s not reported", col)
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE profile SET `+col+` = NULL`); err != nil {
			t.Fatal(err)
		}
	}
}
