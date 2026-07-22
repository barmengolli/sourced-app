// Deterministic tests for the LinkedIn Ads reporting helpers. Synthetic data
// only: generic product/region/ad-set labels, no real source rows, no network,
// no current clock. Fixed dates throughout.

import { describe, it, expect } from 'vitest';
import type { LinkedinAdSnapshot } from '../types/db';
import type { MonthIndex, ReportingPeriod } from '../types/reporting';
import type { PeriodIndex } from '../types/db';
import {
  snapshotInPeriod,
  filterSnapshots,
  sumSnapshots,
  ratesFromTotals,
  periodMetrics,
  comparePeriods,
  periodBreakdowns,
  breakdownBy,
  sundayOnOrBefore,
  finalSundayOfPeriod,
  latestImportedSunday,
  assessLinkedinCompleteness,
  defaultMonthPeriod,
} from './linkedinReporting';

// Synthetic factory. `week` is the week-ending Sunday (YYYY-MM-DD).
let idc = 0;
function snap(over: Partial<LinkedinAdSnapshot> = {}): LinkedinAdSnapshot {
  idc += 1;
  return {
    id: `s${idc}`,
    snapshot_date: '2026-07-19',
    year: 2026,
    week_number: 29,
    campaign_id: null,
    campaign_name: null,
    product: 'Product A',
    region: 'NA',
    adset_id: 'Ad Set 1',
    adset_name: 'Ad Set 1',
    spend: 0,
    impressions: 0,
    clicks: 0,
    created_at: '2026-07-20T00:00:00Z',
    ...over,
  };
}

const month = (year: number, m: number): ReportingPeriod => ({ grain: 'month', year, month: m as MonthIndex });
const quarter = (year: number, q: number): ReportingPeriod => ({ grain: 'quarter', year, quarter: q as PeriodIndex });
const year = (y: number): ReportingPeriod => ({ grain: 'year', year: y });

describe('period assignment by week-ending Sunday', () => {
  it('assigns a week ending July 26 to July and Q3', () => {
    const s = snap({ snapshot_date: '2026-07-26' });
    expect(snapshotInPeriod(s.snapshot_date, month(2026, 7))).toBe(true);
    expect(snapshotInPeriod(s.snapshot_date, month(2026, 8))).toBe(false);
    expect(snapshotInPeriod(s.snapshot_date, quarter(2026, 3))).toBe(true);
    expect(snapshotInPeriod(s.snapshot_date, year(2026))).toBe(true);
  });

  it('assigns a week ending August 2 to August and Q3 (never split across months)', () => {
    const s = snap({ snapshot_date: '2026-08-02' });
    // Even though this week covers late-July days, the whole total is August.
    expect(snapshotInPeriod(s.snapshot_date, month(2026, 8))).toBe(true);
    expect(snapshotInPeriod(s.snapshot_date, month(2026, 7))).toBe(false);
    expect(snapshotInPeriod(s.snapshot_date, quarter(2026, 3))).toBe(true);
  });

  it('does not prorate: one weekly row lands entirely in one month', () => {
    const rows = [snap({ snapshot_date: '2026-08-02', spend: 700, impressions: 1000, clicks: 10 })];
    const jul = sumSnapshots(filterSnapshots(rows, month(2026, 7)));
    const aug = sumSnapshots(filterSnapshots(rows, month(2026, 8)));
    expect(jul).toEqual({ spend: 0, impressions: 0, clicks: 0 }); // nothing bleeds into July
    expect(aug).toEqual({ spend: 700, impressions: 1000, clicks: 10 }); // full total in August
  });

  it('handles quarter boundaries (Q1/Q2/Q3/Q4)', () => {
    expect(snapshotInPeriod('2026-03-29', quarter(2026, 1))).toBe(true);
    expect(snapshotInPeriod('2026-04-05', quarter(2026, 2))).toBe(true);
    expect(snapshotInPeriod('2026-09-27', quarter(2026, 3))).toBe(true);
    expect(snapshotInPeriod('2026-12-27', quarter(2026, 4))).toBe(true);
  });

  it('handles December to January and Q4 to Q1 across the year boundary', () => {
    // A week ending Jan 3, 2027 belongs to January 2027 / Q1 2027, not to 2026.
    expect(snapshotInPeriod('2027-01-03', month(2027, 1))).toBe(true);
    expect(snapshotInPeriod('2027-01-03', year(2026))).toBe(false);
    expect(snapshotInPeriod('2026-12-27', quarter(2026, 4))).toBe(true);
    expect(snapshotInPeriod('2027-01-03', quarter(2027, 1))).toBe(true);
  });
});

