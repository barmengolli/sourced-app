# Opportunity ledger storage

Status: Bite 5B. Storage model and pure validation helpers only. The
migration (`migrations/2026-07-24_opportunity_ledger_storage.sql`) is
authored but NOT applied. Nothing in this bite activates Salesforce
ingestion, n8n, automated opportunity creation, live deal creation or
linking, or any visible dashboard behavior.

Companion contract: `docs/opportunity-stage-history-contract.md` (Bite 5A).
Boundary module: `src/lib/opportunityImportStorage.ts`.

## 1. The four storage ideas, in plain language

- Source snapshot (`sf_opportunities`): the latest picture of each
  Salesforce Opportunity, one row per Salesforce Opportunity ID. It answers
  "what does Salesforce say right now" plus sync metadata (first/last seen,
  content hash, source-deleted flag).
- Event ledger (`sf_opportunity_events`): every accepted Salesforce
  field-history record, append-only, one row per Salesforce History ID. It
  answers "what happened, in what order" and is the ONLY input for derived
  milestones.
- Deal link (`sf_opportunity_deal_links`): the stable mapping between one
  Salesforce Opportunity and one existing Sourced deal (`deal_id`, the TEXT
  key `attributions` already uses). At most one active link in each
  direction.
- Review inbox projection (`sf_opportunity_reviews`): one CURRENT row per
  Salesforce Opportunity that needs a human decision before it may enter
  the funnel, with constrained issue codes and the reviewer's
  channel/lead/BDR selections. This row is mutable: it always shows the
  latest state, nothing more.
- Review audit trail (`sf_opportunity_review_events`): the permanent,
  append-only record of every meaningful review action: creation, each
  state transition, approvals, link decisions, observed ingestion
  conflicts, and notes, with who acted (system, reviewer, or ingestion, and
  a future SSO identity placeholder), when, which issue codes were in
  force, and what evidence supported it. A record can move
  pending, blocked, pending, approved, linked, resolved and every step
  stays on record even after later transitions.
- Sync runs (`sf_opportunity_sync_runs`): diagnostics and watermarks per
  import run, following the spirit of the existing import-audit pattern.

The projection and the audit trail always move together: the pure helpers
in `opportunityImportStorage.ts` return the projection update and its audit
event as ONE result (or neither, when a transition is invalid or an
approval lacks a channel), so a caller cannot easily update the inbox
without producing the audit entry. A future authenticated review API must
write the pair transactionally. Conflict evidence is carried as content
hashes plus the Salesforce History ID involved, never raw payloads or
unnecessary PII, and a deterministic dedupe key (unique when present)
stops the same ingestion conflict from generating a duplicate audit event
on every nightly sync while keeping a genuinely different conflicting hash
separately reviewable.

## 2. Why the event history is append-only

Milestone dates change meaning when a deal regresses or re-enters a stage.
If imports could rewrite events, an ordinary re-import could silently
change history and past reporting could never be audited. So accepted
events are immutable: the table has no UPDATE-based upsert path, and a
database trigger (the same trigger mechanism the schema already uses for
timestamps) rejects UPDATE and DELETE outright. Exact duplicate History IDs
are ignored informationally at ingestion; a same-ID row with different
content becomes a review conflict (`conflicting_history_id`) and can never
replace the original event. Administrative correction, if ever genuinely
needed, is a reviewed migration that drops the trigger, corrects, and
recreates it; that friction is intentional.

## 3. Why current milestones are derived by Bite 5A

The ledger stores raw movements plus normalized from/to states, and nothing
else. Active HPP/Opportunity/Pursuit dates, regression effects, re-entries,
skips, and velocity are always recomputed by `opportunityStageHistory.ts`
from the events. Storing derived milestone dates as history would freeze
yesterday's interpretation into the data: after a regression the stored
"Opportunity date" would be wrong, and fixing it would mean editing
history. Deriving keeps regressions and re-entries accurate forever: a
backward move clears higher-stage dates only in the derived current path,
while the ledger still shows the full journey for audit and historical
reporting.

## 4. Lead optional, channel mandatory

This mirrors the existing HPP contract: a deal may exist without a linked
lead, so lead selection in review is optional. A channel, however, is the
required attribution evidence for anything that enters the funnel, so
approval is impossible without one. There is no default channel and no
fallback. Primary Campaign Source from Salesforce is stored as EVIDENCE to
help the reviewer decide; it is never treated as a verified channel, never
auto-selected, and never removes the `missing_channel` issue. A channel is
also never inferred from Opportunity name, Account name, owner, Stage, or
Record Type.

## 5. Linking to existing Sourced deals

The only automatic linking key is an exact Salesforce Opportunity ID match.
Name or account similarity may later produce a `possible_existing_deal`
review suggestion, but it can never create a link; a human confirms or
rejects the suggestion in the inbox. Constraints enforce at most one active
link per Salesforce Opportunity and per Sourced deal, in both directions;
retired links remain as audit rows. Existing manually created HPP records
are future reconciliation candidates only: Bite 5B does not modify, link,
or backfill them, and no attribution row is created or changed.

## 6. Watermarks for later ingestion

An initial sync must not rely on Opportunity CreatedDate: old Opportunities
move during the current year. Sync runs record two high-water marks for the
later n8n workflow: the newest Salesforce SystemModstamp seen on snapshots
(pull anything modified since) and the newest history CreatedDate seen on
events (pull any history added since), both as full timestamptz values.
Run rows also count discovered/accepted/duplicate/conflict/review outcomes
and may carry a non-sensitive error summary; credentials, tokens, and n8n
execution secrets are never stored.

## 7. Access: intentionally unavailable to the browser

All five tables have Row Level Security enabled and NO policies, so the
browser anon key can neither read nor write them. They are deliberately not
in the schema's permissive anon-policy loop and not in the realtime
publication, and the current client must not expose Salesforce source
records. Expected future writers:

- the trusted server-side/n8n ingestion identity (service role, which
  bypasses RLS), and
- a future authenticated review API, which will add its own scoped policies
  in a separate reviewed migration.

## 8. What Bite 5B does not activate

No Salesforce connection, no n8n workflow, no CSV import, no automated
opportunity creation, no live deal creation or linking, no attribution
changes, no Create HPP changes, no dashboard changes, no dependency or
environment changes. The migration is unapplied; Supabase is untouched.

## 9. Proposed Bite 5C flow (not implemented)

1. A trusted n8n workflow (service role) pulls current in-scope
   Opportunities plus new OpportunityFieldHistory rows since the saved
   watermarks, using RecordType.DeveloperName for classification and
   history CreatedDate as a full timestamp.
2. Ingestion upserts snapshots, appends only-new events (exact duplicates
   counted, conflicts routed to review), and records a sync run.
3. The Bite 5A calculation derives each Opportunity's movement, current
   path, and quality issues; `buildReviewSeed` opens or refreshes inbox
   rows with issue codes.
4. A reviewer (future authenticated surface) picks a channel (mandatory),
   optionally a lead and BDR, then approves, links (exact ID matches can
   link automatically; suggestions need the human), ignores, or blocks.
5. Only approved or safely linked records are promoted into the live
   Sourced funnel, through a path designed in 5C that writes attributions
   under the existing deal contract. Until then, nothing imported affects
   funnel numbers.
