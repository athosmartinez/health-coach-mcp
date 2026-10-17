// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Adapted from google-health-cli pkg/types/registry.go (filter paths, page and
// rollup range caps) and cmd/data.go (filter and dailyRollUp body builders).
// Changes: a closed table of the read operations the coach uses instead of the
// full registry, ranges taken as inclusive local days, local midnights from
// coach.LocalDate.Bounds for physical-time fields, ranges longer than the
// rollup cap split into chunks instead of rejected.

package googlehealth

import (
	"fmt"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
)

// DataType is a Google Health API data type ID, as used in request paths.
type DataType string

// The data types the coach reads.
const (
	Sleep                     DataType = "sleep"
	HeartRateVariability      DataType = "heart-rate-variability"
	DailyHeartRateVariability DataType = "daily-heart-rate-variability"
	DailyRestingHeartRate     DataType = "daily-resting-heart-rate"
	Steps                     DataType = "steps"
	ActiveZoneMinutes         DataType = "active-zone-minutes"
	Exercise                  DataType = "exercise"
	NutritionLog              DataType = "nutrition-log"
	TotalCalories             DataType = "total-calories"
	Weight                    DataType = "weight"
	BodyFat                   DataType = "body-fat"
)

// filterKind is the time field a type's list filter compares against.
type filterKind int

const (
	civilStart filterKind = iota // interval.civil_start_time, local wall time without a zone
	civilEnd                     // interval.civil_end_time; sleep filters only on its end
	physical                     // sample_time.physical_time, a UTC instant
	date                         // date, a plain YYYY-MM-DD
)

type operation uint8

const (
	opList operation = 1 << iota
	opReconcile
	opDailyRollup
)

func (o operation) String() string {
	switch o {
	case opList:
		return "list"
	case opReconcile:
		return "reconcile"
	default:
		return "daily rollup"
	}
}

type typeInfo struct {
	filterName string // snake_case name used in filter expressions
	kind       filterKind
	ops        operation
	// pageSize is the largest page the API accepts: 25 for sleep and
	// exercise, 10000 for the others.
	pageSize int
	// rollupDays is the longest dailyRollUp range per request: 14 days for
	// total-calories, 90 for the others.
	rollupDays int
}

var typeTable = map[DataType]typeInfo{
	Sleep:                     {"sleep", civilEnd, opList | opReconcile, 25, 0},
	HeartRateVariability:      {"heart_rate_variability", physical, opList | opReconcile, 10000, 0},
	DailyHeartRateVariability: {"daily_heart_rate_variability", date, opList | opReconcile, 10000, 0},
	DailyRestingHeartRate:     {"daily_resting_heart_rate", date, opList | opReconcile, 10000, 0},
	Steps:                     {"steps", civilStart, opList | opReconcile | opDailyRollup, 10000, 90},
	ActiveZoneMinutes:         {"active_zone_minutes", civilStart, opList | opReconcile | opDailyRollup, 10000, 90},
	Exercise:                  {"exercise", civilStart, opList | opReconcile, 25, 0},
	NutritionLog:              {"nutrition_log", civilStart, opList | opReconcile | opDailyRollup, 10000, 90},
	TotalCalories:             {"total_calories", civilStart, opDailyRollup, 10000, 14},
	Weight:                    {"weight", physical, opList | opReconcile | opDailyRollup, 10000, 90},
	BodyFat:                   {"body_fat", physical, opList | opReconcile | opDailyRollup, 10000, 90},
}

// lookup returns the type's facts, or an error when the type is unknown or
// does not support op. Both are caller bugs, caught before any request.
func lookup(dt DataType, op operation) (typeInfo, error) {
	info, ok := typeTable[dt]
	if !ok {
		return typeInfo{}, fmt.Errorf("googlehealth: unknown data type %q", dt)
	}
	if info.ops&op == 0 {
		return typeInfo{}, fmt.Errorf("googlehealth: %s does not support %s", dt, op)
	}
	return info, nil
}

// span validates an inclusive local-day range and returns its exclusive end
// (the day after to).
func span(from, to coach.LocalDate) (end coach.LocalDate, err error) {
	if _, err := coach.ParseDate(string(from)); err != nil {
		return "", fmt.Errorf("googlehealth: from: %w", err)
	}
	if _, err := coach.ParseDate(string(to)); err != nil {
		return "", fmt.Errorf("googlehealth: to: %w", err)
	}
	if to < from { // YYYY-MM-DD orders as text
		return "", fmt.Errorf("googlehealth: range ends (%s) before it starts (%s)", to, from)
	}
	return to.AddDays(1)
}

// filter is the AIP-160 expression selecting the local days [from, to]. The
// API supports only >= and <, so the upper bound is the next day's start.
func filter(info typeInfo, from, to coach.LocalDate, loc *time.Location) (string, error) {
	end, err := span(from, to)
	if err != nil {
		return "", err
	}
	bounds := func(field, lo, hi string) string {
		path := info.filterName + "." + field
		return fmt.Sprintf("%s >= %q AND %s < %q", path, lo, path, hi)
	}
	switch info.kind {
	case civilStart:
		return bounds("interval.civil_start_time", string(from)+"T00:00:00", string(end)+"T00:00:00"), nil
	case civilEnd:
		return bounds("interval.civil_end_time", string(from)+"T00:00:00", string(end)+"T00:00:00"), nil
	case physical:
		lo, _, err := from.Bounds(loc)
		if err != nil {
			return "", err
		}
		_, hi, err := to.Bounds(loc)
		if err != nil {
			return "", err
		}
		const utc = "2006-01-02T15:04:05Z"
		return bounds("sample_time.physical_time", lo.UTC().Format(utc), hi.UTC().Format(utc)), nil
	default:
		return bounds("date", string(from), string(end)), nil
	}
}

// civilDate is the API's CivilDateTime at a day's midnight.
type civilDate struct {
	Date struct {
		Year  int `json:"year"`
		Month int `json:"month"`
		Day   int `json:"day"`
	} `json:"date"`
}

func toCivil(d coach.LocalDate) (civilDate, error) {
	t, err := time.Parse(time.DateOnly, string(d))
	if err != nil {
		return civilDate{}, fmt.Errorf("googlehealth: invalid date %q", d)
	}
	var c civilDate
	c.Date.Year, c.Date.Month, c.Date.Day = t.Year(), int(t.Month()), t.Day()
	return c, nil
}

// rollupRequest is the dailyRollUp body. windowSizeDays is documented as
// optional, but the API answers 400 without it.
type rollupRequest struct {
	Range struct {
		Start civilDate `json:"start"`
		End   civilDate `json:"end"`
	} `json:"range"`
	WindowSizeDays int    `json:"windowSizeDays"`
	PageSize       int    `json:"pageSize"`
	PageToken      string `json:"pageToken,omitempty"`
}

// rollupChunks splits [from, to] into requests of at most info.rollupDays days.
func rollupChunks(info typeInfo, from, to coach.LocalDate) ([]rollupRequest, error) {
	last, err := span(from, to) // exclusive
	if err != nil {
		return nil, err
	}
	var out []rollupRequest
	for start := from; start < last; {
		end, err := start.AddDays(info.rollupDays)
		if err != nil {
			return nil, err
		}
		end = min(end, last)
		r := rollupRequest{WindowSizeDays: 1, PageSize: info.pageSize}
		if r.Range.Start, err = toCivil(start); err != nil {
			return nil, err
		}
		if r.Range.End, err = toCivil(end); err != nil {
			return nil, err
		}
		out = append(out, r)
		start = end
	}
	return out, nil
}
