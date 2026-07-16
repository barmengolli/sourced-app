// Step 3 (M2): parent spend ownership and roll-up.
//
// The retained-direct contract (plan Section 8):
//   retained direct cost = direct cost - distributed own direct cost
//   rolled allocated cost = retained direct cost + sum(child rolled allocated)
//
// Invariants:
//   parent rolled allocated = parent retained direct + sum(child rolled allocated)
//   sum(root rolled allocated) = sum(included prorated direct cost) exactly once
//
// These are guardrails: production has no parent-with-own-and-child-cost shape
// (see docs/diagnostics/2026-07-16.md), so no live number changes. The M2a
// fixtures construct that shape synthetically.
//
// Pure function, no Supabase, no network.

import { describe, it, expect } from 'vitest';
import { computeChannelSpend } from './compute';
import type { RegionKey } from '../constants/regions';
import { channel, campaignCost, lead } from '../test/fixtures/factories';

const ALL_REGIONS = undefined as unknown as Set<RegionKey>;
const TOL = 1e-6;

function run(over: {
  channels: ReturnType<typeof channel>[];
  campaignCosts?: ReturnType<typeof campaignCost>[];
  leads?: ReturnType<typeof lead>[];
}) {
  return computeChannelSpend({
    campaignCosts: over.campaignCosts ?? [],
    channels: over.channels,
    leads: over.leads ?? [],
    attributions: [],
    attributionTouches: [],
    year: 2026,
    filter: 'year',
    regions: ALL_REGIONS,
  });
}

function row(rows: ReturnType<typeof computeChannelSpend>, id: string) {
  const r = rows.find((x) => x.channelId === id);
  if (!r) throw new Error(`no row for ${id}`);
  return r;
}

