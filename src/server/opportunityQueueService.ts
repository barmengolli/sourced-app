// opportunityQueueService.ts: Bite 5C2B2A framework-neutral service layer
// for the Opportunity Queue API.
//
// Pure TypeScript controllers: accept an authenticated principal and
// validated request input, check capability authorization, call the
// existing OpportunityQueueRepository boundary (which enforces every queue
// domain rule), and return typed, sanitized {status, body} results any
// approved Node.js runtime can adapt. No web framework, no React, no
// browser APIs, no environment reads, no database connection.
//
// Mutation safeguards enforced here:
// - Actor identity comes only from the session principal; bodies carrying
//   actor/reviewer/permission fields fail validation (strict allowlists).
// - Every mutation requires a caller-generated idempotency key and the
//   expected review version. Stale versions conflict; identical retries
//   replay the original result; same key with a different payload is an
//   idempotency conflict.
// - Domain validation runs for every principal, including admins: channel
//   requirements, blocking issues, Service exclusion, the review-state
//   machine, exact-ID-only linking, and the reconsider reason all come from
//   the queue domain and are never bypassed.
// - There are no bulk operations: every function addresses one review.

import { authorizeAction } from './opportunityQueueAuth';
import type { QueueApiAction, QueuePrincipal } from './opportunityQueueAuth';
import {
  ALLOWED_BODY_KEYS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  apiError,
  isValidReviewId,
  toQueueItemResponse,
} from './opportunityQueueApiContract';
import type {
  ApiResponse,
  ApproveReviewRequest,
  BlockReviewRequest,
  HealthResponse,
  IgnoreReviewRequest,
  LinkExactRequest,
  ListReviewsQuery,
  ListReviewsResponse,
  MutationEnvelope,
  MutationResponse,
  QueueItemResponse,
  ReadinessCheckState,
  ReadinessResponse,
  ReconsiderReviewRequest,
} from './opportunityQueueApiContract';
import { computeReviewVersion } from './opportunityQueueServerRepository';
import type { IdempotencyStore } from './opportunityQueueServerRepository';
import { sha256Hex } from '../lib/sha256';
import type { QueueFilters } from '../lib/opportunityQueue';
import type {
  OpportunityQueueRepository,
  QueueActionContext,
  QueueActionResult,
} from '../lib/opportunityQueueRepository';

export interface OpportunityQueueServiceDeps {
  repository: OpportunityQueueRepository;
  idempotency: IdempotencyStore;
  // Injected clock: the service never reads the system clock implicitly in
  // tests; hosts supply a real clock at deployment.
  now: () => string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function unauthorized(decision: { reason: 'unauthenticated' | 'forbidden' }): ApiResponse<never> {
  return decision.reason === 'unauthenticated'
    ? apiError('unauthenticated', 'authentication is required')
    : apiError('forbidden', 'this action requires a capability your account does not have');
}

function validateBodyKeys(
  action: QueueApiAction,
  body: Record<string, unknown>,
): string[] {
  const allowed = ALLOWED_BODY_KEYS[action];
  if (!allowed) return [];
  const problems: string[] = [];
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      // Actor identity, groups, or any unexpected field: never accepted
      // from a request body.
      problems.push(`unexpected field: ${key}`);
    }
  }
  return problems;
}

function validateEnvelope(body: MutationEnvelope): string[] {
  const problems: string[] = [];
  if (!body.idempotencyKey || !String(body.idempotencyKey).trim()) {
    problems.push('idempotencyKey is required');
  }
  if (!body.expectedVersion || !String(body.expectedVersion).trim()) {
    problems.push('expectedVersion is required');
  }
  return problems;
}

function requestHash(action: QueueApiAction, reviewId: string, body: Record<string, unknown>): string {
  const canonical = JSON.stringify([action, reviewId, Object.keys(body).sort().map((k) => [k, body[k]])]);
  return sha256Hex(canonical);
}

// The idempotency identity is NAMESPACED over the complete scope: the
// authenticated principal's subject, the action, the internal reviewId, and
// the caller-provided key. Display names never participate. Two principals
// can safely use the same caller key; one principal can reuse a key across
// reviews or actions; and no principal can ever receive another principal's
// stored response. The future persistent store must enforce a UNIQUE
// constraint over this complete namespace. Blank components are invalid.
function idempotencyScope(
  subject: string,
  action: QueueApiAction,
  reviewId: string,
  idempotencyKey: string,
): string | null {
  if (!subject.trim() || !action.trim() || !reviewId.trim() || !idempotencyKey.trim()) {
    return null;
  }
  return JSON.stringify([subject, action, reviewId, idempotencyKey]);
}

