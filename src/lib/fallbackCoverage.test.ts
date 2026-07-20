// Step 6 (M3 + M4): source-coverage before view filters, evaluated at the
// storage grain, so a filtered-to-zero or gated-to-zero source-backed cell is
// never mixed with a manual fallback, and quarterly fallback is never spread
// into invented months.
//
// Pure functions, no Supabase, no network.

import { describe, it, expect } from 'vitest';
import { computeGrid, computeMonthlyLeadsForYear } from './compute';
import type { RegionKey } from '../constants/regions';
import { channel, lead, attribution } from '../test/fixtures/factories';
import type { FunnelActual } from '../types/db';

function manualLead(over: Partial<FunnelActual>): FunnelActual {
  return {
    id: 'fa-1',
    channel_id: 'c1',
    year: 2026,
    period_index: 1,
    stage_key: 'lead',
    actual: 30,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as FunnelActual;
}

function gridLeadCell(rows: ReturnType<typeof computeGrid>['rows'], channelId: string) {
  return rows.find((r) => r.channelId === channelId)?.cells.lead.actual ?? null;
}

describe('computeGrid — M3 manual fallback vs source coverage', () => {
  it('suppresses a manual lead fallback when a real lead exists but is region-filtered to zero', () => {
    const c = channel({ id: 'c1' });
    // Real lead exists for (c1, 2026 Q1, lead) but in EMEA; the view filters NA.
    const leads = [
      lead({ source_channel_id: 'c1', region: 'EMEA cont & LATAM', marketing_sourced_date: '2026-02-01' }),
    ];
    const manual = [manualLead({ channel_id: 'c1', actual: 30 })];
    const grid = computeGrid({
      leads,
      channels: [c],
      projections: [],
      manualActuals: manual,
      attributions: [],
      year: 2026,
      filter: 'Q1',
      regions: new Set<RegionKey>(['NA']),
    });
    // The cell is source-covered (a real Q1 lead exists), so the 30 backfill
    // must NOT appear even though the region filter hides the real lead. The
    // NA-filtered real lead contributes nothing to the displayed count, and the
    // suppressed fallback leaves the cell empty (null), not 30.
    expect(gridLeadCell(grid.rows, 'c1')).toBeNull();
  });

  it('applies a manual lead fallback when there is genuinely no source record', () => {
    const c = channel({ id: 'c1' });
    const grid = computeGrid({
      leads: [],
      channels: [c],
      projections: [],
      manualActuals: [manualLead({ channel_id: 'c1', actual: 30 })],
      attributions: [],
      year: 2026,
      filter: 'Q1',
      regions: undefined,
    });
    expect(gridLeadCell(grid.rows, 'c1')).toBe(30);
  });

  it('suppresses a manual HPP fallback when a source attribution exists but is gated out by the cohort rule', () => {
    const c = channel({ id: 'c1' });
    // An Opp attribution exists for the cell, but its deal has no in-period HPP,
    // so the cohort gate removes it from the displayed count. Coverage should
    // still see the source row and suppress a manual Opp actual.
    const attrs = [
      attribution({ deal_id: 'd1', stage_key: 'opp', channel_id: 'c1', year: 2026, period_index: 1 }),
      // deal d1's HPP is in a prior year, so the Opp is gated out of Q1 2026.
      attribution({ deal_id: 'd1', stage_key: 'hpp', channel_id: 'c1', year: 2025, period_index: 4 }),
    ];
    const grid = computeGrid({
      leads: [],
      channels: [c],
      projections: [],
      manualActuals: [manualLead({ channel_id: 'c1', stage_key: 'opp', actual: 5 })],
      attributions: attrs,
      year: 2026,
      filter: 'Q1',
      regions: undefined,
    });
    const oppCell = grid.rows.find((r) => r.channelId === 'c1')?.cells.opp.actual ?? null;
    // Gated out by cohort, but source-covered, so no manual 5 layered on: the
    // cell stays empty (null) rather than showing the backfill.
    expect(oppCell).toBeNull();
  });
});

describe('computeMonthlyLeadsForYear — M4 quarterly fallback', () => {
  const c = channel({ id: 'c1' });

  it('suppresses the whole quarterly fallback when a real lead covers that quarter, and never spreads', () => {
    // One real lead in Jan (Q1). A quarterly manual actual of 30 for Q1 must be
    // fully suppressed (not spread into Feb/Mar).
    const leads = [lead({ source_channel_id: 'c1', region: 'NA', marketing_sourced_date: '2026-01-15' })];
    const result = computeMonthlyLeadsForYear({
      leads,
      channels: [c],
      year: 2026,
      regions: new Set<RegionKey>(['NA', 'EMEA cont & LATAM', 'UK&IRE, ME, Japan', 'Other']),
      manualActuals: [manualLead({ channel_id: 'c1', actual: 30 })],
    });
    // Monthly bars hold only the one real Jan lead; Feb and Mar are zero.
    const row = result.byChannel.find((r) => r.channelId === 'c1');
    expect(row?.perMonth[0]).toBe(1); // Jan
    expect(row?.perMonth[1]).toBe(0); // Feb, not backfilled
    expect(row?.perMonth[2]).toBe(0); // Mar, not backfilled
    // The quarter is covered, so no separate fallback annotation either.
    expect(result.quarterlyFallback).toHaveLength(0);
  });

  it('returns an uncovered quarterly fallback separately, not in monthly arrays', () => {
    // No real leads at all; a Q1 manual actual of 30 should surface as a
    // separate labeled fallback, and monthTotals stays all-zero.
    const result = computeMonthlyLeadsForYear({
      leads: [],
      channels: [c],
      year: 2026,
      regions: undefined as unknown as Set<RegionKey>,
      manualActuals: [manualLead({ channel_id: 'c1', actual: 30 })],
    });
    expect(result.monthTotals.every((v) => v === 0)).toBe(true);
    expect(result.quarterlyFallback).toHaveLength(1);
    expect(result.quarterlyFallback[0]).toMatchObject({ quarter: 1, value: 30 });
  });

  it('covers per-quarter: a real Q1 lead suppresses Q1 backfill but not Q3 backfill', () => {
    const leads = [lead({ source_channel_id: 'c1', region: 'NA', marketing_sourced_date: '2026-01-15' })];
    const result = computeMonthlyLeadsForYear({
      leads,
      channels: [c],
      year: 2026,
      regions: undefined as unknown as Set<RegionKey>,
      manualActuals: [
        manualLead({ id: 'fa-q1', channel_id: 'c1', period_index: 1, actual: 30 }),
        manualLead({ id: 'fa-q3', channel_id: 'c1', period_index: 3, actual: 12 }),
      ],
    });
    // Q1 covered -> suppressed; Q3 uncovered -> surfaced.
    expect(result.quarterlyFallback).toHaveLength(1);
    expect(result.quarterlyFallback[0]).toMatchObject({ quarter: 3, value: 12 });
  });
});
