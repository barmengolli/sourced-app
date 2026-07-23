# Outreach sequences → Supabase: n8n source contract

Audited 2026-07-23 (Bite 3A) against a read-only exported workflow JSON and a
read-only CSV export of the destination Sheet. **This audit does not prove the
live database schema or the live n8n instance state**; it documents the
exported artifacts and the destination data they produced.

No credentials, private service URLs, Sheet identifiers, sequence IDs, or
complete source rows appear in this document.

## Business purpose

Weekly automated snapshot of every 2026 Outreach sequence's lifetime counters
(sends, delivery, engagement, replies, calls, tasks) so Sourced can derive
per-period activity without querying Outreach live. Feeds the Outreach Data,
Dashboard, and Compare pages.

## Source system and workflow

- Source: the Outreach REST API (`/api/v2/sequences` plus per-sequence count
  queries against `sequenceStates`, `tasks`, and `calls`).
- Workflow: a single n8n workflow ("Outreach Automated Reporting") with a
  Schedule Trigger, one sequences fetch, six per-sequence count fetches
  (prospects added/active, total/overdue/LinkedIn tasks, outbound calls,
  calls answered), a merge/code step, a Google Sheets append, and a Supabase
  upsert.
- Destinations: a Google Sheet tab (human-readable audit trail) and the
  Supabase table `outreach_snapshots` (what Sourced reads).

## Schedule and timezone

- Intended: **every Thursday at 8:00 a.m. Mountain time**.
- Actual trigger: weekly, `triggerAtDay: [4]` (Thursday), `triggerAtHour: 8` —
  but the exported workflow has **no explicit timezone** (the settings block
  contains none). The effective hour therefore follows the instance default and
  can drift across daylight-saving changes.
- Recommendation (separate n8n follow-up, not this bite): set the workflow
  timezone explicitly to `America/Denver`.

## Row grain and natural key

- One row per **sequence per export run**.
- `export_date` = `new Date().toISOString().split('T')[0]` at run time (UTC
  calendar date of the run).
- `year` = the n8n runtime's current year (`now.getFullYear()`), not derived
  from any source field.
- `week_number` = a custom `Math.ceil(...)` day-count formula, **not ISO 8601**.
  Do not trust it for Month/Quarter/Year boundaries; period assignment must use
  `export_date` calendar boundaries.
- Natural key: **(`export_date`, `sequence_id`)**.
- `sequence_id` is the stable identity. The data contains one sequence whose
  `sequence_name` changed between runs under the same `sequence_id`; names are
  labels, not identity.

## Destination behavior

- **Google Sheet: append** (`values/...:append`, `INSERT_ROWS`). Every run adds
  rows; a rerun on the same day appends duplicates. The Sheet has no key.
- **Supabase: upsert** with `on_conflict=export_date,sequence_id` and
  `Prefer: resolution=merge-duplicates`. A rerun on the same day overwrites
  that day's rows idempotently.
- Consequence: the Sheet and the table can disagree after a rerun. The Sheet
  showed 22 duplicate natural keys (all from one date); Supabase would hold one
  row per key (the last write).

## Known workflow limitations (documented, not fixed here)

- **Hardcoded `[2026]` filter.** Sequences are selected by the literal string
  `'[2026]'` in the sequence name. 2027 sequences will silently vanish from the
  feed until this is generalized.
- **No cursor pagination.** The sequences request uses `page[size]=200` with no
  `page[after]` cursor loop. Above 200 matching sequences, rows would be
  silently truncated.
- **Missing vs zero erased at ingest.** Every numeric is transformed with
  `parseInt(value) || 0`, so a missing source value becomes a stored `0`. The
  Sheet preserves blanks; the Supabase rows do not. Downstream consumers must
  treat suspicious zeros in known-uncovered ranges as missing (see coverage
  notes below).
- **Rates are Sheet-only.** The workflow computes `delivery_rate`, `open_rate`,
  `click_rate`, `reply_rate`, `bounce_rate`, `opt_out_rate` as formatted
  strings for the Sheet. The Supabase transform does **not** send them. All
  rates must be recomputed from aggregated count numerators and denominators;
  never average stored percentages.
- **`calls_answered` schema drift (unresolved).** The workflow sends
  `calls_answered` to Supabase, but the repository's `OutreachSnapshot` type
  and `SCHEMA.sql` have no such column. Whether the live table accepts or
  drops it is unverified. Do not build on this field until the drift is
  resolved in a separate schema change.

## Observed destination data (read-only CSV audit)

- 591 rows, 41 distinct sequences, 21 distinct export dates from 2026-03-18
  through 2026-07-23.
- Expected **Thursday** snapshots present every week from 2026-03-19 through
  2026-07-23.