function actionContext(principal: QueuePrincipal, deps: OpportunityQueueServiceDeps, note?: string | null): QueueActionContext {
  return {
    // The ONLY source of actor identity is the authenticated principal.
    actorId: principal.subject,
    occurredAt: deps.now(),
    note: note ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listReviews(
  deps: OpportunityQueueServiceDeps,
  principal: QueuePrincipal | null,
  query: ListReviewsQuery = {},
): Promise<ApiResponse<ListReviewsResponse>> {
  const decision = authorizeAction(principal, 'list_reviews');
  if (!decision.allowed) return unauthorized(decision);

  const page = Math.max(1, Math.floor(query.page ?? 1));
  const requestedSize = Math.floor(query.pageSize ?? DEFAULT_PAGE_SIZE);
  if (requestedSize > MAX_PAGE_SIZE) {
    return apiError('validation_failed', 'request validation failed', [
      `pageSize must not exceed ${MAX_PAGE_SIZE}`,
    ]);
  }
  const pageSize = Math.max(1, requestedSize);

  const filters: QueueFilters = {
    search: query.search,
    reviewStatus: query.reviewStatus,
    recordType: query.recordType,
    openClosed: query.openClosed,
    missingChannelOnly: query.missingChannelOnly,
    blockingIssueOnly: query.blockingIssueOnly,
    campaignEvidence: query.campaignEvidence,
    bdrEvidence: query.bdrEvidence,
    createdFrom: query.createdFrom,
    createdTo: query.createdTo,
  };

  try {
    const items =
      query.view === 'not_selected'
        ? await deps.repository.listNotSelected(filters)
        : await deps.repository.listQueue(filters);
    const totalItems = items.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    return {
      ok: true,
      status: 200,
      body: {
        items: pageItems.map((item) => toQueueItemResponse(item, computeReviewVersion(item))),
        page,
        pageSize,
        totalItems,
        totalPages,
      },
    };
  } catch {
    // Sanitized: no driver errors, connection details, or stack traces.
    return apiError('internal_error', 'the queue could not be loaded');
  }
}

export async function getReview(
  deps: OpportunityQueueServiceDeps,
  principal: QueuePrincipal | null,
  reviewId: string,
): Promise<ApiResponse<QueueItemResponse>> {
  const decision = authorizeAction(principal, 'get_review');
  if (!decision.allowed) return unauthorized(decision);
  if (!isValidReviewId(reviewId)) {
    return apiError('validation_failed', 'request validation failed', [
      'reviewId must be an internal review UUID',
    ]);
  }
  try {
    const item = await deps.repository.getQueueItem(reviewId);
    if (!item) return apiError('not_found', 'no review exists for this id');
    return { ok: true, status: 200, body: toQueueItemResponse(item, computeReviewVersion(item)) };
  } catch {
    return apiError('internal_error', 'the review could not be loaded');
  }
}

// ---------------------------------------------------------------------------
// Mutations: one shared safeguard pipeline, one review at a time.
// ---------------------------------------------------------------------------

async function runMutation<T extends MutationEnvelope>(
  deps: OpportunityQueueServiceDeps,
  principal: QueuePrincipal | null,
  action: QueueApiAction,
  reviewId: string,
  body: T,
  extraValidation: () => string[],
  execute: (ctx: QueueActionContext) => Promise<QueueActionResult>,
): Promise<ApiResponse<MutationResponse>> {
  const decision = authorizeAction(principal, action);
  if (!decision.allowed) return unauthorized(decision);
  const authedPrincipal = principal!;
  const record = body as unknown as Record<string, unknown>;

  const problems = [
    ...(isValidReviewId(reviewId) ? [] : ['reviewId must be an internal review UUID']),
    ...validateBodyKeys(action, record),
    ...validateEnvelope(body),
    ...extraValidation(),
  ];
  if (problems.length > 0) {
    return apiError('validation_failed', 'request validation failed', problems);
  }

  // Idempotency, scoped to (subject, action, reviewId, caller key). An
  // identical retry replays the stored result BEFORE any version check, so
  // a completed request stays replayable even after the review advanced;
  // the same scope with a different payload is a conflict.
  const scope = idempotencyScope(authedPrincipal.subject, action, reviewId, body.idempotencyKey);
  if (scope === null) {
    return apiError('validation_failed', 'request validation failed', [
      'idempotency scope components must be nonblank',
    ]);
  }
  const hash = requestHash(action, reviewId, record);
  const existing = await deps.idempotency.get(scope);
  if (existing) {
    if (existing.requestHash === hash) {
      const replay = existing.result as MutationResponse;
      return { ok: true, status: 200, body: { ...replay, replayed: true } };
    }
    return apiError(
      'idempotency_conflict',
      'this idempotency key was already used with a different request',
    );
  }

  let current;
  try {
    current = await deps.repository.getQueueItem(reviewId);
  } catch {
    return apiError('internal_error', 'the review could not be loaded');
  }
  if (!current) return apiError('not_found', 'no review exists for this id');

  // Optimistic concurrency: the caller must have seen the current version.
  // The comparison target is ALWAYS the authoritative server-loaded review
  // projection; the client can submit an expectation but can never declare
  // what the current version is.
  const currentVersion = computeReviewVersion(current);
  if (body.expectedVersion !== currentVersion) {
    return apiError('version_conflict', 'the review changed since it was loaded; reload and retry');
  }

  let result: QueueActionResult;
  try {
    result = await execute(actionContext(authedPrincipal, deps));
  } catch {
    return apiError('internal_error', 'the action could not be completed');
  }
  if (!result.ok) {
    // Domain refusals are sanitized validation output. Acting on a blocked
    // review (other than reconsider/reopen paths the domain allows) gets
    // its dedicated stable code.
    const blocked =
      current.review?.reviewState === 'blocked' &&
      (action === 'approve_review' || action === 'ignore_review' || action === 'link_exact');
    if (blocked) {
      return apiError('review_blocked', 'this review is blocked and must be reopened first', result.reasons);
    }
    return apiError('validation_failed', 'the action was refused by the review rules', result.reasons);
  }

  const responseBody: MutationResponse = {
    item: toQueueItemResponse(result.item, computeReviewVersion(result.item)),
    auditEventType: result.audit.event_type,
    replayed: false,
  };
  await deps.idempotency.put(scope, { requestHash: hash, result: responseBody });
  return { ok: true, status: 200, body: responseBody };
}

export async function approveReview(
  deps: OpportunityQueueServiceDeps,
  principal: QueuePrincipal | null,
  reviewId: string,
  body: ApproveReviewRequest,
): Promise<ApiResponse<MutationResponse>> {
  return runMutation(
    deps,
    principal,
    'approve_review',
    reviewId,
    body,
    () => (!body.channelId || !String(body.channelId).trim() ? ['channelId is required'] : []),
    (ctx) =>
      deps.repository.approveReview(
        reviewId,
        { channelId: body.channelId, leadId: body.leadId ?? null },
        ctx,
      ),
  );
}

export async function ignoreReview(
  deps: OpportunityQueueServiceDeps,
  principal: QueuePrincipal | null,
  reviewId: string,
  body: IgnoreReviewRequest,
): Promise<ApiResponse<MutationResponse>> {
  return runMutation(
    deps,
    principal,
    'ignore_review',
    reviewId,
    body,
    () => [],
    (ctx) => deps.repository.ignoreReview(reviewId, { ...ctx, note: body.note ?? null }),
  );
}

export async function blockReview(
  deps: OpportunityQueueServiceDeps,
  principal: QueuePrincipal | null,
  reviewId: string,
  body: BlockReviewRequest,
): Promise<ApiResponse<MutationResponse>> {
  return runMutation(
    deps,
    principal,
    'block_review',
    reviewId,
    body,
    () => (!body.reason || !body.reason.trim() ? ['reason is required'] : []),
    (ctx) => deps.repository.blockReview(reviewId, { ...ctx, note: body.reason }),
  );
}

export async function reconsiderReview(
  deps: OpportunityQueueServiceDeps,
  principal: QueuePrincipal | null,
  reviewId: string,
  body: ReconsiderReviewRequest,
): Promise<ApiResponse<MutationResponse>> {
  return runMutation(
    deps,
    principal,
    'reconsider_review',
    reviewId,
    body,
    () => (!body.reason || !body.reason.trim() ? ['reason is required'] : []),
    (ctx) => deps.repository.reconsiderReview(reviewId, { ...ctx, note: body.reason }),
  );
}

export async function linkExactReview(
  deps: OpportunityQueueServiceDeps,
  principal: QueuePrincipal | null,
  reviewId: string,
  body: LinkExactRequest,
): Promise<ApiResponse<MutationResponse>> {
  // The body carries only the target Sourced dealId. The repository loads
  // the staged Salesforce Opportunity ID through the internal review and
  // the link evidence stored on the deal, and compares them SERVER-SIDE;
  // the client is never trusted to claim two Salesforce IDs match.
  return runMutation(
    deps,
    principal,
    'link_exact',
    reviewId,
    body,
    () => (!body.dealId || !body.dealId.trim() ? ['dealId is required'] : []),
    (ctx) => deps.repository.linkExactDeal(reviewId, body.dealId, ctx),
  );
}

// ---------------------------------------------------------------------------
// Health and readiness (no secrets, no connection details)
// ---------------------------------------------------------------------------

export function health(): ApiResponse<HealthResponse> {
  return { ok: true, status: 200, body: { status: 'ok' } };
}

export interface ReadinessAdapters {
  database?: () => Promise<boolean>;
  identityProvider?: () => Promise<boolean>;
  configuration?: () => boolean;
}

// Readiness never claims 'ready' while any adapter is missing: until the
// live database and PingOne configuration exist, checks are 'unconfigured'.
export async function ready(adapters: ReadinessAdapters = {}): Promise<ApiResponse<ReadinessResponse>> {
  const check = async (probe?: () => Promise<boolean> | boolean): Promise<ReadinessCheckState> => {
    if (!probe) return 'unconfigured';
    try {
      return (await probe()) ? 'ok' : 'failed';
    } catch {
      return 'failed';
    }
  };
  const checks = {
    database: await check(adapters.database),
    identityProvider: await check(adapters.identityProvider),
    configuration: await check(adapters.configuration),
  };
  const readyNow = Object.values(checks).every((state) => state === 'ok');
  return {
    ok: true,
    status: readyNow ? 200 : 503,
    body: { status: readyNow ? 'ready' : 'not_ready', checks },
  };
}
