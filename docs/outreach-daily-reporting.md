# Outreach daily ingestion and reporting contract

Status: v3 implemented locally, inactive, and closed to production writes by
default. Its compatibility migration is pending. Existing workflows and the
live dashboard remain unchanged.

## Business rule

For every `America/Denver` calendar month and Outreach sequence:

- enrollment activity is the sum of prospects added during each day;
- v3 email, call, and LinkedIn activity is summed from dated activity records
  captured inside each closed Denver day;
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

`artifacts/[Sourced] - Outreach Daily Activity Ingestion v3 - DISABLED.json`

It is scheduled for **11:50 PM America/Denver** and extracts the **prior fully
closed Denver day**. This intentionally creates a one-day reporting lag: the
run at 11:50 PM on August 20 stores August 19. It never captures an unfinished
day and therefore does not lose the last minutes at a month boundary.

The natural key is `snapshot_date + sequence_id`. A retry updates the same
Google Sheet row and the same Supabase row.

The workflow sequence is:

1. Resolve the prior closed Denver day, including DST boundaries.
2. Read every Outreach sequence with complete pagination and an exact count.
3. Read that day's sequence-state enrollments with global pagination.
4. Read the current active sequence-state snapshot.
5. Read dated mailings, completed outbound calls, and completed LinkedIn tasks
   with global pagination. Event timestamps are rechecked inside the workflow.
6. Validate source pagination, row count, and unique natural keys.
7. Append or update `Daily Sequence Activity v3` in the approved QA Sheet.
8. Package an aggregate-only result.
9. Route to the dry-run terminal unless both apply confirmations are exact.
10. In apply mode only, invoke the protected Supabase RPC and reconcile its
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

Migration `2026-08-24_outreach_daily_activity_inputs.sql` adds an explicit
`activity_basis` and the v3 wrapper
`sourced_apply_outreach_daily_activity_v2(jsonb,jsonb)`. Existing v2 rows keep
the `legacy_cumulative` basis; v3 rows are stored as `daily_event`. Reporting
may use both histories without pretending that the older cumulative rows were
event-level measurements.

The workflow ships with:

```js
const MODE = 'dry_run';
const CONFIRM = '';
```

An apply requires both:

```js
const MODE = 'apply';
const CONFIRM = 'APPLY APPROVED OUTREACH DAILY ACTIVITY TO SOURCED';
```

The apply gate rechecks the phrase and every completeness invariant. The
Supabase credential is selected in n8n; no key is embedded in the workflow.

## Controlled rollout

1. Merge the code change.
2. Apply the pending migration manually and verify the RPC privileges.
3. Import the generated workflow and leave it inactive.
4. Create the `Daily Sequence Activity v3` tab using the workflow's documented
   columns. Attach the Outreach OAuth credential to the six `READ:` nodes, the Google
   Sheets credential to the QA node, and the Supabase service-role Header Auth
   credential only to the `APPLY:` node.
5. Run in dry-run mode and share only `DRY RUN: aggregate summary`.
6. Reconcile the Sheet against Outreach, including a month boundary.
7. Authorize one apply, then repeat it and prove that the same daily keys were
   updated rather than duplicated.
8. Restore dry-run mode until activation is explicitly approved. Keep v2
   published during QA; publish v3 and archive v2 only after the comparison is
   accepted.

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
