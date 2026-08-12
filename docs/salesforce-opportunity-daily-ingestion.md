# Salesforce Opportunity daily ingestion

Status: migration **APPLIED on 2026-08-12** and permissions verified. The
initial production staging apply completed on 2026-08-12; the generated n8n
workflow is not yet published for its daily schedule.

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

## Workflow

Generated artifact: `src/generated/salesforceOpportunityDaily.workflow.json`.

- Inactive by default, with Manual Trigger plus the required daily schedule at
  **11:50 PM America/Denver**.
- Uses a native Salesforce search node and native Header Auth HTTP nodes.
- Reads only the protected planner state through
  `sf_read_opportunity_ingestion_state`.
- Runs the generated bundle of the repository planner and serializer; n8n does
  not maintain a second calculation.
- Defaults to `dry_run`. Apply requires both `MODE = 'apply'` and the exact
  confirmation phrase, plus successful reconciliation.
- The dry-run terminal emits aggregate diagnostics only and is structurally
  separate from the apply RPC.

No Google Sheet is used here. The protected `sf_opportunity_*` staging ledger
is the QA/review layer and has stronger stable IDs, retry protection, review
state, and audit history than a spreadsheet. Production reporting remains
unchanged until reviewed opportunities are explicitly linked or approved.

## Manual test order

1. Import the generated workflow and confirm it is **Inactive**.
2. In `CONFIG: closed by default`, replace only the Supabase project URL.
3. Attach the Salesforce credential to the Salesforce read node and the
   service-role Header Auth credential to the two Supabase HTTP nodes.
4. Keep `MODE = 'dry_run'` and `CONFIRM = ''`; execute manually.
5. Review only `DRY RUN: aggregate summary`. Do not enable apply until its
   counts reconcile with the accepted 71-record audit population or a newer
   deliberately re-run audit.

The migration and initial staging apply are complete. Publish the workflow only
with its explicit 11:50 PM `America/Denver` schedule and closed, credentialed
apply boundary intact. New eligible Opportunities are staged for review;
ingestion never approves their attribution automatically.
