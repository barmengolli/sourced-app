// opportunityQueueMemoryAdapter.ts: TEST-ONLY in-memory implementation of
// OpportunityQueueRepository. Synthetic fixtures only; never imported by
// application code, never connected to Supabase or any network. It exists so
// the queue UI and its tests can exercise the full interface while the
// authenticated server-side review API (the live implementation) is pending.

import {
  classifyNotSelectedMembership,
  classifyQueueMembership,
  filterQueueItems,
  proposeApproval,
  proposeBlock,
  proposeExactLink,
  proposeIgnore,
  proposeReconsider,
  proposeReopen,
} from '../lib/opportunityQueue';
import type { OpportunityQueueItem, QueueFilters } from '../lib/opportunityQueue';
import type {
  OpportunityQueueRepository,
  QueueActionContext,
  QueueActionResult,
} from '../lib/opportunityQueueRepository';
import type { ReviewActionContext, ReviewMutationResult } from '../lib/opportunityImportStorage';

export interface MemoryAdapterOptions {
  // Simulate a backend failure for UI error-state tests.
  failListWith?: string;
  // Synthetic Sourced deals for exact-link tests: dealId -> the Salesforce
  // link evidence stored on that deal. The adapter compares SERVER-SIDE.
  deals?: Record<string, { sfOpportunityId: string | null }>;
  leadsByEmail?: Record<string, { id: string; email: string; firstName: string | null; lastName: string | null; account: string | null }>;
}

function toReviewCtx(ctx: QueueActionContext): ReviewActionContext {
  return {
    actorType: 'reviewer',
    actorId: ctx.actorId,
    note: ctx.note ?? null,
    occurredAt: ctx.occurredAt,
  };
}

export function createMemoryQueueRepository(
  seed: OpportunityQueueItem[],
  options: MemoryAdapterOptions = {},
): OpportunityQueueRepository & { auditLog: ReadonlyArray<unknown>; allItems: () => OpportunityQueueItem[] } {
  // Deep-ish copy so tests can reuse fixture arrays.
  const items = seed.map((item) => ({
    ...item,
    evidence: { ...item.evidence },
    review: item.review ? { ...item.review, issueCodes: [...item.review.issueCodes] } : null,
    diagnostics: { ...item.diagnostics },
  }));
  const auditLog: unknown[] = [];

  // All lookups key on the opaque internal review identity.
  const find = (reviewId: string): OpportunityQueueItem | undefined =>
    items.find((i) => i.reviewId === reviewId);

  const applyResult = (
    item: OpportunityQueueItem,
    result: ReviewMutationResult,
  ): QueueActionResult => {
    if (!result.ok) return { ok: false, reasons: result.reasons };
    // The projection mutation and its audit event land together or not at
    // all, mirroring the transactional contract the real API must honor.
    item.review = result.mutation.projection;
    auditLog.push(result.mutation.auditEvent);
    return { ok: true, item, audit: result.mutation.auditEvent };
  };

  return {
    auditLog,
    allItems: () => items,
    async listQueue(filters?: QueueFilters) {
      if (options.failListWith) throw new Error(options.failListWith);
      const eligible = items.filter((item) => classifyQueueMembership(item).inQueue);
      return filters ? filterQueueItems(eligible, filters) : eligible;
    },
    async listNotSelected(filters?: QueueFilters) {
      if (options.failListWith) throw new Error(options.failListWith);
      const eligible = items.filter((item) => classifyNotSelectedMembership(item).inQueue);
      return filters ? filterQueueItems(eligible, filters) : eligible;
    },
    async getQueueItem(reviewId: string) {
      return find(reviewId) ?? null;
    },
    async findLeadByEmail(email: string) {
      return options.leadsByEmail?.[email.trim().toLowerCase()] ?? null;
    },
    async approveReview(reviewId, decision, ctx) {
      const item = find(reviewId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeApproval(item, decision, toReviewCtx(ctx)));
    },
    async ignoreReview(reviewId, ctx) {
      const item = find(reviewId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeIgnore(item, toReviewCtx(ctx)));
    },
    async blockReview(reviewId, ctx) {
      const item = find(reviewId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeBlock(item, toReviewCtx(ctx)));
    },
    async reopenReview(reviewId, ctx) {
      const item = find(reviewId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeReopen(item, toReviewCtx(ctx)));
    },
    async reconsiderReview(reviewId, ctx) {
      const item = find(reviewId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeReconsider(item, toReviewCtx(ctx)));
    },
    async linkExactDeal(reviewId, dealId, ctx) {
      const item = find(reviewId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      // Server-side evidence resolution: the staged Salesforce Opportunity
      // ID comes from the review's item; the candidate value comes from the
      // deal registry, never from the caller.
      const deal = options.deals?.[dealId];
      if (!deal) return { ok: false, reasons: ['unknown deal'] };
      return applyResult(item, proposeExactLink(item, deal.sfOpportunityId, toReviewCtx(ctx)));
    },
  };
}
