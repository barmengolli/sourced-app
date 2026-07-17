// Step 8 (M5): Sankey source semantics and deal-stage conservation.
//
// Units: Channel/Lead/MQL edges are unique PEOPLE; HPP and later are DEALS. The
// suite asserts conservation ONLY within the deal subgraph (HPP+), never across
// the person-to-deal boundary.
//
// Pure function, no Supabase, no network.

import { describe, it, expect } from 'vitest';
import { computeFunnelSankey } from './compute';
import type { RegionKey } from '../constants/regions';
import { channel, lead, attribution, stageHistory } from '../test/fixtures/factories';

const ALL: Set<RegionKey> | undefined = undefined;

function edgesOf(
  result: ReturnType<typeof computeFunnelSankey>,
) {
  // Collapse channel color into one value per (source,target).
  const m = new Map<string, number>();
  for (const e of result.edges) {
    const k = `${e.source}->${e.target}`;
    m.set(k, (m.get(k) ?? 0) + e.value);
  }
  return m;
}

// Sum of edges into a node minus edges out; for a deal-subgraph node this must
// be 0 once open/terminal sinks are materialized.
function nodeIn(edges: Map<string, number>, node: string): number {
  let sum = 0;
  for (const [k, v] of edges) if (k.endsWith(`->${node}`)) sum += v;
  return sum;
}
function nodeOut(edges: Map<string, number>, node: string): number {
  let sum = 0;
  for (const [k, v] of edges) if (k.startsWith(`${node}->`)) sum += v;
  return sum;
}

describe('computeFunnelSankey — source semantics (M5)', () => {
  it('a recorded-MQL lead with one deal flows channel->lead->mql->hpp', () => {
    const c = channel({ id: 'c1' });
    const l = lead({
      id: 'L1',
      source_channel_id: 'c1',
      region: 'NA',
      marketing_sourced_date: '2026-02-01',
      current_stage: 'mql',
      stage_history: [stageHistory('mql', '2026-02-10')],
    });
    const attrs = [
      attribution({ deal_id: 'd1', lead_id: 'L1', stage_key: 'hpp', channel_id: 'c1', year: 2026, period_index: 1 }),
    ];
    const e = edgesOf(computeFunnelSankey({ leads: [l], attributions: attrs, channels: [c], year: 2026, filter: 'year', regions: ALL }));
    expect(e.get('channel:c1->stage:lead')).toBe(1);
    expect(e.get('stage:lead->stage:mql')).toBe(1);
    expect(e.get('stage:mql->stage:hpp')).toBe(1);
    // No "no recorded MQL" ingress for this lead.
    expect(e.get('stage:no-mql->stage:hpp')).toBeUndefined();
  });

  it('an MQL-less lead with a deal enters via "No recorded MQL", NOT mql->hpp', () => {
    const c = channel({ id: 'c1' });
    const l = lead({
      id: 'L1',
      source_channel_id: 'c1',
      region: 'NA',
      marketing_sourced_date: '2026-02-01',
      current_stage: 'lead',
      stage_history: [], // no MQL history
    });
    const attrs = [
      attribution({ deal_id: 'd1', lead_id: 'L1', stage_key: 'hpp', channel_id: 'c1', year: 2026, period_index: 1 }),
    ];
    const e = edgesOf(computeFunnelSankey({ leads: [l], attributions: attrs, channels: [c], year: 2026, filter: 'year', regions: ALL }));
    // The M5a fix: no MQL -> HPP edge for a lead without MQL history.
    expect(e.get('stage:mql->stage:hpp')).toBeUndefined();
    expect(e.get('stage:lead->stage:mql')).toBeUndefined();
    expect(e.get('stage:no-mql->stage:hpp')).toBe(1);
  });

  it('a leadless deal on the Sales Generated channel enters via "Sales-sourced"', () => {
    // A null lead_id alone is NOT enough; the channel must PROVE Sales origin.
    const sales = channel({ id: 'sales', name: '2026 - Sales Generated' });
    const attrs = [
      attribution({ deal_id: 'd1', lead_id: null, stage_key: 'hpp', channel_id: 'sales', year: 2026, period_index: 1 }),
    ];
    const e = edgesOf(computeFunnelSankey({ leads: [], attributions: attrs, channels: [sales], year: 2026, filter: 'year', regions: ALL }));
    expect(e.get('source:sales->stage:hpp')).toBe(1);
    expect(e.get('source:no-lead->stage:hpp')).toBeUndefined();
    expect(e.get('stage:mql->stage:hpp')).toBeUndefined();
  });

  it('a leadless deal on a NON-Sales channel enters via neutral "No linked lead", NOT Sales-sourced', () => {
    // The bug this audit fixes: a null lead_id on a Marketing channel (Website,
    // Events, Content Syndication, Marketing SDR) must not claim Sales origin.
    for (const name of ['2026 - Website', '2026 - Events', '2026 - Marketing SDR', '2026 - Content Syndication']) {
      const c = channel({ id: 'c1', name });
      const attrs = [
        attribution({ deal_id: 'd1', lead_id: null, stage_key: 'hpp', channel_id: 'c1', year: 2026, period_index: 1 }),
      ];
      const e = edgesOf(computeFunnelSankey({ leads: [], attributions: attrs, channels: [c], year: 2026, filter: 'year', regions: ALL }));
      expect(e.get('source:no-lead->stage:hpp')).toBe(1);
      expect(e.get('source:sales->stage:hpp')).toBeUndefined();
    }
  });

  it('a leadless deal with no channel enters via neutral "No linked lead"', () => {
    // No channel -> no proof of Sales origin -> neutral.
    const c = channel({ id: 'c1' });
    const attrs = [
      attribution({ deal_id: 'd1', lead_id: null, stage_key: 'hpp', channel_id: null, year: 2026, period_index: 1 }),
    ];
    const e = edgesOf(computeFunnelSankey({ leads: [], attributions: attrs, channels: [c], year: 2026, filter: 'year', regions: ALL }));
    // A null channel_id is filtered out before ingress, so no deal edge at all,
    // and crucially it is never labelled Sales-sourced.
    expect(e.get('source:sales->stage:hpp')).toBeUndefined();
  });

  it('one lead sourcing two deals enters HPP twice but counts the person once at MQL', () => {
    const c = channel({ id: 'c1' });
    const l = lead({
      id: 'L1', source_channel_id: 'c1', region: 'NA', marketing_sourced_date: '2026-02-01',
      current_stage: 'mql', stage_history: [stageHistory('mql', '2026-02-10')],
    });
    const attrs = [
      attribution({ deal_id: 'd1', lead_id: 'L1', stage_key: 'hpp', channel_id: 'c1', year: 2026, period_index: 1 }),
      attribution({ deal_id: 'd2', lead_id: 'L1', stage_key: 'hpp', channel_id: 'c1', year: 2026, period_index: 1 }),
    ];
    const e = edgesOf(computeFunnelSankey({ leads: [l], attributions: attrs, channels: [c], year: 2026, filter: 'year', regions: ALL }));
    // Person counted once upstream...
    expect(e.get('channel:c1->stage:lead')).toBe(1);
    expect(e.get('stage:lead->stage:mql')).toBe(1);
    // ...but both deals enter HPP (deal count = 2).
    expect(e.get('stage:mql->stage:hpp')).toBe(2);
  });
});