- Two extra **Wednesday** snapshots: 2026-03-18 and 2026-05-20 (manual or
  ad-hoc runs).
- 22 duplicate (`export_date`, `sequence_id`) natural keys, all from
  2026-05-07: 15 duplicate groups identical, 7 with changed values (a rerun
  after data moved). The Sheet kept both; Supabase would keep the last.
- One `sequence_id` appears under two names (rename).
- **`calls_answered`** is blank before 2026-07-16 (the metric was added then).
- **`linkedin_tasks_completed`** is populated through 2026-07-09 but blank on
  2026-07-16 and 2026-07-23 (coverage break, likely when calls_answered was
  added). LinkedIn-task activity in the uncovered range is unknown, not zero.

## Metric classification

| Class | Fields | Aggregation rule |
|---|---|---|
| Derived cumulative activity counters | `total_sent`, `delivered`, `bounced`, `failed`, `opened`, `clicked`, `replied`, `positive_replies`, `neutral_replies`, `negative_replies`, `opted_out`, `outbound_calls` | Period activity = end-of-period counter − last counter before the period (baseline). Verified monotonically non-decreasing in the deduplicated data. |
| Conditional cumulative counter | `linkedin_tasks_completed` | Same rule, but **only while source coverage is present and continuous**. Suppress across the observed coverage break. |
| Point-in-time / status | `enabled`, `step_count`, `duration_days`, `prospects_active`, `overdue_tasks` | Snapshot semantics: latest eligible value; never summed or differenced as activity. |
| **Not approved** as derived activity | `contacted_prospects`, `replied_prospects`, `prospects_added`, `total_tasks` | Decreases exist in the supplied data (12, 1, 5, and 7 per-sequence decreases respectively), so differencing produces wrong or clamped numbers. Do not report these as period activity. |
| Rates | delivery, open, click, reply, bounce, opt-out | Recompute from aggregated activity numerators/denominators per period. Never average stored percentages. |

## Derived-activity rules (the calculation contract)

Reporting basis: **Derived activity** — period activity calculated from
cumulative snapshots. Note: Thursday snapshots approximate calendar boundaries;
"March activity" is really activity between the last snapshot on/before
March 1 and the last snapshot within March, not exact midnight-to-midnight.

- **Baseline behavior (exact boundary, per sequence and metric).** A period's
  complete activity for a sequence requires a baseline taken from the EXACT
  scheduled boundary-Thursday row (the Thursday immediately before the period
  start) with a NON-NULL measurement for the requested metric, plus the last
  valid snapshot inside the period. Activity = end − boundary baseline. An
  older snapshot is never promoted to a complete baseline — that would
  silently widen the measurement window even when the boundary Thursday exists
  for other sequences. The requirement is metric-specific: a null LinkedIn
  measurement on the boundary row invalidates only LinkedIn, not `total_sent`
  measured on the same row. When the sequence existed at the boundary but the
  exact row/measurement is absent, the result is an explicit missing-baseline
  condition. Exemptions: a sequence whose entire history starts after the
  boundary Thursday (debut in the boundary gap or inside the period) keeps
  debut semantics (growth from its first known value, flagged incomplete), and
  a boundary that predates the feed itself is waived (pre-feed exemption).
- **Newly appearing sequence.** A sequence's first-ever snapshot is a lifetime
  total, not period activity: it must **never** be counted as "debut volume."
  Later increases from that first snapshot may be counted, but the
  sequence/period is marked incomplete because earlier activity is unknown. A
  zero baseline is never invented.
- **Metric-specific missing coverage.** A snapshot row can exist while ONE
  metric's measurement is null (the observed LinkedIn-task break; pre-launch
  `calls_answered`). A null measurement inside the period marks that metric's
  result with an explicit missing-measurement state: the known partial value is
  retained but the metric is incomplete (a trailing null means later activity
  is unknown; an interior null hides potential resets). Aggregates count these
  gaps in their issues and are marked incomplete; comparison deltas are
  suppressed whenever either side's metric coverage is incomplete. Global
  row-date completeness alone cannot detect this.
- **Missing-run behavior.** A missing expected Thursday inside or bounding a
  period is flagged (see completeness below); the period is incomplete rather
  than pretending exact coverage.
- **Duplicate-run behavior.** Duplicate natural keys are never summed. With a
  reliable recency signal (e.g. `created_at`), the latest row wins; otherwise
  the key is an ambiguous-duplicate quality issue. Ambiguity is SCOPED: an
  ambiguous duplicate affects a period's result only when it falls inside the
  period or would have served as the affected sequence's baseline; an
  ambiguity in an unrelated older month does not mark every later period
  incomplete.