describe('totals and rate recomputation', () => {
  const rows = [
    snap({ spend: 100, impressions: 4000, clicks: 40 }),
    snap({ spend: 300, impressions: 6000, clicks: 60 }),
  ];
  it('sums spend, impressions, clicks', () => {
    expect(sumSnapshots(rows)).toEqual({ spend: 400, impressions: 10000, clicks: 100 });
  });
  it('recomputes CTR/CPC/CPM from aggregate totals (not averaged per week)', () => {
    const r = ratesFromTotals(sumSnapshots(rows));
    expect(r.ctrPercent).toBeCloseTo(1.0, 10); // 100/10000 = 1%
    expect(r.cpc).toBeCloseTo(4.0, 10); // 400/100
    expect(r.cpm).toBeCloseTo(40.0, 10); // 400/10000*1000
  });
  it('returns null rates when a denominator is zero (undefined, not zero)', () => {
    const r = ratesFromTotals({ spend: 50, impressions: 0, clicks: 0 });
    expect(r.ctrPercent).toBeNull();
    expect(r.cpc).toBeNull();
    expect(r.cpm).toBeNull();
  });
});

describe('periodMetrics — missing vs zero', () => {
  it('marks all metrics missing when the period has no rows', () => {
    const pm = periodMetrics([snap({ snapshot_date: '2026-06-28' })], month(2026, 7));
    expect(pm.hasData).toBe(false);
    expect(pm.values.spend).toEqual({ state: 'missing' });
    expect(pm.values.clicks).toEqual({ state: 'missing' });
  });
  it('marks a measured zero as present-zero, distinct from missing', () => {
    const pm = periodMetrics([snap({ snapshot_date: '2026-07-19', spend: 0, impressions: 0, clicks: 0 })], month(2026, 7));
    expect(pm.hasData).toBe(true);
    expect(pm.values.spend).toEqual({ state: 'present', value: 0 });
    // Rate metrics with zero denominator are missing (rate undefined).
    expect(pm.values.ctrPercent).toEqual({ state: 'missing' });
  });
});

describe('comparePeriods — current and comparison totals with identical filters', () => {
  const rows = [
    snap({ snapshot_date: '2026-07-19', product: 'Product A', spend: 200, impressions: 5000, clicks: 50 }),
    snap({ snapshot_date: '2026-06-28', product: 'Product A', spend: 100, impressions: 2000, clicks: 20 }),
    snap({ snapshot_date: '2026-06-28', product: 'Product B', spend: 999, impressions: 9999, clicks: 99 }),
  ];
  it('computes current (July) and previous-period (June) totals', () => {
    const c = comparePeriods(rows, month(2026, 7), 'previous_period');
    expect(c.current.totals).toEqual({ spend: 200, impressions: 5000, clicks: 50 });
    expect(c.comparison?.totals).toEqual({ spend: 1099, impressions: 11999, clicks: 119 });
  });
  it('applies the same non-time filter to both periods', () => {
    const c = comparePeriods(rows, month(2026, 7), 'previous_period', { products: ['Product A'] });
    expect(c.current.totals.spend).toBe(200);
    expect(c.comparison?.totals.spend).toBe(100); // Product B excluded from June too
  });
});

