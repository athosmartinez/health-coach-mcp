package coach

import (
	"testing"
	"time"
)

func brt(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

func TestParseDate(t *testing.T) {
	cases := []struct {
		in   string
		ok   bool
		want LocalDate
	}{
		{"2026-10-13", true, "2026-10-13"},
		{"2028-02-29", true, "2028-02-29"},
		{"2026-02-29", false, ""},
		{"2026-13-01", false, ""},
		{"13/10/2026", false, ""},
		{"", false, ""},
	}
	for _, c := range cases {
		got, err := ParseDate(c.in)
		if (err == nil) != c.ok {
			t.Errorf("ParseDate(%q) err = %v, want ok=%v", c.in, err, c.ok)
			continue
		}
		if c.ok && got != c.want {
			t.Errorf("ParseDate(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestBoundsAreLocalMidnights(t *testing.T) {
	loc := brt(t)
	start, end := LocalDate("2026-10-13").Bounds(loc)
	if want := time.Date(2026, 10, 13, 0, 0, 0, 0, loc); !start.Equal(want) {
		t.Errorf("start = %v, want %v", start, want)
	}
	if want := time.Date(2026, 10, 14, 0, 0, 0, 0, loc); !end.Equal(want) {
		t.Errorf("end = %v, want %v", end, want)
	}
}

func TestTodayUsesConfiguredZone(t *testing.T) {
	// 01:30 UTC on Oct 14 is still Oct 13 in BRT (UTC-3).
	now := time.Date(2026, 10, 14, 1, 30, 0, 0, time.UTC)
	if got := Today(now, brt(t)); got != "2026-10-13" {
		t.Errorf("Today = %q, want 2026-10-13", got)
	}
}

func TestSleepBelongsToTheDayItEnds(t *testing.T) {
	loc := brt(t)
	end := time.Date(2026, 10, 13, 9, 24, 0, 0, loc) // started 23:00 on Oct 12
	if got := SleepDay(end, loc); got != "2026-10-13" {
		t.Errorf("SleepDay = %q, want 2026-10-13", got)
	}
}

func TestAddDays(t *testing.T) {
	if got := LocalDate("2026-10-01").AddDays(-1); got != "2026-09-30" {
		t.Errorf("AddDays(-1) = %q", got)
	}
	if got := LocalDate("2028-02-28").AddDays(1); got != "2028-02-29" {
		t.Errorf("AddDays(1) = %q", got)
	}
}
