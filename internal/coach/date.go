// Package coach holds the domain types shared by every tool: local dates,
// the response envelope and the stable error contract.
package coach

import (
	"fmt"
	"time"
)

const dateLayout = "2006-01-02"

// DatePattern is the JSON schema pattern for a LocalDate. Calendar validity
// (no Feb 30) is checked by UnmarshalText, which the SDK runs on tool input.
const DatePattern = `^\d{4}-\d{2}-\d{2}$`

// LocalDate is a calendar day (YYYY-MM-DD) in the configured time zone. It is a
// string type so tool schemas infer it as a plain JSON string.
type LocalDate string

// ParseDate validates s as a real calendar date.
func ParseDate(s string) (LocalDate, error) {
	t, err := time.Parse(dateLayout, s)
	if err != nil {
		return "", fmt.Errorf("invalid date %q, want YYYY-MM-DD", s)
	}
	return LocalDate(t.Format(dateLayout)), nil
}

// UnmarshalText rejects malformed dates while tool arguments are decoded, so a
// handler never receives a LocalDate that is not a real calendar day. An empty
// string is kept as-is: it means "omitted", and tools pick their own default.
func (d *LocalDate) UnmarshalText(b []byte) error {
	if len(b) == 0 {
		*d = ""
		return nil
	}
	v, err := ParseDate(string(b))
	if err != nil {
		return err
	}
	*d = v
	return nil
}

func (d LocalDate) time() (time.Time, error) {
	t, err := time.Parse(dateLayout, string(d))
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid date %q, want YYYY-MM-DD", string(d))
	}
	return t, nil
}

// Bounds returns [start, end) of the day in loc. Local midnights are used instead of
// adding 24h, so a DST day is 23h or 25h long and consecutive days never overlap.
func (d LocalDate) Bounds(loc *time.Location) (start, end time.Time, err error) {
	t, err := d.time()
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	y, m, day := t.Date()
	return startOfDay(y, m, day, loc), startOfDay(y, m, day+1, loc), nil
}

// startOfDay is the first instant of the local day. When DST starts at 00:00 that
// midnight does not exist and time.Date may resolve it to 23:00 of the previous
// day, so step forward to the transition (zone changes fall on minute boundaries).
func startOfDay(y int, m time.Month, day int, loc *time.Location) time.Time {
	t := time.Date(y, m, day, 0, 0, 0, 0, loc)
	want := time.Date(y, m, day, 0, 0, 0, 0, time.UTC).Format(dateLayout)
	for i := 0; i < 24*60 && t.In(loc).Format(dateLayout) != want; i++ {
		t = t.Add(time.Minute)
	}
	return t
}

// AddDays returns the date n days later (negative n goes back).
func (d LocalDate) AddDays(n int) (LocalDate, error) {
	t, err := d.time()
	if err != nil {
		return "", err
	}
	return LocalDate(t.AddDate(0, 0, n).Format(dateLayout)), nil
}

// DateOf returns the local calendar day that t falls on.
func DateOf(t time.Time, loc *time.Location) LocalDate {
	return LocalDate(t.In(loc).Format(dateLayout))
}

// Today is the local day at instant now.
func Today(now time.Time, loc *time.Location) LocalDate {
	return DateOf(now, loc)
}

// SleepDay assigns a sleep session to the local day it ends on, so the night of
// Oct 12→13 is reported in the Oct 13 morning briefing.
func SleepDay(end time.Time, loc *time.Location) LocalDate {
	return DateOf(end, loc)
}