- **Reset behavior (intermediate detection).** The ordered valid observations
  from the selected baseline through the period end are scanned pairwise. ANY
  consecutive decrease is a reset/correction state — including a mid-period
  drop that later recovers above the baseline (where end-minus-baseline alone
  would report a plausible positive number). Resets are surfaced explicitly and
  never clamped to zero.
- **Missing vs zero.** A missing value stays missing; a measured zero stays a
  zero. (Note the ingest `parseInt||0` caveat above: for ranges with known
  coverage breaks, stored zeros are treated as missing.)
- **Sequence rename.** Identity is `sequence_id`; a rename does not split a
  sequence's history.
- **Data-through and completeness.** The global data-through date is the latest
  `export_date`. The expected cadence is Thursday (America/Denver intent). A
  period is complete only when: (1) the **required boundary baseline** — the
  scheduled Thursday immediately before the period start, when the feed already
  existed then — has a snapshot; (2) every expected in-period Thursday has a
  snapshot; and (3) data has reached the period's final expected Thursday. A
  missing boundary Thursday makes the period partial even when every in-period
  Thursday is present, because falling back to an older snapshot silently
  widens the measurement window; no baseline is invented, and a Wednesday
  snapshot near the boundary does not substitute (any alternative-boundary
  policy would be an explicit future decision, not an assumption). A current
  period before its final expected Thursday is partial. Extra Wednesday/manual
  snapshots never replace a missing Thursday and (because activity is a
  two-endpoint diff, not a row sum) cannot be double-counted. Partial and
  missing periods suppress comparison deltas. **Limitation:** missing expected
  Thursdays (boundary and in-period) are detected and flag the period
  incomplete; the calculation cannot reconstruct what the missing run would
  have measured, so gaps surface as incompleteness, never as corrected
  numbers.
- **Delta suppression (two layers).** The comparison helper returns an
  authoritative METRIC-LEVEL `suppressDelta`: true when the comparison mode is
  off, the comparison period is invalid or unavailable, or either metric total
  is missing or incomplete; false only when both totals are present and
  complete. **Bite 3B must combine this metric-level flag with
  `assessOutreachCompleteness` for BOTH calendar periods** (schedule-level
  Thursday coverage) before showing any delta: the flag covers the metric's
  own data quality; the completeness assessment covers the run cadence.

## Aggregate reconciliation (read-only, deduplicated)

The current dashboard delta logic (`toDeltaSnapshots`) counts each sequence's
first available lifetime value as "debut volume", clamps negative diffs to
zero, and includes the four unapproved fields in its cumulative list, while its
comment claims all fields are monotonically non-decreasing (disproved above).
Because March 2026 is the first month of data, the debut-volume rule counts
every sequence's lifetime-to-date counter as March activity:

| Metric | Current-style March | Safe-known March | Overstatement |
|---|---|---|---|
| Emails sent | 3,677 | 503 | 3,174 |
| Delivered | 3,485 | 491 | 2,994 |
| Opened | 827 | 177 | 650 |
| Outbound calls | 2,002 | 285 | 1,717 |
| LinkedIn tasks | 1,024 | 70 | 954 |

"Safe-known" counts only increases above an existing prior baseline. The truth
lies at or above safe-known but far below current-style; the difference is
pre-tracking lifetime volume, not March activity.

## Bite 3B implementation status (Outreach Dashboard migrated)

The Outreach **Dashboard** now runs on this contract; the **Data** and
**Compare** tabs are not yet migrated (Data keeps its weekly diagnostic view).

Visible behavior:

- Timeframe is the shared `Month | Quarter | Year` control with a
  `Previous period | Previous year | Off` comparison (Year collapses to one
  option). The legacy Week/Month toggle, quarter buttons, and W-number pills
  are gone from the Dashboard; weekly rows remain in storage and on Data.
- The page discloses `Derived activity: Weekly lifetime counters converted to
  period activity using exact Thursday baselines.` and shows the global
  `Data through <date>` from the latest valid `export_date`, a `Partial
  period` marker, and a `No data for selected period` status. Missing stays
  distinct from measured zero everywhere.
- The default period is the Month containing the latest `export_date`,
  derived from data (never the browser clock); explicit user selections are
  lifted to App state and survive realtime inserts and tab navigation.
- Every panel (KPI cards, Region Performance, Engagement Funnel, Sequence
  Rankings, Activity Heatmap) computes through `src/lib/outreachReporting.ts`.
  The old `toDeltaSnapshots` (debut-volume counting, negative-diff clamping,
  nonmonotonic fields) is deleted. Deltas render only when the metric-level
  `compareOutreachActivity(...).suppressDelta` AND both calendar periods'
  `assessOutreachCompleteness(...).suppressDelta` all allow it. Rankings
  exclude reset / no-baseline sequences with a visible excluded count;
  heatmap cells distinguish measured zeros, missing, and reset/no-baseline
  states; funnel conversion rates recompute from aggregate stage totals and
  show `n/a` when a side is missing.
