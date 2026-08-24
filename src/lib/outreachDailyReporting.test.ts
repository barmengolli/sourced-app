import { describe, expect, it } from 'vitest';
import type { ReportingPeriod } from '../types/reporting';
import type { ActivityCounter } from './outreachReporting';
import {
  aggregateDailyPeriodActivity,
  aggregateDailyPeriodEnrollments,
  assessDailyOutreachCoverage,
  dedupeDailySnapshots,
  sequenceDailyPeriodActiveProspects,
  sequenceDailyPeriodActivity,
  sequenceDailyPeriodEnrollments,
  type OutreachDailyRun,
  type OutreachDailySnapshot,
} from './outreachDailyReporting';

const july: ReportingPeriod = { grain: 'month', year: 2026, month: 7 };
const august: ReportingPeriod = { grain: 'month', year: 2026, month: 8 };

function row(
  snapshot_date: string,
  sequence_id: number,
  options: {
    basis?: 'legacy_cumulative' | 'daily_event';
    created?: string | null;
    enrolled?: number | null;
    active?: number | null;
    counters?: Partial<Record<ActivityCounter, number | null>>;
    collected?: string | null;
  } = {},
): OutreachDailySnapshot {
  return {
    snapshot_date,
    collected_at: options.collected ?? `${snapshot_date}T06:05:00Z`,
    sequence_id,
    sequence_name: `Sequence ${sequence_id}`,
    activity_basis: options.basis,
    sequence_created_date: options.created ?? '2026-01-01',
    enabled: true,
    prospects_enrolled: options.enrolled ?? 0,
    prospects_active: options.active ?? 0,
    counters: options.counters ?? {},
  };
}

function run(snapshot_date: string, overrides: Partial<OutreachDailyRun> = {}): OutreachDailyRun {
  return {
    snapshot_date,
    status: 'complete',
    pagination_complete: true,
    expected_sequences: 25,
    observed_sequences: 25,
    ...overrides,
  };
}

