import { describe, expect, it } from 'vitest';
import type { Attribution, AttributionStageKey, Channel } from '../types/db';
import { computeStageVelocityStats } from './compute';
import {
  buildOpportunityDistributions,
  buildOpportunityExplorerRows,
  filterOpportunityExplorerRows,
  scopeOpportunityDeals,
  summarizeOpenPipeline,
} from './opportunityPageReporting';

const TODAY = '2026-08-17';

function attribution(input: {
  id: string;
  dealId: string;
  stage: AttributionStageKey;
  enteredAt: string;
  channelId?: string;
  region?: Attribution['region'];
  amount?: number;
  label?: string;
}): Attribution {
  const year = Number(input.enteredAt.slice(0, 4));
  const month = Number(input.enteredAt.slice(5, 7));
  return {
    id: input.id,
    source_system: 'salesforce',
    sf_opportunity_id: `sf-${input.dealId}`,
    lead_id: null,
    deal_id: input.dealId,
    stage_key: input.stage,
    channel_id: input.channelId ?? 'channel-child',
    year,
    period_index: (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4,
    label: input.label ?? input.dealId,
    account: `Account ${input.dealId}`,
    amount: input.amount ?? 100,
    sf_link: `https://example.test/${input.dealId}`,
    region: input.region ?? 'NA',
    stage_entered_at: input.enteredAt,
    created_at: `${input.enteredAt}T00:00:00Z`,
    updated_at: `${input.enteredAt}T00:00:00Z`,
  };
}

const channels: Channel[] = [
  {
    id: 'channel-root',
    name: '2026 - Website',
    parent_channel_id: null,
    year: 2026,
    display_order: 1,
    hidden: false,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'channel-child',
    name: '2026 - Book a Call',
    parent_channel_id: 'channel-root',
    year: 2026,
    display_order: 2,
    hidden: false,
    created_at: '2026-01-01T00:00:00Z',
  },
];

describe('opportunity page reporting contract', () => {
  it('keeps every open opportunity in current pipeline while movement remains period-scoped', () => {
    const rows = [
      attribution({ id: 'old-hpp', dealId: 'old-open', stage: 'hpp', enteredAt: '2025-04-01' }),
      attribution({ id: 'moved-hpp', dealId: 'moved', stage: 'hpp', enteredAt: '2026-06-20' }),
      attribution({ id: 'moved-opp', dealId: 'moved', stage: 'opp', enteredAt: '2026-07-05' }),
      attribution({ id: 'won-hpp', dealId: 'won', stage: 'hpp', enteredAt: '2026-01-01' }),
      attribution({ id: 'won-row', dealId: 'won', stage: 'closeWon', enteredAt: '2026-07-10' }),
    ];

    const current = scopeOpportunityDeals({
      attributions: rows,
      regions: new Set(),
      status: 'open',
      today: TODAY,
    });
    const q3Movement = scopeOpportunityDeals({
      attributions: rows,
      regions: new Set(),
      period: { year: 2026, filter: 'Q3' },
      today: TODAY,
    });

    expect(current.map((deal) => deal.dealId).sort()).toEqual(['moved', 'old-open']);
    expect(q3Movement.map((deal) => deal.dealId).sort()).toEqual(['moved', 'won']);
  });

  it('makes terminal opportunities reachable through explicit Won, Lost, and All states', () => {
    const rows = [
      attribution({ id: 'open', dealId: 'open', stage: 'hpp', enteredAt: '2026-01-01' }),
      attribution({ id: 'won', dealId: 'won', stage: 'closeWon', enteredAt: '2026-02-01' }),
      attribution({ id: 'lost', dealId: 'lost', stage: 'closeLost', enteredAt: '2026-03-01' }),
    ];
    expect(scopeOpportunityDeals({ attributions: rows, regions: new Set(), status: 'open', today: TODAY })).toHaveLength(1);
    expect(scopeOpportunityDeals({ attributions: rows, regions: new Set(), status: 'won', today: TODAY })[0]?.dealId).toBe('won');
    expect(scopeOpportunityDeals({ attributions: rows, regions: new Set(), status: 'lost', today: TODAY })[0]?.dealId).toBe('lost');
    expect(scopeOpportunityDeals({ attributions: rows, regions: new Set(), status: 'all', today: TODAY })).toHaveLength(3);
  });

  it('summarizes distinct open deals without multiplying stage rows', () => {
    const rows = [
      attribution({ id: 'a-hpp', dealId: 'a', stage: 'hpp', enteredAt: '2026-01-01', amount: 500 }),
      attribution({ id: 'a-opp', dealId: 'a', stage: 'opp', enteredAt: '2026-02-01', amount: 500 }),
      attribution({ id: 'b-hpp', dealId: 'b', stage: 'hpp', enteredAt: '2026-03-01', amount: 250 }),
    ];
    const deals = scopeOpportunityDeals({ attributions: rows, regions: new Set(), today: TODAY });

    expect(summarizeOpenPipeline(deals)).toEqual({
      openDeals: 2,
      totalAmount: 750,
      byStage: { hpp: 1, opp: 1, pursuit: 0 },
    });
  });

  it('builds both charts from the exact same scoped deal set and rolls child channels up', () => {
    const rows = [
      attribution({ id: 'a', dealId: 'a', stage: 'hpp', enteredAt: '2026-01-01', amount: 500, region: 'NA' }),
      attribution({ id: 'b', dealId: 'b', stage: 'hpp', enteredAt: '2026-01-02', amount: 250, region: 'EMEA cont & LATAM' }),
      attribution({ id: 'excluded', dealId: 'excluded', stage: 'hpp', enteredAt: '2026-01-03', amount: 999, region: 'Other' }),
    ];
    const scoped = scopeOpportunityDeals({ attributions: rows.slice(0, 2), regions: new Set(), today: TODAY });
    const result = buildOpportunityDistributions({ deals: scoped, attributions: rows, channels });

    expect(result.regionDistribution.totalDeals).toBe(2);
    expect(result.regionDistribution.totalAmount).toBe(750);
    expect(result.regionDistribution.regions.map((row) => row.region).sort()).toEqual([
      'EMEA cont & LATAM',
      'NA',
    ]);
    expect(result.channelDistribution.totalDeals).toBe(2);
    expect(result.channelDistribution.channels).toEqual([
      expect.objectContaining({
        channelId: 'channel-root',
        channelName: '2026 - Website',
        dealCount: 2,
        totalAmount: 750,
      }),
    ]);
    expect(
      result.regionDistribution.regions.reduce(
        (sum, row) => sum + row.percentageOfCount,
        0,
      ),
    ).toBe(100);
    expect(
      result.channelDistribution.channels.reduce(
        (sum, row) => sum + row.percentageOfCount,
        0,
      ),
    ).toBe(100);
  });

  it('builds a read-only journey index with the same top-level channel rollup', () => {
    const rows = [
      attribution({ id: 'a', dealId: 'a', stage: 'hpp', enteredAt: '2026-01-01', label: 'Alpha' }),
      attribution({ id: 'b', dealId: 'b', stage: 'hpp', enteredAt: '2026-03-01', label: 'Beta' }),
      attribution({ id: 'b-won', dealId: 'b', stage: 'closeWon', enteredAt: '2026-05-01', label: 'Beta' }),
      attribution({ id: 'c', dealId: 'c', stage: 'closeLost', enteredAt: '2026-04-01', label: 'Gamma' }),
    ];
    const deals = scopeOpportunityDeals({ attributions: rows, regions: new Set(), today: TODAY });
    const explorerRows = buildOpportunityExplorerRows({ deals, attributions: rows, channels });

    expect(explorerRows.map((row) => row.deal.dealId)).toEqual(['b', 'c', 'a']);
    expect(explorerRows.every((row) => row.channelId === 'channel-root')).toBe(true);
    expect(explorerRows.every((row) => row.channelName === '2026 - Website')).toBe(true);
  });

  it('keeps every opportunity reachable through journey status, search, and channel filters', () => {
    const rows = [
      attribution({ id: 'open', dealId: 'open', stage: 'hpp', enteredAt: '2026-01-01', label: 'Northstar' }),
      attribution({ id: 'won', dealId: 'won', stage: 'closeWon', enteredAt: '2026-02-01', label: 'Beacon' }),
      attribution({ id: 'lost', dealId: 'lost', stage: 'closeLost', enteredAt: '2026-03-01', label: 'Compass' }),
    ];
    const deals = scopeOpportunityDeals({ attributions: rows, regions: new Set(), today: TODAY });
    const explorerRows = buildOpportunityExplorerRows({ deals, attributions: rows, channels });

    expect(filterOpportunityExplorerRows({ rows: explorerRows, status: 'all' })).toHaveLength(3);
    expect(filterOpportunityExplorerRows({ rows: explorerRows, status: 'open' })[0]?.deal.dealId).toBe('open');
    expect(filterOpportunityExplorerRows({ rows: explorerRows, status: 'won' })[0]?.deal.dealId).toBe('won');
    expect(filterOpportunityExplorerRows({ rows: explorerRows, status: 'lost' })[0]?.deal.dealId).toBe('lost');
    expect(filterOpportunityExplorerRows({ rows: explorerRows, status: 'all', search: 'account won' })[0]?.deal.dealId).toBe('won');
    expect(filterOpportunityExplorerRows({ rows: explorerRows, status: 'all', channelId: 'missing-channel' })).toEqual([]);
  });

  it('anchors velocity to the destination period and excludes contradictory dates', () => {
    const rows = [
      attribution({ id: 'valid-hpp', dealId: 'valid', stage: 'hpp', enteredAt: '2026-06-01' }),
      attribution({ id: 'valid-opp', dealId: 'valid', stage: 'opp', enteredAt: '2026-07-01' }),
      attribution({ id: 'valid-pursuit', dealId: 'valid', stage: 'pursuit', enteredAt: '2026-07-10' }),
      attribution({ id: 'invalid-hpp', dealId: 'invalid', stage: 'hpp', enteredAt: '2026-08-10' }),
      attribution({ id: 'invalid-opp', dealId: 'invalid', stage: 'opp', enteredAt: '2026-08-01' }),
    ];
    const deals = scopeOpportunityDeals({ attributions: rows, regions: new Set(), today: TODAY });
    const q3 = computeStageVelocityStats(deals, { year: 2026, filter: 'Q3' });
    const q2 = computeStageVelocityStats(deals, { year: 2026, filter: 'Q2' });

    expect(q3.find((stat) => stat.transitionKey === 'hpp->opp')).toEqual({
      transitionKey: 'hpp->opp',
      average: 30,
      median: 30,
      count: 1,
      invalidCount: 1,
    });
    expect(q3.find((stat) => stat.transitionKey === 'opp->pursuit')).toEqual({
      transitionKey: 'opp->pursuit',
      average: 9,
      median: 9,
      count: 1,
      invalidCount: 0,
    });
    expect(q2.find((stat) => stat.transitionKey === 'hpp->opp')).toEqual({
      transitionKey: 'hpp->opp',
      average: null,
      median: null,
      count: 0,
      invalidCount: 0,
    });
  });
});
