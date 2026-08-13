// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelSpendBreakdown } from '../../lib/compute';
import { summarizeFunnelInvestment } from '../../lib/funnelExecutiveEfficiency';
import FunnelExecutiveEfficiency from './FunnelExecutiveEfficiency';

afterEach(cleanup);

function row(overrides: Partial<ChannelSpendBreakdown>): ChannelSpendBreakdown {
  return {
    channelId: 'channel',
    channelName: 'Channel',
    isParent: false,
    parentId: null,
    depth: 1,
    cost: 0,
    allocatedCost: 0,
    leads: 0,
    mqls: 0,
    firstTouchOpps: 0,
    pipelineAmount: 0,
    wonAmount: 0,
    costPerLead: null,
    costPerMql: null,
    roi: null,
    ...overrides,
  };
}

describe('FunnelExecutiveEfficiency', () => {
  it('uses the Spend page leaf-only aggregation and never double-counts rolled parents', () => {
    const summary = summarizeFunnelInvestment([
      row({ channelId: 'parent', isParent: true, allocatedCost: 1_000, leads: 100, mqls: 20, pipelineAmount: 50_000, wonAmount: 10_000 }),
      row({ channelId: 'a', parentId: 'parent', allocatedCost: 600, leads: 60, mqls: 12, pipelineAmount: 30_000, wonAmount: 6_000 }),
      row({ channelId: 'b', parentId: 'parent', allocatedCost: 400, leads: 40, mqls: 8, pipelineAmount: 20_000, wonAmount: 4_000 }),
    ]);

    expect(summary).toMatchObject({
      coveredChannelCount: 2,
      totalCost: 1_000,
      totalLeads: 100,
      totalMqls: 20,
      totalPipeline: 50_000,
      totalWon: 10_000,
      costPerLead: 10,
      costPerMql: 50,
      realizedRoi: 10,
      pipelineCoverage: 50,
    });
  });

  it('excludes channels without recorded spend from efficiency denominators and returns', () => {
    const summary = summarizeFunnelInvestment([
      row({ channelId: 'paid', allocatedCost: 1_000, leads: 100, mqls: 20, pipelineAmount: 50_000, wonAmount: 10_000 }),
      row({ channelId: 'website', allocatedCost: 0, leads: 500, mqls: 100, pipelineAmount: 500_000, wonAmount: 100_000 }),
    ]);

    expect(summary).toMatchObject({
      coveredChannelCount: 1,
      totalCost: 1_000,
      totalLeads: 100,
      totalMqls: 20,
      totalPipeline: 50_000,
      totalWon: 10_000,
      costPerLead: 10,
      costPerMql: 50,
      realizedRoi: 10,
    });
  });

  it('labels realized return separately from open pipeline and keeps unavailable cost ratios missing', () => {
    render(<FunnelExecutiveEfficiency breakdown={[row({ pipelineAmount: 25_000 })]} />);

    expect(screen.getByRole('heading', { name: 'Investment and return' })).toBeTruthy();
    expect(screen.getByText('Only channels with campaign spend recorded in Sourced are included.')).toBeTruthy();
    expect(screen.getByText('Attributed pipeline')).toBeTruthy();
    expect(screen.queryByText('$25K')).toBeNull();
    expect(screen.getByText('Recorded investment')).toBeTruthy();
    expect(screen.getByText('Realized ROI')).toBeTruthy();
    expect(screen.getAllByText('—').length).toBe(6);
    expect(screen.queryByText(/Pipeline coverage/)).toBeNull();
  });

  it('shows rolled parent-channel investment once and omits uncosted channels', () => {
    render(<FunnelExecutiveEfficiency breakdown={[
      row({
        channelId: 'content-syndication',
        channelName: '2026 - Content Syndication',
        isParent: true,
        allocatedCost: 20_000,
        leads: 200,
        mqls: 100,
        pipelineAmount: 500_000,
        wonAmount: 100_000,
        costPerLead: 100,
        costPerMql: 200,
        roi: 5,
      }),
      row({
        channelId: 'content-syndication-life',
        channelName: '2026 - Content Syndication - Life',
        parentId: 'content-syndication',
        allocatedCost: 20_000,
        leads: 200,
        mqls: 100,
      }),
      row({ channelId: 'website', channelName: '2026 - Website', allocatedCost: 0, leads: 50 }),
    ]} />);

    expect(screen.getByRole('heading', { name: 'Investment by channel' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: '2026 - Content Syndication' })).toBeTruthy();
    expect(screen.queryByRole('rowheader', { name: '2026 - Content Syndication - Life' })).toBeNull();
    expect(screen.queryByRole('rowheader', { name: '2026 - Website' })).toBeNull();
  });
});
