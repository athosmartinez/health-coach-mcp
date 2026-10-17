// Package healthdata turns Google Health records into the coach's daily
// values, through the daily_metrics cache. It decides what is cached; the API
// client fetches and the metrics package does the math.
package healthdata

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"sort"
	"time"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/googlehealth"
	"github.com/athosmartinez/health-coach-mcp/internal/metrics"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// Daily value keys: the store's closed list (CAPABILITY §5.3).
const (
	KeyAsleep     = "sleep_asleep_min"
	KeyAwake      = "sleep_awake_min"
	KeyInBed      = "sleep_in_bed_min"
	KeyDeep       = "sleep_deep_min"
	KeyLight      = "sleep_light_min"
	KeyREM        = "sleep_rem_min"
	KeySleepStart = "sleep_start_min_of_day"
	KeyHRV        = "hrv_rmssd_ms"
	KeyRestingHR  = "resting_hr_bpm"
)

// sleepKeys are the per-night rows. KeyAsleep is written last and removed
// first, so a night is a cache hit only when its write completed.
var sleepKeys = []string{KeyAsleep, KeyAwake, KeyInBed, KeyDeep, KeyLight, KeyREM, KeySleepStart}

var (
	coreKeys  = []string{KeyAwake, KeyInBed, KeySleepStart} // with KeyAsleep, always present
	stageKeys = []string{KeyDeep, KeyLight, KeyREM}         // all or none
)

const (
	// settleDays: the band syncs late, so a day is cached only once it is
	// this many days old; the days after it are always fetched live.
	settleDays = 3
	// The band records rMSSD about every 5 minutes of sleep. A nightly median
	// needs at least minHRVSamples samples covering minHRVCoverage of the
	// night's slots, and minHalfCoverage of each half: a band worn for the
	// last hour only would otherwise give a value that sits in the baselines.
	hrvSlot         = 5 * time.Minute
	minHRVSamples   = 12
	minHRVCoverage  = 0.5
	minHalfCoverage = 0.25
	// maxSplitGap: main-sleep records ending on the same day with at most
	// this much awake time between them are one night split by a wake-up.
	maxSplitGap = 3 * time.Hour
	// MaxRangeDays bounds one Recovery call (28-day baselines with slack).
	MaxRangeDays     = 120
	restingWithSleep = "WITH_SLEEP"
)

// Fetcher is the part of googlehealth.Client this package uses.
type Fetcher interface {
	List(ctx context.Context, dt googlehealth.DataType, from, to coach.LocalDate) ([]json.RawMessage, error)
}

// Cache is the part of store.Store this package uses.
type Cache interface {
	MetricRange(ctx context.Context, key string, from, to coach.LocalDate, algoVersion int) ([]store.Metric, error)
	PutMetric(ctx context.Context, m store.Metric) error
	DeleteMetric(ctx context.Context, day coach.LocalDate, key string) error
}

// Source is what the coach tools read.
type Source interface {
	Recovery(ctx context.Context, from, to coach.LocalDate) (Recovery, error)
}

// Night is the main sleep ending on a local day (CAPABILITY I4): the longest
// session, joined with the parts of the same night split by a wake-up, and
// the median HRV inside it.
type Night struct {
	AsleepMin, AwakeMin, InBedMin float64
	DeepMin, LightMin, REMMin     *float64 // nil without final stages
	StartMinOfDay                 int      // local start time, minutes after midnight
	HRV                           *float64 // median rMSSD (ms); nil when the samples cover too little of the night
	// HRVCoverage is the share (0..1) of the night's 5-minute slots holding
	// an HRV sample.
	HRVCoverage float64
	Source      string
	// Provisional: Google has not finished processing the night (or sent it
	// in a format the coach does not know), so its values may still change.
	// Baselines leave it out.
	Provisional bool
}

// RestingHR is one day's resting heart rate.
type RestingHR struct {
	BPM float64
	// Method is Google's calculation method. WITH_SLEEP is the band's
	// standard one; other values are shown for the day but kept out of
	// baselines.
	Method string
}

// Standard reports whether the value was computed with the band's standard method.
func (h RestingHR) Standard() bool { return h.Method == restingWithSleep }

// Excluded counts readable records of the range the coach left out, by reason.
type Excluded struct {
	OtherSource      int // another platform, such as Apple Health copies
	Naps             int
	ExtraSessions    int // main-sleep records that were not part of the night, or duplicated it
	NoHRVValue       int // HRV samples inside a night without an rMSSD value
	UnknownSleepType int // nights in a sleep format other than STAGES or CLASSIC
}

