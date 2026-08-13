// opportunityImportStorage.ts: pure storage-boundary helpers for the
// Opportunity ledger tables (Bite 5B,
// migrations/2026-07-24_opportunity_ledger_storage.sql and
// docs/opportunity-ledger-storage.md).
//
// This module validates decisions BEFORE they reach the database and shapes
// Bite 5A results into insert-ready objects. It never calls Supabase or the
// network, and it never re-implements Bite 5A movement or velocity
// calculations: opportunityStageHistory.ts remains the only path from raw
// events to derived milestones.
//
// Core rules enforced here:
//   - Review-state transitions follow one explicit state machine.
//   - Approval requires a verified channel; a lead is optional; there is no
//     default or fallback channel and Primary Campaign Source never counts.
//   - Automatic linking is allowed only on an EXACT Salesforce Opportunity
//     ID match. Name or account similarity can only ever suggest.
//   - Incoming history rows are classified as new, exact duplicate
//     (informational), or conflict (same History ID, different content);
//     a conflict can never overwrite the stored event.
//   - Insert builders preserve full timezone-carrying timestamps and never
//     emit derived milestone dates as event history.

import type {
  OpportunityStageEvent,
  OpportunityTerminalEvent,
  OpportunityDerivedState,
  OpportunityHistoryResult,
} from './opportunityStageHistory';

// ---------------------------------------------------------------------------
// Review states and issue codes (mirror the SQL CHECK constraints)
// ---------------------------------------------------------------------------

export type ReviewState =
  | 'pending'
  | 'approved'
  | 'linked'
  | 'ignored'
  | 'blocked'
  | 'resolved';

export type ReviewIssueCode =
  | 'missing_channel'
  | 'missing_region'
  | 'missing_required_field'
  | 'unknown_record_type'
  | 'unknown_stage_value'
  | 'conflicting_history_id'
  | 'ambiguous_same_timestamp'
  | 'incomplete_history'
  | 'possible_existing_deal'
  | 'invalid_source_row';

// The one review-state machine. pending is the entry state; resolved is the
// terminal audit state. ignored can be reconsidered; blocked returns to
// pending once its blocker is fixed.
export const REVIEW_STATE_TRANSITIONS: Record<ReviewState, ReviewState[]> = {
  pending: ['approved', 'linked', 'ignored', 'blocked'],
  approved: ['linked', 'resolved'],
  linked: ['resolved'],
  ignored: ['pending'],
  blocked: ['pending', 'ignored', 'resolved'],
  resolved: [],
};

export function canTransitionReviewState(from: ReviewState, to: ReviewState): boolean {
  return REVIEW_STATE_TRANSITIONS[from].includes(to);
}

// Issue codes that make an approval unsafe until the underlying record is
// fixed: the funnel state itself is not trustworthy. Other codes (missing
// channel/region/lead questions) are resolved BY the review decision.
const APPROVAL_BLOCKING_CODES: ReadonlySet<ReviewIssueCode> = new Set([
  'unknown_record_type',
  'conflicting_history_id',
  'invalid_source_row',
]);

export interface ReviewDecisionInput {
  reviewState: ReviewState;
  issueCodes: ReviewIssueCode[];
  // The reviewer's selected channel (existing channels.id UUID). Mandatory
  // for approval; there is no default.
  channelId: string | null;
  // Optional lead link (existing leads.id UUID).
  leadId?: string | null;
}

export interface ApprovalAssessment {
  ready: boolean;
  reasons: string[];
}