describe('daily Outreach period contract', () => {
  it('sums v3 dated activity without requiring a cumulative baseline', () => {
    const data = dedupeDailySnapshots([
      row('2026-08-10', 1, {
        basis: 'daily_event',
        counters: { delivered: 40, outbound_calls: 5 },
      }),
      row('2026-08-11', 1, {
        basis: 'daily_event',
        counters: { delivered: 30, outbound_calls: 2 },
      }),
    ]);

    expect(sequenceDailyPeriodActivity(data, 1, 'delivered', august)).toEqual({
      state: 'present',
      value: 70,
      complete: true,
      issues: [],
    });
    expect(sequenceDailyPeriodActivity(data, 1, 'outbound_calls', august)).toEqual({
      state: 'present',
      value: 7,
      complete: true,
      issues: [],
    });
  });

  it('does not subtract one dated activity day from another', () => {
    const data = dedupeDailySnapshots([
      row('2026-08-10', 1, {
        basis: 'daily_event',
        counters: { total_sent: 100 },
      }),
      row('2026-08-11', 1, {
        basis: 'daily_event',
        counters: { total_sent: 20 },
      }),
    ]);
    expect(sequenceDailyPeriodActivity(data, 1, 'total_sent', august)).toEqual({
      state: 'present',
      value: 120,
      complete: true,
      issues: [],
    });
  });

  it('marks a cutover period partial instead of mixing legacy and event math silently', () => {
    const data = dedupeDailySnapshots([
      row('2026-08-10', 1, { counters: { delivered: 1000 } }),
      row('2026-08-11', 1, {
        basis: 'daily_event',
        counters: { delivered: 15 },
      }),
    ]);
    expect(sequenceDailyPeriodActivity(data, 1, 'delivered', august)).toEqual({
      state: 'present',
      value: 15,
      complete: false,
      issues: ['mixed_activity_basis'],
    });
  });

  it('reports July 1,000 and August 1,500 without using sequence count in the formula', () => {
    const data = dedupeDailySnapshots([
      row('2026-06-30', 1, { counters: { total_sent: 0 } }),
      row('2026-07-31', 1, { counters: { total_sent: 600 } }),
      row('2026-06-30', 2, { counters: { total_sent: 0 } }),
      row('2026-07-31', 2, { counters: { total_sent: 400 } }),
      row('2026-08-31', 1, { counters: { total_sent: 1200 } }),
      row('2026-08-31', 2, { counters: { total_sent: 800 } }),
      // Five new August sequences contribute 100 each. Their zero baseline is
      // justified by their creation date, not invented from a missing row.
      ...[3, 4, 5, 6, 7].map((id) =>
        row('2026-08-31', id, {
          created: '2026-08-17',
          counters: { total_sent: 100 },
        }),
      ),
    ]);

    expect(aggregateDailyPeriodActivity(data, 'total_sent', july)).toMatchObject({
      state: 'present',
      value: 1000,
      complete: true,
    });
    expect(aggregateDailyPeriodActivity(data, 'total_sent', august)).toMatchObject({
      state: 'present',
      value: 1500,
      complete: true,
    });
  });

  it('sums repeated manual or automated enrollment events for the same sequence', () => {
    const data = dedupeDailySnapshots([
      row('2026-08-10', 1, { enrolled: 10 }),
      row('2026-08-11', 1, { enrolled: 20 }),
      row('2026-08-12', 2, { enrolled: 5 }),
      row('2026-08-13', 2, { enrolled: 1 }),
      row('2026-08-14', 2, { enrolled: 2 }),
    ]);

    expect(sequenceDailyPeriodEnrollments(data, 1, august)).toMatchObject({
      state: 'present',
      value: 30,
      complete: true,
    });
    expect(sequenceDailyPeriodEnrollments(data, 2, august)).toMatchObject({
      state: 'present',
      value: 8,
      complete: true,
    });
    expect(aggregateDailyPeriodEnrollments(data, august)).toMatchObject({
      state: 'present',
      value: 38,
      complete: true,
    });
  });

  it('treats 500 July enrollments and 200 August enrollments as valid, not incomplete', () => {
    const data = dedupeDailySnapshots([
      row('2026-07-15', 1, { enrolled: 500 }),
      row('2026-08-15', 1, { enrolled: 200 }),
    ]);
    expect(sequenceDailyPeriodEnrollments(data, 1, july)).toEqual({
      state: 'present',
      value: 500,
      complete: true,
      issues: [],
    });
    expect(sequenceDailyPeriodEnrollments(data, 1, august)).toEqual({
      state: 'present',
      value: 200,
      complete: true,
      issues: [],
    });
  });

  it('uses the latest active-prospect snapshot instead of summing daily values', () => {
    const data = dedupeDailySnapshots([
      row('2026-08-10', 1, { active: 500 }),
      row('2026-08-20', 1, { active: 420 }),
      row('2026-08-31', 1, { active: 200 }),
    ]);
    expect(sequenceDailyPeriodActiveProspects(data, 1, august)).toEqual({
      state: 'present',
      value: 200,
      complete: true,
      issues: [],
    });
  });

  it('uses a real pre-period snapshot for an established sequence', () => {
    const data = dedupeDailySnapshots([
      row('2026-07-31', 1, { counters: { delivered: 1000 } }),
      row('2026-08-31', 1, { counters: { delivered: 1300 } }),
    ]);
    expect(sequenceDailyPeriodActivity(data, 1, 'delivered', august)).toEqual({
      state: 'present',
      value: 300,
      complete: true,
      issues: [],
    });
  });

  it('accepts a new mid-month sequence with a zero baseline', () => {
    const data = dedupeDailySnapshots([
      row('2026-08-17', 9, {
        created: '2026-08-17',
        counters: { delivered: 40 },
      }),
      row('2026-08-31', 9, {
        created: '2026-08-17',
        counters: { delivered: 120 },
      }),
    ]);
    expect(sequenceDailyPeriodActivity(data, 9, 'delivered', august)).toEqual({
      state: 'present',
      value: 120,
      complete: true,
      issues: [],
    });
  });

  it('refuses to invent a zero baseline for an established sequence', () => {
    const data = dedupeDailySnapshots([
      row('2026-08-31', 1, {
        created: '2026-01-01',
        counters: { delivered: 120 },
      }),
    ]);
    expect(sequenceDailyPeriodActivity(data, 1, 'delivered', august)).toEqual({
      state: 'missing',
      issues: ['missing_baseline'],
    });
  });

  it('fails closed on a counter reset instead of clamping it to zero', () => {
    const data = dedupeDailySnapshots([
      row('2026-07-31', 1, { counters: { opened: 100 } }),
      row('2026-08-10', 1, { counters: { opened: 130 } }),
      row('2026-08-20', 1, { counters: { opened: 90 } }),
      row('2026-08-31', 1, { counters: { opened: 140 } }),
    ]);
    expect(sequenceDailyPeriodActivity(data, 1, 'opened', august)).toEqual({
      state: 'missing',
      issues: ['counter_reset'],
    });
  });

  it('marks a missing daily measurement partial while retaining safe-known activity', () => {
    const data = dedupeDailySnapshots([
      row('2026-07-31', 1, { counters: { replied: 10 } }),
      row('2026-08-10', 1, { counters: { replied: null } }),
      row('2026-08-31', 1, { counters: { replied: 15 } }),
    ]);
    expect(sequenceDailyPeriodActivity(data, 1, 'replied', august)).toEqual({
      state: 'present',
      value: 5,
      complete: false,
      issues: ['missing_measurement'],
    });
  });

  it('uses the latest same-day retry and refuses an unordered conflict', () => {
    const latest = dedupeDailySnapshots([
      row('2026-08-10', 1, { enrolled: 10, collected: '2026-08-11T06:05:00Z' }),
      row('2026-08-10', 1, { enrolled: 12, collected: '2026-08-11T06:15:00Z' }),
    ]);
    expect(sequenceDailyPeriodEnrollments(latest, 1, august)).toMatchObject({
      state: 'present',
      value: 12,
      complete: true,
    });

    const ambiguous = dedupeDailySnapshots([
      row('2026-08-10', 1, { enrolled: 10, collected: null }),
      row('2026-08-10', 1, { enrolled: 12, collected: null }),
    ]);
    expect(ambiguous.ambiguousKeys).toEqual([
      { snapshot_date: '2026-08-10', sequence_id: 1 },
    ]);
  });
});

