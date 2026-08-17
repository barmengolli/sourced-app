import type { RegionKey } from '../constants/regions';
import type { Attribution, AttributionStageKey, Channel } from '../types/db';
import {
  NO_CHANNEL_KEY,
  computeDealVelocities,
  dealMatchesPeriod,
  type ChannelDistribution,
  type DealVelocity,
  type PeriodFilter,
  type RegionDistribution,
} from './compute';

export type OpportunityStatusFilter = 'open' | 'won' | 'lost' | 'all';

export interface OpportunityPipelineSummary {
  openDeals: number;
  totalAmount: number;
  byStage: Record<'hpp' | 'opp' | 'pursuit', number>;
}

function rowsByDeal(attributions: Attribution[]): Map<string, Attribution[]> {
  const grouped = new Map<string, Attribution[]>();
  for (const row of attributions) {
    if (!row.deal_id) continue;
    const rows = grouped.get(row.deal_id) ?? [];
    rows.push(row);
    grouped.set(row.deal_id, rows);
  }
  return grouped;
}

export function opportunityMatchesStatus(
  deal: DealVelocity,
  status: OpportunityStatusFilter,
): boolean {
  if (status === 'all') return true;
  if (status === 'open') return !deal.isTerminal;
  if (status === 'won') return deal.currentStage === 'closeWon';
  return deal.currentStage === 'closeLost';
}

export function scopeOpportunityDeals(input: {
  attributions: Attribution[];
  regions: Set<RegionKey>;
  status?: OpportunityStatusFilter;
  period?: { year: number; filter: PeriodFilter };
  today?: string;
}): DealVelocity[] {
  const {
    attributions,
    regions,
    status = 'all',
    period,
    today,
  } = input;
  const grouped = rowsByDeal(attributions);
  return computeDealVelocities({ attributions, regions, today }).filter(
    (deal) => {
      if (!opportunityMatchesStatus(deal, status)) return false;
      if (!period) return true;
      const rows = grouped.get(deal.dealId) ?? [];
      return dealMatchesPeriod(rows, period.year, period.filter);
    },
  );
}

export function summarizeOpenPipeline(
  deals: DealVelocity[],
): OpportunityPipelineSummary {
  const open = deals.filter((deal) => !deal.isTerminal);
  const byStage = { hpp: 0, opp: 0, pursuit: 0 };
  let totalAmount = 0;
  for (const deal of open) {
    if (
      deal.currentStage === 'hpp' ||
      deal.currentStage === 'opp' ||
      deal.currentStage === 'pursuit'
    ) {
      byStage[deal.currentStage] += 1;
    }
    totalAmount += deal.amount ?? 0;
  }
  return { openDeals: open.length, totalAmount, byStage };
}

function primaryRow(rows: Attribution[]): Attribution | null {
  const priority: AttributionStageKey[] = [
    'hpp',
    'opp',
    'pursuit',
    'closeWon',
    'closeLost',
  ];
  for (const stage of priority) {
    const row = rows.find((candidate) => candidate.stage_key === stage);
    if (row) return row;
  }
  return null;
}

function rootChannelId(
  channelId: string,
  channelById: Map<string, Channel>,
): string {
  let current = channelId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const channel = channelById.get(current);
    if (!channel || !channel.parent_channel_id) return current;
    current = channel.parent_channel_id;
  }
  return channelId;
}

export function buildOpportunityDistributions(input: {
  deals: DealVelocity[];
  attributions: Attribution[];
  channels: Channel[];
}): {
  regionDistribution: RegionDistribution;
  channelDistribution: ChannelDistribution;
} {
  const { deals, attributions, channels } = input;
  const dealIds = new Set(deals.map((deal) => deal.dealId));
  const grouped = rowsByDeal(attributions);
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const dealById = new Map(deals.map((deal) => [deal.dealId, deal]));

  const regionTally = new Map<RegionKey, { count: number; amount: number }>();
  const channelTally = new Map<
    string,
    { count: number; amount: number; name: string }
  >();

  for (const dealId of dealIds) {
    const deal = dealById.get(dealId);
    if (!deal) continue;
    const amount = deal.amount ?? 0;
    const region = deal.region ?? 'Other';
    const regionEntry = regionTally.get(region) ?? { count: 0, amount: 0 };
    regionEntry.count += 1;
    regionEntry.amount += amount;
    regionTally.set(region, regionEntry);

    const first = primaryRow(grouped.get(dealId) ?? []);
    const bucketId = first?.channel_id
      ? rootChannelId(first.channel_id, channelById)
      : NO_CHANNEL_KEY;
    const name =
      bucketId === NO_CHANNEL_KEY
        ? 'No channel'
        : channelById.get(bucketId)?.name ?? 'Unknown';
    const channelEntry = channelTally.get(bucketId) ?? {
      count: 0,
      amount: 0,
      name,
    };
    channelEntry.count += 1;
    channelEntry.amount += amount;
    channelTally.set(bucketId, channelEntry);
  }

  const totalDeals = deals.length;
  const totalAmount = deals.reduce((sum, deal) => sum + (deal.amount ?? 0), 0);
  const regionDistribution: RegionDistribution = {
    totalDeals,
    totalAmount,
    regions: [...regionTally.entries()]
      .map(([region, value]) => ({
        region,
        dealCount: value.count,
        totalAmount: value.amount,
        percentageOfCount:
          totalDeals === 0 ? 0 : (value.count / totalDeals) * 100,
      }))
      .sort((a, b) => b.dealCount - a.dealCount),
  };
  const channelDistribution: ChannelDistribution = {
    totalDeals,
    totalAmount,
    channels: [...channelTally.entries()]
      .map(([channelId, value]) => ({
        channelId,
        channelName: value.name,
        displayLabel: value.name,
        dealCount: value.count,
        totalAmount: value.amount,
        percentageOfCount:
          totalDeals === 0 ? 0 : (value.count / totalDeals) * 100,
      }))
      .sort((a, b) => b.dealCount - a.dealCount),
  };

  return { regionDistribution, channelDistribution };
}
