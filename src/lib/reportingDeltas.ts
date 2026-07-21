// Pure delta utilities for the reporting standard (Bite 1).
//
// Implements CLAUDE.md section 4 "Delta calculations" exactly:
//   - absolute delta = current - comparison
//   - relative delta = absolute / |comparison| * 100
//   - rate delta is reported in percentage points (pp)
//   - full precision is preserved; rounding is a separate display concern
//   - the zero / missing state table is honored, and zero != missing
//   - presentation tone is direction-aware, never sign-alone; neutral metrics
//     always read as neutral tone
//
// Nothing here reads the clock, touches the network, or knows about a specific
// dashboard. Inputs are MetricValue (present-with-number or missing) so a real
// measured 0 stays distinct from absent data.

import type { MetricDirection, MetricValue } from '../types/reporting';

// The distinct outcomes a current-vs-comparison delta can take. This is the
// full state space from the CLAUDE.md table; callers render each explicitly.
export type DeltaKind =
  | 'delta' // both present, comparison non-zero: absolute + relative available
  | 'new' // current positive, comparison zero: "New", no infinite percentage
  | 'no_change' // both present and both zero
  | 'no_comparison_data' // current present, comparison missing
  | 'no_current_data'; // current missing (comparison anything)

// Tone used for presentation. Derived from metric direction plus the sign of
// the change, never from the sign alone.
export type DeltaTone = 'positive' | 'negative' | 'neutral';

export interface DeltaResult {
  kind: DeltaKind;
  // Full-precision values. Null when not applicable to the kind.
  absolute: number | null;
  // Relative percentage change (e.g. 12.5 means +12.5%). Null for kinds where a
  // percentage is undefined ('new', 'no_change', missing states).
  relativePercent: number | null;
  // Presentation tone for color/label. 'no_*' and 'no_change' are neutral.
  tone: DeltaTone;
}

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

// Map a raw change sign onto a tone using the metric's declared direction.
// A neutral metric is always neutral tone regardless of sign. A zero change is
// neutral for every direction.
function toneForChange(
  changeSign: -1 | 0 | 1,
  direction: MetricDirection,
): DeltaTone {
  if (direction === 'neutral' || changeSign === 0) return 'neutral';
  if (direction === 'higher_is_better') {
    return changeSign > 0 ? 'positive' : 'negative';
  }
  // lower_is_better: a decrease is good.
  return changeSign < 0 ? 'positive' : 'negative';
}

function signOf(n: number): -1 | 0 | 1 {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

// ---------------------------------------------------------------------------
// Count / currency / duration deltas
// ---------------------------------------------------------------------------

// Compute a delta for an additive numeric metric (counts, currency, durations).
// Honors the full zero/missing state table. Full precision is preserved; use
// the display helpers below for rounding.
export function computeDelta(
  current: MetricValue,
  comparison: MetricValue,
  direction: MetricDirection = 'neutral',
): DeltaResult {
  // Missing current dominates: there is nothing to show.
  if (current.state === 'missing') {
    return { kind: 'no_current_data', absolute: null, relativePercent: null, tone: 'neutral' };
  }
  // Current present, comparison missing: we can show the value but not a delta.
  if (comparison.state === 'missing') {
    return { kind: 'no_comparison_data', absolute: null, relativePercent: null, tone: 'neutral' };
  }

  const cur = current.value;
  const cmp = comparison.value;
  const absolute = cur - cmp;

  // Both zero -> genuinely no change.
  if (cur === 0 && cmp === 0) {
    return { kind: 'no_change', absolute: 0, relativePercent: null, tone: 'neutral' };
  }

  // Comparison zero with a positive current -> "New", avoid infinite percent.
  // (A negative current against a zero comparison is unusual for counts but is
  // still not a divide-by-zero percentage; treat as New with the absolute.)
  if (cmp === 0) {
    return {
      kind: 'new',
      absolute,
      relativePercent: null,
      tone: toneForChange(signOf(absolute), direction),
    };
  }

  // Standard case: both present, comparison non-zero.
  const relativePercent = (absolute / Math.abs(cmp)) * 100;
  return {
    kind: 'delta',
    absolute,
    relativePercent,
    tone: toneForChange(signOf(absolute), direction),
  };
}

// ---------------------------------------------------------------------------
// Rate deltas (percentage points)
// ---------------------------------------------------------------------------

// A rate is recomputed for each period from its own aggregate numerator and
// denominator (per CLAUDE.md), then expressed here. `ratePercent` is the rate
// already in percent (e.g. a 3.2% CTR is 3.2, not 0.032). The absolute change
// is in percentage POINTS; the relative change is percent-of-the-old-rate.
export function computeRateDelta(
  current: MetricValue,
  comparison: MetricValue,
  direction: MetricDirection = 'neutral',
): DeltaResult {
  if (current.state === 'missing') {
    return { kind: 'no_current_data', absolute: null, relativePercent: null, tone: 'neutral' };
  }
  if (comparison.state === 'missing') {
    return { kind: 'no_comparison_data', absolute: null, relativePercent: null, tone: 'neutral' };
  }

  const cur = current.value;
  const cmp = comparison.value;
  const pointChange = cur - cmp; // percentage points

  if (cur === 0 && cmp === 0) {
    return { kind: 'no_change', absolute: 0, relativePercent: null, tone: 'neutral' };
  }
  if (cmp === 0) {
    return {
      kind: 'new',
      absolute: pointChange,
      relativePercent: null,
      tone: toneForChange(signOf(pointChange), direction),
    };
  }

  const relativePercent = (pointChange / Math.abs(cmp)) * 100;
  return {
    kind: 'delta',
    absolute: pointChange, // in pp
    relativePercent,
    tone: toneForChange(signOf(pointChange), direction),
  };
}

// ---------------------------------------------------------------------------
// Display helpers (rounding is separate from calculation)
// ---------------------------------------------------------------------------

// Round for display without mutating the stored full-precision value. Uses a
// symmetric round-half-away-from-zero so -0.5 and 0.5 behave predictably.
export function roundForDisplay(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  const shifted = value * factor;
  const rounded = shifted >= 0 ? Math.round(shifted) : -Math.round(-shifted);
  return rounded / factor;
}

// A concise, color-free textual summary of a delta for accessibility and
// snapshotting in tests. Does not include arrows or color; the component layer
// adds those. `unit` is appended to the absolute value (e.g. "pp" for rates).
export function describeDelta(result: DeltaResult, unit = ''): string {
  switch (result.kind) {
    case 'no_current_data':
      return 'No current data';
    case 'no_comparison_data':
      return 'No comparison data';
    case 'no_change':
      return 'No change';
    case 'new':
      return 'New';
    case 'delta': {
      const abs = result.absolute ?? 0;
      const rel = result.relativePercent ?? 0;
      const absStr = `${abs >= 0 ? '+' : ''}${roundForDisplay(abs)}${unit}`;
      const relStr = `${rel >= 0 ? '+' : ''}${roundForDisplay(rel)}%`;
      return `${absStr} (${relStr})`;
    }
  }
}