describe('daily Outreach extraction coverage', () => {
  it('marks a fully observed completed month complete', () => {
    const runs = Array.from({ length: 31 }, (_, index) =>
      run(`2026-07-${String(index + 1).padStart(2, '0')}`),
    );
    expect(assessDailyOutreachCoverage(runs, july, '2026-07-01', '2026-07-31')).toEqual({
      state: 'complete',
      dataThrough: '2026-07-31',
      expectedDays: 31,
      completeDays: 31,
      issues: {
        missingRuns: 0,
        failedRuns: 0,
        incompletePagination: 0,
        sequenceCountMismatches: 0,
        duplicateRunDates: 0,
        predatesFeed: false,
        periodStillOpen: false,
      },
    });
  });

  it('marks a current month partial without calling new sequences incomplete', () => {
    const runs = Array.from({ length: 17 }, (_, index) =>
      run(`2026-08-${String(index + 1).padStart(2, '0')}`, {
        expected_sequences: index < 16 ? 20 : 25,
        observed_sequences: index < 16 ? 20 : 25,
      }),
    );
    const coverage = assessDailyOutreachCoverage(
      runs,
      august,
      '2026-08-01',
      '2026-08-17',
    );
    expect(coverage.state).toBe('partial');
    expect(coverage.completeDays).toBe(17);
    expect(coverage.issues.periodStillOpen).toBe(true);
    expect(coverage.issues.sequenceCountMismatches).toBe(0);
  });

  it('detects failed runs, incomplete pagination, and sequence-count mismatches', () => {
    const coverage = assessDailyOutreachCoverage(
      [
        run('2026-08-01'),
        run('2026-08-02', { status: 'failed' }),
        run('2026-08-03', { pagination_complete: false }),
        run('2026-08-04', { observed_sequences: 24 }),
      ],
      august,
      '2026-08-01',
      '2026-08-05',
    );
    expect(coverage.state).toBe('partial');
    expect(coverage.issues).toMatchObject({
      missingRuns: 1,
      failedRuns: 1,
      incompletePagination: 1,
      sequenceCountMismatches: 1,
    });
  });

  it('handles leap-day coverage without reading the current clock', () => {
    const february2028: ReportingPeriod = { grain: 'month', year: 2028, month: 2 };
    const runs = Array.from({ length: 29 }, (_, index) =>
      run(`2028-02-${String(index + 1).padStart(2, '0')}`),
    );
    expect(
      assessDailyOutreachCoverage(runs, february2028, '2028-02-01', '2028-02-29'),
    ).toMatchObject({ state: 'complete', expectedDays: 29, completeDays: 29 });
  });
});
