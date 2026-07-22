// Pure reporting helpers for the LinkedIn Ads dashboard (Bite 2).
//
// Source contract (see docs/linkedin-n8n-mapping.md and CLAUDE.md section 2):
//   - Each snapshot is a weekly additive total per ad set, keyed by
//     snapshot_date, which is the WEEK-ENDING SUNDAY.
//   - A whole week is assigned to the month, quarter, and year that contain its
//     week-ending Sunday. Weeks are never prorated or split across months, and
//     no daily values are invented.
//   - CTR, CPC, CPM are recomputed from summed numerators/denominators per
//     period, never averaged across weeks.
//
// This module is pure: no React, no Supabase, no current clock. It builds on the
// Bite 1 reporting foundation (reportingPeriods / reportingDeltas). It does NOT
// live in compute.ts.

import type { LinkedinAdSnapshot } from '../types/db';
import type {
  MetricValue,
  MonthIndex,
  ReportingPeriod,
  ComparisonMode,
} from '../types/reporting';
import {
  periodBounds,
  comparisonPeriod,
  isValidIsoDate,
} from './reportingPeriods';

// ---------------------------------------------------------------------------
// Totals and rates
// ---------------------------------------------------------------------------

export interface LinkedinTotals {
  spend: number;
  impressions: number;
  clicks: number;
}

export interface LinkedinRates {
  // CTR and CPM/CPC as raw numbers; the UI formats them. CTR is a fraction
  // (clicks/impressions), expressed as a percentage by the caller. null when
  // the denominator is zero (undefined rate, distinct from a real 0).
  ctrPercent: number | null; // clicks / impressions * 100
  cpc: number | null; // spend / clicks
  cpm: number | null; // spend / impressions * 1000
}

const ZERO_TOTALS: LinkedinTotals = { spend: 0, impressions: 0, clicks: 0 };

// Sum a set of weekly rows. Missing numeric fields are treated as 0 within a
// present row; whether the *period itself* has data is tracked separately (see
// periodTotals) so a real zero stays distinct from "no rows at all".
export function sumSnapshots(rows: readonly LinkedinAdSnapshot[]): LinkedinTotals {
  const t: LinkedinTotals = { ...ZERO_TOTALS };
  for (const r of rows) {
    t.spend += r.spend ?? 0;
    t.impressions += r.impressions ?? 0;
    t.clicks += r.clicks ?? 0;
  }
  return t;
}

// Recompute rates from aggregate totals. Never averages per-week rates.
export function ratesFromTotals(t: LinkedinTotals): LinkedinRates {
  return {
    ctrPercent: t.impressions > 0 ? (t.clicks / t.impressions) * 100 : null,
    cpc: t.clicks > 0 ? t.spend / t.clicks : null,
    cpm: t.impressions > 0 ? (t.spend / t.impressions) * 1000 : null,
  };
}

// ---------------------------------------------------------------------------
// Period membership (assign a whole week by its week-ending Sunday)
// ---------------------------------------------------------------------------

// A snapshot belongs to a reporting period when its week-ending Sunday falls
// within the period's inclusive calendar bounds. Because assignment is by the
// Sunday alone, the whole weekly total lands in one period; it is never split.
export function snapshotInPeriod(
  snapshotDate: string,
  period: ReportingPeriod,
): boolean {
  if (!isValidIsoDate(snapshotDate)) return false;
  const b = periodBounds(period);
  if (!b) return false;
  return snapshotDate >= b.start && snapshotDate <= b.end;
}

export function filterSnapshots(
  rows: readonly LinkedinAdSnapshot[],
  period: ReportingPeriod,
): LinkedinAdSnapshot[] {
  return rows.filter((r) => snapshotInPeriod(r.snapshot_date, period));
}

// ---------------------------------------------------------------------------
// Non-time filters (applied identically to current and comparison periods)
// ---------------------------------------------------------------------------

export interface LinkedinFilters {
  products?: readonly string[];
  regions?: readonly string[];
  adsets?: readonly string[];
}

function matchesFilters(r: LinkedinAdSnapshot, f: LinkedinFilters): boolean {
  if (f.products && f.products.length > 0 && !f.products.includes(r.product ?? '')) return false;
  if (f.regions && f.regions.length > 0 && !f.regions.includes(r.region ?? '')) return false;
  if (f.adsets && f.adsets.length > 0 && !f.adsets.includes(r.adset_name)) return false;
  return true;
}

export function applyFilters(
  rows: readonly LinkedinAdSnapshot[],
  filters: LinkedinFilters,
): LinkedinAdSnapshot[] {
  return rows.filter((r) => matchesFilters(r, filters));
}

// ---------------------------------------------------------------------------
// Period totals as MetricValues (missing vs zero preserved)
// ---------------------------------------------------------------------------

// Totals for a period, plus per-metric MetricValues. When the period has NO
// matching rows, each metric is `missing` (distinct from a measured 0). When it
// has rows, each metric is `present` with the summed value (possibly 0).
export interface PeriodMetrics {
  hasData: boolean;
  totals: LinkedinTotals;
  rates: LinkedinRates;
  values: {
    spend: MetricValue;
    impressions: MetricValue;
    clicks: MetricValue;
    ctrPercent: MetricValue;
    cpc: MetricValue;
    cpm: MetricValue;
  };
}