- The migrated Dashboard reproduces the March 2026 safe-known totals above
  exactly (503 / 491 / 177 / 285 / 70), with every March metric flagged
  incomplete because tracking began mid-month (safe-known, not a claim of
  full capture).

Temporary source normalization: `src/lib/outreachSnapshotAdapter.ts` maps
database rows into the calculation input and converts
`linkedin_tasks_completed` to null (missing) on the two VERIFIED gap dates
(2026-07-16 and 2026-07-23) that the ingest's `parseInt||0` stored as zeros.
This is a stopgap until the n8n workflow preserves nulls end-to-end; arbitrary
zeros and future dates are never blanket-nulled, and the date list lives beside
this doc's coverage notes.

Still pending for later bites: migrating Data/Compare, and the visible-copy
correction on the Data tab ("populated by the n8n cron each Monday" should say
Thursday).

## Future email-variant analytics (design only; not implemented)

Goal: per-email-variant performance (per step, per A/B template) to answer
"which email copy works," beyond the sequence-level rollup above.

### API feasibility (official Outreach documentation)

Confirmed from the official API reference:

1. **`sequenceSteps`** provides step-level information and aggregate metrics:
   `order`, `displayName`, `stepType`, `scheduleCount`, `deliverCount`,
   `bounceCount`, `failureCount`, `openCount`, `clickCount`, `replyCount`,
   `positiveReplyCount`, `neutralReplyCount`, `negativeReplyCount`,
   `optOutCount`.
2. **`sequenceTemplates`** represents each individual email variant within a
   step and provides: `enabled`, `isReply`, `scheduleCount`, `deliverCount`,
   `bounceCount`, `failureCount`, `openCount`, `clickCount`, `replyCount`,
   `positiveReplyCount`, `neutralReplyCount`, `negativeReplyCount`,
   `optOutCount`, `enabledAt`, `updatedAt`.
3. The related **Template** resource provides: template ID, `name`, `subject`,
   `bodyText`/`bodyHtml`, `trackOpens`, `trackLinks`, `updatedAt`.

The Outreach UI's "Interested" figure **probably** maps to
`positiveReplyCount`, but this requires a read-only tenant reconciliation
against one known sequence before implementation. Tenant OAuth permissions and
exact UI parity are **not** verified here; both require a credentialed,
read-only test.

References (official documentation only):
- https://developers.outreach.io/api/reference/sequence-step
- https://developers.outreach.io/api/reference/sequence-template
- https://developers.outreach.io/api/reference/template/paths/~1templates/post
- https://developers.outreach.io/api/reference/mailing
- https://developers.outreach.io/api/making-requests
- https://developers.outreach.io/api/getting-started

### Proposed future architecture (separate path; do not extend the current one)

- A **separate n8n workflow** for email-variant snapshots.
- A **separate Google Sheet** for human-readable audit/reference.
- A **separate Supabase table**, provisionally `outreach_email_variant_snapshots`.
- Do **not** add repeating email-variant columns to `outreach_snapshots`.

Proposed row grain — one row per:

`export_date` + `sequence_id` + `sequence_step_id` + `sequence_template_id`

Proposed fields: `export_date`, `sequence_id`, `sequence_step_id`,
`sequence_template_id`, `template_id`, `step_order`, `step_type`,
`template_name`, `subject`, `enabled`, `is_reply`, `scheduled`, `delivered`,
`bounced`, `failed`, `opened`, `clicked`, `replied`, `positive_replies`,
`neutral_replies`, `negative_replies`, `opted_out`, `track_opens`,
`track_links`, `template_updated_at`.

Constraints for the future implementation:

- The Supabase natural-key upsert is canonical; Google Sheet append behavior
  alone does not prevent duplicate reruns, so a Sheet rerun policy must be
  defined.
- Variant metrics are cumulative lifetime counters and require the same
  baseline/reset/completeness rules as the sequence-level contract above.
- Rates must be recalculated from aggregated counts.
- Do **not** store recipients, prospect relationships, mailbox addresses, or
  any customer/prospect PII.
- Prefer subject/name metadata initially; do not store full email bodies
  without an explicit product and security decision.
- Editing email content in place mixes old and new copy under the same lifetime
  counters; store `template_updated_at` to detect copy changes, and for clean
  experiments create a **new** variant/template when content changes
  materially.
- The existing OAuth connection may require additional read scopes.
- Cursor pagination and rate-limit handling are mandatory.
- A **read-only one-sequence API proof** must happen before creating the
  workflow or the schema.
- Consider running this workflow after, rather than simultaneously with, the
  sequence-summary workflow (shared rate limits and consistent export dates).