// A record may be approved only from pending, only with a channel selected,
// and only when no blocking data-quality issue remains. Lead is optional.
export function assessApprovalReadiness(input: ReviewDecisionInput): ApprovalAssessment {
  const reasons: string[] = [];
  if (input.reviewState !== 'pending') {
    reasons.push(`approval starts from pending, not ${input.reviewState}`);
  }
  if (!input.channelId || !input.channelId.trim()) {
    reasons.push('a verified channel selection is mandatory; there is no default channel');
  }
  for (const code of input.issueCodes) {
    if (APPROVAL_BLOCKING_CODES.has(code)) {
      reasons.push(`blocking issue must be resolved first: ${code}`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Linking safety
// ---------------------------------------------------------------------------

export interface LinkProposal {
  // The Salesforce Opportunity ID stored on the source snapshot.
  sfOpportunityId: string;
  // The external ID carried by the candidate Sourced deal, when one exists.
  candidateSfOpportunityId: string | null;
  // How the candidate was found. Only 'exact_sf_opportunity_id' may link
  // automatically; anything similarity-based is a suggestion for review.
  method: 'exact_sf_opportunity_id' | 'name_similarity' | 'account_similarity';
}

export interface LinkAssessment {
  allowed: boolean;
  // When not allowed, whether the proposal may still surface as a review
  // suggestion (possible_existing_deal) for a human decision.
  suggestionOnly: boolean;
  reason: string;
}

export function assessLinkProposal(proposal: LinkProposal): LinkAssessment {
  if (proposal.method !== 'exact_sf_opportunity_id') {
    return {
      allowed: false,
      suggestionOnly: true,
      reason: `${proposal.method} can only suggest a possible existing deal, never create a link`,
    };
  }
  const a = proposal.sfOpportunityId.trim();
  const b = (proposal.candidateSfOpportunityId ?? '').trim();
  if (!a || !b || a !== b) {
    return {
      allowed: false,
      suggestionOnly: false,
      reason: 'exact linking requires an identical, nonblank Salesforce Opportunity ID on both sides',
    };
  }
  return { allowed: true, suggestionOnly: false, reason: 'exact Salesforce Opportunity ID match' };
}

// ---------------------------------------------------------------------------
// Event classification (duplicate versus conflict)
// ---------------------------------------------------------------------------

// The content identity of a stored/incoming event row for one History ID.
export interface EventRowContent {
  sfOpportunityId: string;
  sourceField: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
}

export type IncomingEventClass = 'new' | 'exact_duplicate' | 'conflict';

// Salesforce and PostgreSQL serialize the same timestamptz instant in
// different ISO forms (for example `.000+0000` versus `+00:00`). History Ids
// are immutable, so representation-only differences must not become content
// conflicts. Invalid values stay raw so malformed timestamps still fail
// closed instead of being coerced into an invented instant.
export function canonicalEventTimestamp(value: string): string {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : value;
}

// Exact duplicates are informational (nothing can change); a same-ID row
// with different content is a conflict that must never overwrite the stored
// event; it belongs in review.
export function classifyIncomingEvent(
  stored: EventRowContent | undefined,
  incoming: EventRowContent,
): IncomingEventClass {
  if (!stored) return 'new';
  const same =
    stored.sfOpportunityId === incoming.sfOpportunityId &&
    stored.sourceField === incoming.sourceField &&
    stored.oldValue === incoming.oldValue &&
    stored.newValue === incoming.newValue &&
    canonicalEventTimestamp(stored.changedAt) === canonicalEventTimestamp(incoming.changedAt);
  return same ? 'exact_duplicate' : 'conflict';
}

// ---------------------------------------------------------------------------
// Insert builders from Bite 5A results
// ---------------------------------------------------------------------------

// Insert-ready shape for sf_opportunity_events. Note what is ABSENT: no
// derived hpp/opp/pursuit milestone dates. Milestones and velocity are
// always recomputed by Bite 5A from these raw events.
export interface EventInsert {
  sf_opportunity_id: string;
  sf_history_id: string;
  source_field: string;
  old_value: string | null;
  new_value: string | null;
  event_kind: 'record_type' | 'stage';
  from_record_type_state: string | null;
  to_record_type_state: string | null;
  from_terminal_state: string | null;
  to_terminal_state: string | null;
  // Full timestamp preserved exactly as the source supplied it (timezone
  // information intact); never truncated to a date.
  changed_at: string;
}

export function buildRecordTypeEventInsert(
  event: OpportunityStageEvent,
  sourceField: string,
): EventInsert {
  return {
    sf_opportunity_id: event.salesforceOpportunityId,
    sf_history_id: event.sourceHistoryId,
    source_field: sourceField,
    old_value: event.rawRecordType?.oldValue ?? null,
    new_value: event.rawRecordType?.newValue ?? null,
    event_kind: 'record_type',
    from_record_type_state: event.fromState,
    to_record_type_state: event.toState,
    from_terminal_state: null,
    to_terminal_state: null,
    changed_at: event.changedAt,
  };
}

export function buildTerminalEventInsert(
  event: OpportunityTerminalEvent,
  sourceField: string,
): EventInsert {
  return {
    sf_opportunity_id: event.salesforceOpportunityId,
    sf_history_id: event.sourceHistoryId,
    source_field: sourceField,
    old_value: event.rawStage.oldValue,
    new_value: event.rawStage.newValue,
    event_kind: 'stage',
    from_record_type_state: null,
    to_record_type_state: null,
    from_terminal_state: event.fromStatus,
    to_terminal_state: event.toStatus,
    changed_at: event.changedAt,
  };
}

// ---------------------------------------------------------------------------
// Review seeding from Bite 5A results
// ---------------------------------------------------------------------------

export interface ReviewSeedSnapshot {
  // Evidence only: a present Primary Campaign Source never becomes a
  // channel selection and never removes missing_channel.
  primaryCampaignSource: string | null;
  commercialRegion: string | null;
}

export interface ReviewSeed {
  sf_opportunity_id: string;
  review_state: 'pending';
  issue_codes: ReviewIssueCode[];
  channel_id: null;
  lead_id: null;
}

// ---------------------------------------------------------------------------
// Coupled projection + audit mutations
// ---------------------------------------------------------------------------
// sf_opportunity_reviews is the mutable CURRENT projection;
// sf_opportunity_review_events is the append-only audit trail. Every helper
// below returns BOTH operations as one result (or neither), so a caller
// cannot easily update the inbox without producing the audit entry. A future
// authenticated review API must write the pair transactionally.

export type ReviewActorType = 'system' | 'reviewer' | 'ingestion';

export type ReviewEventType =
  | 'review_created'
  | 'issues_updated'
  | 'state_transition'
  | 'approval_recorded'
  | 'link_recorded'
  | 'conflict_observed'
  | 'note_added'
  | 'reopened';

// The projection values a mutation reads and writes.
export interface ReviewProjection {
  reviewState: ReviewState;
  issueCodes: ReviewIssueCode[];
  channelId: string | null;
  leadId?: string | null;
}

// Insert-ready shape for sf_opportunity_review_events. Evidence is hashes
// and the History ID, never raw payloads or customer records.
export interface ReviewEventInsert {
  event_type: ReviewEventType;
  previous_state: ReviewState | null;
  new_state: ReviewState | null;
  issue_codes_snapshot: ReviewIssueCode[];
  actor_type: ReviewActorType;
  actor_id: string | null;
  note: string | null;
  sf_history_id: string | null;
  accepted_content_hash: string | null;
  conflicting_content_hash: string | null;
  dedupe_key: string | null;
  occurred_at: string;
}

export interface ReviewMutation {
  projection: ReviewProjection;
  auditEvent: ReviewEventInsert;
}

export type ReviewMutationResult =
  | { ok: true; mutation: ReviewMutation }
  | { ok: false; reasons: string[] };

export interface ReviewActionContext {
  actorType: ReviewActorType;
  actorId?: string | null;
  note?: string | null;
  // Explicit timestamp from the caller; this module never reads the clock.
  occurredAt: string;
}

function auditEvent(
  type: ReviewEventType,
  previous: ReviewState | null,
  next: ReviewState | null,
  codes: ReviewIssueCode[],
  ctx: ReviewActionContext,
  evidence: Partial<Pick<ReviewEventInsert, 'sf_history_id' | 'accepted_content_hash' | 'conflicting_content_hash' | 'dedupe_key'>> = {},
): ReviewEventInsert {
  return {
    event_type: type,
    previous_state: previous,
    new_state: next,
    issue_codes_snapshot: [...codes].sort(),
    actor_type: ctx.actorType,
    actor_id: ctx.actorId ?? null,
    note: ctx.note ?? null,
    sf_history_id: evidence.sf_history_id ?? null,
    accepted_content_hash: evidence.accepted_content_hash ?? null,
    conflicting_content_hash: evidence.conflicting_content_hash ?? null,
    dedupe_key: evidence.dedupe_key ?? null,
    occurred_at: ctx.occurredAt,
  };
}

// Creating a review produces the pending projection AND its birth event.
export function createReviewMutation(seed: ReviewSeed, ctx: ReviewActionContext): ReviewMutation {
  const projection: ReviewProjection = {
    reviewState: seed.review_state,
    issueCodes: seed.issue_codes,
    channelId: seed.channel_id,
    leadId: seed.lead_id,
  };
  return {
    projection,
    auditEvent: auditEvent('review_created', null, 'pending', seed.issue_codes, ctx),
  };
}

// A state transition produces both operations, or neither. An invalid
// transition yields nothing; an approval additionally requires the channel
// and no blocking issues BEFORE anything is produced. Reopening an ignored
// or blocked review is a normal transition back to pending: earlier events
// are never touched, so the prior decision history is retained.
export function applyReviewTransition(
  current: ReviewProjection,
  to: ReviewState,
  ctx: ReviewActionContext,
): ReviewMutationResult {
  if (!canTransitionReviewState(current.reviewState, to)) {
    return { ok: false, reasons: [`invalid transition ${current.reviewState} -> ${to}`] };
  }
  if (to === 'approved') {
    const approval = assessApprovalReadiness({
      reviewState: current.reviewState,
      issueCodes: current.issueCodes,
      channelId: current.channelId,
      leadId: current.leadId,
    });
    if (!approval.ready) return { ok: false, reasons: approval.reasons };
  }
  const reopened =
    to === 'pending' && (current.reviewState === 'ignored' || current.reviewState === 'blocked');
  const type: ReviewEventType = reopened
    ? 'reopened'
    : to === 'approved'
      ? 'approval_recorded'
      : 'state_transition';
  return {
    ok: true,
    mutation: {
      projection: { ...current, reviewState: to },
      auditEvent: auditEvent(type, current.reviewState, to, current.issueCodes, ctx),
    },
  };
}

// An exact-link decision: only a safe exact-ID proposal can move the review
// to linked, and doing so records an auditable link event carrying the
// matched Salesforce Opportunity ID as its note-free evidence.
export function applyLinkDecision(
  current: ReviewProjection,
  proposal: LinkProposal,
  ctx: ReviewActionContext,
): ReviewMutationResult {
  const safety = assessLinkProposal(proposal);
  if (!safety.allowed) return { ok: false, reasons: [safety.reason] };
  if (!canTransitionReviewState(current.reviewState, 'linked')) {
    return { ok: false, reasons: [`invalid transition ${current.reviewState} -> linked`] };
  }
  return {
    ok: true,
    mutation: {
      projection: { ...current, reviewState: 'linked' },
      auditEvent: auditEvent('link_recorded', current.reviewState, 'linked', current.issueCodes, ctx, {
        dedupe_key: `link:${proposal.sfOpportunityId.trim()}`,
      }),
    },
  };
}

// An ingestion conflict adds the conflicting_history_id code to the
// projection and records evidence as hashes plus the History ID. The
// deterministic dedupe key means the SAME conflict re-observed on every
// nightly sync produces the same key (the partial unique index ignores the
// repeat), while a DIFFERENT conflicting hash stays separately reviewable.
export function recordIngestionConflict(
  current: ReviewProjection,
  evidence: { sfHistoryId: string; acceptedContentHash: string; conflictingContentHash: string },
  ctx: ReviewActionContext,
): ReviewMutation {
  const codes = current.issueCodes.includes('conflicting_history_id')
    ? current.issueCodes
    : [...current.issueCodes, 'conflicting_history_id' as ReviewIssueCode];
  return {
    projection: { ...current, issueCodes: codes },
    auditEvent: auditEvent('conflict_observed', null, null, codes, ctx, {
      sf_history_id: evidence.sfHistoryId,
      accepted_content_hash: evidence.acceptedContentHash,
      conflicting_content_hash: evidence.conflictingContentHash,
      dedupe_key: `conflict:${evidence.sfHistoryId}:${evidence.conflictingContentHash}`,
    }),
  };
}

// Seed one pending review row for a derived Opportunity. Every imported
// record starts with missing_channel because no source field is a verified
// Sourced channel; the reviewer supplies one.
export function buildReviewSeed(
  derived: OpportunityDerivedState,
  snapshot: ReviewSeedSnapshot,
  resultReview: OpportunityHistoryResult['review'] = [],
): ReviewSeed {
  const codes = new Set<ReviewIssueCode>(['missing_channel']);
  if (!snapshot.commercialRegion || !snapshot.commercialRegion.trim()) {
    codes.add('missing_region');
  }
  for (const issue of derived.issues) {
    if (issue.kind === 'unknown_record_type') codes.add('unknown_record_type');
    if (issue.kind === 'ambiguous_same_timestamp') codes.add('ambiguous_same_timestamp');
    if (issue.kind === 'incomplete_baseline') codes.add('incomplete_history');
    if (issue.kind === 'invalid_source_row') codes.add('invalid_source_row');
  }
  for (const item of resultReview) {
    if (item.opportunityId !== derived.opportunityId) continue;
    if (item.reason === 'conflicting_duplicate_history_id') codes.add('conflicting_history_id');
    if (item.reason === 'unknown_stage_value') codes.add('unknown_stage_value');
    if (item.reason === 'invalid_source_row') codes.add('invalid_source_row');
  }
  return {
    sf_opportunity_id: derived.opportunityId,
    review_state: 'pending',
    issue_codes: [...codes].sort(),
    channel_id: null,
    lead_id: null,
  };
}
