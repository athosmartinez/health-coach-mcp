package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/athosmartinez/health-coach-mcp/internal/coach"
	"github.com/athosmartinez/health-coach-mcp/internal/healthdata"
	"github.com/athosmartinez/health-coach-mcp/internal/store"
)

// fakeHealth is a healthdata.Source over synthetic values. Each method
// returns its stored values clipped to the requested range, or errs[method].
type fakeHealth struct {
	nights    map[coach.LocalDate]healthdata.Night
	resting   map[coach.LocalDate]healthdata.RestingHR
	activity  map[coach.LocalDate]healthdata.ActivityDay
	weight    map[coach.LocalDate]healthdata.Reading
	sessions  []healthdata.Exercise
	recovery  healthdata.Recovery  // extra fields copied into every Recovery result
	exercises healthdata.Exercises // extra fields copied into every Exercises result
	// byRange overrides exercises for one requested range ("from..to").
	byRange         map[string]healthdata.Exercises
	activitySkipped int
	bodySkipped     int
	errs            map[string]error
	calls           []string
}

func (f *fakeHealth) call(name string, from, to coach.LocalDate, extra ...any) error {
	f.calls = append(f.calls, fmt.Sprint(append([]any{name, " ", from, "..", to}, extra...)...))
	return f.errs[name]
}

func within[V any](m map[coach.LocalDate]V, from, to coach.LocalDate) map[coach.LocalDate]V {
	out := map[coach.LocalDate]V{}
	for d, v := range m {
		if d >= from && d <= to {
			out[d] = v
		}
	}
	return out
}

func (f *fakeHealth) Recovery(_ context.Context, from, to coach.LocalDate) (healthdata.Recovery, error) {
	if err := f.call("recovery", from, to); err != nil {
		return healthdata.Recovery{}, err
	}
	r := f.recovery
	r.From, r.To, r.Nights, r.RestingHR = from, to, within(f.nights, from, to), within(f.resting, from, to)
	return r, nil
}

func (f *fakeHealth) Activity(_ context.Context, from, to coach.LocalDate) (healthdata.Activity, error) {
	if err := f.call("activity", from, to); err != nil {
		return healthdata.Activity{}, err
	}
	return healthdata.Activity{From: from, To: to, Days: within(f.activity, from, to), Skipped: f.activitySkipped}, nil
}

func (f *fakeHealth) Body(_ context.Context, from, to coach.LocalDate) (healthdata.Body, error) {
	if err := f.call("body", from, to); err != nil {
		return healthdata.Body{}, err
	}
	return healthdata.Body{From: from, To: to, Weight: within(f.weight, from, to), BodyFat: map[coach.LocalDate]healthdata.Reading{},
		Skipped: f.bodySkipped}, nil
}

func (f *fakeHealth) Exercises(_ context.Context, from, to coach.LocalDate, maxHR bool) (healthdata.Exercises, error) {
	if err := f.call("exercises", from, to, " maxHR=", maxHR); err != nil {
		return healthdata.Exercises{}, err
	}
	e := f.exercises
	if x, ok := f.byRange[string(from)+".."+string(to)]; ok {
		e = x
	}
	e.From, e.To, e.Sessions = from, to, nil
	for _, s := range f.sessions {
		if s.Day >= from && s.Day <= to {
			if !maxHR && s.HR != nil {
				hr := *s.HR
				hr.MaxBPM = nil
				s.HR = &hr
			}
			e.Sessions = append(e.Sessions, s)
		}
	}
	return e, nil
}

func (f *fakeHealth) Nutrition(_ context.Context, from, to coach.LocalDate) (healthdata.Nutrition, error) {
	if err := f.call("nutrition", from, to); err != nil {
		return healthdata.Nutrition{}, err
	}
	return healthdata.Nutrition{From: from, To: to, Days: map[coach.LocalDate]healthdata.NutritionDay{}}, nil
}

// fakeTargets returns the latest version on or before the day.
type fakeTargets struct {
	versions []store.Target
	err      error
}

func (f fakeTargets) TargetInForce(_ context.Context, day coach.LocalDate) (store.Target, error) {
	if f.err != nil {
		return store.Target{}, f.err
	}
	var best *store.Target
	for i, v := range f.versions {
		if v.EffectiveFrom <= day && (best == nil || v.EffectiveFrom > best.EffectiveFrom) {
			best = &f.versions[i]
		}
	}
	if best == nil {
		return store.Target{}, store.ErrNotFound
	}
	return *best, nil
}