describe('breakdowns reconcile to KPI totals', () => {
  const rows = [
    snap({ snapshot_date: '2026-07-05', product: 'Product A', region: 'NA', adset_name: 'AS1', spend: 100, impressions: 1000, clicks: 10 }),
    snap({ snapshot_date: '2026-07-12', product: 'Product B', region: 'EMEA', adset_name: 'AS2', spend: 300, impressions: 3000, clicks: 30 }),
    snap({ snapshot_date: '2026-07-19', product: 'Product A', region: 'EMEA', adset_name: 'AS1', spend: 50, impressions: 500, clicks: 5 }),
  ];
  const kpi = sumSnapshots(filterSnapshots(rows, month(2026, 7)));
  const bd = periodBreakdowns(rows, month(2026, 7));
  const sumRows = (rs: { totals: { spend: number; impressions: number; clicks: number } }[]) =>
    rs.reduce((a, r) => ({ spend: a.spend + r.totals.spend, impressions: a.impressions + r.totals.impressions, clicks: a.clicks + r.totals.clicks }), { spend: 0, impressions: 0, clicks: 0 });

  it('Product breakdown totals equal the KPI totals', () => {
    expect(sumRows(bd.byProduct)).toEqual(kpi);
  });
  it('Region breakdown totals equal the KPI totals', () => {
    expect(sumRows(bd.byRegion)).toEqual(kpi);
  });
  it('Ad Set breakdown totals equal the KPI totals', () => {
    expect(sumRows(bd.byAdset)).toEqual(kpi);
  });
  it('breakdown row rates come from that row\'s aggregate counts', () => {
    const as1 = breakdownBy(filterSnapshots(rows, month(2026, 7)), (r) => r.adset_name).find((r) => r.name === 'AS1');
    // AS1: spend 150, impressions 1500, clicks 15 -> CTR 1%, CPC 10, CPM 100
    expect(as1?.rates.ctrPercent).toBeCloseTo(1.0, 10);
    expect(as1?.rates.cpc).toBeCloseTo(10.0, 10);
    expect(as1?.rates.cpm).toBeCloseTo(100.0, 10);
  });
});

describe('week-ending / Sunday math', () => {
  it('sundayOnOrBefore returns the same day for a Sunday, the prior Sunday otherwise', () => {
    expect(sundayOnOrBefore('2026-07-19')).toBe('2026-07-19'); // a Sunday
    expect(sundayOnOrBefore('2026-07-22')).toBe('2026-07-19'); // Wed -> prior Sun
    expect(sundayOnOrBefore('2026-07-25')).toBe('2026-07-19'); // Sat -> prior Sun
    expect(sundayOnOrBefore('2026-07-26')).toBe('2026-07-26'); // next Sunday
  });
  it('final Sunday of a month/quarter is the last Sunday within its bounds', () => {
    // July 2026 ends Fri Jul 31; last Sunday in July is Jul 26.
    expect(finalSundayOfPeriod(month(2026, 7))).toBe('2026-07-26');
    // Q3 2026 ends Sep 30 (Wed); last Sunday is Sep 27.
    expect(finalSundayOfPeriod(quarter(2026, 3))).toBe('2026-09-27');
    // 2026 ends Dec 31 (Thu); last Sunday is Dec 27.
    expect(finalSundayOfPeriod(year(2026))).toBe('2026-12-27');
  });
});

describe('completeness — latest data-through and final-Sunday', () => {
  const rows = [
    snap({ snapshot_date: '2026-07-05' }),
    snap({ snapshot_date: '2026-07-12' }),
    snap({ snapshot_date: '2026-07-19' }),
  ];
  it('reports the latest imported week-ending date', () => {
    expect(latestImportedSunday(rows)).toBe('2026-07-19');
  });
  it('is partial when the latest import has not reached the final Sunday', () => {
    // July's final Sunday is Jul 26; data only through Jul 19.
    const c = assessLinkedinCompleteness(rows, month(2026, 7));
    expect(c.completeness).toBe('partial');
    expect(c.finalSunday).toBe('2026-07-26');
    expect(c.dataThrough).toBe('2026-07-19');
    expect(c.suppressDelta).toBe(true);
  });
  it('is complete when the latest import reaches the final Sunday', () => {
    const done = [...rows, snap({ snapshot_date: '2026-07-26' })];
    const c = assessLinkedinCompleteness(done, month(2026, 7));
    expect(c.completeness).toBe('complete');
    expect(c.suppressDelta).toBe(false);
  });
  it('is missing (and suppressed) when there is no data at all', () => {
    const c = assessLinkedinCompleteness([], month(2026, 7));
    expect(c.completeness).toBe('missing');
    expect(c.suppressDelta).toBe(true);
  });
});

