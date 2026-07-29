// opportunityQueue.ts: Bite 5C2B1 Opportunity Queue Manager domain logic.
//
// Pure functions only. This module decides which staged opportunities appear
// in the human review queue, how the queue is filtered, and what each review
// action produces. Every state-changing proposal returns the coupled
// projection mutation AND append-only audit event from the Bite 5B contracts
// (opportunityImportStorage); nothing here writes anywhere.
//
// Hard rules encoded below:
// - Only pending and blocked reviews require human attention.
// - Service/out_of_scope records never appear in the queue.
// - Unknown record types stay visible but are never approvable.
// - Active links never return to the approval queue; retired links are never
//   silently re-queued; ignored/resolved/approved/linked reviews never
//   silently reopen.
// - Approval requires an explicit reviewer-selected channel. No channel is
//   ever inferred from the creator, owner, BDR, Lead Source, or Primary
//   Campaign Source: those values are evidence only.
// - Linking an existing Sourced deal is allowed only on an exact matching
//   Salesforce Opportunity ID; similarity is a suggestion for a future
//   explicit decision, never a link.
// - Every function acts on ONE item. There is no bulk approval path.

import {
  applyLinkDecision,
  applyReviewTransition,
  assessApprovalReadiness,
  assessLinkProposal,
} from './opportunityImportStorage';
import type {
  ApprovalAssessment,
  LinkAssessment,
  LinkProposal,
  ReviewActionContext,
  ReviewIssueCode,
  ReviewMutationResult,
  ReviewProjection,
  ReviewState,
} from './opportunityImportStorage';

// ---------------------------------------------------------------------------
// Queue item shape
// ---------------------------------------------------------------------------

export type QueueRecordTypeState = 'hpp' | 'opp' | 'pursuit' | 'out_of_scope' | 'unknown';

// Raw source evidence shown to the reviewer. Evidence NEVER selects a
// channel, includes, excludes, or attributes a record; it only informs the
// human decision.
export interface QueueEvidence {
  bdrUserId: string | null;
  creatorUserId: string | null;
  primaryCampaignSource: string | null;
  customerExpansionRaw: string | null;
}

// Raw identifiers live behind the diagnostics disclosure only; the main
// queue surface never renders them.
export interface QueueDiagnostics {
  sfOpportunityId: string;
}

export type QueueLinkStatus = 'none' | 'active' | 'retired';

export interface OpportunityQueueItem {
  opportunityName: string;
  accountName: string | null;
  recordTypeState: QueueRecordTypeState;
  stageName: string | null;
  isClosed: boolean;
  amount: number | null;
  amountCurrency: string | null;
  createdAt: string | null;
  lastModifiedAt: string | null;
  owner: string | null;
  evidence: QueueEvidence;
  review: ReviewProjection | null;
  linkStatus: QueueLinkStatus;
  diagnostics: QueueDiagnostics;
}

// ---------------------------------------------------------------------------
// Queue membership
// ---------------------------------------------------------------------------

// The review states that require human attention. Everything else is a
// decided review and stays out of the queue.
export const QUEUE_ATTENTION_STATES: ReadonlySet<ReviewState> = new Set(['pending', 'blocked']);

// Issue codes that make a record non-approvable until the underlying data is
// fixed. Mirrors the Bite 5B approval-blocking set; kept here for display.
export const BLOCKING_ISSUE_CODES: ReadonlySet<ReviewIssueCode> = new Set([
  'unknown_record_type',
  'conflicting_history_id',
  'invalid_source_row',
]);

export type QueueMembership = { inQueue: true } | { inQueue: false; reason: string };

export function classifyQueueMembership(item: OpportunityQueueItem): QueueMembership {
  if (item.recordTypeState === 'out_of_scope') {
    // Includes Service by confirmed business rule. A linked record moving to
    // Service keeps its link and history but leaves every queue surface; if
    // it returns to hpp/opp/pursuit it resumes through its existing link
    // without a new approval (linkStatus rules below), never through here.
    return { inQueue: false, reason: 'service and out-of-scope records never enter the queue' };
  }
  if (item.linkStatus === 'active') {
    return { inQueue: false, reason: 'an existing active link never returns to the approval queue' };
  }
  if (item.linkStatus === 'retired') {
    return { inQueue: false, reason: 'a retired link is never silently re-queued' };
  }
  if (!item.review) {
    return { inQueue: false, reason: 'no review record requires attention' };
  }
  if (!QUEUE_ATTENTION_STATES.has(item.review.reviewState)) {
    return { inQueue: false, reason: `a ${item.review.reviewState} review does not silently reopen` };
  }
  return { inQueue: true };
}

