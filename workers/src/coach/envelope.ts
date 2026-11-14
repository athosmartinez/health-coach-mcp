// The shape every coach-moment tool returns (Go: internal/coach/envelope.go).

/** Tells the model how much to trust a number. */
export type ConfidenceLevel = "low" | "medium" | "high";

/** How much history backs a number, so the model can hedge advice built on a thin baseline. */
export interface Coverage {
  n_days: number;
  confidence: ConfidenceLevel;
}

export interface Envelope<T> {
  data: T;
  coverage: Coverage;
  sources: string[];
  quality_flags: string[];
  /** RFC 3339, UTC. */
  generated_at: string;
}

/** Maps days of coverage to a band: low (<7), medium (7–20), high (≥21). */
export function confidence(nDays: number): ConfidenceLevel {
  if (nDays >= 21) return "high";
  return nDays >= 7 ? "medium" : "low";
}

/** Builds an envelope. Missing lists become empty, so the JSON carries [] and never null. */
export function newEnvelope<T>(data: T, nDays: number, sources: string[] | undefined, flags: string[] | undefined, now: Date): Envelope<T> {
  return {
    data,
    coverage: { n_days: nDays, confidence: confidence(nDays) },
    sources: sources ?? [],
    quality_flags: flags ?? [],
    // The fraction is trimmed of trailing zeros, as the Go server writes a time.
    generated_at: now.toISOString().replace(/\.?0+Z$/, "Z"),
  };
}