function metric(hasData: boolean, value: number | null): MetricValue {
  if (!hasData || value === null) return { state: 'missing' };
  return { state: 'present', value };
}

export function periodMetrics(
  allRows: readonly LinkedinAdSnapshot[],
  period: ReportingPeriod,
  filters: LinkedinFilters = {},
): PeriodMetrics {
  const rows = applyFilters(filterSnapshots(allRows, period), filters);
  const hasData = rows.length > 0;
  const totals = sumSnapshots(rows);
  const rates = ratesFromTotals(totals);
  return {
    hasData,
    totals,
    rates,
    values: {
      spend: metric(hasData, totals.spend),
      impressions: metric(hasData, totals.impressions),
      clicks: metric(hasData, totals.clicks),
      // Rate metrics are missing when their denominator is zero (rate undefined).
      ctrPercent: metric(hasData, rates.ctrPercent),
      cpc: metric(hasData, rates.cpc),
      cpm: metric(hasData, rates.cpm),
    },
  };
}

// ---------------------------------------------------------------------------
// Comparison (same non-time filters on both sides)
// ---------------------------------------------------------------------------

export interface PeriodComparison {
  current: PeriodMetrics;
  // null when comparison mode is off or the comparison period is out of range
  // (e.g. year 1 has no predecessor).
  comparison: PeriodMetrics | null;
  comparisonPeriod: ReportingPeriod | null;
}

export function comparePeriods(
  allRows: readonly LinkedinAdSnapshot[],
  period: ReportingPeriod,
  mode: ComparisonMode,
  filters: LinkedinFilters = {},
): PeriodComparison {
  const current = periodMetrics(allRows, period, filters);
  const cmpPeriod = comparisonPeriod(period, mode);
  const comparison = cmpPeriod
    ? periodMetrics(allRows, cmpPeriod, filters)
    : null;
  return { current, comparison, comparisonPeriod: cmpPeriod };
}

// ---------------------------------------------------------------------------
// Breakdowns (Product / Region / Ad Set), reconciling to KPI totals
// ---------------------------------------------------------------------------

export interface BreakdownRow {
  name: string;
  totals: LinkedinTotals;
  rates: LinkedinRates;
}

// Group the given (already period- and filter-scoped) rows by a key. Rates per
// row are recomputed from that row's aggregate numerators/denominators. The sum
// of the rows' totals equals the KPI totals for the same scope, guaranteeing
// reconciliation.
export function breakdownBy(
  rows: readonly LinkedinAdSnapshot[],
  key: (r: LinkedinAdSnapshot) => string,
): BreakdownRow[] {
  const map = new Map<string, LinkedinTotals>();
  for (const r of rows) {
    const k = key(r) || '—';
    const t = map.get(k) ?? { spend: 0, impressions: 0, clicks: 0 };
    t.spend += r.spend ?? 0;
    t.impressions += r.impressions ?? 0;
    t.clicks += r.clicks ?? 0;
    map.set(k, t);
  }
  return [...map.entries()]
    .map(([name, totals]) => ({ name, totals, rates: ratesFromTotals(totals) }))
    .sort((a, b) => b.totals.spend - a.totals.spend);
}

// Convenience: the three standard breakdowns for the current period + filters.
export interface LinkedinBreakdowns {
  byProduct: BreakdownRow[];
  byRegion: BreakdownRow[];
  byAdset: BreakdownRow[];
}

export function periodBreakdowns(
  allRows: readonly LinkedinAdSnapshot[],
  period: ReportingPeriod,
  filters: LinkedinFilters = {},
): LinkedinBreakdowns {
  const rows = applyFilters(filterSnapshots(allRows, period), filters);
  return {
    byProduct: breakdownBy(rows, (r) => r.product ?? ''),
    byRegion: breakdownBy(rows, (r) => r.region ?? ''),
    byAdset: breakdownBy(rows, (r) => r.adset_name),
  };
}

// ---------------------------------------------------------------------------
// Source-specific completeness (week-ending convention)
// ---------------------------------------------------------------------------

// Pure integer day math (no Date, no clock, no timezone) for the week-ending
// convention. Absolute epoch is irrelevant; only day differences matter.
function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
// A proleptic day ordinal: year*365 + leap-days + day-of-year.
function ymdToOrdinal(y: number, m: number, d: number): number {
  let days = 0;
  for (let yy = 1; yy < y; yy++) days += isLeap(yy) ? 366 : 365;
  days += CUM_DAYS[m - 1];
  if (m > 2 && isLeap(y)) days += 1;
  days += d;
  return days;
}
// 2023-01-01 is a Sunday; day-of-week = (ordinal - REF) mod 7, 0 = Sunday.
const REF_SUNDAY_ORDINAL = ymdToOrdinal(2023, 1, 1);
function ordinalToYmd(ordinal: number): string {
  let y = 1;
  let remaining = ordinal;
  // Walk years forward. Ordinals here are small (year >= 1), so this loop is
  // bounded and clock-free.
  for (;;) {
    const inYear = isLeap(y) ? 366 : 365;
    if (remaining <= inYear) break;
    remaining -= inYear;
    y += 1;
  }
  const leap = isLeap(y);
  let m = 12;
  for (let mm = 1; mm <= 12; mm++) {
    const start = CUM_DAYS[mm - 1] + (mm > 2 && leap ? 1 : 0);
    if (remaining <= start) {
      m = mm - 1;
      break;
    }
    m = mm;
  }
  const monthStart = CUM_DAYS[m - 1] + (m > 2 && leap ? 1 : 0);
  const d = remaining - monthStart;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
}

