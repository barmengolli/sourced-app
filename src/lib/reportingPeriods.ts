// Pure period utilities for the reporting standard (Bite 1).
//
// Design rules (from CLAUDE.md section 4 and the testing rules):
//   - No function here reads the current clock. Any "is this partial?" decision
//     takes an explicitly supplied as-of / data-through date.
//   - ISO date-only values (YYYY-MM-DD) are treated as pure calendar strings.
//     We never build a `new Date(iso)` and read local getters, which would shift
//     the day in negative timezones. All comparison is lexicographic on the
//     normalized YYYY-MM-DD form, which is safe because the format is fixed
//     width and zero-padded.
//   - Invalid or unsupported period shapes are rejected (null return or a
//     thrown RangeError, documented per function), never silently coerced.
//   - No reporting math lives in compute.ts; this is the dedicated home.

import type {
  ComparisonMode,
  MonthIndex,
  PeriodBounds,
  ReportingGrain,
  ReportingPeriod,
} from '../types/reporting';
import type { PeriodIndex } from '../types/db';

// ---------------------------------------------------------------------------
// Internal calendar helpers (no Date, no clock, no timezone)
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

// Days in a month, honoring leap years. month is 1..12.
function daysInMonth(year: number, month: MonthIndex): number {
  // February leap-year rule: divisible by 4, except centuries not divisible by 400.
  if (month === 2) {
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return isLeap ? 29 : 28;
  }
  // April, June, September, November have 30; the rest 31.
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Build a YYYY-MM-DD calendar string from integer parts. Pure string assembly,
// no Date construction.
function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

function isValidYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1 && year <= 9999;
}

function isMonthIndex(n: number): n is MonthIndex {
  return Number.isInteger(n) && n >= 1 && n <= 12;
}

