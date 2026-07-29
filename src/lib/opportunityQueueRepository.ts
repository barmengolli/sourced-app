// opportunityQueueRepository.ts: the Bite 5C2B1 data-access boundary for the
// Opportunity Queue Manager.
//
// This is an INTERFACE ONLY. The six sf_opportunity_* tables have RLS enabled
// with zero browser policies and only service_role may execute the ingestion
// function, so the browser can not and must not query them directly: no
// implementation in this repository imports the Supabase client, and none may
// until an authenticated server-side review API exists (the open Bite 5C2
// infrastructure decision). The UI consumes this interface; tests use a
// synthetic in-memory adapter (src/test/opportunityQueueMemoryAdapter.ts).
//
// Every action is single-item and returns the coupled projection + audit
// result produced by the pure domain functions in opportunityQueue.ts. A
// future server implementation must write that pair transactionally, exactly
// as sf_apply_opportunity_ingestion does for ingestion writes.

import type { OpportunityQueueItem, QueueFilters } from './opportunityQueue';
import type { ReviewEventInsert } from './opportunityImportStorage';

// The caller supplies actor identity and an explicit timestamp; repository
// implementations never read the clock themselves.
export interface QueueActionContext {
  actorId: string | null;
  occurredAt: string;
  note?: string | null;
}

export type QueueActionResult =
  | { ok: true; item: OpportunityQueueItem; audit: ReviewEventInsert }
  | { ok: false; reasons: string[] };

export interface OpportunityQueueRepository {
  // Queue-eligible items only (classifyQueueMembership), further narrowed by
  // the optional filters.
  listQueue(filters?: QueueFilters): Promise<OpportunityQueueItem[]>;
  getQueueItem(sfOpportunityId: string): Promise<OpportunityQueueItem | null>;
  // Approval requires the reviewer's explicit channel; lead is optional.
  approveReview(
    sfOpportunityId: string,
    decision: { channelId: string; leadId?: string | null },
    ctx: QueueActionContext,
  ): Promise<QueueActionResult>;
  // Optional non-sensitive note on ctx.note.
  ignoreReview(sfOpportunityId: string, ctx: QueueActionContext): Promise<QueueActionResult>;
  // ctx.note is the required blocking reason.
  blockReview(sfOpportunityId: string, ctx: QueueActionContext): Promise<QueueActionResult>;
  reopenReview(sfOpportunityId: string, ctx: QueueActionContext): Promise<QueueActionResult>;
  // Exact Salesforce Opportunity ID match only; similarity never links.
  linkExactDeal(
    sfOpportunityId: string,
    candidateSfOpportunityId: string,
    ctx: QueueActionContext,
  ): Promise<QueueActionResult>;
}
