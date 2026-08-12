# Salesforce Opportunity daily ingestion

Status: implementation prepared; migration **PENDING / NOT APPLIED**; generated
n8n workflow **disabled**; no production ingestion has run.

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

1. Review and manually apply
   `migrations/2026-08-12_opportunity_daily_ingestion_contract.sql`.
2. Verify the new columns and both RPC permissions in the live catalog.
3. Import the generated workflow and confirm it is **Inactive**.
4. In `CONFIG: closed by default`, replace only the Supabase project URL.
5. Attach the Salesforce credential to the Salesforce read node and the
   service-role Header Auth credential to the two Supabase HTTP nodes.
6. Keep `MODE = 'dry_run'` and `CONFIRM = ''`; execute manually.
7. Review only `DRY RUN: aggregate summary`. Do not enable apply until its
   counts reconcile with the accepted 71-record audit population or a newer
   deliberately re-run audit.

The migration and workflow are safe to review but are not yet authorized for
production application or activation.
