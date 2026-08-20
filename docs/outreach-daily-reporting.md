# Outreach daily ingestion and reporting contract

Status: implemented locally, inactive, and closed to production writes by
default. The production migration is pending. The existing weekly Outreach
workflow and dashboard source remain unchanged.

## Business rule

For every `America/Denver` calendar month and Outreach sequence:

- enrollment activity is the sum of prospects added during each day;
- email, call, and LinkedIn activity is the last cumulative counter in the
  period minus the last counter before the period;
- active prospects and sequence configuration are the latest known state at
  period end; and
- rates are recomputed from the resulting period totals.

Sequence count and sequence age never enter those formulas. A sequence that
starts during a month has a legitimate zero baseline at creation.

Examples locked by tests:

- July has 1,000 emails and August has 1,500: report 1,000 and 1,500.
- Ten enrollments today plus twenty tomorrow: report 30 for the month.
- A new sequence with no earlier snapshot does not make the month incomplete.
- Missing source measurements remain missing; they are never converted to zero.

## Daily extraction

The generated inactive workflow is:

`artifacts/[Sourced] - Outreach Daily Ingestion v2 - DISABLED.json`

It is scheduled for **11:50 PM America/Denver** and extracts the **prior fully
closed Denver day**. This intentionally creates a one-day reporting lag: the
run at 11:50 PM on August 20 stores August 19. It never captures an unfinished
day and therefore does not lose the last minutes at a month boundary.

The natural key is `snapshot_date + sequence_id`. A retry updates the same
Google Sheet row and the same Supabase row.

The workflow sequence is:

1. Resolve the prior closed Denver day, including DST boundaries.
2. Read every Outreach sequence with complete pagination and an exact count.
3. Read that day's sequence-state enrollments for each sequence.
4. Read current active prospects and cumulative email, call, and LinkedIn
   counters.
5. Validate row count and unique natural keys.
6. Append or update `Daily Sequence Snapshots v2` in the approved QA Sheet.
7. Package an aggregate-only result.
8. Route to the dry-run terminal unless both apply confirmations are exact.
9. In apply mode only, invoke the protected Supabase RPC and reconcile its
   returned date and row count.

## Storage and write safety

Migration `2026-08-20_outreach_daily_ingestion.sql` adds:

- `outreach_daily_runs`: one extraction manifest per Denver day;
- `outreach_daily_snapshots`: one sequence row per Denver day; and
- `sourced_apply_outreach_daily_snapshot(jsonb,jsonb)`: an atomic,
  service-role-only apply boundary.

The RPC refuses incomplete pagination, count mismatches, duplicate keys,
mixed dates or timezones, and stored-day totals that differ from the run
manifest. It is revoked from PUBLIC, anon, and authenticated roles.

The workflow ships with:

```js
const MODE = 'dry_run';
const CONFIRM = '';
```

An apply requires both:

```js
const MODE = 'apply';
const CONFIRM = 'APPLY APPROVED OUTREACH DAILY SNAPSHOT TO SOURCED';
```

The apply gate rechecks the phrase and every completeness invariant. The
Supabase credential is selected in n8n; no key is embedded in the workflow.

## Controlled rollout

1. Merge the code change.
2. Apply the pending migration manually and verify the RPC privileges.
3. Import the generated workflow and leave it inactive.
4. Attach the Outreach OAuth credential to the five `READ:` nodes, the Google
   Sheets credential to the QA node, and the Supabase service-role Header Auth
   credential only to the `APPLY:` node.
5. Run in dry-run mode and share only `DRY RUN: aggregate summary`.
6. Reconcile the Sheet against Outreach, including a month boundary.
7. Authorize one apply, then repeat it and prove that the same daily keys were
   updated rather than duplicated.
8. Restore dry-run mode until activation is explicitly approved.

## Dashboard cutover gate

The current Sourced Outreach dashboard still reads weekly cumulative snapshots
with exact-Thursday baselines. Daily and weekly rows must not be combined.

Keep the weekly workflow and dashboard unchanged until the daily feed has:

- consecutive complete runs;
- one overlap with the weekly source;
- exact reconciliation for selected sequences and aggregate counters; and
- a deliberate dashboard cutover change with its own tests.

Only then should the dashboard switch to the daily calculation engine in
`src/lib/outreachDailyReporting.ts`. This ingestion change alone cannot alter
the live Outreach reports.
