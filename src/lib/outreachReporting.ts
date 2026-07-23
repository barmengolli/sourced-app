// Pure Outreach derived-activity utilities (Bite 3A).
//
// Contract source: docs/outreach-n8n-mapping.md. Snapshots are weekly
// cumulative LIFETIME counters per sequence, keyed by (export_date,
// sequence_id). Reporting basis is "Derived activity": period activity is
// end-of-period counter minus a real pre-period baseline. Thursday snapshots
// approximate calendar boundaries; a "month" is really last-snapshot-before
// to last-snapshot-within, not midnight-to-midnight.
//
// Hard rules implemented here:
//   - A sequence's first-ever snapshot is lifetime volume, never period
//     activity ("debut volume" is banned). A zero baseline is never invented.
//   - Negative differences are RESETS, surfaced explicitly, never clamped.
//   - Missing values stay missing; a measured zero stays zero.
//   - Duplicate natural keys are never summed: latest created_at wins when
//     recency is reliable, otherwise the key is an ambiguous duplicate.
//   - Only audited cumulative counters can be requested; nonmonotonic fields
//     (contacted_prospects, replied_prospects, prospects_added, total_tasks)
//     are excluded at the type level.
//   - Period boundaries come from export_date calendar math (Bite 1
//     reportingPeriods), never from the stored week_number.
//   - No clock reads; no React; no Supabase; not in compute.ts.

import type { ReportingPeriod, ComparisonMode } from '../types/reporting';
import {
  periodBounds,
  comparisonPeriod,
  isValidIsoDate,
} from './reportingPeriods';

// ---------------------------------------------------------------------------
// Input row and approved counters
// ---------------------------------------------------------------------------

// The approved derived-cumulative activity counters. Requesting any other
// field is a compile-time error.
export const CUMULATIVE_COUNTERS = [
  'total_sent',
  'delivered',
  'bounced',
  'failed',
  'opened',
  'clicked',
  'replied',
  'positive_replies',
  'neutral_replies',
  'negative_replies',
  'opted_out',
  'outbound_calls',
] as const;
export type CumulativeCounter = (typeof CUMULATIVE_COUNTERS)[number];

// Conditional counter: cumulative only while source coverage is continuous.
export const CONDITIONAL_COUNTERS = ['linkedin_tasks_completed'] as const;
export type ConditionalCounter = (typeof CONDITIONAL_COUNTERS)[number];

export type ActivityCounter = CumulativeCounter | ConditionalCounter;

// A reporting input row. Counters are number | null so a caller that knows a
// value was missing at the source (e.g. the linkedin_tasks coverage break, or
// pre-introduction calls_answered) can represent it as null instead of the
// ingest-coerced 0. created_at may be null when recency is unreliable.
export interface OutreachReportingRow {
  export_date: string; // YYYY-MM-DD
  sequence_id: number;
  sequence_name: string;
  created_at: string | null;
  counters: Partial<Record<ActivityCounter, number | null>>;
}

// ---------------------------------------------------------------------------
// Explicit typed states (no NaN, no negative sentinels, no magic strings)
// ---------------------------------------------------------------------------

// Per-sequence, per-metric period activity.
export type SequenceActivity =
  | { state: 'present'; value: number; baselineIncomplete: boolean }
  | { state: 'missing' } // no usable end snapshot / value in the period
  | { state: 'missing_baseline' } // sequence first appears; no prior snapshot at all and no in-period pair
  | { state: 'reset' } // counter decreased: reset/correction, not clamped
  | { state: 'ambiguous_duplicate' }; // duplicate natural key with unreliable recency

// Aggregated metric total across sequences.
export type MetricTotal =
  | {
      state: 'present';
      value: number;
      // True when any contributing sequence lacked a pre-period baseline (its
      // pre-tracking activity is unknown) or a metric had gaps.
      incomplete: boolean;
      issues: { resets: number; ambiguousDuplicates: number; missingBaselines: number };
    }
  | { state: 'missing' };

export type PeriodCompletenessState = 'missing' | 'partial' | 'complete';

// ---------------------------------------------------------------------------
// Dedup: duplicate (export_date, sequence_id) natural keys
// ---------------------------------------------------------------------------

type DedupResult =
  | { state: 'ok'; row: OutreachReportingRow }
  | { state: 'ambiguous_duplicate' };

