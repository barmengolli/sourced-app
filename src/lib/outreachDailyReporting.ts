// Pure reporting contract for the future daily Outreach feed.
//
// This intentionally lives beside, rather than inside, outreachReporting.ts.
// The existing module interprets the legacy Thursday lifetime snapshots. This
// module defines the replacement daily grain without changing the live report:
//
//   - v3 activity inputs are dated events and are summed directly;
//   - legacy v2 sequence counters remain cumulative and use period deltas;
//   - prospects_enrolled is a dated event count and is summed;
//   - prospects_active is a point-in-time value and uses the latest snapshot;
//   - a sequence created during the period has a legitimate zero baseline;
//   - a new or newly active sequence is never a data-quality problem;
//   - extraction failures, counter resets, missing measurements, and ambiguous
//     duplicate rows remain visible as data-quality issues.

import type { ReportingPeriod } from '../types/reporting';
import { isValidIsoDate, periodBounds } from './reportingPeriods';
import type { ActivityCounter } from './outreachReporting';

export interface OutreachDailySnapshot {
  snapshot_date: string; // America/Denver calendar date, YYYY-MM-DD
  collected_at: string | null; // ordering signal for same-day retries
  sequence_id: number;
  sequence_name: string;
  // Rows written before v3 have no value and are treated as legacy cumulative.
  activity_basis?: 'legacy_cumulative' | 'daily_event';
  // America/Denver calendar date derived from Outreach sequence.createdAt.
  // This is supporting evidence for a legitimate zero baseline, not part of
  // the business formula for established sequences.
  sequence_created_date: string | null;
  enabled: boolean;
  // Event flow: sequenceStates whose createdAt falls on snapshot_date.
  prospects_enrolled: number | null;
  // Point-in-time state at the end of snapshot_date.
  prospects_active: number | null;
  counters: Partial<Record<ActivityCounter, number | null>>;
}

export interface OutreachDailyRun {
  snapshot_date: string;
  status: 'complete' | 'failed';
  pagination_complete: boolean;
  expected_sequences: number;
  observed_sequences: number;
  activity_basis?: 'legacy_cumulative' | 'daily_event';
}

export type DailyMetricIssue =
  | 'ambiguous_duplicate'
  | 'missing_baseline'
  | 'missing_measurement'
  | 'counter_reset'
  | 'mixed_activity_basis';

export type DailyPeriodMetric =
  | {
      state: 'present';
      value: number;
      complete: boolean;
      issues: DailyMetricIssue[];
    }
  | {
      state: 'missing';
      issues: DailyMetricIssue[];
    };

export interface DailyDedupedSnapshots {
  bySequence: Map<number, OutreachDailySnapshot[]>;
  ambiguousKeys: Array<{ snapshot_date: string; sequence_id: number }>;
}

export interface DailyCoverageAssessment {
  state: 'complete' | 'partial' | 'missing';
  dataThrough: string | null;
  expectedDays: number;
  completeDays: number;
  issues: {
    missingRuns: number;
    failedRuns: number;
    incompletePagination: number;
    sequenceCountMismatches: number;
    duplicateRunDates: number;
    predatesFeed: boolean;
    periodStillOpen: boolean;
  };
}

function snapshotPayload(row: OutreachDailySnapshot): string {
  return JSON.stringify({
    activity_basis: row.activity_basis ?? 'legacy_cumulative',
    sequence_name: row.sequence_name,
    sequence_created_date: row.sequence_created_date,
    enabled: row.enabled,
    prospects_enrolled: row.prospects_enrolled,
    prospects_active: row.prospects_active,
    counters: row.counters,
  });
}

function activityBasis(
  row: OutreachDailySnapshot,
): 'legacy_cumulative' | 'daily_event' {
  return row.activity_basis ?? 'legacy_cumulative';
}

function resolveDailyDuplicate(
  rows: readonly OutreachDailySnapshot[],
): OutreachDailySnapshot | null {
  if (rows.length === 1) return rows[0];
  const payloads = new Set(rows.map(snapshotPayload));
  if (payloads.size === 1) return rows[0];

  if (rows.every((row) => row.collected_at !== null)) {
    const stamps = new Set(rows.map((row) => row.collected_at));
    if (stamps.size === rows.length) {
      return [...rows].sort((a, b) =>
        (a.collected_at as string).localeCompare(b.collected_at as string),
      )[rows.length - 1];
    }
  }
  return null;
}

