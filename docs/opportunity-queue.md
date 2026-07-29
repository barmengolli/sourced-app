# Opportunity Queue Manager (Bite 5C2B1)

Status: foundation only. Domain logic, reusable UI, and tests exist; the
queue has NO production route and is NOT connected to production data.

## What the queue does

The Opportunity Queue Manager is the human review surface for staged
Salesforce opportunities. It lists staged records whose review requires
attention (review state `pending` or `blocked`), shows the reviewer the
snapshot fields and raw evidence, and produces the review decisions:
approve, ignore, block, reopen, and exact-ID link. Marketing must manually
approve an opportunity here before it can enter Sourced reporting; nothing
is ever approved, linked, or attributed automatically.

Implementation:

- `src/lib/opportunityQueue.ts`: pure domain logic. Queue membership,
  filters, and single-item action proposals that return the coupled
  projection mutation plus append-only audit event from the Bite 5B
  contracts (`src/lib/opportunityImportStorage.ts`).
- `src/lib/opportunityQueueRepository.ts`: the typed data-access boundary
  (`OpportunityQueueRepository`): listQueue, getQueueItem, approveReview,
  ignoreReview, blockReview, reopenReview, linkExactDeal.
- `src/components/opportunities/OpportunityQueueManager.tsx`: the UI. It
  consumes the repository interface only and covers loading, empty, error,
  pending, blocked, approval-form, validation, non-approvable, evidence
  disclosure, and local action-result states.
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

## Exact-ID-only linking

An existing Sourced deal can be linked automatically only by an exact,
nonblank, identical Salesforce Opportunity ID on both sides. Name or
account similarity may be displayed as a suggestion only and requires a
future explicit human decision; a similarity method can never produce a
link.

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
