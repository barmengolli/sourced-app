// Deterministic tests for the Outreach derived-activity utilities (Bite 3A).
// Synthetic fixtures only: generic sequence ids/names, no real records, no
// network, no clock. Fixed dates throughout.

import { describe, it, expect } from 'vitest';
import type { MonthIndex, ReportingPeriod } from '../types/reporting';
import type { PeriodIndex } from '../types/db';
import {
  dedupeSnapshots,
  sequencePeriodActivity,
  aggregateActivity,
  rateFromTotals,
  isThursday,
  expectedThursdays,
  assessOutreachCompleteness,
  compareOutreachActivity,
  CUMULATIVE_COUNTERS,
  type OutreachReportingRow,
  type ActivityCounter,
} from './outreachReporting';

// Synthetic row factory. All Thursdays in the default series.
function row(
  export_date: string,
  sequence_id: number,
  counters: Partial<Record<ActivityCounter, number | null>>,
  over: Partial<OutreachReportingRow> = {},
): OutreachReportingRow {
  return {
    export_date,
    sequence_id,
    sequence_name: `Seq ${sequence_id}`,
    created_at: `${export_date}T08:00:00Z`,
    counters,
    ...over,
  };
}

const month = (year: number, m: number): ReportingPeriod => ({ grain: 'month', year, month: m as MonthIndex });
const quarter = (year: number, q: number): ReportingPeriod => ({ grain: 'quarter', year, quarter: q as PeriodIndex });
const year = (y: number): ReportingPeriod => ({ grain: 'year', year: y });

// A sequence with a clean weekly Thursday series across March..April 2026.
// Thursdays: Mar 5, 12, 19, 26; Apr 2, 9, ...
function cleanSeries(seq = 1): OutreachReportingRow[] {
  return [
    row('2026-03-05', seq, { total_sent: 100 }),
    row('2026-03-12', seq, { total_sent: 150 }),
    row('2026-03-19', seq, { total_sent: 210 }),
    row('2026-03-26', seq, { total_sent: 300 }),
    row('2026-04-02', seq, { total_sent: 340 }),
    row('2026-04-09', seq, { total_sent: 420 }),
  ];
}

describe('sequencePeriodActivity — baselines', () => {
  it('computes end minus pre-period baseline for a normal series', () => {
    // April activity for seq 1: last-before-April = 300 (Mar 26); last-in-April = 420.
    const d = dedupeSnapshots(cleanSeries());
    const a = sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', month(2026, 4));
    expect(a).toEqual({ state: 'present', value: 120, baselineIncomplete: false, missingMeasurements: false });
  });

  it('never counts the first-ever nonzero snapshot as activity', () => {
    // Seq debuts Mar 5 at lifetime 100. March activity must NOT include the 100.
    const d = dedupeSnapshots(cleanSeries());
    const a = sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', month(2026, 3));
    // Growth measured from the first in-period snapshot: 300 - 100 = 200,
    // flagged incomplete because pre-debut activity is unknown.
    expect(a).toEqual({ state: 'present', value: 200, baselineIncomplete: true, missingMeasurements: false });
  });

  it('a single debut snapshot yields missing_baseline (no measurable growth, no invented zero)', () => {
    const d = dedupeSnapshots([row('2026-03-19', 7, { total_sent: 999 })]);
    const a = sequencePeriodActivity(d.bySequence.get(7)!, 'total_sent', month(2026, 3));
    expect(a).toEqual({ state: 'missing_baseline' });
  });

  it('a new sequence starting at zero can accumulate later activity but stays baseline-incomplete', () => {
    const d = dedupeSnapshots([
      row('2026-03-12', 8, { total_sent: 0 }),
      row('2026-03-19', 8, { total_sent: 40 }),
    ]);
    const a = sequencePeriodActivity(d.bySequence.get(8)!, 'total_sent', month(2026, 3));
    expect(a).toEqual({ state: 'present', value: 40, baselineIncomplete: true, missingMeasurements: false });
  });

  it('negative counter difference returns reset, never clamped to zero', () => {
    const d = dedupeSnapshots([
      row('2026-03-26', 9, { total_sent: 500 }),
      row('2026-04-02', 9, { total_sent: 450 }), // decreased
    ]);
    const a = sequencePeriodActivity(d.bySequence.get(9)!, 'total_sent', month(2026, 4));
    expect(a).toEqual({ state: 'reset' });
  });

  it('missing values remain missing; measured zero remains zero', () => {
    const d = dedupeSnapshots([
      row('2026-03-26', 10, { total_sent: 100, linkedin_tasks_completed: null }), // missing
      row('2026-04-02', 10, { total_sent: 100, linkedin_tasks_completed: null }),
    ]);
    // linkedin metric missing entirely -> missing (not zero)
    expect(
      sequencePeriodActivity(d.bySequence.get(10)!, 'linkedin_tasks_completed', month(2026, 4)),
    ).toEqual({ state: 'missing' });
    // total_sent measured, unchanged -> a real zero with a real baseline
    expect(
      sequencePeriodActivity(d.bySequence.get(10)!, 'total_sent', month(2026, 4)),
    ).toEqual({ state: 'present', value: 0, baselineIncomplete: false, missingMeasurements: false });
  });

  it('empty selected period returns missing', () => {
    const d = dedupeSnapshots(cleanSeries());
    expect(
      sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', month(2026, 9)),
    ).toEqual({ state: 'missing' });
  });
});

