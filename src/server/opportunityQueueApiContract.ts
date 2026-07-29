// opportunityQueueApiContract.ts: Bite 5C2B2A typed request/response
// contracts for the Opportunity Queue API.
//
// Framework-neutral and HTTP-neutral: handlers return {status, body} pairs
// that any approved Node.js runtime (Express, Fastify, Hono, or an internal
// platform) can adapt later. Nothing here binds to a framework, reads
// environment values, or touches a database.
//
// Endpoints (same-origin /api, session-cookie authenticated):
//   GET  /api/opportunity-reviews                 list (attention or not-selected view)
//   GET  /api/opportunity-reviews/:reviewId       single item
//   POST /api/opportunity-reviews/:reviewId/approve
//   POST /api/opportunity-reviews/:reviewId/ignore
//   POST /api/opportunity-reviews/:reviewId/block
//   POST /api/opportunity-reviews/:reviewId/reconsider
//   POST /api/opportunity-reviews/:reviewId/link-exact
//   GET  /api/health
//   GET  /api/ready
//
// :reviewId is the OPAQUE INTERNAL review identity: the UUID primary key of
// sf_opportunity_reviews.id. It is never a Salesforce Opportunity ID,
// sf_opportunity_id, opportunity name, or account name; the server resolves
// the internal review to its staged opportunity itself. There are NO bulk
// endpoints: every mutation addresses exactly one review.

import type { ReviewIssueCode, ReviewState } from '../lib/opportunityImportStorage';
import { REVIEW_STATE_LABELS } from '../lib/opportunityQueue';
import type { OpportunityQueueItem, QueueRecordTypeState } from '../lib/opportunityQueue';

// Route-parameter validation: reviewId must be UUID-shaped. Anything else
// (including a Salesforce-ID-shaped value) fails validation before any
// lookup happens.
export const REVIEW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidReviewId(reviewId: string): boolean {
  return REVIEW_ID_PATTERN.test(reviewId);
}

// ---------------------------------------------------------------------------
// Errors: sanitized and stable. Never SQL errors, tokens, database details,
// credentials, raw Salesforce payloads, or stack traces. `reasons` carries
// only domain validation sentences produced by the queue domain itself.
// ---------------------------------------------------------------------------

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'validation_failed'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'review_blocked'
  | 'internal_error';

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  validation_failed: 422,
  not_found: 404,
  version_conflict: 409,
  idempotency_conflict: 409,
  review_blocked: 409,
  internal_error: 500,
};

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    reasons?: string[];
  };
}

export type ApiResponse<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: ApiErrorBody };

export function apiError(code: ApiErrorCode, message: string, reasons?: string[]): ApiResponse<never> {
  return {
    ok: false,
    status: API_ERROR_STATUS[code],
    body: { error: { code, message, ...(reasons && reasons.length > 0 ? { reasons } : {}) } },
  };
}

// ---------------------------------------------------------------------------
// List request: view, filters, pagination
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface ListReviewsQuery {
  // 'attention' is the active queue (pending + blocked); 'not_selected' is
  // the recovery view (stored state 'ignored', shown as "Not selected").
  view?: 'attention' | 'not_selected';
  search?: string;
  reviewStatus?: ReviewState | 'all';
  recordType?: 'hpp' | 'opp' | 'pursuit' | 'unknown' | 'all';
  openClosed?: 'open' | 'closed' | 'all';
  missingChannelOnly?: boolean;
  blockingIssueOnly?: boolean;
  campaignEvidence?: 'present' | 'missing' | 'all';
  bdrEvidence?: 'present' | 'missing' | 'all';
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  pageSize?: number;
}

