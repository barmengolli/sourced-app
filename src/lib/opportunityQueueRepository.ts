// opportunityQueueRepository.ts: the data-access boundary for the Opportunity
// Queue Manager.
//
// This is an INTERFACE ONLY. The six sf_opportunity_* tables have RLS enabled
// with zero browser policies and only service_role may execute the ingestion
// function, so the browser can not and must not query them directly: no
// browser implementation imports the Supabase client. Production uses a
// same-origin authenticated API adapter; tests use a synthetic in-memory
// adapter (src/test/opportunityQueueMemoryAdapter.ts).
//
// Every action is single-item and returns the coupled projection + audit
// result produced by the pure domain functions in opportunityQueue.ts. A
// future server implementation must write that pair transactionally, exactly
// as sf_apply_opportunity_ingestion does for ingestion writes.

import type { ApprovalDecision, OpportunityQueueItem, QueueFilters } from './opportunityQueue';
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
  // The separate "Not selected" recovery view: ignored reviews only
  // (classifyNotSelectedMembership), never mixed into the active queue.
  listNotSelected(filters?: QueueFilters): Promise<OpportunityQueueItem[]>;
  // Every method below keys on the OPAQUE INTERNAL review identity
  // (sf_opportunity_reviews.id UUID), never on a Salesforce Opportunity
  // ID, opportunity name, or account name. The implementation resolves the
  // internal review to its staged opportunity server-side.
  getQueueItem(reviewId: string): Promise<OpportunityQueueItem | null>;
  // Approval requires the reviewer's explicit channel; lead is optional.
  approveReview(
    reviewId: string,
    decision: ApprovalDecision,
    ctx: QueueActionContext,
  ): Promise<QueueActionResult>;
  // Optional non-sensitive note on ctx.note.
  ignoreReview(reviewId: string, ctx: QueueActionContext): Promise<QueueActionResult>;
  // ctx.note is the required blocking reason.
  blockReview(reviewId: string, ctx: QueueActionContext): Promise<QueueActionResult>;
  reopenReview(reviewId: string, ctx: QueueActionContext): Promise<QueueActionResult>;
  // Recovery for a not-selected (ignored) review: ignored -> pending via the
  // existing state contract with the 'reopened' audit event. ctx.note is the
  // required, non-sensitive reconsideration reason. Recovery is not
  // approval; the record re-enters the pending queue for a fresh decision.
  reconsiderReview(reviewId: string, ctx: QueueActionContext): Promise<QueueActionResult>;
  // Exact-ID linking, verified SERVER-SIDE: the caller supplies only the
  // internal reviewId and the target Sourced dealId. The implementation
  // loads the staged Salesforce Opportunity ID through the review, loads
  // the Salesforce link evidence stored on the target deal, and permits
  // the link only when both stored values are nonblank and exactly equal.
  // The client is never trusted to submit two Salesforce IDs and claim
  // they match, and names/accounts never link.
  linkExactDeal(
    reviewId: string,
    dealId: string,
    ctx: QueueActionContext,
  ): Promise<QueueActionResult>;
}
