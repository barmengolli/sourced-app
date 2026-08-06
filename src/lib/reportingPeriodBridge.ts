// reportingPeriodBridge.ts
//
// The adapter between the shared reporting standard (ReportingPeriod: Month,
// Quarter, Year) and the legacy funnel calculator (PeriodFilter: 'year' or
// 'Q1'..'Q4').
//
// WHY A BRIDGE INSTEAD OF CHANGING PeriodFilter
//   Adding a month grain to PeriodFilter means changing the ten compute.ts
//   functions that accept it, across thirteen files and the ~2,900-line module
//   behind every funnel number. That is a calculation change and deserves its
//   own reconciliation, separate from a filter-standardization change. Doing
//   both at once would make any regression impossible to attribute.
//
//   So the funnel pages adopt the shared CONTROLS, the shared SELECTION, and
//   the shared COMPARISON and DELTA rules now, while their calculators keep
//   speaking PeriodFilter. Month is DISABLED on those pages with a visible
//   reason rather than silently absent or, worse, fabricated by splitting a
//   quarter into three.
//
// THE RULE THIS ENFORCES
//   toPeriodFilter returns null for a month period. It never rounds a month up
//   to its containing quarter. Reporting July as Q3 would silently triple the
//   number a user asked for, which is exactly the class of defect the standard
//   exists to prevent.

import type { PeriodFilter } from './compute';
import type { ReportingGrain, ReportingPeriod } from '../types/reporting';

// Grains the legacy funnel calculator can honestly serve today.
export const LEGACY_FUNNEL_GRAINS: ReadonlyArray<ReportingGrain> = [
  'quarter',
  'year',
];

// Shown wherever Month is offered but disabled, so the control explains itself
// rather than looking broken. Sentence case, no em dash.
export const MONTH_DISABLED_REASON =
  'Month is not available for this source yet. These figures are computed by '
  + 'quarter, and splitting a quarter into months would invent data that was '
  + 'never recorded.';

// Convert a shared ReportingPeriod into the legacy PeriodFilter.
//
// Returns null for a month period: the caller must handle that explicitly
// rather than receive a silently widened quarter.
export function toPeriodFilter(period: ReportingPeriod): PeriodFilter | null {
  if (period.grain === 'year') return 'year';
  if (period.grain === 'quarter') return `Q${period.quarter}` as PeriodFilter;
  return null;
}

// Convert a legacy (year, filter) pair back into a shared ReportingPeriod, so a
// page holding legacy state can seed the shared selection without guessing.
export function fromPeriodFilter(
  year: number,
  filter: PeriodFilter,
): ReportingPeriod {
  if (filter === 'year') return { grain: 'year', year };
  const quarter = Number(filter.slice(1));
  // The union only admits Q1..Q4, so this cast is describing the type system's
  // existing guarantee rather than widening it.
  return { grain: 'quarter', year, quarter: quarter as 1 | 2 | 3 | 4 };
}

// Whether a page backed by the legacy calculator can render this period at all.
export function legacySupportsPeriod(period: ReportingPeriod): boolean {
  return period.grain !== 'month';
}