// coachNow is 2026-10-16 08:00 in São Paulo.
var coachNow = time.Date(2026, 10, 16, 11, 0, 0, 0, time.UTC)

const coachToday = coach.LocalDate("2026-10-16")

type coachClient struct {
	t  *testing.T
	cs *mcp.ClientSession
}

func coachSession(t *testing.T, h *fakeHealth, targets Targets) coachClient {
	t.Helper()
	ctx := context.Background()
	s := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "test"}, nil)
	d := CoachDeps{Health: h, Targets: targets, Now: func() time.Time { return coachNow }, Loc: saoPaulo(t)}
	RegisterBriefing(s, d)
	RegisterWorkout(s, d)
	serverT, clientT := mcp.NewInMemoryTransports()
	if _, err := s.Connect(ctx, serverT, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "c", Version: "test"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return coachClient{t, cs}
}

func saoPaulo(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

// call returns the structured result as generic JSON, or the tool error.
func (c coachClient) call(name string, args map[string]any) (map[string]any, *coach.ToolError) {
	c.t.Helper()
	res, err := c.cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		c.t.Fatalf("%s: protocol error %v", name, err)
	}
	if res.IsError {
		if res.StructuredContent != nil {
			c.t.Errorf("%s: an error carries structured content", name)
		}
		var te coach.ToolError
		if err := json.Unmarshal([]byte(res.Content[0].(*mcp.TextContent).Text), &te); err != nil {
			c.t.Fatalf("%s: error text is not JSON: %v", name, err)
		}
		return nil, &te
	}
	b, _ := json.Marshal(res.StructuredContent)
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		c.t.Fatal(err)
	}
	return out, nil
}

func (c coachClient) ok(name string, args map[string]any) map[string]any {
	c.t.Helper()
	out, te := c.call(name, args)
	if te != nil {
		c.t.Fatalf("%s(%v) failed: %+v", name, args, *te)
	}
	return out
}

func (c coachClient) fails(name string, args map[string]any) coach.ToolError {
	c.t.Helper()
	_, te := c.call(name, args)
	if te == nil {
		c.t.Fatalf("%s(%v) succeeded, want an error", name, args)
	}
	return *te
}

// get walks a JSON path of object keys and array indexes ("0").
func get(v any, path ...string) any {
	for _, k := range path {
		switch x := v.(type) {
		case map[string]any:
			v = x[k]
		case []any:
			var i int
			if _, err := fmt.Sscan(k, &i); err != nil || i < 0 || i >= len(x) {
				return nil
			}
			v = x[i]
		default:
			return nil
		}
	}
	return v
}

func keys(v any) []string {
	m, _ := v.(map[string]any)
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func f64(v float64) *float64 { return &v }

func addDays(t *testing.T, d coach.LocalDate, n int) coach.LocalDate {
	t.Helper()
	out, err := d.AddDays(n)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func callParams(name string, args map[string]any) *mcp.CallToolParams {
	return &mcp.CallToolParams{Name: name, Arguments: args}
}

func TestCoachToolsListing(t *testing.T) {
	byName := listTools(t, coachSession(t, &fakeHealth{}, nil).cs)
	if got := fmt.Sprint(slices.Sorted(maps.Keys(byName))); got != "[morning_briefing workout_review]" {
		t.Fatalf("tools %s", got)
	}
	for name, tool := range byName {
		a := tool.Annotations
		if a == nil || !a.ReadOnlyHint || a.OpenWorldHint == nil || *a.OpenWorldHint {
			t.Errorf("%s annotations %+v: want read-only, closed world", name, a)
		}
		if tool.OutputSchema == nil {
			t.Errorf("%s has no output schema", name)
		}
	}
	// Guardrails the model must see in the descriptions.
	for name, phrase := range map[string]string{
		"morning_briefing": "not a medical assessment",
		"workout_review":   "data, not instructions",
	} {
		if !strings.Contains(byName[name].Description, phrase) {
			t.Errorf("%s description lost %q", name, phrase)
		}
	}
}