describe('computeChannelSpend M2 — parent allocation and retained-direct roll-up', () => {
  it('parent $60k, children $0, descendant leads present: parent stays $60k, not $120k', () => {
    const p = channel({ id: 'p' });
    const a = channel({ id: 'a', parent_channel_id: 'p' });
    const b = channel({ id: 'b', parent_channel_id: 'p' });
    const rows = run({
      channels: [p, a, b],
      campaignCosts: [campaignCost({ channel_id: 'p', amount: 60000 })],
      leads: [
        lead({ source_channel_id: 'a', region: 'NA' }),
        lead({ source_channel_id: 'a', region: 'NA' }),
        lead({ source_channel_id: 'b', region: 'NA' }),
      ],
    });
    // Children split $60k by lead share (2/3, 1/3).
    expect(row(rows, 'a').allocatedCost).toBeCloseTo(40000, TOL);
    expect(row(rows, 'b').allocatedCost).toBeCloseTo(20000, TOL);
    // Parent rolled = retained direct (0, fully distributed) + children (60k).
    expect(row(rows, 'p').allocatedCost).toBeCloseTo(60000, TOL);
  });

  it('parent $60k, children $0, ZERO descendant leads: parent stays $60k, not $0', () => {
    const p = channel({ id: 'p' });
    const a = channel({ id: 'a', parent_channel_id: 'p' });
    const rows = run({
      channels: [p, a],
      campaignCosts: [campaignCost({ channel_id: 'p', amount: 60000 })],
      leads: [], // nothing to allocate to
    });
    // Nothing distributed, so the parent RETAINS its full direct cost.
    expect(row(rows, 'a').allocatedCost).toBeCloseTo(0, TOL);
    expect(row(rows, 'p').allocatedCost).toBeCloseTo(60000, TOL);
  });

  it('parent $60k AND child $10k direct (M2a): parent displays $70k', () => {
    // The shape the old code broke: parent keeps its own budget, child keeps
    // its own, no allocation happens (child already has direct cost), and the
    // roll-up ADDS rather than overwrites.
    const p = channel({ id: 'p' });
    const a = channel({ id: 'a', parent_channel_id: 'p' });
    const rows = run({
      channels: [p, a],
      campaignCosts: [
        campaignCost({ channel_id: 'p', amount: 60000 }),
        campaignCost({ channel_id: 'a', amount: 10000 }),
      ],
      leads: [lead({ source_channel_id: 'a', region: 'NA' })],
    });
    expect(row(rows, 'a').allocatedCost).toBeCloseTo(10000, TOL);
    // Parent retained $60k (nothing distributed) + child rolled $10k = $70k.
    expect(row(rows, 'p').allocatedCost).toBeCloseTo(70000, TOL);
  });

  it('multiple cost rows on one parent sum before allocation', () => {
    const p = channel({ id: 'p' });
    const a = channel({ id: 'a', parent_channel_id: 'p' });
    const rows = run({
      channels: [p, a],
      campaignCosts: [
        campaignCost({ channel_id: 'p', amount: 20000, start_date: '2026-01-01', end_date: '2026-06-30' }),
        campaignCost({ channel_id: 'p', amount: 40000, start_date: '2026-07-01', end_date: '2026-12-31' }),
      ],
      leads: [lead({ source_channel_id: 'a', region: 'NA' })],
    });
    // Both rows are fully inside the year, so direct = 60k, all to the one child.
    expect(row(rows, 'a').allocatedCost).toBeCloseTo(60000, TOL);
    expect(row(rows, 'p').allocatedCost).toBeCloseTo(60000, TOL);
  });

  it('three-level hierarchy allocates to grandchildren by lead share', () => {
    const p = channel({ id: 'p' });
    const mid = channel({ id: 'mid', parent_channel_id: 'p' });
    const g1 = channel({ id: 'g1', parent_channel_id: 'mid' });
    const g2 = channel({ id: 'g2', parent_channel_id: 'mid' });
    const rows = run({
      channels: [p, mid, g1, g2],
      campaignCosts: [campaignCost({ channel_id: 'p', amount: 100 })],
      leads: [
        lead({ source_channel_id: 'g1', region: 'NA' }),
        lead({ source_channel_id: 'g1', region: 'NA' }),
        lead({ source_channel_id: 'g1', region: 'NA' }),
        lead({ source_channel_id: 'g2', region: 'NA' }),
      ],
    });
    // $100 spreads to grandchildren 3:1.
    expect(row(rows, 'g1').allocatedCost).toBeCloseTo(75, TOL);
    expect(row(rows, 'g2').allocatedCost).toBeCloseTo(25, TOL);
    // mid retained 0 (no own cost) + grandchildren 100 = 100.
    expect(row(rows, 'mid').allocatedCost).toBeCloseTo(100, TOL);
    // root retained 0 (distributed) + mid rolled 100 = 100.
    expect(row(rows, 'p').allocatedCost).toBeCloseTo(100, TOL);
  });

  it('partial period overlap prorates the parent budget before allocation', () => {
    const p = channel({ id: 'p' });
    const a = channel({ id: 'a', parent_channel_id: 'p' });
    const rows = computeChannelSpend({
      campaignCosts: [campaignCost({ channel_id: 'p', amount: 12000, start_date: '2026-01-01', end_date: '2026-12-31' })],
      channels: [p, a],
      leads: [lead({ source_channel_id: 'a', region: 'NA', marketing_sourced_date: '2026-02-01' })],
      attributions: [],
      attributionTouches: [],
      year: 2026,
      filter: 'Q1',
      regions: ALL_REGIONS,
    });
    const prorated = 12000 * (90 / 365);
    expect(row(rows, 'a').allocatedCost).toBeCloseTo(prorated, TOL);
    expect(row(rows, 'p').allocatedCost).toBeCloseTo(prorated, TOL);
  });

  it('decimal proration: children slices sum to the prorated parent within tolerance', () => {
    const p = channel({ id: 'p' });
    const a = channel({ id: 'a', parent_channel_id: 'p' });
    const b = channel({ id: 'b', parent_channel_id: 'p' });
    const c = channel({ id: 'c', parent_channel_id: 'p' });
    const rows = run({
      channels: [p, a, b, c],
      campaignCosts: [campaignCost({ channel_id: 'p', amount: 1000 })],
      // 1/7, 2/7, 4/7 shares produce repeating decimals.
      leads: [
        lead({ source_channel_id: 'a', region: 'NA' }),
        lead({ source_channel_id: 'b', region: 'NA' }),
        lead({ source_channel_id: 'b', region: 'NA' }),
        lead({ source_channel_id: 'c', region: 'NA' }),
        lead({ source_channel_id: 'c', region: 'NA' }),
        lead({ source_channel_id: 'c', region: 'NA' }),
        lead({ source_channel_id: 'c', region: 'NA' }),
      ],
    });
    const childSum =
      row(rows, 'a').allocatedCost +
      row(rows, 'b').allocatedCost +
      row(rows, 'c').allocatedCost;
    expect(childSum).toBeCloseTo(1000, TOL);
    expect(row(rows, 'p').allocatedCost).toBeCloseTo(1000, TOL);
  });

  it('regression: production Content Syndication shape keeps $60k unchanged', () => {
    // The live shape (see docs/diagnostics/2026-07-16.md): one parent with
    // $60k, 6 children with no own cost, descendant leads present. This asserts
    // the fix does NOT change the live number: the parent still reads $60k.
    const p = channel({ id: 'cs' });
    const kids = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) =>
      channel({ id: k, parent_channel_id: 'cs' }),
    );
    const leadCounts: Record<string, number> = { a: 27, b: 55, c: 5, d: 26, e: 98, f: 66 };
    const leads = Object.entries(leadCounts).flatMap(([cid, n]) =>
      Array.from({ length: n }, () => lead({ source_channel_id: cid, region: 'NA' })),
    );
    const rows = run({
      channels: [p, ...kids],
      campaignCosts: [campaignCost({ channel_id: 'cs', amount: 60000 })],
      leads,
    });
    expect(row(rows, 'cs').allocatedCost).toBeCloseTo(60000, 4);
    const childSum = ['a', 'b', 'c', 'd', 'e', 'f'].reduce(
      (t, k) => t + row(rows, k).allocatedCost,
      0,
    );
    expect(childSum).toBeCloseTo(60000, 4);
  });

  it('root rolled allocated cost equals total included prorated direct cost exactly once', () => {
    // Two separate roots, one with a child subtree, one leaf. The sum of root
    // rolled allocated must equal the sum of all included direct cost.
    const p = channel({ id: 'p' });
    const a = channel({ id: 'a', parent_channel_id: 'p' });
    const solo = channel({ id: 'solo' });
    const rows = run({
      channels: [p, a, solo],
      campaignCosts: [
        campaignCost({ channel_id: 'p', amount: 60000 }),
        campaignCost({ channel_id: 'solo', amount: 5000 }),
      ],
      leads: [lead({ source_channel_id: 'a', region: 'NA' })],
    });
    const roots = rows.filter((r) => !r.parentId);
    const rootSum = roots.reduce((t, r) => t + r.allocatedCost, 0);
    expect(rootSum).toBeCloseTo(65000, TOL); // 60k + 5k, counted once
  });
});