function isPeriodIndex(n: number): n is PeriodIndex {
  return n === 1 || n === 2 || n === 3 || n === 4;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Returns the same period if it is structurally valid, otherwise null. Callers
// that prefer to fail loudly can use assertReportingPeriod.
export function isValidReportingPeriod(period: ReportingPeriod): boolean {
  if (!isValidYear(period.year)) return false;
  switch (period.grain) {
    case 'month':
      return isMonthIndex(period.month);
    case 'quarter':
      return isPeriodIndex(period.quarter);
    case 'year':
      return true;
    default: {
      // Exhaustiveness guard: an unknown grain is invalid, not a crash.
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Boundaries (inclusive, date-only)
// ---------------------------------------------------------------------------

// The first calendar month of a quarter (1, 4, 7, 10).
function quarterStartMonth(quarter: PeriodIndex): MonthIndex {
  return ((quarter - 1) * 3 + 1) as MonthIndex;
}

// Inclusive YYYY-MM-DD boundaries of a reporting period. Returns null for an
// invalid period rather than throwing, so UI code can guard gracefully.
export function periodBounds(period: ReportingPeriod): PeriodBounds | null {
  if (!isValidReportingPeriod(period)) return null;
  switch (period.grain) {
    case 'month': {
      const last = daysInMonth(period.year, period.month);
      return {
        start: isoDate(period.year, period.month, 1),
        end: isoDate(period.year, period.month, last),
      };
    }
    case 'quarter': {
      const sm = quarterStartMonth(period.quarter);
      const em = (sm + 2) as MonthIndex;
      const last = daysInMonth(period.year, em);
      return {
        start: isoDate(period.year, sm, 1),
        end: isoDate(period.year, em, last),
      };
    }
    case 'year': {
      return {
        start: isoDate(period.year, 1, 1),
        end: isoDate(period.year, 12, 31),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Previous period and previous year
// ---------------------------------------------------------------------------

// The immediately-preceding period of the same grain. Crosses calendar
// boundaries: January -> prior-year December, Q1 -> prior-year Q4, and year N
// -> year N-1. Returns null for an invalid input period.
export function previousPeriod(period: ReportingPeriod): ReportingPeriod | null {
  if (!isValidReportingPeriod(period)) return null;
  switch (period.grain) {
    case 'month': {
      if (period.month === 1) {
        // January of year 1 has no valid previous month (year 0 is invalid).
        if (period.year <= 1) return null;
        return { grain: 'month', year: period.year - 1, month: 12 };
      }
      return {
        grain: 'month',
        year: period.year,
        month: (period.month - 1) as MonthIndex,
      };
    }
    case 'quarter': {
      if (period.quarter === 1) {
        // Q1 of year 1 has no valid previous quarter (year 0 is invalid).
        if (period.year <= 1) return null;
        return { grain: 'quarter', year: period.year - 1, quarter: 4 };
      }
      return {
        grain: 'quarter',
        year: period.year,
        quarter: (period.quarter - 1) as PeriodIndex,
      };
    }
    case 'year': {
      // Year 1 has no valid previous year (year 0 is invalid).
      if (period.year <= 1) return null;
      return { grain: 'year', year: period.year - 1 };
    }
  }
}

// The same period one calendar year earlier. For Year grain this is identical
// to previousPeriod (year N-1), which is why the UI collapses the two options.
export function previousYearPeriod(
  period: ReportingPeriod,
): ReportingPeriod | null {
  if (!isValidReportingPeriod(period)) return null;
  // Any year-1 period has no valid prior-year counterpart (year 0 is invalid).
  if (period.year <= 1) return null;
  switch (period.grain) {
    case 'month':
      return { grain: 'month', year: period.year - 1, month: period.month };
    case 'quarter':
      return { grain: 'quarter', year: period.year - 1, quarter: period.quarter };
    case 'year':
      return { grain: 'year', year: period.year - 1 };
  }
}

// Resolve a comparison mode to the concrete comparison period. `off` yields
// null. For Year grain, previous_period and previous_year coincide.
export function comparisonPeriod(
  period: ReportingPeriod,
  mode: ComparisonMode,
): ReportingPeriod | null {
  if (mode === 'off') return null;
  if (mode === 'previous_year') return previousYearPeriod(period);
  return previousPeriod(period);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

// Human label for a period, e.g. "June 2026", "Q2 2026", "2026". Empty string
// for an invalid period so callers can render nothing.
export function periodLabel(period: ReportingPeriod): string {
  if (!isValidReportingPeriod(period)) return '';
  switch (period.grain) {
    case 'month':
      return `${MONTH_NAMES[period.month - 1]} ${period.year}`;
    case 'quarter':
      return `Q${period.quarter} ${period.year}`;
    case 'year':
      return `${period.year}`;
  }
}

// Comparison label shown next to a delta, e.g. "vs June", "vs Q2", "vs 2025".
// The comparison mode plus the CURRENT period determine phrasing:
//   - previous_year on a month  -> "vs <Month> <prior year>" is verbose; the
//     standard short form names the comparison period concisely.
// Returns empty string when the mode is off or inputs are invalid.
export function comparisonLabel(
  period: ReportingPeriod,
  mode: ComparisonMode,
): string {
  const cmp = comparisonPeriod(period, mode);
  if (!cmp) return '';
  switch (cmp.grain) {
    case 'month':
      // Month comparisons name the month; include the year only when it differs
      // from the current period's year (previous_year, or a January rollover).
      return cmp.year === period.year
        ? `vs ${MONTH_NAMES[cmp.month - 1]}`
        : `vs ${MONTH_NAMES[cmp.month - 1]} ${cmp.year}`;
    case 'quarter':
      return cmp.year === period.year
        ? `vs Q${cmp.quarter}`
        : `vs Q${cmp.quarter} ${cmp.year}`;
    case 'year':
      return `vs ${cmp.year}`;
  }
}

// Whether the two comparison modes collapse to one option for a grain. Year
// grain: previous_period === previous_year, so the UI shows a single choice.
export function comparisonModesCollapse(grain: ReportingGrain): boolean {
  return grain === 'year';
}

// ---------------------------------------------------------------------------
// Partial-period detection (explicit as-of date, never the clock)
// ---------------------------------------------------------------------------

// A real, existing calendar date in YYYY-MM-DD form. Beyond the fixed-width
// shape, this rejects month 0, month 13, day 0, impossible month lengths, and
// invalid February dates, honoring leap years (including the 1900 and 2000
// century rules via daysInMonth). Purely string/integer math: no Date object,
// so it stays timezone-independent.
export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (!isValidYear(year)) return false;
  if (!isMonthIndex(month)) return false; // rejects 0 and 13
  if (day < 1 || day > daysInMonth(year, month)) return false; // rejects 0 and overflow
  return true;
}

// Compare two YYYY-MM-DD strings lexicographically. Returns null if either is
// not a real calendar date. Lexicographic order is correct once both are valid
// because the format is fixed-width and zero-padded.
function compareIsoDates(a: string, b: string): number | null {
  if (!isValidIsoDate(a) || !isValidIsoDate(b)) return null;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Assess a current period's completeness against an explicitly supplied
// data-through (or as-of) calendar date. This function NEVER reads the clock;
// the caller must pass the date it trusts.
//
//   - If dataThrough is null or not a real calendar date -> 'missing'
//     (cannot judge; suppress). Shape-valid but impossible dates such as
//     '2026-13-40' are rejected here, not treated as trustworthy.
//   - If dataThrough is on/after the period end -> 'complete'.
//   - If dataThrough is before the period start -> 'missing' (no data yet).
//   - Otherwise the period is underway -> 'partial'.
//
// suppressDelta is true for 'partial' and 'missing': a partial or unknown
// current period must not be compared as if it were whole.
export function assessCompleteness(
  period: ReportingPeriod,
  dataThrough: string | null,
): { completeness: 'missing' | 'partial' | 'complete'; dataThrough: string | null; suppressDelta: boolean } {
  const bounds = periodBounds(period);
  if (!bounds || !dataThrough) {
    return { completeness: 'missing', dataThrough: dataThrough ?? null, suppressDelta: true };
  }
  const cmpEnd = compareIsoDates(dataThrough, bounds.end);
  const cmpStart = compareIsoDates(dataThrough, bounds.start);
  if (cmpEnd === null || cmpStart === null) {
    return { completeness: 'missing', dataThrough, suppressDelta: true };
  }
  if (cmpEnd >= 0) {
    return { completeness: 'complete', dataThrough, suppressDelta: false };
  }
  if (cmpStart < 0) {
    return { completeness: 'missing', dataThrough, suppressDelta: true };
  }
  return { completeness: 'partial', dataThrough, suppressDelta: true };
}

// Convenience predicate for callers that only need a boolean.
export function isPeriodComplete(
  period: ReportingPeriod,
  dataThrough: string | null,
): boolean {
  return assessCompleteness(period, dataThrough).completeness === 'complete';
}