// Recovery holds the nights and resting heart rates of [From, To].
type Recovery struct {
	From, To  coach.LocalDate
	Nights    map[coach.LocalDate]Night
	RestingHR map[coach.LocalDate]RestingHR
	Sources   []string // device or platform labels, sorted
	// Skipped counts records that could not be read. Tools report it as a
	// data quality flag; the day of one (or its whole fetch, when the day
	// is unknown) is never cached.
	Skipped  int
	Excluded Excluded
	// Empty lists the data types whose records for the range were all from
	// another platform or without a value: a source or format change, not a
	// lack of data.
	Empty []googlehealth.DataType
}

// Series returns one point per day of [From, To] for key, nil where the value
// is missing: every value, for reporting the days themselves.
func (r Recovery) Series(key string) ([]metrics.Point, error) { return r.series(key, false) }

// BaselineSeries is Series without the values that must not shape a
// baseline: provisional nights and resting heart rates from a non-standard
// method.
func (r Recovery) BaselineSeries(key string) ([]metrics.Point, error) { return r.series(key, true) }

func (r Recovery) series(key string, baseline bool) ([]metrics.Point, error) {
	night := func(f func(Night) *float64) func(coach.LocalDate) *float64 {
		return func(d coach.LocalDate) *float64 {
			if n, ok := r.Nights[d]; ok && !(baseline && n.Provisional) {
				return f(n)
			}
			return nil
		}
	}
	var get func(coach.LocalDate) *float64
	switch key {
	case KeyAsleep:
		get = night(func(n Night) *float64 { return &n.AsleepMin })
	case KeyAwake:
		get = night(func(n Night) *float64 { return &n.AwakeMin })
	case KeyInBed:
		get = night(func(n Night) *float64 { return &n.InBedMin })
	case KeyDeep:
		get = night(func(n Night) *float64 { return n.DeepMin })
	case KeyLight:
		get = night(func(n Night) *float64 { return n.LightMin })
	case KeyREM:
		get = night(func(n Night) *float64 { return n.REMMin })
	case KeySleepStart:
		get = night(func(n Night) *float64 { v := float64(n.StartMinOfDay); return &v })
	case KeyHRV:
		get = night(func(n Night) *float64 { return n.HRV })
	case KeyRestingHR:
		get = func(d coach.LocalDate) *float64 {
			if v, ok := r.RestingHR[d]; ok && !(baseline && !v.Standard()) {
				return &v.BPM
			}
			return nil
		}
	default:
		return nil, fmt.Errorf("healthdata: no series %q", key)
	}
	days, err := dayList(r.From, r.To)
	if err != nil {
		return nil, err
	}
	out := make([]metrics.Point, len(days))
	for i, d := range days {
		out[i] = metrics.Point{Date: d, Value: get(d)}
	}
	return out, nil
}

// Data implements Source over the API client and the cache. It is safe for
// concurrent use when its Fetcher and Cache are.
type Data struct {
	api   Fetcher
	cache Cache
	loc   *time.Location
	zone  string // loc's name, stored with each row: another zone is a miss
	now   func() time.Time
	log   *slog.Logger
}

// New wires the source. now is the clock that decides which days are settled.
func New(api Fetcher, cache Cache, loc *time.Location, now func() time.Time, log *slog.Logger) (*Data, error) {
	if api == nil || cache == nil || loc == nil || now == nil {
		return nil, errors.New("healthdata: api, cache, time zone and clock are required")
	}
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Data{api: api, cache: cache, loc: loc, zone: loc.String(), now: now, log: log}, nil
}

// fetch accumulates one Recovery call's results across its API ranges.
type fetch struct {
	r       *Recovery
	settled coach.LocalDate
	sources map[string]bool
	empty   map[googlehealth.DataType]bool
}