// Never sum duplicates. With reliable created_at recency, the latest row wins;
// identical rows are trivially resolved; otherwise the key is ambiguous.
function dedupeKey(rows: OutreachReportingRow[]): DedupResult {
  if (rows.length === 1) return { state: 'ok', row: rows[0] };
  // Identical counter payloads collapse safely regardless of created_at.
  const payload = (r: OutreachReportingRow) => JSON.stringify(r.counters);
  const distinct = new Set(rows.map(payload));
  if (distinct.size === 1) return { state: 'ok', row: rows[0] };
  // Changed values: rely on created_at recency when every row has one and
  // they are distinct (a real ordering). Otherwise ambiguous.
  if (rows.every((r) => r.created_at !== null)) {
    const sorted = [...rows].sort((a, b) =>
      (a.created_at as string) < (b.created_at as string) ? -1 : 1,
    );
    const stamps = new Set(rows.map((r) => r.created_at));
    if (stamps.size === rows.length) {
      return { state: 'ok', row: sorted[sorted.length - 1] };
    }
  }
  return { state: 'ambiguous_duplicate' };
}

// Group rows into per-sequence chronological series with duplicates resolved.
// Returns the series plus the set of (date, sequence) keys that were ambiguous.
export interface DedupedSeries {
  // sequence_id -> rows sorted by export_date ascending (one per date)
  bySequence: Map<number, OutreachReportingRow[]>;
  ambiguousKeys: Array<{ export_date: string; sequence_id: number }>;
}

export function dedupeSnapshots(rows: readonly OutreachReportingRow[]): DedupedSeries {
  const byKey = new Map<string, OutreachReportingRow[]>();
  for (const r of rows) {
    if (!isValidIsoDate(r.export_date)) continue;
    const k = `${r.export_date}|${r.sequence_id}`;
    const arr = byKey.get(k) ?? [];
    arr.push(r);
    byKey.set(k, arr);
  }
  const bySequence = new Map<number, OutreachReportingRow[]>();
  const ambiguousKeys: Array<{ export_date: string; sequence_id: number }> = [];
  for (const [k, group] of byKey) {
    const [export_date, seqStr] = k.split('|');
    const sequence_id = Number(seqStr);
    const res = dedupeKey(group);
    if (res.state === 'ambiguous_duplicate') {
      ambiguousKeys.push({ export_date, sequence_id });
      continue; // ambiguous rows do not silently enter the series
    }
    const arr = bySequence.get(sequence_id) ?? [];
    arr.push(res.row);
    bySequence.set(sequence_id, arr);
  }
  for (const arr of bySequence.values()) {
    arr.sort((a, b) => (a.export_date < b.export_date ? -1 : 1));
  }
  return { bySequence, ambiguousKeys };
}

// ---------------------------------------------------------------------------
// Per-sequence period activity (baseline minus end)
// ---------------------------------------------------------------------------

function counterValue(row: OutreachReportingRow, metric: ActivityCounter): number | null {
  const v = row.counters[metric];
  return v === undefined ? null : v;
}

// Activity for one sequence and one metric within a period:
//   baseline = last snapshot BEFORE the period with a non-null value
//   end      = last snapshot INSIDE the period with a non-null value
//   activity = end - baseline
// A sequence first appearing inside the period has no true baseline: its first
// in-period snapshot is lifetime volume and is NOT counted; later in-period
// increases count from that first snapshot, flagged baselineIncomplete.
export function sequencePeriodActivity(
  series: readonly OutreachReportingRow[], // one sequence, sorted ascending
  metric: ActivityCounter,
  period: ReportingPeriod,
): SequenceActivity {
  const bounds = periodBounds(period);
  if (!bounds) return { state: 'missing' };

  let baseline: number | null = null; // last valid value before period
  let firstInPeriod: number | null = null; // first valid value inside period
  let lastInPeriod: number | null = null; // last valid value inside period
  let inPeriodValueCount = 0; // usable (non-null) in-period observations
  let sawInPeriodRow = false;

  for (const row of series) {
    const d = row.export_date;
    const v = counterValue(row, metric);
    if (d < bounds.start) {
      if (v !== null) baseline = v;
    } else if (d <= bounds.end) {
      sawInPeriodRow = true;
      if (v !== null) {
        if (firstInPeriod === null) firstInPeriod = v;
        lastInPeriod = v;
        inPeriodValueCount += 1;
      }
    } else {
      break;
    }
  }

  if (!sawInPeriodRow || lastInPeriod === null) {
    // No usable end value inside the period. Distinguish "the sequence exists
    // but this metric was missing" from "the sequence has no rows here": both
    // are missing for this metric/period.
    return { state: 'missing' };
  }

  if (baseline !== null) {
    const diff = lastInPeriod - baseline;
    if (diff < 0) return { state: 'reset' };
    return { state: 'present', value: diff, baselineIncomplete: false };
  }

  // No pre-period baseline: the sequence first appears (for this metric)
  // inside the period. Never invent zero; never count the first snapshot.
  if (firstInPeriod === null) return { state: 'missing' };
  if (inPeriodValueCount < 2) {
    // Only one usable in-period observation and nothing before it: earlier
    // activity is unknown and no in-period growth is measurable.
    return { state: 'missing_baseline' };
  }
  const withinDiff = lastInPeriod - firstInPeriod;
  if (withinDiff < 0) return { state: 'reset' };
  // Growth measured from the first in-period snapshot (which itself is NOT
  // counted). A measured zero growth across >=2 observations is a real zero,
  // still flagged baselineIncomplete because pre-debut activity is unknown.
  return { state: 'present', value: withinDiff, baselineIncomplete: true };
}