export function dedupeDailySnapshots(
  rows: readonly OutreachDailySnapshot[],
): DailyDedupedSnapshots {
  const byKey = new Map<string, OutreachDailySnapshot[]>();
  for (const row of rows) {
    if (!isValidIsoDate(row.snapshot_date) || !Number.isInteger(row.sequence_id)) {
      continue;
    }
    const key = `${row.snapshot_date}|${row.sequence_id}`;
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }

  const bySequence = new Map<number, OutreachDailySnapshot[]>();
  const ambiguousKeys: DailyDedupedSnapshots['ambiguousKeys'] = [];
  for (const [key, group] of byKey) {
    const [snapshot_date, sequenceIdText] = key.split('|');
    const sequence_id = Number(sequenceIdText);
    const resolved = resolveDailyDuplicate(group);
    if (!resolved) {
      ambiguousKeys.push({ snapshot_date, sequence_id });
      continue;
    }
    bySequence.set(sequence_id, [...(bySequence.get(sequence_id) ?? []), resolved]);
  }

  for (const series of bySequence.values()) {
    series.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  }
  ambiguousKeys.sort((a, b) =>
    `${a.snapshot_date}|${a.sequence_id}`.localeCompare(
      `${b.snapshot_date}|${b.sequence_id}`,
    ),
  );
  return { bySequence, ambiguousKeys };
}

function periodWindow(period: ReportingPeriod): { start: string; end: string } | null {
  return periodBounds(period);
}

function hasRelevantAmbiguity(
  data: DailyDedupedSnapshots,
  sequenceId: number,
  start: string,
  end: string,
): boolean {
  return data.ambiguousKeys.some(
    (key) =>
      key.sequence_id === sequenceId &&
      key.snapshot_date >= start &&
      key.snapshot_date <= end,
  );
}

// Period activity for one sequence. v3 rows are dated event counts. Rows from
// the superseded v2 feed are cumulative counters and retain the delta contract
// so historical reports do not silently change.
export function sequenceDailyPeriodActivity(
  data: DailyDedupedSnapshots,
  sequenceId: number,
  metric: ActivityCounter,
  period: ReportingPeriod,
): DailyPeriodMetric {
  const bounds = periodWindow(period);
  if (!bounds) return { state: 'missing', issues: ['missing_measurement'] };

  const rows = data.bySequence.get(sequenceId) ?? [];
  const inPeriod = rows.filter(
    (row) => row.snapshot_date >= bounds.start && row.snapshot_date <= bounds.end,
  );
  if (inPeriod.length === 0) {
    return {
      state: 'missing',
      issues: hasRelevantAmbiguity(data, sequenceId, bounds.start, bounds.end)
        ? ['ambiguous_duplicate']
        : ['missing_measurement'],
    };
  }

  const issues: DailyMetricIssue[] = [];
  if (hasRelevantAmbiguity(data, sequenceId, bounds.start, bounds.end)) {
    issues.push('ambiguous_duplicate');
  }

  const dailyRows = inPeriod.filter((row) => activityBasis(row) === 'daily_event');
  const legacyRows = inPeriod.filter(
    (row) => activityBasis(row) === 'legacy_cumulative',
  );
  if (dailyRows.length > 0) {
    let value = 0;
    let measured = 0;
    for (const row of dailyRows) {
      const observation = row.counters[metric];
      if (observation === null || observation === undefined) {
        if (!issues.includes('missing_measurement')) issues.push('missing_measurement');
        continue;
      }
      if (!Number.isFinite(observation) || observation < 0) {
        return { state: 'missing', issues: [...issues, 'missing_measurement'] };
      }
      value += observation;
      measured += 1;
    }
    if (legacyRows.length > 0) issues.push('mixed_activity_basis');
    if (measured === 0) {
      return {
        state: 'missing',
        issues: [...new Set<DailyMetricIssue>([...issues, 'missing_measurement'])],
      };
    }
    return {
      state: 'present',
      value,
      complete: issues.length === 0,
      issues: [...new Set(issues)],
    };
  }

  const baseline = [...rows]
    .reverse()
    .find(
      (row) =>
        activityBasis(row) === 'legacy_cumulative' &&
        row.snapshot_date < bounds.start &&
        row.counters[metric] != null,
    );
  const createdInPeriod = inPeriod.some(
    (row) =>
      row.sequence_created_date !== null &&
      row.sequence_created_date >= bounds.start &&
      row.sequence_created_date <= bounds.end,
  );

  if (!baseline && !createdInPeriod) {
    return { state: 'missing', issues: [...issues, 'missing_baseline'] };
  }

  const observations: number[] = [];
  if (baseline) observations.push(baseline.counters[metric] as number);
  else observations.push(0);

  for (const row of inPeriod) {
    const value = row.counters[metric];
    if (value === null || value === undefined) {
      if (!issues.includes('missing_measurement')) issues.push('missing_measurement');
      continue;
    }
    observations.push(value);
  }

  if (observations.length === 1) {
    return { state: 'missing', issues: [...issues, 'missing_measurement'] };
  }
  if (observations.some((value) => !Number.isFinite(value) || value < 0)) {
    return { state: 'missing', issues: [...issues, 'missing_measurement'] };
  }
  for (let index = 1; index < observations.length; index += 1) {
    if (observations[index] < observations[index - 1]) {
      return { state: 'missing', issues: [...issues, 'counter_reset'] };
    }
  }

  return {
    state: 'present',
    value: observations[observations.length - 1] - observations[0],
    complete: issues.length === 0,
    issues,
  };
}

