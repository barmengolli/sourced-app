// Pure, deterministic tests for the reporting period utilities. No clock, no
// network, no timezone dependence: every input is an explicit fixed value.

import { describe, it, expect } from 'vitest';
import {
  periodBounds,
  previousPeriod,
  previousYearPeriod,
  comparisonPeriod,
  periodLabel,
  comparisonLabel,
  comparisonModesCollapse,
  isValidReportingPeriod,
  assessCompleteness,
  isPeriodComplete,
} from './reportingPeriods';
import type { MonthIndex, ReportingPeriod } from '../types/reporting';
import type { PeriodIndex } from '../types/db';

const month = (year: number, m: number): ReportingPeriod => ({
  grain: 'month',
  year,
  month: m as MonthIndex,
});
const quarter = (year: number, q: number): ReportingPeriod => ({
  grain: 'quarter',
  year,
  quarter: q as PeriodIndex,
});
const year = (y: number): ReportingPeriod => ({ grain: 'year', year: y });

describe('periodBounds — inclusive date-only boundaries', () => {
  it('handles 31-day months (January)', () => {
    expect(periodBounds(month(2026, 1))).toEqual({ start: '2026-01-01', end: '2026-01-31' });
  });
  it('handles 30-day months (April)', () => {
    expect(periodBounds(month(2026, 4))).toEqual({ start: '2026-04-01', end: '2026-04-30' });
  });
  it('handles 28-day February in a common year', () => {
    expect(periodBounds(month(2026, 2))).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
  it('handles 29-day February in a leap year (2024)', () => {
    expect(periodBounds(month(2024, 2))).toEqual({ start: '2024-02-01', end: '2024-02-29' });
  });
  it('treats century non-leap 1900 and leap 2000 correctly', () => {
    expect(periodBounds(month(1900, 2))?.end).toBe('1900-02-28');
    expect(periodBounds(month(2000, 2))?.end).toBe('2000-02-29');
  });
  it('handles all four quarter boundaries', () => {
    expect(periodBounds(quarter(2026, 1))).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(periodBounds(quarter(2026, 2))).toEqual({ start: '2026-04-01', end: '2026-06-30' });
    expect(periodBounds(quarter(2026, 3))).toEqual({ start: '2026-07-01', end: '2026-09-30' });
    expect(periodBounds(quarter(2026, 4))).toEqual({ start: '2026-10-01', end: '2026-12-31' });
  });
  it('handles the full-year boundary', () => {
    expect(periodBounds(year(2026))).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });
});

describe('isValidReportingPeriod — reject invalid shapes safely', () => {
  it('rejects an out-of-range month', () => {
    expect(isValidReportingPeriod({ grain: 'month', year: 2026, month: 13 as MonthIndex })).toBe(false);
    expect(periodBounds({ grain: 'month', year: 2026, month: 0 as MonthIndex })).toBeNull();
  });
  it('rejects an out-of-range quarter', () => {
    expect(isValidReportingPeriod({ grain: 'quarter', year: 2026, quarter: 5 as PeriodIndex })).toBe(false);
  });
  it('rejects a non-integer or out-of-range year', () => {
    expect(isValidReportingPeriod({ grain: 'year', year: 0 })).toBe(false);
    expect(isValidReportingPeriod({ grain: 'year', year: 2026.5 })).toBe(false);
  });
});

describe('previousPeriod — crosses calendar boundaries', () => {
  it('steps back within a year for months', () => {
    expect(previousPeriod(month(2026, 6))).toEqual(month(2026, 5));
  });
  it('rolls December to prior-year January boundary (Jan -> prior Dec)', () => {
    expect(previousPeriod(month(2026, 1))).toEqual(month(2025, 12));
  });
  it('steps back within a year for quarters', () => {
    expect(previousPeriod(quarter(2026, 3))).toEqual(quarter(2026, 2));
  });
  it('rolls Q1 to prior-year Q4', () => {
    expect(previousPeriod(quarter(2026, 1))).toEqual(quarter(2025, 4));
  });
  it('steps back a year for year grain', () => {
    expect(previousPeriod(year(2026))).toEqual(year(2025));
  });
});

describe('previousYearPeriod — same period one year earlier', () => {
  it('month keeps the month, drops a year', () => {
    expect(previousYearPeriod(month(2026, 1))).toEqual(month(2025, 1));
    expect(previousYearPeriod(month(2026, 12))).toEqual(month(2025, 12));
  });
  it('quarter keeps the quarter, drops a year', () => {
    expect(previousYearPeriod(quarter(2026, 1))).toEqual(quarter(2025, 1));
  });
  it('year drops a year', () => {
    expect(previousYearPeriod(year(2026))).toEqual(year(2025));
  });
});

describe('comparisonPeriod + collapse for Year grain', () => {
  it('previous_period and previous_year are identical for year grain', () => {
    expect(comparisonPeriod(year(2026), 'previous_period')).toEqual(year(2025));
    expect(comparisonPeriod(year(2026), 'previous_year')).toEqual(year(2025));
    expect(comparisonModesCollapse('year')).toBe(true);
    expect(comparisonModesCollapse('month')).toBe(false);
    expect(comparisonModesCollapse('quarter')).toBe(false);
  });
  it('off yields no comparison period', () => {
    expect(comparisonPeriod(month(2026, 6), 'off')).toBeNull();
  });
  it('month previous_period differs from previous_year', () => {
    expect(comparisonPeriod(month(2026, 6), 'previous_period')).toEqual(month(2026, 5));
    expect(comparisonPeriod(month(2026, 6), 'previous_year')).toEqual(month(2025, 6));
  });
});

describe('labels', () => {
  it('period labels', () => {
    expect(periodLabel(month(2026, 6))).toBe('June 2026');
    expect(periodLabel(quarter(2026, 2))).toBe('Q2 2026');
    expect(periodLabel(year(2026))).toBe('2026');
  });
  it('comparison labels name the comparison, adding the year only when it differs', () => {
    expect(comparisonLabel(month(2026, 6), 'previous_period')).toBe('vs May');
    expect(comparisonLabel(month(2026, 1), 'previous_period')).toBe('vs December 2025'); // rollover
    expect(comparisonLabel(month(2026, 6), 'previous_year')).toBe('vs June 2025');
    expect(comparisonLabel(quarter(2026, 2), 'previous_period')).toBe('vs Q1');
    expect(comparisonLabel(quarter(2026, 1), 'previous_period')).toBe('vs Q4 2025');
    expect(comparisonLabel(year(2026), 'previous_year')).toBe('vs 2025');
    expect(comparisonLabel(month(2026, 6), 'off')).toBe('');
  });
});

describe('assessCompleteness — explicit data-through date, never the clock', () => {
  it('marks complete when data-through reaches the period end', () => {
    const r = assessCompleteness(month(2026, 6), '2026-06-30');
    expect(r.completeness).toBe('complete');
    expect(r.suppressDelta).toBe(false);
    expect(isPeriodComplete(month(2026, 6), '2026-06-30')).toBe(true);
  });
  it('marks partial when data-through is inside the period', () => {
    const r = assessCompleteness(month(2026, 6), '2026-06-15');
    expect(r.completeness).toBe('partial');
    expect(r.suppressDelta).toBe(true);
  });
  it('marks missing when data-through is before the period start', () => {
    const r = assessCompleteness(month(2026, 6), '2026-05-31');
    expect(r.completeness).toBe('missing');
    expect(r.suppressDelta).toBe(true);
  });
  it('marks missing (and suppresses) when data-through is unknown', () => {
    const r = assessCompleteness(month(2026, 6), null);
    expect(r.completeness).toBe('missing');
    expect(r.suppressDelta).toBe(true);
  });
  it('treats a completed calendar period as still complete only when data-through covers it', () => {
    // Stale import: the calendar month ended but data only runs through the 20th.
    expect(assessCompleteness(month(2026, 6), '2026-06-20').completeness).toBe('partial');
  });
  it('quarter completeness uses the quarter end', () => {
    expect(assessCompleteness(quarter(2026, 2), '2026-06-30').completeness).toBe('complete');
    expect(assessCompleteness(quarter(2026, 2), '2026-05-15').completeness).toBe('partial');
  });
});