// ---------------------------------------------------------------------------
// Aggregation across sequences
// ---------------------------------------------------------------------------

// Sum a metric's period activity across all sequences. Resets and ambiguous
// duplicates make the total incomplete (counted in issues) but do not zero it;
// a metric with no present contributions at all is missing.
export function aggregateActivity(
  deduped: DedupedSeries,
  metric: ActivityCounter,
  period: ReportingPeriod,
): MetricTotal {
  let sum = 0;
  let present = 0;
  let resets = 0;
  let missingBaselines = 0;
  let anyBaselineIncomplete = false;
  for (const series of deduped.bySequence.values()) {
    const a = sequencePeriodActivity(series, metric, period);
    switch (a.state) {
      case 'present':
        sum += a.value;
        present += 1;
        if (a.baselineIncomplete) anyBaselineIncomplete = true;
        break;
      case 'reset':
        resets += 1;
        break;
      case 'missing_baseline':
        missingBaselines += 1;
        break;
      case 'missing':
        break;
      case 'ambiguous_duplicate':
        break; // not produced per-sequence; ambiguity tracked at dedupe level
    }
  }
  const ambiguousDuplicates = deduped.ambiguousKeys.length;
  if (present === 0) return { state: 'missing' };
  return {
    state: 'present',
    value: sum,
    incomplete:
      anyBaselineIncomplete || resets > 0 || missingBaselines > 0 || ambiguousDuplicates > 0,
    issues: { resets, ambiguousDuplicates, missingBaselines },
  };
}

// ---------------------------------------------------------------------------
// Rates (recomputed from aggregated counts; never averaged)
// ---------------------------------------------------------------------------

// numerator / denominator * 100. Missing inputs stay missing; a zero
// denominator makes the rate undefined (missing), never Infinity or 0.
export function rateFromTotals(
  numerator: MetricTotal,
  denominator: MetricTotal,
): { state: 'present'; percent: number; incomplete: boolean } | { state: 'missing' } {
  if (numerator.state !== 'present' || denominator.state !== 'present') {
    return { state: 'missing' };
  }
  if (denominator.value <= 0) return { state: 'missing' };
  return {
    state: 'present',
    percent: (numerator.value / denominator.value) * 100,
    incomplete: numerator.incomplete || denominator.incomplete,
  };
}

// ---------------------------------------------------------------------------
// Expected-Thursday completeness (America/Denver cadence intent)
// ---------------------------------------------------------------------------

