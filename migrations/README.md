# Migrations

SQL migrations for the Sourced Supabase project. The canonical schema
lives in [`../SCHEMA.sql`](../SCHEMA.sql); files in this directory
record incremental changes applied on top of that baseline.

## Naming convention

```
YYYY-MM-DD_short_description.sql
```

Date is the day the migration was authored (not the day it was
applied). `short_description` is snake_case and should make the intent
obvious from the filename alone. Files sort alphabetically by date
prefix, which is also the intended apply order.

## Migrations in this directory

Listed in date order. Status reflects what has been applied to the
production Supabase project as of 2026-05-06.

| File | Status | Notes |
|---|---|---|
| `2026-05-04_q1_date_correction_book_a_call.sql` | APPLIED | Moved 34 leads' `marketing_sourced_date` from 2026-04-02 to 2026-03-31 (Q1 boundary correction for the "Book a call" form) and locked the field. |
| `2026-05-04_q1_mql_history_correction_book_a_call.sql` | APPLIED | Of those 34 leads, moved 13 MQL `stage_history` entries' `entered_at` to 2026-03-31 so they bucket into Q1. |
| `2026-05-04_add_close_lost_stage.sql` | APPLIED | Relaxed the `stage_key` CHECK constraints on `attributions`, `funnel_projections`, and `funnel_actuals` to include `'closeLost'`. |
| `2026-05-07_attributions_unique_deal_stage.sql` | PENDING | F-006: Adds a partial UNIQUE index on `attributions (deal_id, stage_key)` (where `deal_id` is non-null and non-empty) to prevent duplicate downstream rows from any write path. Run the dedup query in the migration header before applying. |
| `2026-05-07_attributions_stage_entered_at.sql` | PENDING | Adds `stage_entered_at DATE NOT NULL` to `attributions` plus a supporting index. Backfills existing rows with `created_at::date`. Feeds the new Marketing Funnel: Velocity sub-tab. |
| `2026-05-12_backfill_missing_mql_stage_history.sql` | PENDING | One-time backfill: appends a `stage_history` MQL entry (entered_at = CURRENT_DATE) to every lead whose `current_stage` is `'mql'` but whose `stage_history` has no `'mql'` entry. Fixes the legacy MQL under-count from re-imports that updated `current_stage` without seeding history. Pair with the importer fix in `useLeads.ts` so future re-imports auto-append on stage upgrade. Preview-count snippet in the file header. |
| `2026-05-13_leads_event_activations.sql` | PENDING | Adds `event_activations TEXT[] NOT NULL DEFAULT '{}'` to `leads` plus a GIN index for membership queries. Feeds the new Marketing Funnel: Events sub-tab. No backfill needed: existing rows get `'{}'` from the column default; the next SFDC re-import populates real values from the "Event Activation" column. |
| `2026-05-14_campaign_costs.sql` | PENDING | Adds `campaign_costs` table (one row per date-range budget per channel) plus RLS policies, realtime publication, and an updated_at trigger. Feeds the new Marketing Funnel: Spend sub-tab. No data migration needed; users enter budgets via the Channel Manager UI after applying. |
| `2026-05-19_channels_year.sql` | APPLIED | Adds `year INTEGER` to `channels` plus a supporting index. Backfills from the existing `"YYYY -"` name prefix so every existing 2026 channel ends up `year=2026`; evergreen channels (no prefix) stay NULL. Drives the year-aware attribution-modal channel filter. |
| `2026-05-19_funnel_actuals_lead_mql.sql` | PENDING | Relaxes the `stage_key` CHECK on `funnel_actuals` to include `'lead'` and `'mql'`. Required so historical-year lead/MQL counts can be seeded as actuals when no lead-level data was imported (e.g. 2025 pre-Sourced). For years where real leads exist, lead/MQL counts continue to come from `leads.marketing_sourced_date` and `leads.stage_history`; funnel_actuals rows for these stages are fallback only. Pair with the compute.ts change on this branch. |
| `2026-05-19_seed_2025_channels_and_actuals.sql` | PENDING | Seeds the five 2025 top-level channels (`year=2025`, no sub-channels) plus 32 `funnel_actuals` rows (lead and MQL per quarter, four channels) and 32 `funnel_projections` rows (annual projections split evenly across quarters). Sales Generated has no Lead/MQL data but is created for completeness. Run AFTER `2026-05-19_funnel_actuals_lead_mql.sql`. |
| `2026-06-10_region_taxonomy_migration.sql` | PENDING | EIS region taxonomy: re-derives `leads.region` from country, auto-maps `attributions` LATAM→`EMEA cont & LATAM` and APAC→`UK&IRE, ME, Japan`, and produces a review list for old EMEA deals (manual split between the two new buckets). Run AFTER deploying the code change from `prompts/2026-06-10_eis-region-taxonomy.md`. Also update the n8n leads-sync region mapping the same day. Outreach tabs unaffected. |
| `2026-06-11_sixsense_snapshots.sql` | PENDING | Adds the `sixsense_snapshots` table (one row per 6sense "Activities By Source" summary import, keyed by `snapshot_date`) plus RLS policies and realtime publication. Idempotent (`IF NOT EXISTS`, guarded policies/publication). Feeds the new 6sense section (Dashboard + in-app CSV Import). No data migration; the MOps lead imports exports via the in-app importer after applying. An n8n + Google Sheet writer may target the same table later, tagged via the `source` column. |

Status legend: **APPLIED** (run against prod), **APPLIED** (committed
but not yet run), **UNKNOWN** (provenance unclear, verify in Supabase
before applying).

## Applying pending migrations from a fresh checkout

There is no migration runner wired into the app. Two options:

1. **Supabase SQL Editor (current practice).** Open the project in the
   Supabase dashboard, navigate to SQL Editor, paste the file
   contents, run. Apply files in alphabetical order. Each migration is
   wrapped in its own transaction; if it fails, fix and rerun.
2. **Supabase CLI (if adopted later).** Move files into
   `supabase/migrations/` (matching the CLI's expected layout) and run
   `supabase db push`. The project does not currently use the CLI; this
   is documented for future use only.

For a brand-new database, run [`../SCHEMA.sql`](../SCHEMA.sql) first,
then apply any migrations dated after the schema's "as of" header in
order. SCHEMA.sql is kept current with applied migrations folded in,
so on a clean install most files in this directory will be redundant
but harmless to re-run (each is idempotent or guarded).

## Adding a new migration

1. Create `YYYY-MM-DD_description.sql` in this directory.
2. Write the migration. Prefer idempotent statements (`IF NOT EXISTS`,
   `DROP ... IF EXISTS` before `CREATE`, `ON CONFLICT DO NOTHING` for
   seeds) so re-running is safe.
3. If the migration changes structure (new table, new column, changed
   CHECK constraint), update [`../SCHEMA.sql`](../SCHEMA.sql) in the
   same commit so the canonical schema stays current.
4. Apply it in Supabase, then update the table above with status
   APPLIED.
