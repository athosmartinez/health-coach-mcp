package coach

import "time"

// Coverage tells the model how much history backs a number, so it can hedge
// advice built on a thin baseline.
type Coverage struct {
	NDays      int    `json:"n_days"`
	Confidence string `json:"confidence"`
}

// Envelope is the shape every coach tool returns.
type Envelope[T any] struct {
	Data         T         `json:"data"`
	Coverage     Coverage  `json:"coverage"`
	Sources      []string  `json:"sources"`
	QualityFlags []string  `json:"quality_flags"`
	GeneratedAt  time.Time `json:"generated_at"`
}

// Confidence maps days of coverage to a band: low (<7), medium (7–20), high (≥21).
func Confidence(nDays int) string {
	switch {
	case nDays >= 21:
		return "high"
	case nDays >= 7:
		return "medium"
	default:
		return "low"
	}
}

// NewEnvelope builds an envelope. Nil slices become empty so the JSON carries []
// rather than null, which some clients treat as a schema violation.
func NewEnvelope[T any](data T, nDays int, sources, flags []string, now time.Time) Envelope[T] {
	if sources == nil {
		sources = []string{}
	}
	if flags == nil {
		flags = []string{}
	}
	return Envelope[T]{
		Data:         data,
		Coverage:     Coverage{NDays: nDays, Confidence: Confidence(nDays)},
		Sources:      sources,
		QualityFlags: flags,
		GeneratedAt:  now,
	}
}
