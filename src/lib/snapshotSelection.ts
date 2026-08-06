// snapshotSelection.ts
//
// Point-in-time snapshot selection for the reporting standard (CLAUDE.md
// section 4): "use the latest eligible snapshot at or before period end; never
// sum snapshots".
//
// 6sense stores one monthly point-in-time summary per segment. Two rules drive
// everything here:
//
//   1. Never borrow a FUTURE snapshot. Asking for June and being shown July's
//      numbers would report a state that did not exist at the end of June, and
//      the reader has no way to tell.
//   2. Never sum snapshots. A quarter is not the sum of its three monthly
//      snapshots; the account base would be triple-counted. A quarter is the
//      state as of its last day, which is the latest snapshot at or before it.
//
// Selection is PER SEGMENT, because segments have different import coverage. A
// single page-level "latest date" would show one segment its current month and
// another a stale one with no indication which.
//
// This module never reads the clock: eligibility is judged against the selected
// period's bounds only.

import { periodBounds } from './reportingPeriods';
import type { ReportingPeriod } from '../types/reporting';

// A snapshot needs only a date to be selected; callers keep their own richer row.
export interface DatedSnapshot {
  snapshot_date: string;
}

export type SnapshotSelection<T extends DatedSnapshot> =
  // The latest snapshot at or before period end.
  | { state: 'present'; snapshot: T; snapshotDate: string; withinPeriod: boolean }
  // No snapshot exists at or before period end. This is MISSING, never zero:
  // "we have no reading for this segment yet" is not "the segment reached
  // nobody".
  | { state: 'missing' };

// Select the latest snapshot at or before the selected period's end.
//
// `withinPeriod` distinguishes a reading taken INSIDE the period from an older
// one carried forward. Both are legitimate for a point-in-time source, but a
// carried-forward reading is stale and the UI must be able to say so.
export function selectSnapshotForPeriod<T extends DatedSnapshot>(
  snapshots: readonly T[],
  period: ReportingPeriod,
): SnapshotSelection<T> {
  const bounds = periodBounds(period);
  if (!bounds) return { state: 'missing' };

  let best: T | null = null;
  for (const s of snapshots) {
    const d = s.snapshot_date;
    if (typeof d !== 'string' || d === '') continue;
    // Strictly at or before the period END. A snapshot dated after the period
    // is a future reading and is never borrowed.
    if (d > bounds.end) continue;
    if (best === null || d > best.snapshot_date) best = s;
  }

  if (best === null) return { state: 'missing' };
  return {
    state: 'present',
    snapshot: best,
    snapshotDate: best.snapshot_date,
    withinPeriod: best.snapshot_date >= bounds.start,
  };
}

// Select the current and comparison snapshots together.
//
// A comparison is offered ONLY when both periods have a real eligible snapshot
// AND they are not the same row. Comparing a period against itself would render
// a guaranteed zero delta that looks like "no change" when it actually means
// "no distinct earlier reading", which is the missing-versus-zero confusion the
// standard forbids.
export function selectSnapshotComparison<T extends DatedSnapshot>(
  snapshots: readonly T[],
  current: ReportingPeriod,
  comparison: ReportingPeriod | null,
): {
  current: SnapshotSelection<T>;
  comparison: SnapshotSelection<T>;
  comparable: boolean;
} {
  const cur = selectSnapshotForPeriod(snapshots, current);
  const cmp = comparison
    ? selectSnapshotForPeriod(snapshots, comparison)
    : ({ state: 'missing' } as SnapshotSelection<T>);

  const comparable =
    cur.state === 'present'
    && cmp.state === 'present'
    && cur.snapshotDate !== cmp.snapshotDate;

  return { current: cur, comparison: cmp, comparable };
}
