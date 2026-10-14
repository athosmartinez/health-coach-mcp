package coach

import (
	"encoding/json"
	"testing"
	"time"
	_ "time/tzdata"
)

func zone(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

func brt(t *testing.T) *time.Location { return zone(t, "America/Sao_Paulo") }

func mustBounds(t *testing.T, d LocalDate, loc *time.Location) (time.Time, time.Time) {
	t.Helper()
	start, end, err := d.Bounds(loc)
	if err != nil {
		t.Fatalf("Bounds(%q): %v", d, err)
	}
	return start, end
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
		{"2026-1-3", false, ""},
		{" 2026-10-13", false, ""},
		{"2026-10-13\n", false, ""},
		{"2026-10-13T00:00:00Z", false, ""},
		{"+2026-10-13", false, ""},
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

func TestLocalDateUnmarshalValidates(t *testing.T) {
	var in struct {
		D LocalDate `json:"d"`
	}
	if err := json.Unmarshal([]byte(`{"d":"2026-10-13"}`), &in); err != nil || in.D != "2026-10-13" {
		t.Fatalf("valid date: %q, %v", in.D, err)
	}
	if err := json.Unmarshal([]byte(`{"d":""}`), &in); err != nil || in.D != "" {
		t.Fatalf("empty date means omitted: %q, %v", in.D, err)
	}
	for _, bad := range []string{`{"d":"garbage"}`, `{"d":"2026-02-30"}`} {
		if err := json.Unmarshal([]byte(bad), &in); err == nil {
			t.Errorf("Unmarshal(%s) accepted an invalid date", bad)
		}
	}
}

func TestBoundsAreLocalMidnights(t *testing.T) {
	loc := brt(t)
	start, end := mustBounds(t, "2026-10-13", loc)
	if want := time.Date(2026, 10, 13, 0, 0, 0, 0, loc); !start.Equal(want) {
		t.Errorf("start = %v, want %v", start, want)
	}
	if want := time.Date(2026, 10, 14, 0, 0, 0, 0, loc); !end.Equal(want) {
		t.Errorf("end = %v, want %v", end, want)
	}
}

func TestBoundsAcrossDST(t *testing.T) {
	ny := zone(t, "America/New_York")
	cases := []struct {
		day  LocalDate
		want time.Duration
	}{
		{"2026-03-08", 23 * time.Hour}, // spring forward
		{"2026-11-01", 25 * time.Hour}, // fall back
		{"2026-06-15", 24 * time.Hour},
	}
	for _, c := range cases {
		start, end := mustBounds(t, c.day, ny)
		if got := end.Sub(start); got != c.want {
			t.Errorf("%s length = %v, want %v", c.day, got, c.want)
		}
		next, _ := c.day.AddDays(1)
		nextStart, _ := mustBounds(t, next, ny)
		if !nextStart.Equal(end) {
			t.Errorf("%s end %v != next day start %v (gap or overlap)", c.day, end, nextStart)
		}
	}
}

func TestBoundsWhenMidnightDoesNotExist(t *testing.T) {
	// Brazil started DST at 00:00 on 2018-11-04, so that local midnight was skipped.
	loc := brt(t)
	start, end := mustBounds(t, "2018-11-04", loc)
	if start.In(loc).Day() != 4 || start.In(loc).Hour() != 1 {
		t.Errorf("start = %v, want the first instant of Nov 4 (01:00)", start.In(loc))
	}
	if got := end.Sub(start); got != 23*time.Hour {
		t.Errorf("day length = %v, want 23h", got)
	}
}

func TestDateMethodsRejectUnvalidatedDates(t *testing.T) {
	for _, d := range []LocalDate{"", "garbage", "2026-02-30"} {
		if _, _, err := d.Bounds(time.UTC); err == nil {
			t.Errorf("Bounds(%q) err = nil", d)
		}
		if _, err := d.AddDays(1); err == nil {
			t.Errorf("AddDays(%q) err = nil", d)
		}
	}
}

func TestTodayUsesConfiguredZone(t *testing.T) {
	loc := brt(t)
	cases := []struct {
		now  time.Time
		want LocalDate
	}{
		{time.Date(2026, 10, 14, 1, 30, 0, 0, time.UTC), "2026-10-13"}, // still Oct 13 in BRT
		{time.Date(2026, 10, 14, 3, 0, 0, 0, time.UTC), "2026-10-14"},  // exactly local midnight
		{time.Date(2026, 10, 13, 23, 0, 0, 0, time.UTC), "2026-10-13"},
	}
	for _, c := range cases {
		if got := Today(c.now, loc); got != c.want {
			t.Errorf("Today(%v) = %q, want %q", c.now, got, c.want)
		}
	}
}

func TestSleepBelongsToTheDayItEnds(t *testing.T) {
	loc := brt(t)
	cases := []struct {
		end  time.Time
		want LocalDate
	}{
		{time.Date(2026, 10, 13, 9, 24, 0, 0, loc), "2026-10-13"},
		{time.Date(2026, 10, 13, 23, 59, 59, 999_999_999, loc), "2026-10-13"},
		{time.Date(2026, 10, 14, 0, 0, 0, 0, loc), "2026-10-14"},
	}
	for _, c := range cases {
		if got := SleepDay(c.end, loc); got != c.want {
			t.Errorf("SleepDay(%v) = %q, want %q", c.end, got, c.want)
		}
	}
}

func TestDateOfAcrossFallBack(t *testing.T) {
	// 01:30 occurs twice on 2026-11-01 in New York; both instants are the same day.
	ny := zone(t, "America/New_York")
	first := time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC) // 01:30 EDT
	second := first.Add(time.Hour)                         // 01:30 EST
	for _, ts := range []time.Time{first, second} {
		if got := DateOf(ts, ny); got != "2026-11-01" {
			t.Errorf("DateOf(%v) = %q, want 2026-11-01", ts, got)
		}
	}
}

func TestAddDays(t *testing.T) {
	cases := []struct {
		d    LocalDate
		n    int
		want LocalDate
	}{
		{"2026-10-01", -1, "2026-09-30"},
		{"2028-02-28", 1, "2028-02-29"},
		{"2026-03-01", -1, "2026-02-28"},
		{"2026-12-31", 1, "2027-01-01"},
		{"2026-10-13", 0, "2026-10-13"},
		{"2026-10-13", 365, "2027-10-13"},
	}
	for _, c := range cases {
		got, err := c.d.AddDays(c.n)
		if err != nil || got != c.want {
			t.Errorf("%s.AddDays(%d) = %q, %v; want %q", c.d, c.n, got, err, c.want)
		}
	}
}
