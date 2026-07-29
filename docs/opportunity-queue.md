# Opportunity Queue Manager (Bite 5C2B1)

Status: foundation only. Domain logic, reusable UI, and tests exist; the
queue has NO production route and is NOT connected to production data.

## What the queue does

The Opportunity Queue Manager is the human review surface for staged
Salesforce opportunities. It lists staged records whose review requires
attention (review state `pending` or `blocked`), shows the reviewer the
snapshot fields and raw evidence, and produces the review decisions:
approve, set aside (Not selected), block, reopen, reconsider, and exact-ID
link. Marketing must manually approve an opportunity here before it can
enter Sourced reporting; nothing is ever approved, linked, or attributed
automatically.

User-facing language: the stored review state `ignored` is always shown as
"Not selected". The persisted state value remains `ignored` exactly as the
Bite 5B contract defines it; no new database state or migration exists.

Implementation:

- `src/lib/opportunityQueue.ts`: pure domain logic. Queue membership,
  filters, and single-item action proposals that return the coupled
  projection mutation plus append-only audit event from the Bite 5B
  contracts (`src/lib/opportunityImportStorage.ts`).
- `src/lib/opportunityQueueRepository.ts`: the typed data-access boundary
  (`OpportunityQueueRepository`): listQueue, listNotSelected, getQueueItem,
  approveReview, ignoreReview, blockReview, reopenReview, reconsiderReview,
  linkExactDeal.
- `src/components/opportunities/OpportunityQueueManager.tsx`: the UI. It
  consumes the repository interface only and covers loading, empty, error,
  pending, blocked, approval-form, validation, non-approvable, evidence
  disclosure, the Not selected recovery view with its Reconsider form, and
  local action-result states.
- Tests use synthetic fixtures and an in-memory adapter that live under
  `src/test/` and are never imported by application code.

## What it deliberately does not do yet

- No production route: the component is not registered in `src/App.tsx` or
  the sidebar, so nothing suggests the queue is live.
- No reads or writes against the six protected `sf_opportunity_*` tables.
- No deal creation, attribution, touch, or link record changes.
- No bulk actions of any kind: every action operates on exactly one item.
- No automatic or fuzzy linking, and no channel inference.

## Queue eligibility

- Only staged opportunities with a review in an attention state (`pending`
  or `blocked`) appear.
- Eligible funnel record types are HPP, Opportunity, and Pursuit.
- Service/out_of_scope records never appear, in any state.
- Unknown record types remain visible but are blocked and non-approvable.
- Records with an existing active link never return to the approval queue;
  retired links are never silently re-queued.
- Ignored, resolved, approved, and linked reviews never silently reopen.
- A linked opportunity moving to Service leaves the active funnel but keeps
  its link and history; if it returns to HPP, Opportunity, or Pursuit it
  resumes through the existing link without a new approval.

## Approval and channel rules

- Approval starts from `pending` only and requires the reviewer's explicit
  Sourced channel selection. There is no default channel.
- The channel is NEVER inferred from the creator, owner, BDR,
  Lead Source, or Primary Campaign Source. Those fields (plus Customer
  Expansion and the Industry Vertical raws) are evidence shown to the
  reviewer, nothing more.
- Lead association is optional.
- Blocking issues (`unknown_record_type`, `conflicting_history_id`,
  `invalid_source_row`) make approval impossible until the underlying data
  is fixed.
- Ignore takes an optional non-sensitive note; block requires a reason;
  reopen follows the Bite 5B review-state machine and produces the
  `reopened` audit event.
- Every state-changing decision produces its projection mutation and its
  append-only audit event together, or not at all.

## Not selected and the recovery workflow

Marketing may initially decide not to import an opportunity and later
reconsider it with leadership. Recovery never erases or rewrites the
original decision.

- A separate "Not selected" view lists ignored reviews only; they are
  never mixed into the active pending queue. The view keeps search,
  record-type, open/closed, and created-date filters plus the same
  evidence and diagnostics disclosures as the active queue.
- The "Reconsider opportunity" action is allowed only when the review
  state is `ignored`. It transitions `ignored` to `pending` through the
  existing review-state contract and emits the existing append-only
  `reopened` audit event. A short, non-sensitive reason is required.
- The original not-selected event and its note are preserved untouched;
  no prior audit event is ever overwritten or deleted. An invalid
  recovery attempt produces neither a projection mutation nor an audit
  event.
- Recovery is NOT approval. The record returns to the pending queue for a
  fresh inspection; a channel must still be selected before approval,
  lead association remains optional, and nothing is imported, linked, or
  attributed merely because it was recovered.
- Safeguards: records currently in Service (out_of_scope) cannot be
  reconsidered into the active queue (their history is retained but they
  are unavailable, even in the Not selected view); unknown record types
  can be reconsidered but remain blocked and non-approvable; linked and
  retired-link records cannot be recovered or requeued; resolved reviews
  are terminal; approved and linked reviews cannot be recovered; and a
  Salesforce update never automatically reopens a not-selected review,
  including when the record later returns to an eligible funnel record
  type: the reviewer's explicit Reconsider action is always required.

Limitation: recovery covers opportunities that were previously staged and
explicitly set aside (ignored). It does not recover opportunities that
were never staged, Service opportunities, older opportunities excluded by
the discovery scope, or records removed before entering the review
system. Reaching those requires a future authenticated Salesforce
discovery/search feature, which is separate, unapproved work.

## Exact-ID-only linking

An existing Sourced deal can be linked automatically only by an exact,
nonblank, identical Salesforce Opportunity ID on both sides, and the
comparison happens SERVER-SIDE: the caller supplies only the opaque
internal review id and the target Sourced deal id, and the repository
resolves both stored Salesforce values itself (the client is never
trusted to claim two Salesforce IDs match). Repository methods key on the
internal review identity (`sf_opportunity_reviews.id` UUID), never on
Salesforce IDs or names. Name or account similarity may be displayed as a
suggestion only and requires a future explicit human decision; a
similarity method can never produce a link.

## Why direct browser access is prohibited

The six `sf_opportunity_*` tables have RLS enabled with zero anon or
authenticated policies, and only `service_role` may execute the apply
function. That is deliberate: the app's client-side password gates are not
real authorization, so a browser write path to these tables would let
anyone with the bundle mutate the opportunity ledger. The queue UI
therefore consumes `OpportunityQueueRepository` and must never import the
Supabase client; static tests enforce this.

## The authenticated API requirement (boundary to live integration)

Bite 5C2B1 ends at the repository interface. Going live requires a
server-side authenticated review API that:

- authenticates the reviewer (real auth, not the password gate),
- executes reads and the coupled projection+audit writes transactionally
  against the protected tables using a server-held identity,
- never ships a service-role credential to the browser.

That API, the production route, and visible deal synchronization
(Bite 5C2C approval/link effects on Sourced deals) are explicitly out of
scope for this bite and require their own approval.