// Recovery returns the nights and resting heart rates of [from, to]. Settled
// days come from the cache when complete; the rest is fetched live, one API
// range per run of consecutive missing days.
func (d *Data) Recovery(ctx context.Context, from, to coach.LocalDate) (Recovery, error) {
	days, err := dayList(from, to)
	if err != nil {
		return Recovery{}, err
	}
	settled, err := coach.Today(d.now(), d.loc).AddDays(-settleDays)
	if err != nil {
		return Recovery{}, err
	}
	r := Recovery{From: from, To: to, Nights: map[coach.LocalDate]Night{}, RestingHR: map[coach.LocalDate]RestingHR{}}
	f := &fetch{r: &r, settled: settled, sources: map[string]bool{}, empty: map[googlehealth.DataType]bool{}}

	cached, err := d.readCache(ctx, from, min(to, settled))
	if err != nil {
		return Recovery{}, err
	}
	var needSleep, needResting []coach.LocalDate
	for _, day := range days {
		if n, ok := cached.night(day); ok {
			r.Nights[day] = n
			f.sources[n.Source] = true
		} else {
			needSleep = append(needSleep, day)
		}
		if m, ok := cached[KeyRestingHR][day]; ok {
			// Only standard-method values are cached.
			r.RestingHR[day] = RestingHR{BPM: m.Value, Method: restingWithSleep}
			f.sources[m.Source] = true
		} else {
			needResting = append(needResting, day)
		}
	}
	for _, run := range runs(needSleep) {
		if err := d.fetchNights(ctx, run[0], run[1], f); err != nil {
			return Recovery{}, err
		}
	}
	for _, run := range runs(needResting) {
		if err := d.fetchResting(ctx, run[0], run[1], f); err != nil {
			return Recovery{}, err
		}
	}
	delete(f.sources, "")
	for s := range f.sources {
		r.Sources = append(r.Sources, s)
	}
	sort.Strings(r.Sources)
	for dt := range f.empty {
		r.Empty = append(r.Empty, dt)
	}
	slices.Sort(r.Empty)
	return r, nil
}

type cacheRows map[string]map[coach.LocalDate]store.Metric

func (c cacheRows) night(day coach.LocalDate) (Night, bool) {
	asleep, ok := c[KeyAsleep][day]
	if !ok {
		return Night{}, false
	}
	vals := map[string]float64{}
	for _, k := range coreKeys {
		m, ok := c[k][day]
		if !ok {
			return Night{}, false
		}
		vals[k] = m.Value
	}
	n := Night{
		AsleepMin: asleep.Value, AwakeMin: vals[KeyAwake], InBedMin: vals[KeyInBed],
		StartMinOfDay: int(vals[KeySleepStart]), Source: asleep.Source,
	}
	var stages []*float64
	for _, k := range stageKeys {
		if m, ok := c[k][day]; ok {
			v := m.Value
			stages = append(stages, &v)
		}
	}
	switch len(stages) {
	case len(stageKeys):
		n.DeepMin, n.LightMin, n.REMMin = stages[0], stages[1], stages[2]
	case 0:
	default:
		return Night{}, false
	}
	if m, ok := c[KeyHRV][day]; ok {
		if m.NSamples == nil {
			return Night{}, false
		}
		v := m.Value
		n.HRV, n.HRVCoverage = &v, coverage(*m.NSamples, n.InBedMin)
	}
	return n, true
}

// readCache loads every key for the settled days [from, to], keeping only
// rows computed in the configured zone; an empty range (to before from:
// nothing settled yet) reads nothing.
func (d *Data) readCache(ctx context.Context, from, to coach.LocalDate) (cacheRows, error) {
	rows := cacheRows{}
	if to < from {
		return rows, nil
	}
	for _, k := range append(slices.Clone(sleepKeys), KeyHRV, KeyRestingHR) {
		ms, err := d.cache.MetricRange(ctx, k, from, to, metrics.AlgoVersion)
		if err != nil {
			return nil, fmt.Errorf("healthdata: read cache: %w", err)
		}
		rows[k] = map[coach.LocalDate]store.Metric{}
		for _, m := range ms {
			if m.Zone == d.zone {
				rows[k][m.Date] = m
			}
		}
	}
	return rows, nil
}