// New sequence-state rows are events. Ten enrollments today plus twenty
// tomorrow equal thirty for the reporting period, regardless of active state.
export function sequenceDailyPeriodEnrollments(
  data: DailyDedupedSnapshots,
  sequenceId: number,
  period: ReportingPeriod,
): DailyPeriodMetric {
  const bounds = periodWindow(period);
  if (!bounds) return { state: 'missing', issues: ['missing_measurement'] };
  const rows = (data.bySequence.get(sequenceId) ?? []).filter(
    (row) => row.snapshot_date >= bounds.start && row.snapshot_date <= bounds.end,
  );
  if (rows.length === 0) return { state: 'missing', issues: ['missing_measurement'] };

  const issues: DailyMetricIssue[] = [];
  if (hasRelevantAmbiguity(data, sequenceId, bounds.start, bounds.end)) {
    issues.push('ambiguous_duplicate');
  }
  let value = 0;
  for (const row of rows) {
    if (
      row.prospects_enrolled === null ||
      !Number.isFinite(row.prospects_enrolled) ||
      row.prospects_enrolled < 0
    ) {
      if (!issues.includes('missing_measurement')) issues.push('missing_measurement');
      continue;
    }
    value += row.prospects_enrolled;
  }
  return { state: 'present', value, complete: issues.length === 0, issues };
}

// Active prospects are a point-in-time measurement. Use the latest available
// in-period value and never sum daily snapshots.
export function sequenceDailyPeriodActiveProspects(
  data: DailyDedupedSnapshots,
  sequenceId: number,
  period: ReportingPeriod,
): DailyPeriodMetric {
  const bounds = periodWindow(period);
  if (!bounds) return { state: 'missing', issues: ['missing_measurement'] };
  const rows = (data.bySequence.get(sequenceId) ?? []).filter(
    (row) => row.snapshot_date >= bounds.start && row.snapshot_date <= bounds.end,
  );
  const latest = rows[rows.length - 1];
  if (
    !latest ||
    latest.prospects_active === null ||
    !Number.isFinite(latest.prospects_active) ||
    latest.prospects_active < 0
  ) {
    return { state: 'missing', issues: ['missing_measurement'] };
  }
  const issues: DailyMetricIssue[] = hasRelevantAmbiguity(
    data,
    sequenceId,
    bounds.start,
    bounds.end,
  )
    ? ['ambiguous_duplicate']
    : [];
  return {
    state: 'present',
    value: latest.prospects_active,
    complete: issues.length === 0,
    issues,
  };
}

export function aggregateDailyPeriodActivity(
  data: DailyDedupedSnapshots,
  metric: ActivityCounter,
  period: ReportingPeriod,
): DailyPeriodMetric {
  const bounds = periodWindow(period);
  if (!bounds) return { state: 'missing', issues: ['missing_measurement'] };
  const issues = new Set<DailyMetricIssue>();
  let value = 0;
  let hasPresent = false;
  for (const [sequenceId, rows] of data.bySequence) {
    // A sequence first seen after this period did not yet participate and must
    // not make the earlier report incomplete.
    if (!rows.some((row) => row.snapshot_date <= bounds.end)) continue;
    const result = sequenceDailyPeriodActivity(data, sequenceId, metric, period);
    result.issues.forEach((issue) => issues.add(issue));
    if (result.state === 'present') {
      value += result.value;
      hasPresent = true;
    }
  }
  if (!hasPresent) return { state: 'missing', issues: [...issues] };
  return {
    state: 'present',
    value,
    complete: issues.size === 0,
    issues: [...issues],
  };
}