describe('period boundaries — Month, Quarter, Year, and rollovers', () => {
  // Series spanning Dec 2026 -> Jan 2027. Thursdays: Dec 24, Dec 31, Jan 7.
  const spanRows = [
    row('2026-12-24', 2, { opened: 10 }),
    row('2026-12-31', 2, { opened: 25 }),
    row('2027-01-07', 2, { opened: 40 }),
  ];
  it('January activity uses the December baseline (Dec -> Jan rollover)', () => {
    const d = dedupeSnapshots(spanRows);
    const a = sequencePeriodActivity(d.bySequence.get(2)!, 'opened', month(2027, 1));
    expect(a).toEqual({ state: 'present', value: 15, baselineIncomplete: false, missingMeasurements: false }); // 40 - 25
  });
  it('Q1 activity uses the prior-year Q4 baseline (Q1 rollover)', () => {
    const d = dedupeSnapshots(spanRows);
    const a = sequencePeriodActivity(d.bySequence.get(2)!, 'opened', quarter(2027, 1));
    expect(a).toEqual({ state: 'present', value: 15, baselineIncomplete: false, missingMeasurements: false });
  });
  it('year activity uses the prior-year baseline', () => {
    const d = dedupeSnapshots(spanRows);
    const a = sequencePeriodActivity(d.bySequence.get(2)!, 'opened', year(2027));
    expect(a).toEqual({ state: 'present', value: 15, baselineIncomplete: false, missingMeasurements: false });
  });
  it('quarter and year use export_date calendar boundaries (not week_number)', () => {
    const d = dedupeSnapshots(cleanSeries());
    // Q1 2026 = Jan-Mar: growth from first in-period snapshot (100) to Mar 26 (300).
    const q1 = sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', quarter(2026, 1));
    expect(q1).toEqual({ state: 'present', value: 200, baselineIncomplete: true, missingMeasurements: false });
    // Q2 has a real Q1 baseline: 420 - 300 = 120.
    const q2 = sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', quarter(2026, 2));
    expect(q2).toEqual({ state: 'present', value: 120, baselineIncomplete: false, missingMeasurements: false });
  });
});

describe('duplicates and identity', () => {
  it('duplicate natural keys are never summed; identical duplicates collapse', () => {
    const d = dedupeSnapshots([
      row('2026-03-19', 3, { clicked: 50 }),
      row('2026-03-19', 3, { clicked: 50 }), // identical duplicate
      row('2026-03-26', 3, { clicked: 60 }),
    ]);
    expect(d.ambiguousKeys).toHaveLength(0);
    const a = sequencePeriodActivity(d.bySequence.get(3)!, 'clicked', month(2026, 3));
    // 60 - 50 = 10 from the first snapshot; NOT 50+50 summed.
    expect(a).toEqual({ state: 'present', value: 10, baselineIncomplete: true, missingMeasurements: false });
  });

  it('changed duplicates resolve to the latest created_at when recency is reliable', () => {
    const d = dedupeSnapshots([
      row('2026-03-19', 4, { replied: 5 }, { created_at: '2026-03-19T08:00:00Z' }),
      row('2026-03-19', 4, { replied: 9 }, { created_at: '2026-03-19T12:00:00Z' }), // rerun later
      row('2026-03-26', 4, { replied: 12 }),
    ]);
    expect(d.ambiguousKeys).toHaveLength(0);
    const a = sequencePeriodActivity(d.bySequence.get(4)!, 'replied', month(2026, 3));
    // latest rerun (9) wins as the Mar 19 value -> 12 - 9 = 3.
    expect(a).toEqual({ state: 'present', value: 3, baselineIncomplete: true, missingMeasurements: false });
  });

  it('changed duplicates without reliable recency are an ambiguous-duplicate quality issue', () => {
    const d = dedupeSnapshots([
      row('2026-03-19', 5, { replied: 5 }, { created_at: null }),
      row('2026-03-19', 5, { replied: 9 }, { created_at: null }),
    ]);
    expect(d.ambiguousKeys).toEqual([{ export_date: '2026-03-19', sequence_id: 5 }]);
  });

  it('a sequence rename retains identity through sequence_id', () => {
    const d = dedupeSnapshots([
      row('2026-03-19', 6, { total_sent: 100 }, { sequence_name: 'Old name [2026]' }),
      row('2026-03-26', 6, { total_sent: 130 }, { sequence_name: 'New name [2026]' }),
    ]);
    expect(d.bySequence.get(6)).toHaveLength(2); // one series, not two
    const a = sequencePeriodActivity(d.bySequence.get(6)!, 'total_sent', month(2026, 3));
    expect(a).toEqual({ state: 'present', value: 30, baselineIncomplete: true, missingMeasurements: false });
  });
});