// The latest Sunday on or before the given valid date. Returns null for an
// invalid date. The result is a YYYY-MM-DD string.
export function sundayOnOrBefore(date: string): string | null {
  if (!isValidIsoDate(date)) return null;
  const [y, m, d] = date.split('-').map((s) => parseInt(s, 10));
  const ord = ymdToOrdinal(y, m, d);
  const dow = ((ord - REF_SUNDAY_ORDINAL) % 7 + 7) % 7; // 0 = Sunday
  return ordinalToYmd(ord - dow);
}

// The final week-ending Sunday that BELONGS to a reporting period: the latest
// Sunday on or before the period's inclusive end. A weekly row is in the period
// iff its Sunday is within the period bounds, so this Sunday is the last one the
// period can contain. Returns null for an invalid period.
export function finalSundayOfPeriod(period: ReportingPeriod): string | null {
  const b = periodBounds(period);
  if (!b) return null;
  return sundayOnOrBefore(b.end);
}

// The latest imported week-ending date across ALL rows (global data-through),
// independent of the selected period or filters. null when there are no rows.
export function latestImportedSunday(
  allRows: readonly LinkedinAdSnapshot[],
): string | null {
  let latest: string | null = null;
  for (const r of allRows) {
    if (!isValidIsoDate(r.snapshot_date)) continue;
    if (latest === null || r.snapshot_date > latest) latest = r.snapshot_date;
  }
  return latest;
}

// The Month reporting period that contains the latest imported snapshot_date.
// Used to default the dashboard to "the latest period containing data" without
// reading the clock. Returns null when there are no valid rows.
export function defaultMonthPeriod(
  allRows: readonly LinkedinAdSnapshot[],
): ReportingPeriod | null {
  const latest = latestImportedSunday(allRows);
  if (latest === null) return null;
  const [y, m] = latest.split('-').map((s) => parseInt(s, 10));
  return { grain: 'month', year: y, month: m as MonthIndex };
}

// Distinct years present in the data, plus a guaranteed anchor year, newest
// first. Clock-free; the caller supplies any extra anchor if desired.
export function availableYears(
  allRows: readonly LinkedinAdSnapshot[],
  extraYear?: number,
): number[] {
  const ys = new Set<number>();
  if (extraYear !== undefined) ys.add(extraYear);
  for (const r of allRows) {
    if (typeof r.year === 'number') ys.add(r.year);
  }
  return [...ys].sort((a, b) => b - a);
}

export interface LinkedinCompleteness {
  completeness: 'missing' | 'partial' | 'complete';
  // The final week-ending Sunday belonging to the selected period.
  finalSunday: string | null;
  // The latest imported week-ending Sunday across all data (data-through).
  dataThrough: string | null;
  // Deltas are suppressed unless the period is complete.
  suppressDelta: boolean;
}

// Assess completeness for the SELECTED period using the week-ending convention.
// The status depends on both global coverage and whether the selected period
// actually contains rows:
//   - No rows fall in the selected period -> `missing` (deltas suppressed).
//     This covers a future period and a historical gap where newer global data
//     exists but this period has none.
//   - Rows present, but the latest imported Sunday has not reached the period's
//     final Sunday -> `partial`.
//   - Rows present and coverage has reached the final Sunday -> `complete`.
// `dataThrough` is always the GLOBAL latest imported Sunday, independent of the
// selected period, so the "Data through week ending ..." label stays stable.
// This deliberately does NOT detect a missing intermediate weekly run; see
// docs/linkedin-n8n-mapping.md.
export function assessLinkedinCompleteness(
  allRows: readonly LinkedinAdSnapshot[],
  period: ReportingPeriod,
): LinkedinCompleteness {
  const finalSunday = finalSundayOfPeriod(period);
  const dataThrough = latestImportedSunday(allRows);
  const hasRowsInPeriod = filterSnapshots(allRows, period).length > 0;
  // No rows for this period (or an unusable period/date) -> missing.
  if (finalSunday === null || dataThrough === null || !hasRowsInPeriod) {
    return { completeness: 'missing', finalSunday, dataThrough, suppressDelta: true };
  }
  if (dataThrough >= finalSunday) {
    return { completeness: 'complete', finalSunday, dataThrough, suppressDelta: false };
  }
  return { completeness: 'partial', finalSunday, dataThrough, suppressDelta: true };
}