// fetchNights reads the sleep sessions and HRV samples of [a, b] and fills the
// nights. Sessions are fetched with a day of margin on each side: the API
// filters on the device's local end time, while a night belongs to the day it
// ends in the configured zone. HRV starts the day before, for a night that
// begins in the evening. Records outside [a, b] count for nothing.
func (d *Data) fetchNights(ctx context.Context, a, b coach.LocalDate, f *fetch) error {
	before, err := a.AddDays(-1)
	if err != nil {
		return err
	}
	after, err := b.AddDays(1)
	if err != nil {
		return err
	}
	rawSleep, err := d.api.List(ctx, googlehealth.Sleep, before, after)
	if err != nil {
		return err
	}
	rawHRV, err := d.api.List(ctx, googlehealth.HeartRateVariability, before, b)
	if err != nil {
		return err
	}
	r := f.r
	// An unreadable record taints its day, or the whole range when its day
	// is unknown: a tainted day is returned but not cached.
	runTainted, tainted, skipped := false, map[coach.LocalDate]bool{}, 0
	otherSleep := 0
	byDay := map[coach.LocalDate][]session{}
	for _, raw := range rawSleep {
		s, err := parseSleep(raw)
		if s.end.IsZero() {
			runTainted = true
			skipped++
			continue
		}
		day := coach.SleepDay(s.end, d.loc)
		if day < a || day > b {
			continue
		}
		switch {
		case errors.Is(err, errOtherSource):
			otherSleep++
		case err != nil:
			skipped++
			tainted[day] = true
		case s.nap:
			r.Excluded.Naps++
		default:
			if s.unknownType {
				r.Excluded.UnknownSleepType++
			}
			byDay[day] = append(byDay[day], s)
		}
	}
	var samples []hrvSample
	var bad, noValue, foreign []time.Time // counted only inside a night
	for _, raw := range rawHRV {
		h, err := parseHRV(raw)
		switch {
		case h.at.IsZero():
			runTainted = true
			skipped++
		case errors.Is(err, errOtherSource):
			foreign = append(foreign, h.at)
		case errors.Is(err, errNoValue):
			noValue = append(noValue, h.at)
		case err != nil:
			bad = append(bad, h.at)
		default:
			samples = append(samples, h)
		}
	}
	r.Excluded.OtherSource += otherSleep
	if otherSleep > 0 && len(byDay) == 0 {
		d.markEmpty(f, googlehealth.Sleep, a, b)
	}
	if len(foreign)+len(noValue) > 0 && len(samples) == 0 {
		d.markEmpty(f, googlehealth.HeartRateVariability, a, b)
	}
	for day, ss := range byDay {
		parts, extra := nightParts(ss)
		r.Excluded.ExtraSessions += extra
		n, settled := d.night(parts, samples)
		within := func(ts []time.Time) int {
			c := 0
			for _, t := range ts {
				if inParts(parts, t) {
					c++
				}
			}
			return c
		}
		if c := within(bad); c > 0 {
			skipped += c
			tainted[day] = true
		}
		r.Excluded.NoHRVValue += within(noValue)
		r.Excluded.OtherSource += within(foreign)
		r.Nights[day] = n
		f.sources[n.Source] = true
		// Only settled nights from a clean fetch are cached, and only with a
		// final HRV value or none at all: partial samples may still be syncing.
		if day <= f.settled && !runTainted && !tainted[day] && settled && (n.HRV != nil || n.HRVCoverage == 0) {
			d.putNight(ctx, day, n)
		}
	}
	r.Skipped += skipped
	if skipped > 0 {
		d.log.Warn("unreadable records in a recovery fetch", "from", string(a), "to", string(b), "skipped", skipped)
	}
	return nil
}

// markEmpty flags a data type whose records were all left out.
func (d *Data) markEmpty(f *fetch, dt googlehealth.DataType, a, b coach.LocalDate) {
	f.empty[dt] = true
	d.log.Warn("google health records arrived but none were usable", "data_type", string(dt), "from", string(a), "to", string(b))
}

// nightParts picks the night among one day's main-sleep sessions: records
// that overlap are copies of one session (the longer is kept), sessions at
// most maxSplitGap apart are parts of one night, and the night with the most
// time in bed wins (a tie keeps the later end). extra counts the rest.
func nightParts(ss []session) (parts []session, extra int) {
	sort.Slice(ss, func(i, j int) bool { return ss[i].start.Before(ss[j].start) })
	var kept []session
	for _, s := range ss {
		if n := len(kept); n > 0 && s.start.Before(kept[n-1].end) {
			extra++
			if longer(s, kept[n-1]) {
				kept[n-1] = s
			}
			continue
		}
		kept = append(kept, s)
	}
	var groups [][]session
	for i, s := range kept {
		if i > 0 && s.start.Sub(kept[i-1].end) <= maxSplitGap {
			groups[len(groups)-1] = append(groups[len(groups)-1], s)
			continue
		}
		groups = append(groups, []session{s})
	}
	best := 0
	inBed := func(g []session) (m float64) {
		for _, s := range g {
			m += s.inBed
		}
		return m
	}
	for i, g := range groups[1:] {
		if bi, gi := inBed(groups[best]), inBed(g); gi > bi || (gi == bi && !g[len(g)-1].end.Before(groups[best][len(groups[best])-1].end)) {
			best = i + 1
		}
	}
	return groups[best], len(kept) - len(groups[best]) + extra
}