describe('aggregation and rates', () => {
  it('aggregates across sequences and reports issues without zeroing the total', () => {
    const d = dedupeSnapshots([
      ...cleanSeries(1), // April: +120 with real baseline
      row('2026-03-26', 2, { total_sent: 200 }),
      row('2026-04-02', 2, { total_sent: 150 }), // reset in April
    ]);
    const t = aggregateActivity(d, 'total_sent', month(2026, 4));
    expect(t.state).toBe('present');
    if (t.state === 'present') {
      expect(t.value).toBe(120); // seq 1 only; the reset sequence contributes issues, not 0
      expect(t.incomplete).toBe(true);
      expect(t.issues.resets).toBe(1);
    }
  });

  it('a metric with no present contributions is missing (not zero)', () => {
    const d = dedupeSnapshots(cleanSeries());
    expect(aggregateActivity(d, 'opened', month(2026, 4))).toEqual({ state: 'missing' });
  });

  it('missing LinkedIn-task coverage suppresses that metric while others report', () => {
    const d = dedupeSnapshots([
      row('2026-06-25', 1, { total_sent: 300, linkedin_tasks_completed: 50 }),
      row('2026-07-02', 1, { total_sent: 340, linkedin_tasks_completed: 60 }),
      row('2026-07-09', 1, { total_sent: 380, linkedin_tasks_completed: 70 }),
      row('2026-07-16', 1, { total_sent: 420, linkedin_tasks_completed: null }), // coverage break
      row('2026-07-23', 1, { total_sent: 460, linkedin_tasks_completed: null }),
    ]);
    // total_sent July: fully measured on every row -> complete: 460 - 300 = 160.
    const sent = aggregateActivity(d, 'total_sent', month(2026, 7));
    expect(sent).toMatchObject({ state: 'present', value: 160, incomplete: false });

    // linkedin: the per-sequence result retains the known +20 (baseline 50,
    // last valid Jul 9 = 70) but carries an explicit missing-measurement state:
    const seq = sequencePeriodActivity(d.bySequence.get(1)!, 'linkedin_tasks_completed', month(2026, 7));
    expect(seq).toEqual({ state: 'present', value: 20, baselineIncomplete: false, missingMeasurements: true });

    // ...and the aggregate is explicitly INCOMPLETE with the gap counted:
    const li = aggregateActivity(d, 'linkedin_tasks_completed', month(2026, 7));
    expect(li).toMatchObject({
      state: 'present',
      value: 20,
      incomplete: true,
      issues: { missingMeasurements: 1 },
    });
  });

  it('incomplete metric coverage suppresses comparison deltas via the shared flag', () => {
    const d = dedupeSnapshots([
      row('2026-06-25', 1, { linkedin_tasks_completed: 50 }),
      row('2026-07-02', 1, { linkedin_tasks_completed: 60 }),
      row('2026-07-09', 1, { linkedin_tasks_completed: 70 }),
      row('2026-07-16', 1, { linkedin_tasks_completed: null }), // break in July
      row('2026-07-23', 1, { linkedin_tasks_completed: null }),
    ]);
    const c = compareOutreachActivity(d, 'linkedin_tasks_completed', month(2026, 7), 'previous_period');
    // The shared helper is authoritative: current July is present-but-incomplete
    // (missing measurements), so the delta is suppressed by the returned flag —
    // no caller-side derivation.
    expect(c.suppressDelta).toBe(true);
  });

  it('suppressDelta is true when comparison mode is off, even with clean data', () => {
    const d = dedupeSnapshots([
      row('2026-06-25', 1, { total_sent: 100 }),
      row('2026-07-02', 1, { total_sent: 120 }),
      row('2026-07-30', 1, { total_sent: 150 }),
    ]);
    const c = compareOutreachActivity(d, 'total_sent', month(2026, 7), 'off');
    expect(c.suppressDelta).toBe(true);
  });

  it('a mid-period null between valid measurements marks the metric incomplete', () => {
    // Interior gap: values exist before and after the null, but the gap hides
    // potential resets. Do not rely on global row-date completeness.
    const d = dedupeSnapshots([
      row('2026-03-26', 1, { opened: 100 }),
      row('2026-04-02', 1, { opened: 110 }),
      row('2026-04-09', 1, { opened: null }), // row exists; this metric missing
      row('2026-04-16', 1, { opened: 130 }),
    ]);
    const a = sequencePeriodActivity(d.bySequence.get(1)!, 'opened', month(2026, 4));
    expect(a).toEqual({ state: 'present', value: 30, baselineIncomplete: false, missingMeasurements: true });
    const t = aggregateActivity(d, 'opened', month(2026, 4));
    expect(t).toMatchObject({ state: 'present', incomplete: true, issues: { missingMeasurements: 1 } });
  });

  it('rates recompute from aggregated totals and never average percentages', () => {
    const opened = { state: 'present', value: 50, incomplete: false, issues: { resets: 0, ambiguousDuplicates: 0, missingBaselines: 0, missingMeasurements: 0 } } as const;
    const delivered = { state: 'present', value: 1000, incomplete: false, issues: { resets: 0, ambiguousDuplicates: 0, missingBaselines: 0, missingMeasurements: 0 } } as const;
    const r = rateFromTotals(opened, delivered);
    expect(r).toMatchObject({ state: 'present', percent: 5 });
  });

  it('division by zero yields missing, never Infinity or 0', () => {
    const num = { state: 'present', value: 5, incomplete: false, issues: { resets: 0, ambiguousDuplicates: 0, missingBaselines: 0, missingMeasurements: 0 } } as const;
    const zeroDen = { state: 'present', value: 0, incomplete: false, issues: { resets: 0, ambiguousDuplicates: 0, missingBaselines: 0, missingMeasurements: 0 } } as const;
    expect(rateFromTotals(num, zeroDen)).toEqual({ state: 'missing' });
    expect(rateFromTotals({ state: 'missing' }, zeroDen)).toEqual({ state: 'missing' });
  });

  it('nonmonotonic fields are not requestable as cumulative counters (type-level)', () => {
    // Compile-time contract: 'prospects_added' is not an ActivityCounter.
    // @ts-expect-error prospects_added is not an approved activity counter
    const bad: ActivityCounter = 'prospects_added';
    expect(bad).toBe('prospects_added'); // runtime passthrough; the assertion is the ts-expect-error
    expect((CUMULATIVE_COUNTERS as readonly string[]).includes('total_tasks')).toBe(false);
    expect((CUMULATIVE_COUNTERS as readonly string[]).includes('contacted_prospects')).toBe(false);
  });
});

