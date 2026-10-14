package coach

import "time"

// ConfidenceLevel tells the model how much to trust a number.
type ConfidenceLevel string

const (
	ConfidenceLow    ConfidenceLevel = "low"
	ConfidenceMedium ConfidenceLevel = "medium"
	ConfidenceHigh   ConfidenceLevel = "high"
)

// Coverage tells the model how much history backs a number, so it can hedge
// advice built on a thin baseline.
type Coverage struct {
	NDays      int             `json:"n_days"`
	Confidence ConfidenceLevel `json:"confidence"`
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
func Confidence(nDays int) ConfidenceLevel {
	switch {
	case nDays >= 21:
		return ConfidenceHigh
	case nDays >= 7:
		return ConfidenceMedium
	default:
		return ConfidenceLow
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
