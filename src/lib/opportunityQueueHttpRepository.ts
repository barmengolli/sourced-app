import type {
  ApprovalDecision,
  OpportunityQueueItem,
  QueueFilters,
  QueueLeadMatch,
} from './opportunityQueue';
import { filterQueueItems } from './opportunityQueue';
import type {
  OpportunityQueueRepository,
  QueueActionResult,
} from './opportunityQueueRepository';
import type { ReviewEventInsert, ReviewIssueCode, ReviewState } from './opportunityImportStorage';

interface LiveQueueRow {
  reviewId: string;
  version: string;
  opportunityName: string;
  accountName: string | null;
  recordType: OpportunityQueueItem['recordTypeState'];
  stageName: string | null;
  isClosed: boolean;
  isWon: boolean;
  closeDate: string | null;
  sourceLostReason: string | null;
  amount: number | null;
  amountCurrency: string | null;
  saasRevenue: number | null;
  saasRevenueUsd: number | null;
  createdAt: string | null;
  lastModifiedAt: string | null;
  owner: string | null;
  salesforceUrl: string | null;
  existingManualDeal: OpportunityQueueItem['existingManualDeal'];
  reviewState: ReviewState;
  issueCodes: ReviewIssueCode[];
  channelId: string | null;
  leadId: string | null;
  linkedLead: QueueLeadMatch | null;
  bdrName: string | null;
  sourceMarket: string | null;
  sourceCommercialRegion: string | null;
  sourceGtmCube: string | null;
  marketOverride: string | null;
  commercialRegionOverride: string | null;
  gtmCubeOverride: string | null;
  hppEnteredAt: string | null;
  oppEnteredAt: string | null;
  pursuitEnteredAt: string | null;
  suggestedBdrName: 'Dave Cummins' | 'Garrett McNally' | null;
  primaryCampaignSource: string | null;
  suggestedChannelId: string | null;
  suggestedChannelName: string | null;
  customerExpansionRaw: string | null;
  linkStatus: OpportunityQueueItem['linkStatus'];
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: { message?: string; reasons?: string[] };
}

const rows = new Map<string, LiveQueueRow>();

function toItem(row: LiveQueueRow): OpportunityQueueItem {
  rows.set(row.reviewId, row);
  return {
    reviewId: row.reviewId,
    opportunityName: row.opportunityName,
    accountName: row.accountName,
    recordTypeState: row.recordType,
    stageName: row.stageName,
    isClosed: row.isClosed,
    isWon: row.isWon,
    closeDate: row.closeDate,
    sourceLostReason: row.sourceLostReason,
    amount: row.amount,
    amountCurrency: row.amountCurrency,
    saasRevenue: row.saasRevenue,
    saasRevenueUsd: row.saasRevenueUsd,
    createdAt: row.createdAt,
    lastModifiedAt: row.lastModifiedAt,
    owner: row.owner,
    salesforceUrl: row.salesforceUrl,
    existingManualDeal: row.existingManualDeal ?? null,
    evidence: {
      bdrUserId: row.suggestedBdrName ? 'present' : null,
      creatorUserId: null,
      suggestedBdrName: row.suggestedBdrName,
      primaryCampaignSource: row.primaryCampaignSource,
      suggestedChannelId: row.suggestedChannelId,
      suggestedChannelName: row.suggestedChannelName,
      customerExpansionRaw: row.customerExpansionRaw,
    },
    linkedLead: row.linkedLead,
    review: {
      reviewState: row.reviewState,
      issueCodes: [...row.issueCodes],
      channelId: row.channelId,
      leadId: row.leadId,
    },
    linkStatus: row.linkStatus,
    diagnostics: { sfOpportunityId: 'available only in protected staging' },
    editable: {
      sourceMarket: row.sourceMarket,
      sourceCommercialRegion: row.sourceCommercialRegion,
      sourceGtmCube: row.sourceGtmCube,
      marketOverride: row.marketOverride,
      commercialRegionOverride: row.commercialRegionOverride,
      gtmCubeOverride: row.gtmCubeOverride,
      bdrName: row.bdrName,
      hppEnteredAt: row.hppEnteredAt,
      oppEnteredAt: row.oppEnteredAt,
      pursuitEnteredAt: row.pursuitEnteredAt,
    },
  };
}

async function request<T>(body: Record<string, unknown>, csrf?: string): Promise<T> {
  const response = await fetch('/api/opportunity-queue', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-Sourced-CSRF': csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as ApiResult<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    const reasons = payload.error?.reasons?.join('; ');
    throw new Error(reasons || payload.error?.message || 'Opportunity queue request failed');
  }
  return payload.data;
}

function audit(action: string, state: ReviewState): ReviewEventInsert {
  return {
    event_type: action === 'approve' ? 'approval_recorded' : action === 'reconsider' ? 'reopened' : 'state_transition',
    previous_state: null,
    new_state: state,
    issue_codes_snapshot: [],
    actor_type: 'reviewer',
    actor_id: null,
    note: null,
    sf_history_id: null,
    accepted_content_hash: null,
    conflicting_content_hash: null,
    dedupe_key: null,
    occurred_at: new Date().toISOString(),
  };
}

export function createOpportunityQueueHttpRepository(
  getCsrf: () => string,
): OpportunityQueueRepository {
  const list = async (view: 'attention' | 'not_selected', filters?: QueueFilters) => {
    const result = await request<{ items: LiveQueueRow[] }>({ operation: 'list', view });
    const items = result.items.map(toItem);
    return filters ? filterQueueItems(items, filters) : items;
  };

  const act = async (
    reviewId: string,
    action: string,
    decision: Record<string, unknown>,
  ): Promise<QueueActionResult> => {
    const row = rows.get(reviewId);
    if (!row) return { ok: false, reasons: ['Reload the queue and try again.'] };
    try {
      const result = await request<{ reviewState: ReviewState }>({
        operation: 'action',
        action,
        reviewId,
        expectedVersion: row.version,
        idempotencyKey: crypto.randomUUID(),
        decision,
      }, getCsrf());
      const next = toItem({ ...row, reviewState: result.reviewState });
      return { ok: true, item: next, audit: audit(action, result.reviewState) };
    } catch (error) {
      return { ok: false, reasons: [error instanceof Error ? error.message : 'Action failed'] };
    }
  };

  return {
    listQueue: (filters) => list('attention', filters),
    listNotSelected: (filters) => list('not_selected', filters),
    async getQueueItem(reviewId) {
      const row = rows.get(reviewId);
      return row ? toItem(row) : null;
    },
    async findLeadByEmail(email) {
      const result = await request<{ match: QueueLeadMatch | null }>({
        operation: 'find_lead_by_email',
        email,
      });
      return result.match;
    },
    approveReview: (reviewId, decision: ApprovalDecision) =>
      act(reviewId, 'approve', { ...decision }),
    ignoreReview: (reviewId, ctx) => act(reviewId, 'ignore', { note: ctx.note ?? null }),
    blockReview: (reviewId, ctx) => act(reviewId, 'block', { note: ctx.note ?? null }),
    reopenReview: (reviewId, ctx) => act(reviewId, 'reopen', { note: ctx.note ?? null }),
    reconsiderReview: (reviewId, ctx) => act(reviewId, 'reconsider', { note: ctx.note ?? null }),
    linkExactDeal: (reviewId, dealId) => act(reviewId, 'adopt_existing', { dealId }),
  };
}