export function aggregateDailyPeriodEnrollments(
  data: DailyDedupedSnapshots,
  period: ReportingPeriod,
): DailyPeriodMetric {
  const bounds = periodWindow(period);
  if (!bounds) return { state: 'missing', issues: ['missing_measurement'] };
  const issues = new Set<DailyMetricIssue>();
  let value = 0;
  let hasPresent = false;
  for (const [sequenceId, rows] of data.bySequence) {
    if (!rows.some((row) => row.snapshot_date <= bounds.end)) continue;
    const result = sequenceDailyPeriodEnrollments(data, sequenceId, period);
    result.issues.forEach((issue) => issues.add(issue));
    if (result.state === 'present') {
      value += result.value;
      hasPresent = true;
    }
  }
  if (!hasPresent) return { state: 'missing', issues: [...issues] };
  return {
    state: 'present',
    value,
    complete: issues.size === 0,
    issues: [...issues],
  };
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function monthLength(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function nextIsoDate(date: string): string {
  const [yearText, monthText, dayText] = date.split('-');
  let year = Number(yearText);
  let month = Number(monthText);
  let day = Number(dayText) + 1;
  if (day > monthLength(year, month)) {
    day = 1;
    month += 1;
  }
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let cursor = start; cursor <= end; cursor = nextIsoDate(cursor)) {
    dates.push(cursor);
  }
  return dates;
}

export function assessDailyOutreachCoverage(
  runs: readonly OutreachDailyRun[],
  period: ReportingPeriod,
  feedStart: string,
  dataThrough: string,
): DailyCoverageAssessment {
  const bounds = periodWindow(period);
  const empty: DailyCoverageAssessment = {
    state: 'missing',
    dataThrough: isValidIsoDate(dataThrough) ? dataThrough : null,
    expectedDays: 0,
    completeDays: 0,
    issues: {
      missingRuns: 0,
      failedRuns: 0,
      incompletePagination: 0,
      sequenceCountMismatches: 0,
      duplicateRunDates: 0,
      predatesFeed: false,
      periodStillOpen: false,
    },
  };
  if (
    !bounds ||
    !isValidIsoDate(feedStart) ||
    !isValidIsoDate(dataThrough) ||
    dataThrough < bounds.start
  ) {
    return empty;
  }

  const expectedStart = feedStart > bounds.start ? feedStart : bounds.start;
  const expectedEnd = dataThrough < bounds.end ? dataThrough : bounds.end;
  const expectedDates = enumerateDates(expectedStart, expectedEnd);
  const byDate = new Map<string, OutreachDailyRun[]>();
  for (const run of runs) {
    if (!isValidIsoDate(run.snapshot_date)) continue;
    byDate.set(run.snapshot_date, [...(byDate.get(run.snapshot_date) ?? []), run]);
  }

  const issues = {
    missingRuns: 0,
    failedRuns: 0,
    incompletePagination: 0,
    sequenceCountMismatches: 0,
    duplicateRunDates: 0,
    predatesFeed: feedStart > bounds.start,
    periodStillOpen: dataThrough < bounds.end,
  };
  let completeDays = 0;
  for (const date of expectedDates) {
    const sameDay = byDate.get(date) ?? [];
    if (sameDay.length === 0) {
      issues.missingRuns += 1;
      continue;
    }
    if (sameDay.length > 1) issues.duplicateRunDates += 1;
    const run = sameDay[sameDay.length - 1];
    if (run.status !== 'complete') issues.failedRuns += 1;
    if (!run.pagination_complete) issues.incompletePagination += 1;
    if (run.expected_sequences !== run.observed_sequences) {
      issues.sequenceCountMismatches += 1;
    }
    if (
      sameDay.length === 1 &&
      run.status === 'complete' &&
      run.pagination_complete &&
      run.expected_sequences === run.observed_sequences
    ) {
      completeDays += 1;
    }
  }

  const partial =
    issues.missingRuns > 0 ||
    issues.failedRuns > 0 ||
    issues.incompletePagination > 0 ||
    issues.sequenceCountMismatches > 0 ||
    issues.duplicateRunDates > 0 ||
    issues.predatesFeed ||
    issues.periodStillOpen;
  return {
    state: partial ? 'partial' : 'complete',
    dataThrough,
    expectedDays: expectedDates.length,
    completeDays,
    issues,
  };
}
