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

  const find = (sfOpportunityId: string): OpportunityQueueItem | undefined =>
    items.find((i) => i.diagnostics.sfOpportunityId === sfOpportunityId);

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
    async getQueueItem(sfOpportunityId: string) {
      return find(sfOpportunityId) ?? null;
    },
    async approveReview(sfOpportunityId, decision, ctx) {
      const item = find(sfOpportunityId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeApproval(item, decision, toReviewCtx(ctx)));
    },
    async ignoreReview(sfOpportunityId, ctx) {
      const item = find(sfOpportunityId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeIgnore(item, toReviewCtx(ctx)));
    },
    async blockReview(sfOpportunityId, ctx) {
      const item = find(sfOpportunityId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeBlock(item, toReviewCtx(ctx)));
    },
    async reopenReview(sfOpportunityId, ctx) {
      const item = find(sfOpportunityId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeReopen(item, toReviewCtx(ctx)));
    },
    async reconsiderReview(sfOpportunityId, ctx) {
      const item = find(sfOpportunityId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeReconsider(item, toReviewCtx(ctx)));
    },
    async linkExactDeal(sfOpportunityId, candidateSfOpportunityId, ctx) {
      const item = find(sfOpportunityId);
      if (!item) return { ok: false, reasons: ['unknown opportunity'] };
      return applyResult(item, proposeExactLink(item, candidateSfOpportunityId, toReviewCtx(ctx)));
    },
  };
}