func longer(s, than session) bool {
	ds, dt := s.end.Sub(s.start), than.end.Sub(than.start)
	return ds > dt || (ds == dt && s.end.After(than.end))
}

func inParts(parts []session, t time.Time) bool {
	for _, p := range parts {
		if !t.Before(p.start) && !t.After(p.end) {
			return true
		}
	}
	return false
}

// night joins the parts and computes the HRV median over the samples inside
// them. settled is false when any part may still change.
func (d *Data) night(parts []session, samples []hrvSample) (n Night, settled bool) {
	n = Night{StartMinOfDay: minuteOfDay(parts[0].start.In(d.loc)), Source: parts[0].source}
	settled, staged := true, true
	var deep, light, rem float64
	for _, p := range parts {
		n.AsleepMin += p.asleep
		n.AwakeMin += p.awake
		n.InBedMin += p.inBed
		settled = settled && p.settled
		if p.deep == nil {
			staged = false
			continue
		}
		deep, light, rem = deep+*p.deep, light+*p.light, rem+*p.rem
	}
	if staged {
		n.DeepMin, n.LightMin, n.REMMin = &deep, &light, &rem
	}
	n.Provisional = !settled

	var vals []float64
	var slots []bool // each part's 5-minute slots, in order
	for _, p := range parts {
		ps := make([]bool, slotCount(p.inBed))
		for _, h := range samples {
			if !h.at.Before(p.start) && !h.at.After(p.end) {
				vals = append(vals, h.rmssd)
				ps[min(int(h.at.Sub(p.start)/hrvSlot), len(ps)-1)] = true
			}
		}
		slots = append(slots, ps...)
	}
	n.HRVCoverage = coverage(count(slots), n.InBedMin)
	half := len(slots) / 2
	if len(vals) >= minHRVSamples && n.HRVCoverage >= minHRVCoverage &&
		share(slots[:half]) >= minHalfCoverage && share(slots[half:]) >= minHalfCoverage {
		m := median(vals)
		n.HRV = &m
	}
	return n, settled
}

func slotCount(inBedMin float64) int {
	return max(1, int(math.Ceil(inBedMin/hrvSlot.Minutes())))
}

// coverage is the share of a night's slots holding a sample. It depends only
// on what the cache stores (the covered slot count and the time in bed), so a
// cached night reports the same value as a live one.
func coverage(covered int, inBedMin float64) float64 {
	return min(1, float64(covered)/float64(slotCount(inBedMin)))
}

func coveredSlots(n Night) int {
	return int(math.Round(n.HRVCoverage * float64(slotCount(n.InBedMin))))
}

func count(b []bool) (c int) {
	for _, x := range b {
		if x {
			c++
		}
	}
	return c
}

func share(b []bool) float64 {
	if len(b) == 0 {
		return 1
	}
	return float64(count(b)) / float64(len(b))
}

// putNight writes a night: the commit row (KeyAsleep) is removed first and
// written last, so a write that fails halfway leaves a miss, never a night
// mixing old and new rows. Stage and HRV rows are written or removed.
func (d *Data) putNight(ctx context.Context, day coach.LocalDate, n Night) {
	if !d.del(ctx, day, KeyAsleep) {
		return
	}
	stages := map[string]*float64{KeyDeep: n.DeepMin, KeyLight: n.LightMin, KeyREM: n.REMMin}
	for _, k := range stageKeys {
		ok := false
		if v := stages[k]; v != nil {
			ok = d.put(ctx, store.Metric{Date: day, Key: k, Value: *v, Source: n.Source})
		} else {
			ok = d.del(ctx, day, k)
		}
		if !ok {
			return
		}
	}
	ok := false
	if n.HRV != nil {
		slots := coveredSlots(n)
		ok = d.put(ctx, store.Metric{Date: day, Key: KeyHRV, Value: *n.HRV, NSamples: &slots, Source: n.Source})
	} else {
		ok = d.del(ctx, day, KeyHRV)
	}
	if !ok {
		return
	}
	for k, v := range map[string]float64{KeyAwake: n.AwakeMin, KeyInBed: n.InBedMin, KeySleepStart: float64(n.StartMinOfDay)} {
		if !d.put(ctx, store.Metric{Date: day, Key: k, Value: v, Source: n.Source}) {
			return
		}
	}
	d.put(ctx, store.Metric{Date: day, Key: KeyAsleep, Value: n.AsleepMin, Source: n.Source})
}

