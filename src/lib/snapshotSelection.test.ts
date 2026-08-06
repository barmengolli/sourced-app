// snapshotSelection.test.ts
//
// Point-in-time snapshot selection. The two rules being pinned are the ones a
// migration to Month/Quarter/Year would otherwise break:
//
//   never borrow a FUTURE snapshot, and never sum snapshots across time.

import { describe, it, expect } from 'vitest';
import {
  selectSnapshotForPeriod,
  selectSnapshotComparison,
} from './snapshotSelection';
import type { ReportingPeriod } from '../types/reporting';

const snap = (snapshot_date: string, tag = '') => ({ snapshot_date, tag });

const MAY = { grain: 'month', year: 2026, month: 5 } as const satisfies ReportingPeriod;
const JUN = { grain: 'month', year: 2026, month: 6 } as const satisfies ReportingPeriod;
const JUL = { grain: 'month', year: 2026, month: 7 } as const satisfies ReportingPeriod;
const Q2 = { grain: 'quarter', year: 2026, quarter: 2 } as const satisfies ReportingPeriod;
const Y2026 = { grain: 'year', year: 2026 } as const satisfies ReportingPeriod;

describe('selectSnapshotForPeriod', () => {
  it('takes the latest snapshot at or before period end', () => {
    const rows = [snap('2026-05-31'), snap('2026-06-30'), snap('2026-07-31')];
    const r = selectSnapshotForPeriod(rows, JUN);
    expect(r.state).toBe('present');
    if (r.state !== 'present') return;
    expect(r.snapshotDate).toBe('2026-06-30');
    expect(r.withinPeriod).toBe(true);
  });

  it('never borrows a future snapshot', () => {
    // THE CORE REFUSAL. Asking for June must not surface July's numbers: that
    // reports a state that did not exist at the end of June.
    const rows = [snap('2026-07-31'), snap('2026-08-31')];
    expect(selectSnapshotForPeriod(rows, JUN).state).toBe('missing');
    expect(selectSnapshotForPeriod(rows, MAY).state).toBe('missing');
  });

  it('carries an older snapshot forward and flags it as outside the period', () => {
    // Legitimate for a point-in-time source, but stale, so the UI can say so.
    const rows = [snap('2026-04-30')];
    const r = selectSnapshotForPeriod(rows, JUN);
    expect(r.state).toBe('present');
    if (r.state !== 'present') return;
    expect(r.snapshotDate).toBe('2026-04-30');
    expect(r.withinPeriod).toBe(false);
  });

  it('reports missing rather than zero when nothing is eligible', () => {
    expect(selectSnapshotForPeriod([], JUN).state).toBe('missing');
  });

  it('uses the last day of a quarter, never a sum of its months', () => {
    // Q2 must be the state as of June 30. Summing April, May, and June would
    // triple-count the account base and report a reach that never existed.
    const rows = [snap('2026-04-30'), snap('2026-05-31'), snap('2026-06-30')];
    const r = selectSnapshotForPeriod(rows, Q2);
    expect(r.state).toBe('present');
    if (r.state !== 'present') return;
    expect(r.snapshotDate).toBe('2026-06-30');
  });

  it('uses the last day of a year for the year grain', () => {
    const rows = [snap('2026-06-30'), snap('2026-12-31'), snap('2027-01-31')];
    const r = selectSnapshotForPeriod(rows, Y2026);
    expect(r.state).toBe('present');
    if (r.state !== 'present') return;
    // 2027 is after the period end and is not borrowed.
    expect(r.snapshotDate).toBe('2026-12-31');
  });

  it('handles a snapshot dated exactly on the period boundary', () => {
    const first = selectSnapshotForPeriod([snap('2026-06-01')], JUN);
    expect(first.state).toBe('present');
    const last = selectSnapshotForPeriod([snap('2026-06-30')], JUN);
    expect(last.state).toBe('present');
    // One day after the period end is out.
    expect(selectSnapshotForPeriod([snap('2026-07-01')], JUN).state).toBe('missing');
  });

  it('ignores malformed dates rather than ranking them', () => {
    const rows = [snap(''), snap('2026-06-30')];
    const r = selectSnapshotForPeriod(rows, JUN);
    expect(r.state).toBe('present');
    if (r.state !== 'present') return;
    expect(r.snapshotDate).toBe('2026-06-30');
  });

  it('selects independently per segment coverage', () => {
    // Segments import on different cadences. Segment A has June, segment B
    // stopped in April. A single page-level "latest date" would show one of
    // them a period it has no reading for.
    const a = [snap('2026-05-31'), snap('2026-06-30')];
    const b = [snap('2026-04-30')];
    const ra = selectSnapshotForPeriod(a, JUN);
    const rb = selectSnapshotForPeriod(b, JUN);
    expect(ra.state === 'present' && ra.withinPeriod).toBe(true);
    expect(rb.state === 'present' && rb.withinPeriod).toBe(false);
  });
});

describe('selectSnapshotComparison', () => {
  const rows = [snap('2026-05-31'), snap('2026-06-30'), snap('2026-07-31')];

  it('compares when both periods have a distinct eligible snapshot', () => {
    const r = selectSnapshotComparison(rows, JUL, JUN);
    expect(r.comparable).toBe(true);
    expect(r.current.state === 'present' && r.current.snapshotDate).toBe('2026-07-31');
    expect(r.comparison.state === 'present' && r.comparison.snapshotDate).toBe('2026-06-30');
  });

  it('refuses to compare when the comparison period has no snapshot', () => {
    const r = selectSnapshotComparison([snap('2026-07-31')], JUL, JUN);
    expect(r.comparable).toBe(false);
    expect(r.comparison.state).toBe('missing');
  });

  it('refuses to compare when both periods resolve to the SAME snapshot', () => {
    // A carried-forward reading would otherwise be compared against itself,
    // rendering a guaranteed zero delta that reads as "no change" when it
    // really means "no distinct earlier reading".
    const stale = [snap('2026-04-30')];
    const r = selectSnapshotComparison(stale, JUL, JUN);
    expect(r.current.state).toBe('present');
    expect(r.comparison.state).toBe('present');
    expect(r.comparable).toBe(false);
  });

  it('refuses to compare when comparison is off', () => {
    const r = selectSnapshotComparison(rows, JUL, null);
    expect(r.comparable).toBe(false);
    expect(r.comparison.state).toBe('missing');
  });

  it('refuses to compare when the current period has no snapshot', () => {
    const r = selectSnapshotComparison([snap('2026-01-31')], MAY, JUL);
    // The comparison would borrow a future snapshot; neither side is valid.
    expect(r.comparable).toBe(false);
  });
});
