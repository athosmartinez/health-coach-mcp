package coach

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestConfidenceBands(t *testing.T) {
	cases := map[int]ConfidenceLevel{
		-1: ConfidenceLow, 0: ConfidenceLow, 6: ConfidenceLow,
		7: ConfidenceMedium, 20: ConfidenceMedium,
		21: ConfidenceHigh, 28: ConfidenceHigh,
	}
	for n, want := range cases {
		if got := Confidence(n); got != want {
			t.Errorf("Confidence(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestNewEnvelopeNeverReturnsNilSlices(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	env := NewEnvelope(42, 5, nil, nil, now)
	if env.Coverage != (Coverage{NDays: 5, Confidence: ConfidenceLow}) {
		t.Errorf("Coverage = %+v", env.Coverage)
	}
	if !env.GeneratedAt.Equal(now) || env.Data != 42 {
		t.Errorf("unexpected envelope %+v", env)
	}

	b, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	for _, want := range []string{`"sources":[]`, `"quality_flags":[]`, `"generated_at":"2026-10-13T12:00:00Z"`, `"confidence":"low"`} {
		if !strings.Contains(got, want) {
			t.Errorf("JSON %s missing %s", got, want)
		}
	}
}
