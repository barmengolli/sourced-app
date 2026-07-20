// Step 2 tests: pin the ALREADY-CORRECT spend behavior that later steps must
// not regress. This suite deliberately does NOT assert the M2 parent roll-up
// (that shape is fixed in Step 3); it covers the M1 exclusion policy, day-based
// proration, region/period filtering, and a plain leaf channel.
//
// Pure function, no Supabase, no network.

import { describe, it, expect } from 'vitest';
import { computeChannelSpend } from './compute';
import type { RegionKey } from '../constants/regions';
import { channel, campaignCost, lead } from '../test/fixtures/factories';

const ALL_REGIONS = undefined as unknown as Set<RegionKey>; // undefined = no region filter

function rowFor(rows: ReturnType<typeof computeChannelSpend>, channelId: string) {
  return rows.find((r) => r.channelId === channelId);
}

describe('computeChannelSpend — M1 exclusion policy (approved behavior)', () => {
  it('excludes cost attached to a channel outside the selected-year channel set', () => {
    // The caller passes only the 2026 channel; the cost points at a channel id
    // that is NOT in the array (e.g. filtered out by year). Its money must not
    // appear anywhere, and no synthetic "unassigned" row may be created.
    const c2026 = channel({ id: 'c-2026', year: 2026 });
    const costOnMissingChannel = campaignCost({
      channel_id: 'c-2025-not-in-array',
      amount: 9999,
    });

    const rows = computeChannelSpend({
      campaignCosts: [costOnMissingChannel],
      channels: [c2026],
      leads: [],
      attributions: [],
      attributionTouches: [],
      year: 2026,
      filter: 'year',
      regions: ALL_REGIONS,
    });

    // Exactly one row (the one channel), and it carries no cost.
    expect(rows).toHaveLength(1);
    expect(rowFor(rows, 'c-2026')?.cost).toBe(0);
    // No row references the missing channel, and no total absorbs the $9999.
    expect(rows.some((r) => r.channelId === 'c-2025-not-in-array')).toBe(false);
    const totalCost = rows.reduce((t, r) => t + r.cost, 0);
    expect(totalCost).toBe(0);
  });
});

describe('computeChannelSpend — day-based proration', () => {
  it('prorates a cost by inclusive-day overlap with the selected period', () => {
    // A full-year $12,000 budget viewed in Q1 (Jan 1 - Mar 31, 90 days of 365)
    // prorates to 12000 * 90/365.
    const c = channel({ id: 'c1', year: 2026 });
    const cost = campaignCost({
      channel_id: 'c1',
      amount: 12000,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    });

    const rows = computeChannelSpend({
      campaignCosts: [cost],
      channels: [c],
      leads: [],
      attributions: [],
      attributionTouches: [],
      year: 2026,
      filter: 'Q1',
      regions: ALL_REGIONS,
    });

    const q1Days = 31 + 28 + 31; // 90 (2026 is not a leap year)
    const yearDays = 365;
    expect(rowFor(rows, 'c1')?.cost).toBeCloseTo(12000 * (q1Days / yearDays), 6);
  });

  it('keeps the full amount when the budget lies entirely inside the period', () => {
    const c = channel({ id: 'c1', year: 2026 });
    const cost = campaignCost({
      channel_id: 'c1',
      amount: 5000,
      start_date: '2026-02-01',
      end_date: '2026-02-28',
    });
    const rows = computeChannelSpend({
      campaignCosts: [cost],
      channels: [c],
      leads: [],
      attributions: [],
      attributionTouches: [],
      year: 2026,
      filter: 'Q1',
      regions: ALL_REGIONS,
    });
    // Feb is fully within Q1, so the whole $5000 is retained.
    expect(rowFor(rows, 'c1')?.cost).toBeCloseTo(5000, 6);
  });

  it('drops a cost whose date range does not overlap the period at all', () => {
    const c = channel({ id: 'c1', year: 2026 });
    const cost = campaignCost({
      channel_id: 'c1',
      amount: 5000,
      start_date: '2026-07-01',
      end_date: '2026-07-31',
    });
    const rows = computeChannelSpend({
      campaignCosts: [cost],
      channels: [c],
      leads: [],
      attributions: [],
      attributionTouches: [],
      year: 2026,
      filter: 'Q1', // July does not overlap Q1
      regions: ALL_REGIONS,
    });
    expect(rowFor(rows, 'c1')?.cost).toBe(0);
  });
});

describe('computeChannelSpend — leaf channel counts and CPL', () => {
  it('counts region+period leads and derives CPL from the channel own cost', () => {
    const c = channel({ id: 'c1', year: 2026 });
    const cost = campaignCost({ channel_id: 'c1', amount: 1000 });
    // 2 in-period NA leads, 1 out-of-period lead (ignored), 1 wrong-region lead.
    const leads = [
      lead({ source_channel_id: 'c1', region: 'NA', marketing_sourced_date: '2026-02-01' }),
      lead({ source_channel_id: 'c1', region: 'NA', marketing_sourced_date: '2026-03-01' }),
      lead({ source_channel_id: 'c1', region: 'NA', marketing_sourced_date: '2025-12-01' }),
    ];

    const rows = computeChannelSpend({
      campaignCosts: [cost],
      channels: [c],
      leads,
      attributions: [],
      attributionTouches: [],
      year: 2026,
      filter: 'year',
      regions: ALL_REGIONS,
    });

    const row = rowFor(rows, 'c1');
    expect(row?.leads).toBe(2); // only the two 2026 leads
    // Leaf channel with its own cost: allocatedCost == directCost, CPL = 1000/2.
    expect(row?.allocatedCost).toBeCloseTo(1000, 6);
    expect(row?.costPerLead).toBeCloseTo(500, 6);
  });

  it('applies the region filter to lead counts', () => {
    const c = channel({ id: 'c1', year: 2026 });
    const leads = [
      lead({ source_channel_id: 'c1', region: 'NA', marketing_sourced_date: '2026-02-01' }),
      lead({ source_channel_id: 'c1', region: 'EMEA cont & LATAM', marketing_sourced_date: '2026-02-01' }),
    ];
    const rows = computeChannelSpend({
      campaignCosts: [],
      channels: [c],
      leads,
      attributions: [],
      attributionTouches: [],
      year: 2026,
      filter: 'year',
      regions: new Set<RegionKey>(['NA']),
    });
    expect(rowFor(rows, 'c1')?.leads).toBe(1); // only the NA lead
  });
});
