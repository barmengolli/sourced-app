# Salesforce Opportunity daily ingestion

Status: migration **APPLIED on 2026-08-12** and permissions verified. The
initial production staging apply completed on 2026-08-12 and the v2 workflow
is active. Exact Account-ID support is prepared in a separate pending v3
migration; the active workflow remains authoritative until that migration is
deliberately applied and verified.

## Verified initial production staging

The accepted dry run reconciled 71 eligible opportunities: 36 open current
pipeline records and 35 closed records retained for review. The first apply
stored 71 snapshots and created 71 pending reviews. Direct database
verification confirmed 71 distinct opportunities, no missing reviews, no
missing primary `SaaS_Revenue_USD__c` values, open stages of 9 HPP / 14
Opportunity / 13 Pursuit, and BDR suggestions of 13 Dave Cummins / 7 Garrett
McNally. An immediate exact retry applied 0 snapshots and created 0 reviews,
confirming retry idempotency against the production state.

This staging apply did not approve attribution, create reporting rows, or link
Sourced deals. All 71 records remain pending human review.

## Approved scope

- Salesforce `Opportunity.CreatedDate` is in 2025 or 2026.
- `RecordType.DeveloperName` is exactly `High_Potential_Prospect`, `Leads`, or
  `Licensing`, normalized to HPP, Opportunity, or Pursuit.
- `Existing_Customer_or_New_Business__c` is exactly the API value
  `New Project` (Salesforce shows its UI label as **New Logo**).
- Blank and every non-New-Project business type are excluded.
- Open and closed eligible records are staged for review. Executive pipeline
  reporting uses open records only; no Opportunity cohort report is added.

## Revenue and business fields

`SaaS_Revenue_USD__c` is the primary visible revenue. `Amount` and
`SaaS_Revenue__c` are still imported and stored, but initially hidden. The
workflow also imports `Market__c`, `Commercial_Region__c`, and `GTM_Cube__c`.

Nightly sync refreshes the Salesforce source values. Human corrections are
stored separately as `market_override`, `commercial_region_override`,
`gtm_cube_override`, and the existing review `channel_id`. Reporting and the
future live review API must resolve each field as `override ?? source`.
Ingestion never clears or overwrites an override.

The pending v3 contract also persists exact Salesforce `AccountId`. That ID,
not the editable account name, is the only permitted MQL-account-to-HPP join.

The regenerated v3 workflow also reads `OpportunityFieldHistory` for
`RecordType` and `StageName`, plus the live Opportunity `RecordType` reference
table. Those rows go through the repository's authoritative history adapter;
n8n does not infer movement from two nightly snapshots. The protected event
ledger therefore retains forward moves, regressions, re-entry, closing, and
reopening. Reporting promotion will derive the reversible current-qualified
path from that evidence: current HPP reports HPP only, current Opportunity
reports HPP + Opportunity, and current Pursuit reports HPP + Opportunity +
Pursuit. A regression removes the higher stage from reporting without deleting
the historical movement.

## Review and attribution

Every eligible Opportunity enters the protected review staging ledger. Creator,
Sales Development Rep, and Primary Campaign Source are evidence only. A record
created by Dave/David Cummins stores the normalized suggestion `Dave Cummins`;
one created by Garrett McNally stores `Garrett McNally`. This may support a
Marketing SDR suggestion in the eventual live review UI, but ingestion never
approves that source automatically. Every other creator stores no BDR
suggestion. The reviewer selects the final source channel.

The repository contains the review domain and preview UI, but the live queue
still requires the approved authenticated server/API runtime. This workflow
does not pretend that browser access exists and does not write directly to
reporting or attribution tables.

The pure promotion boundary now exists in
`src/lib/opportunityReportingProjection.ts`. It requires an approved review,
an active exact link, a reviewer-selected channel, an effective Commercial
Region in the application taxonomy, and real stage-entry dates. The authored
`2026-08-12_opportunity_reporting_projection.sql` migration is applied and
adds provenance that keeps generated Salesforce rows separate from manual
attributions. Live promotion remains blocked on the authenticated server API
described in `docs/opportunity-queue-api.md`; no browser bypass is permitted.

## Workflow

Generated artifact: `src/generated/salesforceOpportunityDaily.workflow.json`.

- Inactive by default, with Manual Trigger plus the required daily schedule at
  **11:50 PM America/Denver**.
- Uses native Salesforce search nodes for current Opportunities, Opportunity
  field history, and runtime RecordType references, plus native Header Auth
  HTTP nodes.
- Reads only the protected planner state through
  `sf_read_opportunity_ingestion_state`.
- Runs the generated bundle of the repository planner and serializer; n8n does
  not maintain a second calculation.
- Defaults to `dry_run`. Apply requires both `MODE = 'apply'` and the exact
  confirmation phrase, plus successful reconciliation.
- The dry-run terminal emits aggregate diagnostics only and is structurally
  separate from the apply RPC.
- The regenerated artifact targets v3. Its required migration and restricted
  permissions were verified on 2026-08-12, so it is ready for a controlled dry
  run before replacing the active v2 workflow.

No Google Sheet is used here. The protected `sf_opportunity_*` staging ledger
is the QA/review layer and has stronger stable IDs, retry protection, review
state, and audit history than a spreadsheet. Production reporting remains
unchanged until reviewed opportunities are explicitly linked or approved.

## Manual test order

1. Import the generated workflow and confirm it is **Inactive**.
2. In `CONFIG: closed by default`, replace only the Supabase project URL.
3. Attach the Salesforce credential to all three Salesforce read nodes and the
   service-role Header Auth credential to the two Supabase HTTP nodes.
4. Keep `MODE = 'dry_run'` and `CONFIRM = ''`; execute manually.
5. Review only `DRY RUN: aggregate summary`. It must report the current
   Opportunity count, history-row count, RecordType-reference count, and the
   planned event count. Do not enable apply until the Opportunity population
   reconciles with the accepted 71-record audit (or a newer deliberately
   re-run audit) and the history query is confirmed complete.

The migration and initial staging apply are complete. Publish the workflow only
with its explicit 11:50 PM `America/Denver` schedule and closed, credentialed
apply boundary intact. New eligible Opportunities are staged for review;
ingestion never approves their attribution automatically.