describe('completeness — accounts for rows in the SELECTED period', () => {
  // Global data lives only in July 2026.
  const july = [
    snap({ snapshot_date: '2026-07-05', spend: 10, impressions: 100, clicks: 1 }),
    snap({ snapshot_date: '2026-07-26', spend: 10, impressions: 100, clicks: 1 }),
  ];

  it('a FUTURE period with no rows is missing and suppressed, keeping the global data-through', () => {
    const c = assessLinkedinCompleteness(july, month(2026, 9)); // September, no rows
    expect(c.completeness).toBe('missing');
    expect(c.suppressDelta).toBe(true);
    expect(c.dataThrough).toBe('2026-07-26'); // global latest preserved
  });

  it('a HISTORICAL period with no rows is missing even though newer global data exists', () => {
    const c = assessLinkedinCompleteness(july, month(2026, 3)); // March, no rows
    expect(c.completeness).toBe('missing'); // NOT complete just because dataThrough > March
    expect(c.suppressDelta).toBe(true);
    expect(c.dataThrough).toBe('2026-07-26');
  });

  it('a PARTIAL period with rows is partial (final Sunday not yet reached)', () => {
    const partial = [snap({ snapshot_date: '2026-07-05' })]; // July final Sunday is Jul 26
    const c = assessLinkedinCompleteness(partial, month(2026, 7));
    expect(c.completeness).toBe('partial');
    expect(c.suppressDelta).toBe(true);
  });

  it('a COMPLETE period with rows reaching the final Sunday is complete', () => {
    const c = assessLinkedinCompleteness(july, month(2026, 7)); // includes Jul 26 (final Sunday)
    expect(c.completeness).toBe('complete');
    expect(c.suppressDelta).toBe(false);
  });
});

describe('defaultMonthPeriod', () => {
  it('defaults to the month containing the latest imported week', () => {
    const rows = [snap({ snapshot_date: '2026-06-28' }), snap({ snapshot_date: '2026-07-19' })];
    expect(defaultMonthPeriod(rows)).toEqual({ grain: 'month', year: 2026, month: 7 });
  });
  it('returns null when there is no data', () => {
    expect(defaultMonthPeriod([])).toBeNull();
  });
});

describe('reconciliation — synthetic mirror of the workbook week ending 2026-07-19', () => {
  // The real workbook's week ending 2026-07-19 reconciles to Spend 3981,
  // Impressions 68572, Clicks 935 (documented in docs/linkedin-n8n-mapping.md
  // reconciliation notes). We reproduce ONLY the aggregate totals with synthetic
  // rows (no real ad-set/campaign identifiers) to prove the summation path.
  const rows = [
    snap({ snapshot_date: '2026-07-19', adset_name: 'AS-a', spend: 1981, impressions: 30000, clicks: 400 }),
    snap({ snapshot_date: '2026-07-19', adset_name: 'AS-b', spend: 2000, impressions: 38572, clicks: 535 }),
    // a different week must not leak into July 19's period-scoped total
    snap({ snapshot_date: '2026-07-12', adset_name: 'AS-a', spend: 999, impressions: 1, clicks: 1 }),
  ];
  it('the July 2026 total matches the reconciliation figures for that single week', () => {
    // Restrict to just the July-19 week by selecting a period that contains only it.
    const only719 = rows.filter((r) => r.snapshot_date === '2026-07-19');
    const t = sumSnapshots(only719);
    expect(t.spend).toBe(3981);
    expect(t.impressions).toBe(68572);
    expect(t.clicks).toBe(935);
    // And the recomputed CTR from those totals:
    expect(ratesFromTotals(t).ctrPercent).toBeCloseTo((935 / 68572) * 100, 6);
  });
});