describe('Thursday cadence and completeness', () => {
  it('recognizes Thursdays', () => {
    expect(isThursday('2026-03-19')).toBe(true);
    expect(isThursday('2026-03-18')).toBe(false); // Wednesday
    expect(isThursday('2026-07-23')).toBe(true);
  });

  it('enumerates expected Thursdays bounded by feed lifetime', () => {
    expect(expectedThursdays(month(2026, 3), '2026-03-19', '2026-07-23')).toEqual([
      '2026-03-19', '2026-03-26',
    ]);
    // Feed did not exist before Mar 19: earlier March Thursdays are not expected.
    expect(expectedThursdays(month(2026, 3), '2026-03-19', '2026-07-23')).not.toContain('2026-03-05');
  });

  it('a missing scheduled Thursday marks the period partial', () => {
    const rows = [
      row('2026-04-02', 1, { total_sent: 1 }),
      row('2026-04-09', 1, { total_sent: 2 }),
      // 2026-04-16 Thursday MISSING
      row('2026-04-23', 1, { total_sent: 3 }),
      row('2026-04-30', 1, { total_sent: 4 }),
      row('2026-05-07', 1, { total_sent: 5 }),
    ];
    const c = assessOutreachCompleteness(rows, month(2026, 4));
    expect(c.completeness).toBe('partial');
    expect(c.missingThursdays).toEqual(['2026-04-16']);
    expect(c.suppressDelta).toBe(true);
  });

  it('an extra Wednesday snapshot does not replace a missing Thursday', () => {
    const rows = [
      row('2026-04-02', 1, { total_sent: 1 }),
      row('2026-04-09', 1, { total_sent: 2 }),
      row('2026-04-15', 1, { total_sent: 2 }), // Wednesday extra
      // Thursday 2026-04-16 still missing
      row('2026-04-23', 1, { total_sent: 3 }),
      row('2026-04-30', 1, { total_sent: 4 }),
      row('2026-05-07', 1, { total_sent: 5 }),
    ];
    const c = assessOutreachCompleteness(rows, month(2026, 4));
    expect(c.completeness).toBe('partial');
    expect(c.missingThursdays).toEqual(['2026-04-16']);
  });

  it('extra snapshots cannot double-count activity (two-endpoint diff)', () => {
    const d = dedupeSnapshots([
      row('2026-03-26', 1, { total_sent: 100 }),
      row('2026-04-02', 1, { total_sent: 120 }),
      row('2026-04-08', 1, { total_sent: 130 }), // extra Wednesday
      row('2026-04-09', 1, { total_sent: 140 }),
    ]);
    const a = sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', month(2026, 4));
    expect(a).toEqual({ state: 'present', value: 40, baselineIncomplete: false, missingMeasurements: false }); // 140-100, not inflated
  });

  it('a complete period has every expected Thursday including the final one', () => {
    const rows = [
      row('2026-03-26', 1, { total_sent: 1 }),
      row('2026-04-02', 1, { total_sent: 2 }),
      row('2026-04-09', 1, { total_sent: 3 }),
      row('2026-04-16', 1, { total_sent: 4 }),
      row('2026-04-23', 1, { total_sent: 5 }),
      row('2026-04-30', 1, { total_sent: 6 }), // final April Thursday
      row('2026-05-07', 1, { total_sent: 7 }),
    ];
    const c = assessOutreachCompleteness(rows, month(2026, 4));
    expect(c.completeness).toBe('complete');
    expect(c.suppressDelta).toBe(false);
    expect(c.finalExpectedThursday).toBe('2026-04-30');
    expect(c.dataThrough).toBe('2026-05-07'); // global preserved
  });

  it('a current period before its final expected Thursday is partial', () => {
    const rows = [
      row('2026-03-26', 1, { total_sent: 1 }),
      row('2026-04-02', 1, { total_sent: 2 }),
      row('2026-04-09', 1, { total_sent: 3 }), // data through Apr 9; April's final Thursday is Apr 30
    ];
    const c = assessOutreachCompleteness(rows, month(2026, 4));
    expect(c.completeness).toBe('partial');
    expect(c.suppressDelta).toBe(true);
  });

  it('a period with no snapshots is missing', () => {
    const c = assessOutreachCompleteness(cleanSeries(), month(2026, 9));
    expect(c.completeness).toBe('missing');
    expect(c.suppressDelta).toBe(true);
    expect(c.dataThrough).toBe('2026-04-09'); // global preserved
  });
});

