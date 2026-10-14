// Package coach holds the domain types shared by every tool: local dates,
// the response envelope and the stable error contract.
package coach

import (
	"fmt"
	"time"
)

const dateLayout = "2006-01-02"

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

// Bounds returns [start, end) of the day in loc. Local midnights are used instead of
// adding 24h so the range stays correct if the zone ever observes DST again.
func (d LocalDate) Bounds(loc *time.Location) (start, end time.Time) {
	t, err := time.Parse(dateLayout, string(d))
	if err != nil {
		panic(fmt.Sprintf("coach: Bounds on unvalidated date %q", string(d)))
	}
	y, m, day := t.Date()
	return time.Date(y, m, day, 0, 0, 0, 0, loc), time.Date(y, m, day+1, 0, 0, 0, 0, loc)
}

// AddDays returns the date n days later (negative n goes back).
func (d LocalDate) AddDays(n int) LocalDate {
	t, err := time.Parse(dateLayout, string(d))
	if err != nil {
		panic(fmt.Sprintf("coach: AddDays on unvalidated date %q", string(d)))
	}
	return LocalDate(t.AddDate(0, 0, n).Format(dateLayout))
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
