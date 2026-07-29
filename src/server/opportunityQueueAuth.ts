// opportunityQueueAuth.ts: Bite 5C2B2A server-only principal and
// capability-based authorization for the Opportunity Queue API.
//
// Framework-neutral pure TypeScript: no web framework, no React, no browser
// APIs, no Supabase, no environment reads. IT hosts the eventual runtime on
// its approved internal Node.js platform; these functions are the portable
// authorization core it adapts.
//
// Identity rules (non-negotiable):
// - The actor identity comes EXCLUSIVELY from the authenticated server
//   session. Request bodies never carry actor_id, reviewer identity, groups,
//   or permissions; the service layer ignores and rejects such fields.
// - The intended future pattern is PingOne OIDC Authorization Code flow with
//   a backend-managed session delivered as a Secure/HttpOnly/SameSite
//   cookie, and same-origin /api routes. Authentication tokens are never
//   stored in browser localStorage or sessionStorage.
// - There is no production authentication bypass. A missing principal is
//   always unauthenticated; nothing defaults to allowed.
// - Test principals live under src/test/ only, never in server code.

// The minimum server-side identity. Groups from the identity provider are
// mapped to capabilities BEFORE a principal is constructed; server logic
// never hardcodes PingOne/AD group names. IT supplies the group-to-
// capability mapping at deployment time (see docs/opportunity-queue-api.md).
export interface QueuePrincipal {
  // Stable identity-provider user id (OIDC `sub`). Used as the audit actor.
  subject: string;
  capabilities: ReadonlyArray<QueueCapability>;
  // Display information for responses only; never used for authorization.
  displayName?: string;
}

export type QueueCapability =
  | 'opportunity_queue:read'
  | 'opportunity_queue:review'
  | 'opportunity_queue:link'
  | 'opportunity_queue:admin';

export const QUEUE_CAPABILITIES: ReadonlyArray<QueueCapability> = [
  'opportunity_queue:read',
  'opportunity_queue:review',
  'opportunity_queue:link',
  'opportunity_queue:admin',
];

// Every API action and the capability it requires. Admin satisfies any
// requirement below, but admin NEVER bypasses domain validation: channel
// requirements, blocking issues, Service exclusion, and the review-state
// machine are enforced by the queue domain regardless of capability.
export type QueueApiAction =
  | 'list_reviews'
  | 'get_review'
  | 'approve_review'
  | 'ignore_review'
  | 'block_review'
  | 'reconsider_review'
  | 'link_exact';

export const CAPABILITY_FOR_ACTION: Record<QueueApiAction, QueueCapability> = {
  list_reviews: 'opportunity_queue:read',
  get_review: 'opportunity_queue:read',
  approve_review: 'opportunity_queue:review',
  ignore_review: 'opportunity_queue:review',
  block_review: 'opportunity_queue:review',
  reconsider_review: 'opportunity_queue:review',
  link_exact: 'opportunity_queue:link',
};

export type AuthorizationDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden' };

export function hasCapability(
  principal: QueuePrincipal,
  capability: QueueCapability,
): boolean {
  return (
    principal.capabilities.includes(capability) ||
    principal.capabilities.includes('opportunity_queue:admin')
  );
}

// The single authorization gate. No principal is always unauthenticated;
// an authenticated principal without the required capability is forbidden.
export function authorizeAction(
  principal: QueuePrincipal | null | undefined,
  action: QueueApiAction,
): AuthorizationDecision {
  if (!principal || !principal.subject || !principal.subject.trim()) {
    return { allowed: false, reason: 'unauthenticated' };
  }
  if (!hasCapability(principal, CAPABILITY_FOR_ACTION[action])) {
    return { allowed: false, reason: 'forbidden' };
  }
  return { allowed: true };
}
