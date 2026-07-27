# Opportunity staging ingestion (Bite 5C2A)

Status: safe ingestion FOUNDATION. The pure planner and the restricted
apply function exist and are fully tested; nothing has been executed. The
PENDING migration is unapplied, the workflow shell below is inactive, and
no write of any kind has happened. Bite 5C2A does not build the Review
Queue UI and does not create Sourced opportunities.

Companions: `docs/opportunity-stage-history-contract.md` (5A),
`docs/opportunity-ledger-storage.md` (5B),
`docs/salesforce-opportunity-sync.md` (5C1),
`src/lib/opportunityIngestionPlanner.ts` (this bite's planner),
`migrations/2026-07-27_opportunity_ingestion_apply_fn.sql` (PENDING).

## 1. The core safety principle

Salesforce discovery and staging must never cause an opportunity to appear
in Sourced reporting. Staging writes touch ONLY the six protected
`sf_opportunity_*` tables, which no dashboard reads and no anon policy
exposes. Only a later explicit approval or link action (Bite 5C2B, human
in the loop) may affect visible deals. The planner's operation type system
contains no approval, link, deal, or attribution operation, and no
operation can target any table outside the protected six; both facts are
enforced by types and tests. The existing deals, attributions, touches,
leads, channels, funnel and campaign tables are untouched, and legacy
`sf_link` metadata is never parsed or altered.

## 2. Candidate versus linked paths

Candidate (new, unlinked Salesforce Opportunity):

- Eligible for a pending review only when its current normalized record
  type is hpp, opp, or pursuit; it is currently open OR created during the
  configured initial cohort year; it is not Service/out_of_scope; it is
  not unknown/unmapped; and no existing review in a decided state
  (ignored, resolved, blocked, approved, linked) owns it. Previously
  decided reviews obey the Bite 5B state machine: the planner never
  reopens them.
- BDR creator, SDR lookup, Primary Campaign Source, Customer Expansion,
  and Industry Vertical are review EVIDENCE only: none can include,
  exclude, attribute, or assign a channel, no channel is ever inferred,
  and no linked Lead is required. Every new review seeds missing_channel;
  channel selection is a human act at approval.
- Ineligible NEW records are NOT staged at all: a newly discovered,
  unlinked current-Service/out_of_scope record, unknown record type, or
  older closed record outside the cohort enters no snapshot, no event,
  and no review; it appears only in aggregate sync diagnostics without
  identifiers. Older closed records are reserved for a later controlled
  historical-backfill program. Exceptions that DO keep staging: existing
  active links (even after moving to Service), records with an existing
  review (protected history is retained while temporarily out of scope,
  without appearing as an active queue candidate), and retired links
  (preserved, never reactivated). Historical Service movements of an
  eligible, reviewed, or linked opportunity remain preserved.

Linked (existing active exact Salesforce-to-Sourced link):

- Snapshot and history keep syncing; approval is never reopened.
- A linked deal moving to Service keeps its link and full history; its
  snapshot's normalized state becomes out_of_scope, which is how the
  future application layer derives active-funnel availability. The link
  and deal are never deleted.
- If it returns to hpp/opp/pursuit, the snapshot's normalized state
  restores availability with NO new review or reapproval; the plan counts
  these transitions (`linked.nowUnavailableService`,
  `linked.restoredToFunnel`).
- A retired link is never silently reactivated and never becomes an
  automatic candidate again; humans own it.

## 3. The pure planner

`planStagingIngestion(records, history, recordTypeRefs, existingState,
config)` reuses the single 5C1 preparation pipeline (RecordType-Id
resolution plus paired-representation collapse via `prepareHistoryRows`),
the 5A derivation, and the 5B review builders. It emits an explicit plan
of allowlisted operations only: snapshot upserts and no-ops, append-only
event inserts, informational duplicate no-ops, blocked conflicts,
review creations coupled with their review_created audit events, pending
review issue updates coupled with issues_updated audit events, and exactly
one sync-run diagnostics operation.

The serialization boundary (`serializeApplyPayload`) converts a plan into
the exact `sf_apply_opportunity_ingestion` parameters: full snapshot
payloads carrying every approved evidence field (raw values and source
USER IDS only, never configured employee names; all three Industry
Vertical candidates as separate raw fields; no canonical choice, no
Customer Expansion rule), events with their canonical SHA-256 content
hash, and review items carrying their audit event INSIDE the item so the
database enforces coupling. Unknown operation kinds fail closed, blocked
conflicts make the batch non-appliable, and `summarizeDryRunPlan` reports
counts with zero writes attempted. Fingerprints are SHA-256 over an
explicitly ordered canonical field list (key order irrelevant; every
staged field included).

Stale-write protection carries the source SystemModstamp end to end: an
older timestamp is a stale no-op that can never overwrite, an identical
timestamp with identical fingerprint no-ops, an identical timestamp with
DIFFERENT content is a blocked conflict never silently chosen, and a
missing source timestamp fails validation, at both the planner and the
database boundary.

Review preservation: reviewer-controlled state (channel_id, lead_id,
notes, reviewed_by, BDR selection, human review state) is inviolable. A
populated channel means missing_channel was humanly resolved and
ingestion never re-adds it; issue updates touch ONLY issue_codes and only
on the expected pending row; reprocessing can never undo a human
decision.

Idempotency: the same input against the same existing state plans zero
duplicate work (hash-equal snapshots no-op, known History Ids no-op,
unchanged issue codes produce no update). Exact repeated History Ids are
informational; a same-Id conflict blocks with no version chosen and seeds
conflicting_history_id on the review. Unknown, invalid, or ambiguous
source data never creates an approvable clean candidate: it stays
excluded or lands in review issues. Paired label/RecordTypeId
representations preserve their evidence but count as one business
movement (5C1 collapse). The initial cohort year is explicit
configuration; 2026 is the approved first-run value and today's date is
never consulted.

## 4. Initial and incremental synchronization

Initial run scope: eligible current open records, plus eligible records
created during the configured cohort year, plus every Salesforce Id with
an existing active link (including linked records currently in Service).

Incremental runs: lower-bound on `SystemModstamp` (never CreatedDate
alone) using the newest COMPLETED run's watermark, minus a small overlap
window (recommended: 10 minutes) so boundary-second updates cannot be
missed; overlap is harmless because every layer deduplicates (Salesforce
Ids, History Ids, content hashes, and the database's unique constraints).
History pulls lower-bound on history CreatedDate with the same overlap.
The planner only PROPOSES watermarks; they persist exclusively on the
completed run row written by the apply function after the whole batch
succeeds. A failed or partial batch rolls back entirely and records a
FAILED run with a non-sensitive error summary and NULL watermarks, so it
can never claim progress. Diagnostics are aggregate-only: no customer
identifiers ever enter `sf_opportunity_sync_runs`.

## 5. Write mechanism and credential boundary

The PENDING migration adds the review-evidence columns and defines
`public.sf_apply_opportunity_ingestion(...)`: one SECURITY DEFINER
function with search_path pinned to pg_catalog and every reference
schema-qualified, applying one planned batch as ONE transaction. The
sync-run row is created FIRST (status running) and its id tags every
inserted history event, so all writes trace to their run; on complete
success that same row becomes completed with the watermarks, and on any
failure every batch write rolls back and the same row becomes failed with
NULL watermarks. Event inserts VERIFY content: an existing History Id
with identical canonical hash is an idempotent no-op, different content
FAILS the atomic batch (never silently ignored, never updated); audit
dedupe-key collisions with different content also fail. Review creates
that lose a race to an existing compatible pending review skip both the
insert and the review_created audit event (no false audit); issue updates
require the expected pending row and fail on zero rows. Failure
diagnostics are SANITIZED: only the SQLSTATE and an allowlisted category
(custom SF001-SF007 codes for the function's own assertions) are
persisted or returned; SQLERRM never is, because engine messages can
embed source values. The future n8n caller MUST treat ok:false as
workflow failure. Execution is revoked from PUBLIC, anon, and
authenticated and granted only to service_role, the trusted server-side
identity from the Bite 5B contract. RLS stays enabled on all six tables with no browser
policies; no credential exists in React or this repository, and all n8n
credential references are placeholders.

INFRASTRUCTURE DECISION STILL REQUIRED before any live apply:

1. Where the TypeScript planner executes server-side with the restricted
   credential. The planner is repository TypeScript; n8n Code nodes cannot
   import it, and duplicating it in n8n is forbidden divergence. The two
   candidate homes are a small server-side endpoint (for example a Vercel
   serverless function holding the service-role key as a server env var)
   or a bundled planner artifact executed inside n8n. This is an
   infrastructure decision and is deliberately not made here.
2. Optionally, a narrower dedicated ingestion role than service_role
   (custom JWT role in Supabase), tightening the blast radius further.

Until (1) is decided, the apply path DOES NOT EXIST: the workflow shell
below fails closed, and 5C2A stops before adding a weaker write path
(no Google Sheets intermediary, no browser writes, no inline SQL from
n8n).

## 6. Prerequisites before any live execution

1. Review and apply the PENDING apply-function migration (separately).
2. Decide the planner execution environment (above) and provision its
   restricted credential outside the repository.
3. Merge the read-side workflow (5C1) results: confirmed custom fields,
   Service disposition, cohort year 2026.
4. Choose the canonical Industry Vertical field and the Customer
   Expansion value mapping (still open; evidence only until then).
5. A reviewed first run in dry_run mode, then an explicitly confirmed
   apply of the initial cohort.

## 7. Workflow shell (sanitized, disabled, fail-closed)

The read side remains the published 5C1 dry-run workflow. The shell below
holds the run-mode configuration and the fail-closed APPLY GATE that the
full ingestion workflow will grow around in 5C2B; in 5C2A the apply path
terminates in the gate (there is no write-capable node of any kind). It
is exported inactive, Manual Trigger only, defaults to dry_run, and apply
mode cannot run without BOTH a private mode change AND the explicit
confirmation value; even then it fails with the documented dependency
until the planner execution environment exists. Static tests enforce all
of this.

```json
{
  "name": "[Sourced] - SFDC Opportunity Staging Ingestion - SHELL - DISABLED",
  "active": false,
  "settings": { "executionOrder": "v1" },
  "nodes": [
    {
      "id": "s1",
      "name": "Manual Trigger - NEVER SCHEDULED",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 0],
      "parameters": {}
    },
    {
      "id": "s2",
      "name": "CONFIG (PRIVATE): run mode",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [220, 0],
      "parameters": {
        "jsCode": "// PRIVATE RUNTIME CONFIGURATION. mode stays 'dry_run' unless a human\n// deliberately edits it inside n8n for one explicitly confirmed apply.\n// CONFIRM_APPLY must be set to the exact confirmation string for apply\n// mode to even be considered; both reset to safe values on import.\nreturn [{ json: { mode: 'dry_run', CONFIRM_APPLY: '' } }];"
      }
    },
    {
      "id": "s3",
      "name": "DRY RUN: ingestion plan summary (no writes)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [440, 0],
      "parameters": {
        "jsCode": "// READ ONLY / DRY RUN. The authoritative ingestion plan is computed by\n// src/lib/opportunityIngestionPlanner.ts (planStagingIngestion) against\n// the 5C1 read results and the protected staging state; its execution\n// environment is a documented pending infrastructure decision. This node\n// attempts zero writes.\nconst cfg = $('CONFIG (PRIVATE): run mode').first().json;\nreturn [{ json: { dry_run: true, writes_attempted: 0, mode: cfg.mode, note: 'Ingestion plan is computed by the repository planner; see docs/opportunity-staging-ingestion.md for the pending execution-environment decision.' } }];"
      }
    },
    {
      "id": "s4",
      "name": "APPLY GATE (fail closed): no write path exists in 5C2A",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [660, 0],
      "parameters": {
        "jsCode": "// FAIL-CLOSED APPLY GATE. dry_run passes through untouched. Apply mode\n// requires BOTH the private mode change AND the exact confirmation value,\n// and even then it fails here: Bite 5C2A ships no write path. The gate is\n// the write-side terminal until the server-side planner execution\n// environment and its restricted credential exist (see the doc).\nconst cfg = $('CONFIG (PRIVATE): run mode').first().json;\nif (cfg.mode !== 'apply') {\n  return $input.all();\n}\nif (cfg.CONFIRM_APPLY !== 'I_UNDERSTAND_THIS_WRITES_TO_STAGING') {\n  throw new Error('APPLY GATE: apply mode requires the exact CONFIRM_APPLY confirmation value.');\n}\nthrow new Error('APPLY GATE: no write path exists in Bite 5C2A. Applying requires the server-side planner execution environment and the restricted ingestion credential; see docs/opportunity-staging-ingestion.md.');"
      }
    }
  ],
  "connections": {
    "Manual Trigger - NEVER SCHEDULED": {
      "main": [[{ "node": "CONFIG (PRIVATE): run mode", "type": "main", "index": 0 }]]
    },
    "CONFIG (PRIVATE): run mode": {
      "main": [[{ "node": "DRY RUN: ingestion plan summary (no writes)", "type": "main", "index": 0 }]]
    },
    "DRY RUN: ingestion plan summary (no writes)": {
      "main": [[{ "node": "APPLY GATE (fail closed): no write path exists in 5C2A", "type": "main", "index": 0 }]]
    }
  }
}
```