export interface ListReviewsResponse {
  items: QueueItemResponse[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Mutation request bodies. Every state-changing request carries a
// caller-generated idempotency key and the expected review version for
// optimistic concurrency, plus ONLY the fields that action requires. Actor
// identity is NEVER part of a body: the server takes it from the session
// principal, and unknown fields fail validation.
// ---------------------------------------------------------------------------

export interface MutationEnvelope {
  idempotencyKey: string;
  expectedVersion: string;
}

export interface ApproveReviewRequest extends MutationEnvelope {
  // The reviewer's explicit Sourced channel; never inferred from owner,
  // creator, BDR, Lead Source, Primary Campaign Source, or Customer
  // Expansion evidence.
  channelId: string;
  leadId?: string | null;
}

export interface IgnoreReviewRequest extends MutationEnvelope {
  note?: string | null;
}

export interface BlockReviewRequest extends MutationEnvelope {
  reason: string;
}

export interface ReconsiderReviewRequest extends MutationEnvelope {
  reason: string;
}

export interface LinkExactRequest extends MutationEnvelope {
  // The target Sourced deal's internal id. The client NEVER submits
  // Salesforce IDs for linking: the server loads the staged Salesforce
  // Opportunity ID through the internal review, loads the link evidence
  // stored on this deal, and permits the link only when both stored values
  // are nonblank and exactly equal. Similarity is suggestion-only and has
  // no mutation endpoint.
  dealId: string;
}

// The allowlisted body keys per action; anything else is a validation error.
export const ALLOWED_BODY_KEYS: Record<string, ReadonlySet<string>> = {
  approve_review: new Set(['idempotencyKey', 'expectedVersion', 'channelId', 'leadId']),
  ignore_review: new Set(['idempotencyKey', 'expectedVersion', 'note']),
  block_review: new Set(['idempotencyKey', 'expectedVersion', 'reason']),
  reconsider_review: new Set(['idempotencyKey', 'expectedVersion', 'reason']),
  link_exact: new Set(['idempotencyKey', 'expectedVersion', 'dealId']),
};

// ---------------------------------------------------------------------------
// Responses: explicit allowlisted fields only, never raw database rows.
// ---------------------------------------------------------------------------

// Ordinary responses expose NO Salesforce Opportunity IDs, History IDs,
// User IDs, database row internals, tokens, or credentials. Evidence is
// reduced to presence flags plus the non-identifying Customer Expansion
// label; a future administrative diagnostic contract may expose external
// IDs behind a separate capability, but it does not exist yet.
export interface QueueItemResponse {
  // The opaque internal review identity (sf_opportunity_reviews.id UUID).
  reviewId: string;
  opportunityName: string;
  accountName: string | null;
  recordType: QueueRecordTypeState;
  stageName: string | null;
  isClosed: boolean;
  amount: number | null;
  amountCurrency: string | null;
  createdAt: string | null;
  lastModifiedAt: string | null;
  owner: string | null;
  reviewState: ReviewState;
  reviewStateLabel: string;
  issueCodes: ReviewIssueCode[];
  channelId: string | null;
  leadId: string | null;
  evidence: {
    bdrEvidencePresent: boolean;
    creatorEvidencePresent: boolean;
    campaignEvidencePresent: boolean;
    customerExpansionRaw: string | null;
  };
  linkStatus: 'none' | 'active' | 'retired';
  // Optimistic-concurrency token for the next mutation on this review.
  version: string;
}

export interface MutationResponse {
  item: QueueItemResponse;
  auditEventType: string;
  // True when an identical idempotent request was replayed from the ledger.
  replayed: boolean;
}

// Explicit field-by-field mapping: adding a field to the domain item never
// silently leaks it into the API.
export function toQueueItemResponse(
  item: OpportunityQueueItem,
  version: string,
): QueueItemResponse {
  const present = (value: string | null): boolean => value !== null && value.trim() !== '';
  return {
    reviewId: item.reviewId ?? '',
    opportunityName: item.opportunityName,
    accountName: item.accountName,
    recordType: item.recordTypeState,
    stageName: item.stageName,
    isClosed: item.isClosed,
    amount: item.amount,
    amountCurrency: item.amountCurrency,
    createdAt: item.createdAt,
    lastModifiedAt: item.lastModifiedAt,
    owner: item.owner,
    reviewState: item.review?.reviewState ?? 'pending',
    reviewStateLabel: item.review ? REVIEW_STATE_LABELS[item.review.reviewState] : '',
    issueCodes: item.review ? [...item.review.issueCodes] : [],
    channelId: item.review?.channelId ?? null,
    leadId: item.review?.leadId ?? null,
    evidence: {
      bdrEvidencePresent: present(item.evidence.bdrUserId),
      creatorEvidencePresent: present(item.evidence.creatorUserId),
      campaignEvidencePresent: present(item.evidence.primaryCampaignSource),
      customerExpansionRaw: item.evidence.customerExpansionRaw,
    },
    linkStatus: item.linkStatus,
    version,
  };
}

// ---------------------------------------------------------------------------
// Health and readiness
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: 'ok';
}

export type ReadinessCheckState = 'ok' | 'failed' | 'unconfigured';

export interface ReadinessResponse {
  // 'ready' only when every check reports ok. Until real database and
  // identity-provider adapters exist, checks are 'unconfigured' and the
  // service must NOT claim readiness. No secrets, connection strings, or
  // internal host details ever appear here.
  status: 'ready' | 'not_ready';
  checks: {
    database: ReadinessCheckState;
    identityProvider: ReadinessCheckState;
    configuration: ReadinessCheckState;
  };
}