// Day-of-week math on calendar strings (no Date, no clock, no timezone).
// 2023-01-05 is a Thursday.
function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}
const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function ymdToOrdinal(y: number, m: number, d: number): number {
  let days = 0;
  for (let yy = 1; yy < y; yy++) days += isLeap(yy) ? 366 : 365;
  days += CUM_DAYS[m - 1];
  if (m > 2 && isLeap(y)) days += 1;
  days += d;
  return days;
}
function ordinalToYmd(ordinal: number): string {
  let y = 1;
  let remaining = ordinal;
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
const REF_THURSDAY_ORDINAL = ymdToOrdinal(2023, 1, 5);

export function isThursday(date: string): boolean {
  if (!isValidIsoDate(date)) return false;
  const [y, m, d] = date.split('-').map((s) => parseInt(s, 10));
  return (((ymdToOrdinal(y, m, d) - REF_THURSDAY_ORDINAL) % 7) + 7) % 7 === 0;
}

// All expected Thursday run dates that fall inside the period AND inside the
// feed's observed lifetime [feedStart .. dataThrough]. Thursdays before the
// feed existed are not "missing runs".
export function expectedThursdays(
  period: ReportingPeriod,
  feedStart: string,
  dataThrough: string,
): string[] {
  const bounds = periodBounds(period);
  if (!bounds || !isValidIsoDate(feedStart) || !isValidIsoDate(dataThrough)) return [];
  const lo = bounds.start > feedStart ? bounds.start : feedStart;
  const hi = bounds.end < dataThrough ? bounds.end : dataThrough;
  if (lo > hi) return [];
  // First Thursday on/after lo.
  const [y, m, d] = lo.split('-').map((s) => parseInt(s, 10));
  const ord = ymdToOrdinal(y, m, d);
  const dow = (((ord - REF_THURSDAY_ORDINAL) % 7) + 7) % 7;
  let cur = dow === 0 ? ord : ord + (7 - dow);
  const out: string[] = [];
  for (;;) {
    const date = ordinalToYmd(cur);
    if (date > hi) break;
    out.push(date);
    cur += 7;
  }
  return out;
}

export interface OutreachCompleteness {
  completeness: PeriodCompletenessState;
  // Expected Thursdays in the period (bounded by feed lifetime) with no
  // snapshot on that exact date. A Wednesday/manual run does NOT substitute.
  missingThursdays: string[];
  // The final expected Thursday belonging to the period, when determinable.
  finalExpectedThursday: string | null;
  // Global latest export_date across the whole feed.
  dataThrough: string | null;
  suppressDelta: boolean;
}

// Completeness of the SELECTED period:
//   - no snapshots inside the period -> missing
//   - any expected Thursday without a snapshot, or data not yet reaching the
//     period's final expected Thursday -> partial
//   - otherwise -> complete
// Wednesday/extra snapshots never replace a missing Thursday, and (because
// activity is a two-endpoint diff, not a sum of rows) extra snapshots are
// structurally incapable of double-counting.
export function assessOutreachCompleteness(
  rows: readonly OutreachReportingRow[],
  period: ReportingPeriod,
): OutreachCompleteness {
  const bounds = periodBounds(period);
  const dates = [...new Set(rows.map((r) => r.export_date).filter(isValidIsoDate))].sort();
  const dataThrough = dates.length ? dates[dates.length - 1] : null;
  const feedStart = dates.length ? dates[0] : null;
  if (!bounds || dataThrough === null || feedStart === null) {
    return {
      completeness: 'missing',
      missingThursdays: [],
      finalExpectedThursday: null,
      dataThrough,
      suppressDelta: true,
    };
  }
  const inPeriod = dates.filter((d) => d >= bounds.start && d <= bounds.end);
  // Final expected Thursday of the period, bounded only by the period (not by
  // dataThrough): the last Thursday on/before the period end, if it is on/after
  // the feed start.
  const allThursdaysInPeriod = expectedThursdays(period, feedStart, bounds.end);
  const finalExpectedThursday = allThursdaysInPeriod.length
    ? allThursdaysInPeriod[allThursdaysInPeriod.length - 1]
    : null;
  if (inPeriod.length === 0) {
    return {
      completeness: 'missing',
      missingThursdays: [],
      finalExpectedThursday,
      dataThrough,
      suppressDelta: true,
    };
  }
  const dateSet = new Set(inPeriod);
  // Expected Thursdays we can already judge (up to dataThrough).
  const judgeable = expectedThursdays(period, feedStart, dataThrough);
  const missingThursdays = judgeable.filter((t) => !dateSet.has(t));
  const reachedFinal =
    finalExpectedThursday !== null && dataThrough >= finalExpectedThursday
      ? dateSet.has(finalExpectedThursday)
      : false; // data has not reached the final Thursday yet -> partial
  const complete = missingThursdays.length === 0 && reachedFinal;
  return {
    completeness: complete ? 'complete' : 'partial',
    missingThursdays,
    finalExpectedThursday,
    dataThrough,
    suppressDelta: !complete,
  };
}

// ---------------------------------------------------------------------------
// Comparisons (exact calendar periods; never skip a missing period)
// ---------------------------------------------------------------------------

export interface OutreachPeriodComparison {
  current: MetricTotal;
  // null when comparison mode is off or the comparison period is invalid.
  comparison: MetricTotal | null;
  comparisonPeriod: ReportingPeriod | null;
}

// Compare a metric between the selected period and its EXACT calendar
// comparison period (previous period or previous year). A missing comparison
// period yields comparison.state === 'missing'; it is never silently replaced
// with an older period that happens to have data.
export function compareOutreachActivity(
  deduped: DedupedSeries,
  metric: ActivityCounter,
  period: ReportingPeriod,
  mode: ComparisonMode,
): OutreachPeriodComparison {
  const current = aggregateActivity(deduped, metric, period);
  const cmpPeriod = comparisonPeriod(period, mode);
  const comparison = cmpPeriod ? aggregateActivity(deduped, metric, cmpPeriod) : null;
  return { current, comparison, comparisonPeriod: cmpPeriod };
}
