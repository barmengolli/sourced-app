# Salesforce CampaignMember daily sync

## Purpose

This is the simple production path for Lead and MQL cohort reporting:

1. Read every current Salesforce CampaignMember under the approved parent
   campaigns.
2. Reconcile the complete source response before any write.
3. Upsert the person and the campaign membership together in Sourced.
4. Run daily at 11:50 PM in `America/Denver`.

It does not use Salesforce lifecycle history and it does not calculate
velocity. The reporting rule is acquisition cohort math:

- every eligible CampaignMember counts once as Lead in that campaign;
- if the person is observed as MQL, that same membership also counts once as
  MQL;
- becoming MQL never removes the Lead count;
- a person first seen as MQL on the nightly run still produces Lead = 1 and
  MQL = 1;
- one person in several campaigns counts once in each campaign, by design.

The membership is always attributed to the Salesforce child campaign. The
parent campaign is stored only as hierarchy and scope metadata; it is not the
membership's reporting channel.

Sales (New Logo) is not in the approved parent campaign list. It remains
deal-only from HPP forward.

## Approved scope

The generated workflow contains these explicit parent campaigns:

- `2026 - Content Syndication`
- `2026 - Email`
- `2026 - Events`
- `2026 - Marketing SDR`
- `2026 - Website`

New child campaigns under those parents are included automatically. A new
parent campaign must be deliberately added to the CONFIG node and reviewed.

## Why this replaces the old workflow

The old nightly workflow is not a trustworthy reporting feed because it:

- reads only CampaignMembers created in the last two days;
- stops at 5,000 rows;
- reads the wrong lifecycle field name and therefore defaults every person to
  Lead;
- discards CampaignMember and Campaign identity;
- updates `leads` but does not write `lead_campaign_touches`, which is the
  table the cohort dashboard now counts;
- can log a failed RPC as a success.

The replacement performs a full approved-scope read each day. The current
population is small enough that this is simpler and safer than a watermark.
The native Salesforce query node follows Salesforce pagination and has no
hard row limit in the SOQL.

## Source reconciliation benchmark

The Salesforce report exported on 2026-08-10 provides the initial acceptance
benchmark. It contains no committed contact-level data.

| Measure | Count |
|---|---:|
| Source campaign memberships | 2,629 |
| Eligible memberships | 2,613 |
| Distinct eligible people | 2,568 |
| MQL memberships under the current app mapping | 538 |
| Rows excluded because email is blank | 16 |
| Duplicate CampaignMember IDs | 0 |

All 353 Content Syndication memberships in that export are eligible. Under the
current application lifecycle mapping, 263 of those memberships have reached
MQL. These are a point-in-time benchmark, not values hardcoded into the
workflow.

Rows without email are never silently counted as imported and never receive a
fabricated identity. The dry-run result reports every exclusion by reason, so
source total = eligible + skipped must always reconcile.

## Files

- Generated n8n workflow:
  `src/generated/salesforceCampaignMemberDaily.workflow.json`
- Generator:
  `scripts/build-salesforce-campaign-member-daily-workflow.mjs`
- Pending database function:
  `migrations/2026-08-11_sfdc_campaign_member_daily_apply.sql`

The generated workflow is disabled, has no credentials, has no pinned data,
and starts in `dry_run` mode. The apply path requires both `MODE = 'apply'`
and the exact confirmation phrase. Either one by itself is insufficient.

## First dry run

1. Import `src/generated/salesforceCampaignMemberDaily.workflow.json` into
   n8n.
2. Confirm the workflow is inactive.
3. Add the existing read-only Salesforce OAuth credential to:
   - `Query approved parent campaigns`
   - `Query all approved CampaignMembers`
4. Do not configure the Supabase apply node yet.
5. Execute the workflow manually.
6. The only successful terminal must be
   `DRY RUN: aggregate reconciliation`.
7. Review `source_memberships`, `eligible_memberships`,
   `skipped_by_reason`, `mql_memberships`, and `by_parent_campaign` against a
   Salesforce report with the same campaign scope.

The dry-run terminal contains aggregate counts only. Contact rows remain in a
private in-memory field used solely by the closed apply branch.

## Production activation

Do this only after the dry-run reconciliation is accepted.

1. Apply the pending migration in the Supabase SQL Editor.
2. Verify the function is `SECURITY DEFINER`, has
   `search_path=pg_catalog`, is not executable by PUBLIC, anon, or
   authenticated, and is executable by service_role.
3. Add the existing Supabase Header Auth credential to
   `APPLY: campaign members to Sourced`.
4. In the CONFIG node, enter the Supabase project URL, set MODE to `apply`,
   and enter the exact confirmation phrase shown in that node.
5. Run once manually. `VERIFY: applied counts` must be the only successful
   terminal.
6. Confirm Sourced Data Entry matches Salesforce by parent campaign and child
   campaign for both Lead and MQL.
7. Only then publish the workflow so the daily schedule becomes active.
8. After one successful scheduled replacement run, deactivate the old
   `[Sourced] - SFDC Leads Automated Sync` workflow. Do not leave both active.

## Database behavior

`sourced_apply_sfdc_campaign_members` applies one reconciled batch in one
transaction. An error rolls back the batch. An exact rerun is idempotent:

- leads resolve by exact Salesforce identity first, then normalized email;
- 15-character and 18-character Salesforce IDs match by the exact
  case-sensitive 15-character prefix;
- conflicting identities fail instead of merging people;
- CampaignMember ID is the unique membership key;
- existing Marketing edit locks are respected;
- first-touch channel and date move only to an earlier source touch unless
  locked;
- MQL evidence is appended once and never erased by a later Lead snapshot;
- a real membership supersedes a backfill seed in the same channel family.

The sync does not delete historical campaign memberships or people when a
later source snapshot omits them. Historical cohort reporting must remain
stable. Corrections and removals require a separate reviewed process.