describe('computeFunnelSankey — deal-stage conservation via sinks', () => {
  function dealAt(stageChain: ('hpp' | 'opp' | 'pursuit' | 'closeWon' | 'closeLost')[]) {
    const c = channel({ id: 'c1' });
    const attrs = stageChain.map((s) =>
      attribution({ deal_id: 'd1', lead_id: null, stage_key: s, channel_id: 'c1', year: 2026, period_index: 1 }),
    );
    return edgesOf(computeFunnelSankey({ leads: [], attributions: attrs, channels: [c], year: 2026, filter: 'year', regions: ALL }));
  }

  it('open at HPP: hpp inflow == open sink', () => {
    const e = dealAt(['hpp']);
    expect(e.get('stage:hpp->open:hpp')).toBe(1);
    expect(nodeIn(e, 'stage:hpp')).toBe(nodeOut(e, 'stage:hpp'));
  });

  it('open at Opp: conserves at hpp and opp', () => {
    const e = dealAt(['hpp', 'opp']);
    expect(e.get('stage:hpp->stage:opp')).toBe(1);
    expect(e.get('stage:opp->open:opp')).toBe(1);
    expect(nodeIn(e, 'stage:opp')).toBe(nodeOut(e, 'stage:opp'));
  });

  it('open at Pursuit', () => {
    const e = dealAt(['hpp', 'opp', 'pursuit']);
    expect(e.get('stage:pursuit->open:pursuit')).toBe(1);
    expect(nodeIn(e, 'stage:pursuit')).toBe(nodeOut(e, 'stage:pursuit'));
  });

  it('won: pursuit -> Won terminal', () => {
    const e = dealAt(['hpp', 'opp', 'pursuit', 'closeWon']);
    expect(e.get('stage:pursuit->terminal:closeWon')).toBe(1);
    expect(nodeOut(e, 'stage:pursuit')).toBe(1);
  });

  it('lost from opp: opp -> Lost terminal, no open sink', () => {
    const e = dealAt(['hpp', 'opp', 'closeLost']);
    expect(e.get('stage:opp->terminal:closeLost')).toBe(1);
    expect(e.get('stage:opp->open:opp')).toBeUndefined();
    expect(nodeIn(e, 'stage:opp')).toBe(nodeOut(e, 'stage:opp'));
  });

  it('every deal-stage node conserves flow across a mixed population', () => {
    const c = channel({ id: 'c1' });
    const mk = (deal: string, chain: ('hpp' | 'opp' | 'pursuit' | 'closeWon' | 'closeLost')[]) =>
      chain.map((s) => attribution({ deal_id: deal, lead_id: null, stage_key: s, channel_id: 'c1', year: 2026, period_index: 1 }));
    const attrs = [
      ...mk('d1', ['hpp']),
      ...mk('d2', ['hpp', 'opp']),
      ...mk('d3', ['hpp', 'opp', 'pursuit', 'closeWon']),
      ...mk('d4', ['hpp', 'opp', 'closeLost']),
    ];
    const e = edgesOf(computeFunnelSankey({ leads: [], attributions: attrs, channels: [c], year: 2026, filter: 'year', regions: ALL }));
    for (const node of ['stage:hpp', 'stage:opp', 'stage:pursuit']) {
      expect(nodeIn(e, node)).toBe(nodeOut(e, node));
    }
    // 4 leadless deals on a NON-Sales channel entered via the neutral node, not
    // Sales-sourced.
    expect(e.get('source:no-lead->stage:hpp')).toBe(4);
    expect(e.get('source:sales->stage:hpp')).toBeUndefined();
  });
});