// put writes one cache row. The cache is disposable, so a failed write is
// logged (key, day and the error's types, never the value) and the live
// value is still returned.
func (d *Data) put(ctx context.Context, m store.Metric) bool {
	m.AlgoVersion, m.Zone, m.FetchedAt = metrics.AlgoVersion, d.zone, d.now()
	if err := d.cache.PutMetric(ctx, m); err != nil {
		d.log.Warn("cache write failed", "metric", m.Key, "date", string(m.Date), "error_types", coach.ErrorTypes(err))
		return false
	}
	return true
}

func (d *Data) del(ctx context.Context, day coach.LocalDate, key string) bool {
	if err := d.cache.DeleteMetric(ctx, day, key); err != nil {
		d.log.Warn("cache delete failed", "metric", key, "date", string(day), "error_types", coach.ErrorTypes(err))
		return false
	}
	return true
}

// fetchResting reads the daily resting heart rates of [a, b]. Two Fitbit
// values for one day keep the one computed with sleep (the band's standard
// method), then the lower. Only a day's single standard value is cached, so
// a later fetch can settle a duplicate or a non-standard method.
func (d *Data) fetchResting(ctx context.Context, a, b coach.LocalDate, f *fetch) error {
	raws, err := d.api.List(ctx, googlehealth.DailyRestingHeartRate, a, b)
	if err != nil {
		return err
	}
	r := f.r
	runTainted, tainted, skipped, other := false, map[coach.LocalDate]bool{}, 0, 0
	byDay := map[coach.LocalDate][]restingDay{}
	for _, raw := range raws {
		v, err := parseResting(raw)
		if v.date == "" {
			runTainted = true
			skipped++
			continue
		}
		if v.date < a || v.date > b {
			continue
		}
		switch {
		case errors.Is(err, errOtherSource):
			other++
		case err != nil:
			skipped++
			tainted[v.date] = true
		default:
			byDay[v.date] = append(byDay[v.date], v)
		}
	}
	r.Skipped += skipped
	if skipped > 0 {
		d.log.Warn("unreadable resting heart rate records", "from", string(a), "to", string(b), "skipped", skipped)
	}
	r.Excluded.OtherSource += other
	if other > 0 && len(byDay) == 0 {
		d.markEmpty(f, googlehealth.DailyRestingHeartRate, a, b)
	}
	for day, vs := range byDay {
		sort.Slice(vs, func(i, j int) bool {
			if wi, wj := vs[i].method == restingWithSleep, vs[j].method == restingWithSleep; wi != wj {
				return wi
			}
			return vs[i].bpm < vs[j].bpm
		})
		v := vs[0]
		h := RestingHR{BPM: v.bpm, Method: v.method}
		r.RestingHR[day] = h
		f.sources[v.source] = true
		if day <= f.settled && !runTainted && !tainted[day] && len(vs) == 1 && h.Standard() {
			d.put(ctx, store.Metric{Date: day, Key: KeyRestingHR, Value: v.bpm, Source: v.source})
		}
	}
	return nil
}

func dayList(from, to coach.LocalDate) ([]coach.LocalDate, error) {
	if _, err := coach.ParseDate(string(from)); err != nil {
		return nil, fmt.Errorf("healthdata: from: %w", err)
	}
	if _, err := coach.ParseDate(string(to)); err != nil {
		return nil, fmt.Errorf("healthdata: to: %w", err)
	}
	if to < from {
		return nil, fmt.Errorf("healthdata: range ends (%s) before it starts (%s)", to, from)
	}
	var out []coach.LocalDate
	for d := from; d <= to; {
		if len(out) == MaxRangeDays {
			return nil, fmt.Errorf("healthdata: a range spans at most %d days", MaxRangeDays)
		}
		out = append(out, d)
		next, err := d.AddDays(1)
		if err != nil {
			return nil, err
		}
		d = next
	}
	return out, nil
}

// runs groups sorted days into [first, last] runs of consecutive days.
func runs(days []coach.LocalDate) [][2]coach.LocalDate {
	var out [][2]coach.LocalDate
	for _, d := range days {
		if n := len(out); n > 0 {
			if next, err := out[n-1][1].AddDays(1); err == nil && next == d {
				out[n-1][1] = d
				continue
			}
		}
		out = append(out, [2]coach.LocalDate{d, d})
	}
	return out
}

func minuteOfDay(t time.Time) int { return t.Hour()*60 + t.Minute() }

func median(v []float64) float64 {
	s := slices.Clone(v)
	slices.Sort(s)
	n := len(s)
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}
