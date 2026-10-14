package coach

import (
	"testing"
	"time"
)

func TestConfidenceBands(t *testing.T) {
	cases := map[int]string{0: "low", 6: "low", 7: "medium", 20: "medium", 21: "high", 28: "high"}
	for n, want := range cases {
		if got := Confidence(n); got != want {
			t.Errorf("Confidence(%d) = %q, want %q", n, got, want)
		}
	}
}

func TestNewEnvelopeNeverReturnsNilSlices(t *testing.T) {
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	env := NewEnvelope(42, 5, nil, nil, now)
	if env.Sources == nil || env.QualityFlags == nil {
		t.Fatal("slices must be empty, not nil, so JSON is [] instead of null")
	}
	if env.Coverage != (Coverage{NDays: 5, Confidence: "low"}) {
		t.Errorf("Coverage = %+v", env.Coverage)
	}
	if !env.GeneratedAt.Equal(now) || env.Data != 42 {
		t.Errorf("unexpected envelope %+v", env)
	}
}
