// opportunityQueueServerRepository.ts: Bite 5C2B2A future server database
// boundary for the Opportunity Queue API. CONTRACT ONLY: no live database
// connection, no Supabase client, no credentials exist in this bite.
//
// The service layer consumes the existing browser-neutral
// OpportunityQueueRepository interface (src/lib/opportunityQueueRepository)
// plus the small server-side additions below. The FUTURE live
// implementation, hosted by IT on the approved internal Node.js platform,
// must:
//
// - Use a server-held RESTRICTED database identity (a dedicated role or the
//   tightly scoped service key kept in server secret storage), never
//   exposed to React or any browser bundle.
// - Read and write ONLY the six sf_opportunity_* tables and approved RPCs
//   (sf_apply_opportunity_ingestion for ingestion; a future review RPC for
//   queue decisions). No other table is reachable from this boundary.
// - Perform every review projection change and its append-only audit event
//   ATOMICALLY (one transaction or one RPC), exactly as the coupled
//   ReviewMutation contract requires.
// - Respect the append-only triggers on sf_opportunity_events and
//   sf_opportunity_review_events: no UPDATE or DELETE, ever.
// - Enforce optimistic concurrency: the stored review row carries a version
//   (its updated_at or a row version); a mutation with a stale expected
//   version fails with version_conflict and changes nothing.
// - Enforce idempotency: the idempotency ledger is persisted server-side so
//   an identical retried request returns the original result and a same-key
//   different-payload request fails with idempotency_conflict.
// - Preserve reviewer decisions during ingestion: channel_id, lead_id,
//   notes, reviewed_by, and human review states are never overwritten by
//   sync (the Bite 5C2A apply function already guarantees this on the
//   ingestion side).
//
// Until that implementation exists, only the synthetic in-memory adapter
// under src/test/ satisfies these interfaces, and only in tests.

// The optimistic-concurrency token. In this bite versions are derived
// deterministically from the review projection content, which is portable
// and requires no schema change; the live implementation may substitute the
// stored row version as long as it changes on every projection mutation.
import { sha256Hex } from '../lib/sha256';
import type { OpportunityQueueItem } from '../lib/opportunityQueue';

export function computeReviewVersion(item: OpportunityQueueItem): string {
  const review = item.review;
  const canonical = JSON.stringify([
    item.diagnostics.sfOpportunityId,
    review ? review.reviewState : null,
    review ? [...review.issueCodes].sort() : null,
    review ? review.channelId : null,
    review ? (review.leadId ?? null) : null,
    item.linkStatus,
  ]);
  return `v1:${sha256Hex(canonical)}`;
}

// Server-side idempotency ledger. Keys are caller-generated; the request
// hash binds a key to one exact payload. Stored results are the sanitized
// API response bodies, never raw rows.
export interface IdempotencyRecord {
  requestHash: string;
  result: unknown;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  put(key: string, record: IdempotencyRecord): Promise<void>;
}
