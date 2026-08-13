// opportunityQueueFixtures.ts: synthetic Opportunity Queue fixtures for
// tests. Every identifier is SYNTH-prefixed and every name is invented; no
// real Salesforce IDs, customer names, account names, or employee data may
// ever appear here.

import type { OpportunityQueueItem, QueueRecordTypeState } from '../../lib/opportunityQueue';
import type { ReviewProjection } from '../../lib/opportunityImportStorage';

let seq = 0;

// Deterministic synthetic UUID for the internal review identity
// (sf_opportunity_reviews.id). Version-4 shaped, obviously fake.
export function synthReviewUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function queueItem(over: Partial<OpportunityQueueItem> = {}): OpportunityQueueItem {
  seq += 1;
  const review: ReviewProjection | null =
    over.review === undefined
      ? { reviewState: 'pending', issueCodes: ['missing_channel'], channelId: null, leadId: null }
      : over.review;
  return {
    reviewId: review ? synthReviewUuid(seq) : null,
    opportunityName: `Synthetic Deal ${seq}`,
    accountName: `Synthetic Account ${seq}`,
    recordTypeState: 'hpp' as QueueRecordTypeState,
    stageName: '3) Qualification',
    isClosed: false,
    amount: 25000,
    amountCurrency: 'USD',
    saasRevenue: 24000,
    saasRevenueUsd: 23000,
    createdAt: '2026-02-01T09:00:00.000Z',
    lastModifiedAt: '2026-06-01T09:00:00.000Z',
    owner: 'Synthetic Owner',
    salesforceUrl: 'https://synthetic.example.test/lightning/r/Opportunity/SYNTH/view',
    evidence: {
      bdrUserId: null,
      creatorUserId: 'SYNTH-USER-CREATOR',
      suggestedBdrName: null,
      primaryCampaignSource: null,
      suggestedChannelId: null,
      suggestedChannelName: null,
      customerExpansionRaw: null,
    },
    linkedLead: null,
    linkStatus: 'none',
    diagnostics: { sfOpportunityId: `SYNTH-OPP-${seq}` },
    editable: {
      sourceMarket: 'Synthetic Market',
      sourceCommercialRegion: 'NA',
      sourceGtmCube: 'Synthetic Cube',
      marketOverride: null,
      commercialRegionOverride: null,
      gtmCubeOverride: null,
      bdrName: null,
      hppEnteredAt: '2026-02-01',
      oppEnteredAt: null,
      pursuitEnteredAt: null,
    },
    ...over,
    review,
  };
}

export const FIXED_NOW = '2026-07-28T12:00:00.000Z';

export const FIXED_CTX = { actorId: 'SYNTH-REVIEWER', occurredAt: FIXED_NOW };
