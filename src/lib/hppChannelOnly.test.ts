// Guards the leadless, channel-attributed HPP workflow: a High-Potential
// Prospect can be created and counted with a source channel and NO linked
// lead. The app must never fabricate or require a lead to make an HPP count.
//
// This complements funnelSankey.test.ts (which covers how a leadless deal is
// *classified* into Sales-sourced vs the neutral "No linked lead" node). Here
// we assert the *actuals* side: the HPP lands in its assigned channel's grid
// cell purely on channel evidence, with lead_id null.

import { describe, it, expect } from 'vitest';
import { computeGrid } from './compute';
import type { RegionKey } from '../constants/regions';
import { channel, attribution } from '../test/fixtures/factories';

function hppActual(
  rows: ReturnType<typeof computeGrid>['rows'],
  channelId: string,
): number | null {
  return rows.find((r) => r.channelId === channelId)?.cells.hpp.actual ?? null;
}

describe('computeGrid — leadless, channel-attributed HPP', () => {
  it('counts an HPP with a channel and no linked lead under its assigned channel', () => {
    const c = channel({ id: 'c1', name: '2026 - Website' });
    // lead_id defaults to null in the factory: this is the leadless case.
    const attrs = [
      attribution({
        deal_id: 'd1',
        lead_id: null,
        stage_key: 'hpp',
        channel_id: 'c1',
        region: 'NA',
        year: 2026,
        period_index: 1,
      }),
    ];
    const grid = computeGrid({
      leads: [],
      channels: [c],
      projections: [],
      manualActuals: [],
      attributions: attrs,
      year: 2026,
      filter: 'year',
      regions: new Set<RegionKey>(['NA']),
    });
    // The HPP is counted under c1 on channel evidence alone; no lead required.
    expect(hppActual(grid.rows, 'c1')).toBe(1);
  });

  it('does not count a leadless HPP that has no channel (channel is the required evidence)', () => {
    // Mirrors the CreateHPP guard (a source channel is required) and the
    // compute rule (rows without channel_id are skipped, line ~257). No lead is
    // invented to rescue the count.
    const c = channel({ id: 'c1', name: '2026 - Website' });
    const attrs = [
      attribution({
        deal_id: 'd1',
        lead_id: null,
        stage_key: 'hpp',
        channel_id: null,
        region: 'NA',
        year: 2026,
        period_index: 1,
      }),
    ];
    const grid = computeGrid({
      leads: [],
      channels: [c],
      projections: [],
      manualActuals: [],
      attributions: attrs,
      year: 2026,
      filter: 'year',
      regions: new Set<RegionKey>(['NA']),
    });
    expect(hppActual(grid.rows, 'c1')).toBeNull();
  });
});