describe('comparisons — exact calendar periods only', () => {
  const rows = [
    // May: baseline Apr 30 = 100; May end = 160  -> May activity 60
    row('2026-04-30', 1, { total_sent: 100 }),
    row('2026-05-07', 1, { total_sent: 120 }),
    row('2026-05-28', 1, { total_sent: 160 }),
    // June: NO SNAPSHOTS AT ALL (missing month)
    // July: baseline = May 28 (160); July end = 200
    row('2026-07-02', 1, { total_sent: 180 }),
    row('2026-07-30', 1, { total_sent: 200 }),
  ];

  it('previous period is the exact prior calendar month', () => {
    const d = dedupeSnapshots(rows);
    const c = compareOutreachActivity(d, 'total_sent', month(2026, 5), 'previous_period');
    expect(c.comparisonPeriod).toEqual({ grain: 'month', year: 2026, month: 4 });
  });

  it('a missing June must not make July silently compare with May', () => {
    const d = dedupeSnapshots(rows);
    const c = compareOutreachActivity(d, 'total_sent', month(2026, 7), 'previous_period');
    // Comparison period is EXACTLY June...
    expect(c.comparisonPeriod).toEqual({ grain: 'month', year: 2026, month: 6 });
    // ...and June has no snapshots, so the comparison is missing, not May's 60.
    expect(c.comparison).toEqual({ state: 'missing' });
    // Under the exact-boundary contract, July's own baseline (the June 25
    // boundary Thursday) is ALSO missing, so July's current is not silently
    // computed from the stale May 28 snapshot either: the whole comparison is
    // suppressed rather than widened.
    expect(c.current).toEqual({ state: 'missing' });
    expect(c.suppressDelta).toBe(true);
  });

  it('a valid exact boundary makes the current period computable and the shared flag authoritative', () => {
    const withBoundary = [
      ...rows,
      row('2026-06-25', 1, { total_sent: 170 }), // July's exact boundary Thursday
    ];
    const d = dedupeSnapshots(withBoundary);
    const c = compareOutreachActivity(d, 'total_sent', month(2026, 7), 'previous_period');
    // July current: 200 - 170 (exact June 25 boundary) = 30, complete.
    expect(c.current).toMatchObject({ state: 'present', value: 30, incomplete: false });
    // June comparison: June's own boundary Thursday is May 28 (present), end
    // June 25 = 170 -> +10 complete.
    expect(c.comparison).toMatchObject({ state: 'present', value: 10, incomplete: false });
    // Both sides present AND complete -> the shared flag permits the delta.
    expect(c.suppressDelta).toBe(false);
  });

  it('previous year compares the same month in the prior year', () => {
    const withPriorYear = [
      row('2025-06-26', 1, { total_sent: 10 }),
      row('2025-07-31', 1, { total_sent: 30 }), // July 2025 activity = 20
      ...rows,
    ];
    const d = dedupeSnapshots(withPriorYear);
    const c = compareOutreachActivity(d, 'total_sent', month(2026, 7), 'previous_year');
    expect(c.comparisonPeriod).toEqual({ grain: 'month', year: 2025, month: 7 });
    expect(c.comparison).toMatchObject({ state: 'present', value: 20 });
  });

  it('comparison off yields no comparison period', () => {
    const d = dedupeSnapshots(rows);
    const c = compareOutreachActivity(d, 'total_sent', month(2026, 7), 'off');
    expect(c.comparisonPeriod).toBeNull();
    expect(c.comparison).toBeNull();
  });
});

