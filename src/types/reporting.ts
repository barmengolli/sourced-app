// Shared reporting-standard types (Bite 1 of the reporting-standardization
// program). These encode the timeframe, comparison, basis, direction, and
// data-availability vocabulary from CLAUDE.md sections 4 and 5.
//
// This module is deliberately disconnected from any existing dashboard. It
// defines the vocabulary; the pure utilities in reportingPeriods.ts and
// reportingDeltas.ts operate on it, and the components in components/reporting/
// render it. No page imports this during Bite 1.
//
// Strictness rules for this foundation: no `any`, no double casts, no
// page-specific unions. Quarter reuses the existing PeriodIndex from db.ts so
// the reporting layer speaks the same 1..4 language as the funnel data.

import type { PeriodIndex } from './db';

// ---------------------------------------------------------------------------
// Grain, comparison, basis, direction
// ---------------------------------------------------------------------------

// Standard executive-reporting grains. Week is intentionally excluded: per
// CLAUDE.md it stays a source/diagnostic detail, not a standard grain.
export type ReportingGrain = 'month' | 'quarter' | 'year';

// Comparison mode chosen in the Compare-to control. `off` means no comparison
// is requested at all (distinct from a comparison that has no data).
export type ComparisonMode = 'previous_period' | 'previous_year' | 'off';

// How a report's numbers are assembled from its source. Drives the
// reporting-basis disclosure and the aggregation rule. Mirrors the five
// standard labels in CLAUDE.md section 4.
export type ReportingBasis =
  | 'cohort'
  | 'activity'
  | 'snapshot'
  | 'derived_activity'
  | 'allocation';

// Whether a larger number is good, bad, or carries no inherent goal. Color and
// tone derive from direction, never from mathematical sign alone. Unknown
// metrics default to `neutral` until a business owner approves a direction.
export type MetricDirection =
  | 'higher_is_better'
  | 'lower_is_better'
  | 'neutral';

// ---------------------------------------------------------------------------
// Selected reporting period
// ---------------------------------------------------------------------------

// A month is 1..12. Kept as a branded-free plain union for exhaustive checks
// and calendar math.
export type MonthIndex =
  | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

// A concrete selected period. The shape is discriminated by `grain` so a month
// period carries a month, a quarter period carries a quarter, and a year
// period carries neither. `year` is a full four-digit calendar year.
export type ReportingPeriod =
  | { grain: 'month'; year: number; month: MonthIndex }
  | { grain: 'quarter'; year: number; quarter: PeriodIndex }
  | { grain: 'year'; year: number };

// Inclusive, date-only (YYYY-MM-DD) boundaries of a period. Both endpoints are
// part of the period. These are calendar strings, never Date objects, so no
// browser-timezone conversion can shift them.
export interface PeriodBounds {
  start: string; // inclusive, YYYY-MM-DD
  end: string; // inclusive, YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Data availability: missing vs zero vs partial vs complete
// ---------------------------------------------------------------------------

// Completeness of the data behind a period. `missing` (no data at all) and a
// real measured `zero` are different facts and must stay distinct downstream.
//   - missing:  no source data for the period (cannot compute a value)
//   - partial:  the period is not finished, or an import is stale/behind
//   - complete: the period is finished and fully covered by source data
export type PeriodCompleteness = 'missing' | 'partial' | 'complete';

// A metric value paired with whether it exists. `state: 'missing'` means there
// is no value (do not treat as 0). `state: 'present'` carries a real number,
// which may legitimately be 0.
export type MetricValue =
  | { state: 'missing' }
  | { state: 'present'; value: number };

// Result of assessing a current period against a data-through / as-of date.
export interface CompletenessAssessment {
  completeness: PeriodCompleteness;
  // The inclusive calendar day through which data is trusted, when known.
  dataThrough: string | null;
  // True when a current-period delta must be suppressed (partial or missing).
  suppressDelta: boolean;
}

// ---------------------------------------------------------------------------
// Full reporting selection (period + comparison)
// ---------------------------------------------------------------------------

export interface ReportingSelection {
  period: ReportingPeriod;
  comparison: ComparisonMode;
}