// Whether the approve action can even be offered. The authoritative gate is
// assessApprovalReadiness at proposal time; this is the display-level guard.
export function isApprovable(item: OpportunityQueueItem): boolean {
  if (!item.review || item.review.reviewState !== 'pending') return false;
  if (item.recordTypeState === 'unknown' || item.recordTypeState === 'out_of_scope') return false;
  return !item.review.issueCodes.some((code) => BLOCKING_ISSUE_CODES.has(code));
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface QueueFilters {
  // Case-insensitive substring match on opportunity or account name.
  search?: string;
  reviewStatus?: ReviewState | 'all';
  recordType?: Exclude<QueueRecordTypeState, 'out_of_scope'> | 'all';
  openClosed?: 'open' | 'closed' | 'all';
  missingChannelOnly?: boolean;
  blockingIssueOnly?: boolean;
  campaignEvidence?: 'present' | 'missing' | 'all';
  bdrEvidence?: 'present' | 'missing' | 'all';
}

const present = (value: string | null): boolean => value !== null && value.trim() !== '';

export function filterQueueItems(
  items: OpportunityQueueItem[],
  filters: QueueFilters,
): OpportunityQueueItem[] {
  const search = (filters.search ?? '').trim().toLowerCase();
  return items.filter((item) => {
    if (search) {
      const haystack = `${item.opportunityName} ${item.accountName ?? ''}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (filters.reviewStatus && filters.reviewStatus !== 'all') {
      if (!item.review || item.review.reviewState !== filters.reviewStatus) return false;
    }
    if (filters.recordType && filters.recordType !== 'all') {
      if (item.recordTypeState !== filters.recordType) return false;
    }
    if (filters.openClosed && filters.openClosed !== 'all') {
      if (item.isClosed !== (filters.openClosed === 'closed')) return false;
    }
    if (filters.missingChannelOnly) {
      if (!item.review || !item.review.issueCodes.includes('missing_channel')) return false;
    }
    if (filters.blockingIssueOnly) {
      if (!item.review || !item.review.issueCodes.some((c) => BLOCKING_ISSUE_CODES.has(c))) {
        return false;
      }
    }
    if (filters.campaignEvidence && filters.campaignEvidence !== 'all') {
      if (present(item.evidence.primaryCampaignSource) !== (filters.campaignEvidence === 'present')) {
        return false;
      }
    }
    if (filters.bdrEvidence && filters.bdrEvidence !== 'all') {
      if (present(item.evidence.bdrUserId) !== (filters.bdrEvidence === 'present')) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Review action proposals (single item, coupled projection + audit)
// ---------------------------------------------------------------------------

export interface ApprovalDecision {
  // The reviewer's explicit Sourced channel selection. This is the ONLY way
  // a channel reaches an approval; no evidence field ever becomes one.
  channelId: string;
  // Optional lead association; approval never requires a lead.
  leadId?: string | null;
}

function requireReview(item: OpportunityQueueItem): ReviewMutationResult | ReviewProjection {
  if (!item.review) return { ok: false, reasons: ['no review record exists for this opportunity'] };
  return item.review;
}

export function proposeApproval(
  item: OpportunityQueueItem,
  decision: ApprovalDecision,
  ctx: ReviewActionContext,
): ReviewMutationResult {
  const review = requireReview(item);
  if ('ok' in review) return review;
  if (item.recordTypeState === 'out_of_scope') {
    return { ok: false, reasons: ['service and out-of-scope records are never approvable'] };
  }
  if (item.recordTypeState === 'unknown') {
    return { ok: false, reasons: ['an unknown record type must be resolved before approval'] };
  }
  const channelId = decision.channelId?.trim() || null;
  const projection: ReviewProjection = {
    ...review,
    channelId,
    leadId: decision.leadId ?? review.leadId ?? null,
  };
  return applyReviewTransition(projection, 'approved', ctx);
}

// Ignore takes an optional non-sensitive note (carried on ctx.note).
export function proposeIgnore(
  item: OpportunityQueueItem,
  ctx: ReviewActionContext,
): ReviewMutationResult {
  const review = requireReview(item);
  if ('ok' in review) return review;
  return applyReviewTransition(review, 'ignored', ctx);
}

// Block requires a reason: a blocked review with no recorded cause cannot be
// actioned later.
export function proposeBlock(
  item: OpportunityQueueItem,
  ctx: ReviewActionContext,
): ReviewMutationResult {
  const review = requireReview(item);
  if ('ok' in review) return review;
  if (!ctx.note || !ctx.note.trim()) {
    return { ok: false, reasons: ['blocking a review requires a reason'] };
  }
  return applyReviewTransition(review, 'blocked', ctx);
}

// Reopen follows the existing review-state contract: only ignored and
// blocked reviews may return to pending, and the transition itself produces
// the 'reopened' audit event. Earlier decision history is never touched.
export function proposeReopen(
  item: OpportunityQueueItem,
  ctx: ReviewActionContext,
): ReviewMutationResult {
  const review = requireReview(item);
  if ('ok' in review) return review;
  return applyReviewTransition(review, 'pending', ctx);
}

// Exact-ID linking only. The proposal is re-assessed here even though the
// repository boundary also validates: similarity methods can never link.
export function proposeExactLink(
  item: OpportunityQueueItem,
  candidateSfOpportunityId: string | null,
  ctx: ReviewActionContext,
): ReviewMutationResult {
  const review = requireReview(item);
  if ('ok' in review) return review;
  const proposal: LinkProposal = {
    sfOpportunityId: item.diagnostics.sfOpportunityId,
    candidateSfOpportunityId,
    method: 'exact_sf_opportunity_id',
  };
  return applyLinkDecision(review, proposal, ctx);
}

// Similarity is display-only: the assessment always comes back
// suggestionOnly and the caller may render it as a hint that requires a
// future explicit decision. It can never produce a mutation.
export function assessSimilaritySuggestion(
  item: OpportunityQueueItem,
  candidateSfOpportunityId: string | null,
  method: 'name_similarity' | 'account_similarity',
): LinkAssessment {
  return assessLinkProposal({
    sfOpportunityId: item.diagnostics.sfOpportunityId,
    candidateSfOpportunityId,
    method,
  });
}

// Display-level readiness for the approval form (validation messages).
export function assessQueueApproval(
  item: OpportunityQueueItem,
  decision: ApprovalDecision,
): ApprovalAssessment {
  if (!item.review) return { ready: false, reasons: ['no review record exists for this opportunity'] };
  return assessApprovalReadiness({
    reviewState: item.review.reviewState,
    issueCodes: item.review.issueCodes,
    channelId: decision.channelId?.trim() || null,
    leadId: decision.leadId ?? null,
  });
}