describe('intermediate reset detection (consecutive-observation scan)', () => {
  it('detects a mid-period reset followed by partial recovery', () => {
    // Baseline 100; drop to 50; recover to 80. End-minus-baseline = -20 would
    // already be negative here, but the scan flags the 100->50 drop directly.
    const d = dedupeSnapshots([
      row('2026-03-26', 1, { total_sent: 100 }),
      row('2026-04-02', 1, { total_sent: 50 }),
      row('2026-04-09', 1, { total_sent: 80 }),
    ]);
    expect(sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', month(2026, 4))).toEqual({ state: 'reset' });
  });

  it('detects a mid-period reset even when the counter recovers ABOVE the baseline', () => {
    // Baseline 100 -> 50 -> 130. End-minus-baseline alone reports +30 and
    // hides the correction; the consecutive scan must return reset.
    const d = dedupeSnapshots([
      row('2026-03-26', 1, { total_sent: 100 }),
      row('2026-04-02', 1, { total_sent: 50 }),
      row('2026-04-09', 1, { total_sent: 130 }),
    ]);
    expect(sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', month(2026, 4))).toEqual({ state: 'reset' });
  });

  it('detects an in-period reset for a debut sequence (no pre-period baseline)', () => {
    const d = dedupeSnapshots([
      row('2026-04-02', 1, { total_sent: 90 }),
      row('2026-04-09', 1, { total_sent: 40 }), // drop after debut
      row('2026-04-16', 1, { total_sent: 120 }),
    ]);
    expect(sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', month(2026, 4))).toEqual({ state: 'reset' });
  });

  it('normal unchanged and increasing sequences stay present', () => {
    const flat = dedupeSnapshots([
      row('2026-03-26', 1, { total_sent: 100 }),
      row('2026-04-02', 1, { total_sent: 100 }),
      row('2026-04-09', 1, { total_sent: 100 }),
    ]);
    expect(sequencePeriodActivity(flat.bySequence.get(1)!, 'total_sent', month(2026, 4))).toEqual({
      state: 'present', value: 0, baselineIncomplete: false, missingMeasurements: false,
    });
    const rising = dedupeSnapshots([
      row('2026-03-26', 2, { total_sent: 100 }),
      row('2026-04-02', 2, { total_sent: 130 }),
      row('2026-04-09', 2, { total_sent: 170 }),
    ]);
    expect(sequencePeriodActivity(rising.bySequence.get(2)!, 'total_sent', month(2026, 4))).toEqual({
      state: 'present', value: 70, baselineIncomplete: false, missingMeasurements: false,
    });
  });
});

describe('required boundary-baseline Thursday', () => {
  it('all in-period Thursdays present but the required pre-period Thursday missing -> partial', () => {
    // April 2026 Thursdays: Apr 2, 9, 16, 23, 30. Required boundary baseline:
    // Thu Mar 26 (immediately before April 1). Feed existed since Mar 19, but
    // the Mar 26 run is MISSING; only the older Mar 19 snapshot exists. April
    // must not silently widen its window back to Mar 19.
    const rows = [
      row('2026-03-19', 1, { total_sent: 1 }),
      // 2026-03-26 MISSING (the required boundary baseline)
      row('2026-04-02', 1, { total_sent: 2 }),
      row('2026-04-09', 1, { total_sent: 3 }),
      row('2026-04-16', 1, { total_sent: 4 }),
      row('2026-04-23', 1, { total_sent: 5 }),
      row('2026-04-30', 1, { total_sent: 6 }),
      row('2026-05-07', 1, { total_sent: 7 }),
    ];
    const c = assessOutreachCompleteness(rows, month(2026, 4));
    expect(c.requiredBaselineThursday).toBe('2026-03-26');
    expect(c.missingBaselineThursday).toBe(true);
    expect(c.completeness).toBe('partial');
    expect(c.suppressDelta).toBe(true);
    expect(c.missingThursdays).toEqual([]); // every in-period Thursday IS present
  });

  it('a Wednesday snapshot near the boundary does not substitute for the required Thursday', () => {
    const rows = [
      row('2026-03-19', 1, { total_sent: 1 }),
      row('2026-03-25', 1, { total_sent: 1 }), // Wednesday before the boundary
      // Thursday 2026-03-26 still missing
      row('2026-04-02', 1, { total_sent: 2 }),
      row('2026-04-09', 1, { total_sent: 3 }),
      row('2026-04-16', 1, { total_sent: 4 }),
      row('2026-04-23', 1, { total_sent: 5 }),
      row('2026-04-30', 1, { total_sent: 6 }),
    ];
    const c = assessOutreachCompleteness(rows, month(2026, 4));
    expect(c.missingBaselineThursday).toBe(true);
    expect(c.completeness).toBe('partial');
  });

  it('the boundary Thursday is not required before the feed existed', () => {
    // Feed starts Apr 2; the pre-April boundary (Mar 26) predates the feed.
    const rows = [
      row('2026-04-02', 1, { total_sent: 2 }),
      row('2026-04-09', 1, { total_sent: 3 }),
      row('2026-04-16', 1, { total_sent: 4 }),
      row('2026-04-23', 1, { total_sent: 5 }),
      row('2026-04-30', 1, { total_sent: 6 }),
      row('2026-05-07', 1, { total_sent: 7 }),
    ];
    const c = assessOutreachCompleteness(rows, month(2026, 4));
    expect(c.requiredBaselineThursday).toBeNull();
    expect(c.missingBaselineThursday).toBe(false);
    expect(c.completeness).toBe('complete');
  });

  it('a present boundary Thursday plus all in-period Thursdays is complete', () => {
    const rows = [
      row('2026-03-26', 1, { total_sent: 1 }), // required boundary present
      row('2026-04-02', 1, { total_sent: 2 }),
      row('2026-04-09', 1, { total_sent: 3 }),
      row('2026-04-16', 1, { total_sent: 4 }),
      row('2026-04-23', 1, { total_sent: 5 }),
      row('2026-04-30', 1, { total_sent: 6 }),
      row('2026-05-07', 1, { total_sent: 7 }),
    ];
    const c = assessOutreachCompleteness(rows, month(2026, 4));
    expect(c.requiredBaselineThursday).toBe('2026-03-26');
    expect(c.missingBaselineThursday).toBe(false);
    expect(c.completeness).toBe('complete');
  });
});

describe('ambiguous-duplicate scoping', () => {
  it('an unrelated May ambiguity does not mark a clean July incomplete', () => {
    const d = dedupeSnapshots([
      // May: ambiguous duplicate (changed values, no reliable recency).
      row('2026-05-07', 2, { replied: 5 }, { created_at: null }),
      row('2026-05-07', 2, { replied: 9 }, { created_at: null }),
      // A later valid pre-July observation for seq 2 exists, so the May
      // ambiguity cannot be July's baseline.
      row('2026-06-25', 2, { replied: 12 }),
      row('2026-07-02', 2, { replied: 15 }),
      row('2026-07-30', 2, { replied: 20 }),
      // Clean seq 1 in July too.
      row('2026-06-25', 1, { replied: 100 }),
      row('2026-07-30', 1, { replied: 130 }),
    ]);
    expect(d.ambiguousKeys).toHaveLength(1);
    const july = aggregateActivity(d, 'replied', month(2026, 7));
    expect(july).toMatchObject({
      state: 'present',
      value: 38, // seq1 +30, seq2 +8 (15->20 in July from 12 baseline? no: baseline 6/25=12, end 7/30=20 -> +8)
      incomplete: false,
      issues: { ambiguousDuplicates: 0 },
    });
  });

  it('an ambiguity inside the selected period still counts', () => {
    const d = dedupeSnapshots([
      row('2026-06-25', 1, { replied: 10 }),
      row('2026-07-02', 1, { replied: 12 }, { created_at: null }),
      row('2026-07-02', 1, { replied: 14 }, { created_at: null }), // ambiguous IN July
      row('2026-07-30', 1, { replied: 20 }),
    ]);
    const july = aggregateActivity(d, 'replied', month(2026, 7));
    expect(july).toMatchObject({ state: 'present', incomplete: true, issues: { ambiguousDuplicates: 1 } });
  });

  it('a pre-period ambiguity that would have been the baseline counts', () => {
    const d = dedupeSnapshots([
      // The ONLY pre-July observation is ambiguous: it would have been July's baseline.
      row('2026-06-25', 1, { replied: 10 }, { created_at: null }),
      row('2026-06-25', 1, { replied: 12 }, { created_at: null }),
      row('2026-07-02', 1, { replied: 15 }),
      row('2026-07-30', 1, { replied: 20 }),
    ]);
    const july = aggregateActivity(d, 'replied', month(2026, 7));
    expect(july).toMatchObject({ state: 'present', incomplete: true, issues: { ambiguousDuplicates: 1 } });
  });
});

describe('sequence-and-metric-level boundary baseline', () => {
  // April 2026's exact boundary Thursday is 2026-03-26.

  it('boundary Thursday exists globally for Sequence A but is missing for Sequence B', () => {
    const d = dedupeSnapshots([
      // Sequence A: exact boundary present -> complete April activity.
      row('2026-03-26', 1, { total_sent: 100 }),
      row('2026-04-30', 1, { total_sent: 150 }),
      // Sequence B: existed earlier (Mar 19) but has NO Mar 26 boundary row.
      row('2026-03-19', 2, { total_sent: 40 }),
      row('2026-04-30', 2, { total_sent: 90 }),
    ]);
    expect(
      sequencePeriodActivity(d.bySequence.get(1)!, 'total_sent', month(2026, 4), d.feedStart ?? undefined),
    ).toEqual({ state: 'present', value: 50, baselineIncomplete: false, missingMeasurements: false });
    // Sequence B must NOT fall back to Mar 19 (window widening): explicit
    // missing-baseline instead, even though the boundary exists feed-wide.
    expect(
      sequencePeriodActivity(d.bySequence.get(2)!, 'total_sent', month(2026, 4), d.feedStart ?? undefined),
    ).toEqual({ state: 'missing_baseline' });
    // Aggregate counts the gap and stays incomplete without zeroing seq A.
    expect(aggregateActivity(d, 'total_sent', month(2026, 4))).toMatchObject({
      state: 'present',
      value: 50,
      incomplete: true,
      issues: { missingBaselines: 1 },
    });
  });

  it('boundary row exists for the sequence but the target metric is null; another metric on the same row stays usable', () => {
    const d = dedupeSnapshots([
      row('2026-03-19', 3, { total_sent: 90, linkedin_tasks_completed: 10 }),
      // Boundary row exists, but linkedin is null on it while total_sent is measured.
      row('2026-03-26', 3, { total_sent: 100, linkedin_tasks_completed: null }),
      row('2026-04-30', 3, { total_sent: 150, linkedin_tasks_completed: 30 }),
    ]);
    // The metric with a null boundary measurement gets missing_baseline (no
    // fallback to the older Mar 19 value of 10)...
    expect(
      sequencePeriodActivity(d.bySequence.get(3)!, 'linkedin_tasks_completed', month(2026, 4), d.feedStart ?? undefined),
    ).toEqual({ state: 'missing_baseline' });
    // ...while total_sent, measured on the exact boundary row, is complete.
    expect(
      sequencePeriodActivity(d.bySequence.get(3)!, 'total_sent', month(2026, 4), d.feedStart ?? undefined),
    ).toEqual({ state: 'present', value: 50, baselineIncomplete: false, missingMeasurements: false });
  });

  it('a valid exact boundary produces the expected activity', () => {
    const d = dedupeSnapshots([
      row('2026-03-26', 4, { opened: 200 }),
      row('2026-04-09', 4, { opened: 230 }),
      row('2026-04-30', 4, { opened: 260 }),
    ]);
    expect(
      sequencePeriodActivity(d.bySequence.get(4)!, 'opened', month(2026, 4), d.feedStart ?? undefined),
    ).toEqual({ state: 'present', value: 60, baselineIncomplete: false, missingMeasurements: false });
  });

  it('a genuinely new sequence retains the debut behavior', () => {
    const d = dedupeSnapshots([
      // Other feed data proves the feed existed before April.
      row('2026-03-26', 1, { total_sent: 100 }),
      row('2026-04-30', 1, { total_sent: 120 }),
      // Sequence 5 debuts inside April: first snapshot never counted; later
      // growth counts, baseline-incomplete.
      row('2026-04-09', 5, { total_sent: 70 }),
      row('2026-04-30', 5, { total_sent: 95 }),
    ]);
    expect(
      sequencePeriodActivity(d.bySequence.get(5)!, 'total_sent', month(2026, 4), d.feedStart ?? undefined),
    ).toEqual({ state: 'present', value: 25, baselineIncomplete: true, missingMeasurements: false });
  });

  it('a sequence debuting inside the boundary gap keeps incomplete-baseline semantics', () => {
    const d = dedupeSnapshots([
      row('2026-03-26', 1, { total_sent: 10 }), // feed existed at the boundary
      row('2026-04-30', 1, { total_sent: 15 }),
      // Sequence 6's history starts Mar 28 (after the Mar 26 boundary): the
      // exact boundary cannot exist for it. Later growth counts, incomplete.
      row('2026-03-28', 6, { total_sent: 50 }),
      row('2026-04-30', 6, { total_sent: 80 }),
    ]);
    expect(
      sequencePeriodActivity(d.bySequence.get(6)!, 'total_sent', month(2026, 4), d.feedStart ?? undefined),
    ).toEqual({ state: 'present', value: 30, baselineIncomplete: true, missingMeasurements: false });
  });

  it('the pre-feed exemption remains intact', () => {
    // Feed starts Apr 2 (inside April): the Mar 26 boundary predates the feed,
    // so the exact-boundary requirement is waived; debut semantics apply.
    const d = dedupeSnapshots([
      row('2026-04-02', 7, { total_sent: 100 }),
      row('2026-04-30', 7, { total_sent: 140 }),
    ]);
    expect(
      sequencePeriodActivity(d.bySequence.get(7)!, 'total_sent', month(2026, 4), d.feedStart ?? undefined),
    ).toEqual({ state: 'present', value: 40, baselineIncomplete: true, missingMeasurements: false });
    // And a MAY period on the same feed: May's boundary Thursday (Apr 30) is
    // on/after the feed start and present, so it is required and satisfied.
    const withMay = dedupeSnapshots([
      row('2026-04-02', 7, { total_sent: 100 }),
      row('2026-04-30', 7, { total_sent: 140 }),
      row('2026-05-28', 7, { total_sent: 190 }),
    ]);
    expect(
      sequencePeriodActivity(withMay.bySequence.get(7)!, 'total_sent', month(2026, 5), withMay.feedStart ?? undefined),
    ).toEqual({ state: 'present', value: 50, baselineIncomplete: false, missingMeasurements: false });
  });
});
