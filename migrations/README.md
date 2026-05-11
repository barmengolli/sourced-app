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
