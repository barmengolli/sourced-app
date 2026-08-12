# sourced: Claude Code instructions

Status: Active canonical instructions
Last verified against the repository: 2026-07-21
Owner: Marketing Operations

This is the single active instruction document for Claude Code in this
repository. Read it completely before every task and follow it strictly.

The checked-in code and live database are the final evidence when they conflict
with this file. Do not silently choose one. Investigate the difference, report
it to Benjamin, and update this file as part of an approved change.

## 1. Application overview

`sourced` is an internal B2B marketing attribution and lead-tracking SPA for
EIS Group's Marketing Operations team. It contains customer and prospect
business-contact data and must be treated as sensitive.

The application helps Marketing work around incomplete Salesforce data while
preserving provenance. Its main capabilities are:

- A corrected Salesforce lead ledger with field-level edit locks.
- Computed funnel and conversion reporting.
- HPP and opportunity tracking with multi-touch attribution.
- Campaign tagging across channels and reporting sources.
- Spend, event, BDR quota, Outreach, LinkedIn Ads, and 6sense reporting.

The app is not a CRM and does not replace Salesforce.

Current navigation is defined in `src/constants/sidebar.ts` and routed in
`src/App.tsx`:

| Area | Current pages |
|---|---|
| Marketing Funnel | Data Entry, Leads & MQLs, Opportunities, Events, Spend, Compare |
| Reach & Engagement | 6sense Dashboard, Import |
| BDR Quota | Dashboard, Quotas |
| Outreach | Data, Dashboard |
| LinkedIn Ads | Dashboard |
| Campaigns | Overview, Tags |
| Utilities | User Manual, Feedback & Bug Reports, Leads, Channels, Funnel Import, Settings |

Some pages are marked Beta. Calculation changes on Beta pages still require
tests and before-and-after reconciliation.

`src/pages/CohortPage.tsx` is retained but is not currently routed.

## 2. Current architecture and data sources

### Technology and delivery

- Frontend: React 19, TypeScript 5.9, Vite 8.
- Styling: Tailwind CSS 4 through the Vite plugin.
- Charts: Recharts 3.
- Database: Supabase PostgreSQL with realtime subscriptions.
- Hosting: Vercel, automatically deployed from `main`.
- CI: GitHub Actions on Node 24.
- Testing: Vitest with pure and jsdom component tests.
- Package manager: npm with a committed lockfile.

AWS hosting is being discussed but has not replaced Vercel or Supabase.

### Repository map

| Path | Responsibility |
|---|---|
| `src/App.tsx` | Top-level routing and shared section state |
| `src/constants/sidebar.ts` | Navigation structure and labels |
| `src/pages/` | Page-level reporting and operations surfaces |
| `src/components/` | Reusable UI grouped by domain |
| `src/hooks/` | Supabase reads, writes, realtime, and mutations |
| `src/lib/compute.ts` | Current consolidated reporting calculations |
| `src/lib/leadSync.ts` | Typed edit-lock import and merge logic |
| `src/lib/dates.ts` | Calendar and ISO-week helpers |
| `src/lib/campaignScorecard.ts` | Cross-source campaign scoring |
| `src/types/db.ts` | Application data interfaces |
| `src/test/` | Test setup and factories |
| `SCHEMA.sql` | Intended fresh-database schema |
| `migrations/` | Incremental SQL and migration ledger |

### Core database tables

- `channels`: hierarchical marketing channel taxonomy.
- `leads`: corrected Salesforce lead mirror with locks and provenance.
- `attributions`: one row per deal stage.
- `attribution_touches`: ordered channel touches.
- `campaign_costs`: date-range budgets and costs by channel.
- `funnel_projections`: stored quarterly projections.
- `funnel_actuals`: manual quarterly fallback actuals.
- `cell_comments`, `cell_links`: funnel-cell annotations.
- `outreach_snapshots`: weekly cumulative sequence snapshots.
- `linkedin_ads_snapshots`: weekly additive ad-set totals.
- `sixsense_snapshots`: monthly point-in-time summaries.
- `bdr_quotas`: annual HPP and Opp targets by BDR.
- `campaign_tags`, `campaign_tag_links`: cross-source manual campaign tags.

For database work, inspect `SCHEMA.sql`, relevant migrations, application
types, and the live catalog when authorized. Migration status documentation
alone is not proof of production state.

### Data sources and ingestion

#### Salesforce leads

- An n8n workflow extracts leads from Salesforce into a Google Sheet.
- The prepared Sheet data is then brought into `sourced` through the Funnel
  Import workflow. The app does not currently query Salesforce directly.
- Email is the canonical match key and is normalized to lowercase.
- Parent Campaign and Campaign Name can populate the channel hierarchy.
- Imports must honor field locks and update source provenance.
- Event Activation is a validated label array without individual activation
  timestamps.
- Lifecycle state is tracked separately in the `sf_lifecycle_*` observation
  ledger, because Bite 4G1 proved the Salesforce org holds zero lifecycle
  field history, so past movement cannot be reconstructed and truth must be
  accumulated forward. A first observation is a BASELINE recording the state
  first seen, never a transition: `null -> mql` means "first observed as
  MQL", not "moved from Lead to MQL". The contracts are in
  `docs/lead-lifecycle-observation-ledger.md` (storage and planning),
  `docs/lead-lifecycle-atomic-apply.md` (serialization and the restricted
  apply function), and `docs/lead-lifecycle-ingestion-dry-run.md` (scope,
  extraction, and the disabled dry run). Read them only when working on
  lifecycle sync. Ingestion is not built or active: nothing writes to
  these tables today, and the ledger observes only people Sourced already
  anchors by exact Salesforce id, never the whole org.

#### Opportunities and attribution

- HPP and later stages are managed in the application.
- Rows for one logical deal share `deal_id`.
- `stage_entered_at` records entry into each deal stage.
- Ordered touches are stored separately.
- An HPP may be created without a linked lead. Source channel is the required
  attribution evidence.
- The approved Salesforce Opportunity daily-ingestion contract is documented
  in `docs/salesforce-opportunity-daily-ingestion.md`. Its exact scope is
  2025-2026 `New Project` records in the three funnel record types;
  `SaaS_Revenue_USD__c` is primary visible revenue while `Amount` and
  `SaaS_Revenue__c` remain stored. Source fields refresh nightly, separate
  reviewer overrides win, approved creator names become BDR suggestions only
  (never automatic attribution). The supporting migration was applied and
  permission-verified on 2026-08-12. The initial staging apply then stored 71
  snapshots and created 71 pending reviews; direct SQL reconciliation matched
  the accepted scope exactly, and an immediate retry wrote 0 snapshots and 0
  reviews. Daily ingestion may stage new or changed records, but it must never
  approve attribution automatically or overwrite reviewer-owned fields.
  The pending v3 workflow additionally reads OpportunityFieldHistory and
  runtime RecordType references through native Salesforce nodes. The
  repository planner is the only movement authority: raw regressions remain
  append-only while later reporting promotion derives a reversible
  current-qualified HPP / Opportunity / Pursuit path.

#### Outreach

- Populated by a scheduled n8n workflow intended for Thursdays 8:00 Mountain;
  the exported workflow stores no explicit timezone.
- Rows are weekly cumulative lifetime counters per sequence, keyed by
  (`export_date`, `sequence_id`). `sequence_id` is the stable identity;
  sequence names can change. The stored `week_number` is a custom formula, not
  ISO; period math must use `export_date` calendar boundaries.
- Reporting basis is Derived activity: end-of-period counter minus a real
  pre-period baseline. A sequence's first-ever snapshot is lifetime volume,
  never period activity; negative diffs are resets, never clamped; duplicate
  natural keys are never summed; missing stays distinct from zero.
- Only the audited cumulative counters may be differenced.
  `contacted_prospects`, `replied_prospects`, `prospects_added`, and
  `total_tasks` decrease in real data and are not activity counters.
  `linkedin_tasks_completed` has a source coverage break; rates are always
  recomputed from aggregated counts.
- Known source limitations: hardcoded `[2026]` name filter, `page[size]=200`
  with no cursor pagination, Sheet append vs Supabase upsert divergence,
  `parseInt||0` missing-to-zero coercion, and unresolved `calls_answered`
  schema drift.
- Outreach uses its own legacy five-region taxonomy inferred from sequence
  names.
- **The Outreach Dashboard is migrated (Bite 3B/3C):** it uses Month, Quarter,
  and Year with Derived activity, exact Thursday baselines, standardized
  Previous period / Previous year / Off comparisons, and combined
  metric-level + cadence-level delta suppression. It shows a screenshot-ready
  Sequence performance table (all metrics per sequence; rates recomputed from
  aggregate counts; Prospects is a point-in-time snapshot, not totaled), and
  reason-specific data-quality disclosures sourced from the same Bite 3A
  results (comparison Off never hides them). Weekly rows are retained only as
  source/diagnostic detail on the Data tab; the Dashboard has no Week control.
- **Outreach Compare is retired (Bite 3C):** its nav item is removed and the
  legacy route redirects to the Dashboard; the Compare page source is kept but
  unrouted. The Data tab is unchanged and not yet migrated.
- The full audited contract, reconciliation, the Bite 3B/3C implementation
  status, and the future email-variant design are in
  `docs/outreach-n8n-mapping.md`; read it when working on this integration.

#### LinkedIn Ads

- Populated by n8n from a weekly Google Sheet.
- Rows are additive weekly totals per ad set, not cumulative counters.
- `snapshot_date` is the **week-ending Sunday**. The source `Week` column is
  `MM/DD/YYYY` and always names that Sunday.
- **Reporting basis: Activity.** A whole week is assigned to the month, quarter,
  and year that contain its week-ending Sunday. Weeks are never prorated or
  split across calendar months, and no daily values are invented. The dashboard
  discloses "Activity: Weekly LinkedIn Ads activity assigned by week-ending
  Sunday" and shows "Data through week ending <date>".
- Standard grains are Month, Quarter, and Year (Bite 2 migration). Week is
  retained in storage but is not an executive-dashboard control.
- Completeness uses the week-ending convention: a period is complete when the
  latest imported `snapshot_date` reaches the final Sunday belonging to that
  period; otherwise it is Partial and deltas are suppressed. This cannot detect
  a missing intermediate weekly run.
- CTR, CPC, and CPM must be recalculated from aggregated numerators and
  denominators, never averaged across weeks.
- Current n8n limitations (separate follow-up, not app work): the workflow
  timezone is not stored explicitly (schedule is "Every Monday 12:00 Mountain"),
  and the read tab is hardcoded to `Q3 S`.
- The detailed mapping is in `docs/linkedin-n8n-mapping.md` and should be read
  only when working on that integration.

#### 6sense

- Imported manually through the 6sense CSV Import page.
- Rows are monthly point-in-time summaries per segment.
- The legacy `week_number` column stores month number `1..12`. Never interpret
  it as an ISO week in 6sense code.

#### Campaigns

- Campaigns are manual tags over channels, 6sense segments, Outreach
  sequences, and LinkedIn ad sets.
- One asset may belong to multiple tags.
- A shared asset counts in full for each campaign claiming it. Campaign totals
  can overlap and must not be summed into a company total.

The repository does not contain sanitized exports for every live n8n workflow.
Do not claim a complete workflow audit from repository evidence alone.

## 3. Business-critical rules

### Lead edit-lock contract

When a user edits an editable lead field:

1. Save the corrected value.
2. Set `field_locks[field] = true`.
3. Set `last_edited_by` and update timestamps.

During Salesforce import or future synchronization:

1. A locked field keeps the Marketing value.
2. The incoming Salesforce value still updates `source_sfdc[field]`.
3. An unlocked field may be overwritten and also updates `source_sfdc`.
4. `last_synced_at` is always updated.

The typed builders in `src/lib/leadSync.ts` are the core implementation. Any
change requires edit-lock regression tests.

### Computed actuals and stored planning values

- Lead-level actuals are computed from source records.
- Lead stage uses `marketing_sourced_date`.
- MQL uses stage history under the view's stated cohort or activity rule.
- HPP and later stages use attribution records.
- Projections are stored quarterly in `funnel_projections`.
- `funnel_actuals` is a quarterly fallback where source records do not cover a
  historical cell.
- Never invent monthly values from a quarterly fallback.

### Deal and HPP contract

- `lead_id` is optional.
- Source channel is required when creating an HPP.
- Never fabricate or require a lead merely to make a deal count.
- A null `lead_id` does not prove Sales origin.
- Label a leadless deal `Sales-sourced` only when its top-level channel is
  `Sales Generated`. Otherwise use `No linked lead`.
- Preserve the unique logical deal and stage relationship.

### Funnel cohort and attribution contract (foundation)

`docs/funnel-source-contract.md` is the canonical contract for funnel cohort,
lifecycle-history, and attribution semantics. Summary:

- Stage counts are non-additive memberships: never sum stages into a
  total-person or total-opportunity count. Unique totals come from unique
  people (`leadId`) and unique deals (`deal_id`).
- The Data Entry grid is stage activity: Lead stays in its membership period;
  MQL, HPP, Opp, and Pursuit belong to their own effective stage periods.
  The adjacent Conversion panel is separate cohort reporting: selected-period
  Leads and HPPs are followed forward rather than dividing activity totals.
- Lifecycle is a repeatable event history (Lead > MQL > Lead > MQL). First
  valid conversion drives cohort MQLs; later ones are requalifications.
  Dates carry provenance (`salesforce_confirmed`, `n8n_observed`,
  `unknown`); unknown dates are never invented, reverse dates are flagged.
- Primary source (earliest valid touch, mutually exclusive, locks win) is
  separate from campaign influence (overlapping by design, never an
  efficiency denominator).
- Efficiency comparisons across cohorts of different maturity are suppressed
  until a maturity-alignment rule is selected.

Pure foundations remain in `src/lib/funnelCohorts.ts` and
`src/lib/campaignAttribution.ts`; the live cohort conversion calculation is
`src/lib/funnelConversionCohorts.ts` and `computeGrid` now renders stage
activity. The contract doc also records the current nightly
SFDC CampaignMember workflow's verified gaps and the open Salesforce
field-name questions.

`docs/opportunity-stage-history-contract.md` defines the Opportunity
movement and velocity contract: the funnel level is the Opportunity Record
Type (HPP/Opportunity/Pursuit via a closed alias mapping, never RecordType
IDs), movement is non-monotonic (regressions, skips, re-entries, Nurture
visits), and `src/lib/opportunityStageHistory.ts` derives an append-only
movement ledger plus a current path where a regression clears higher-stage
dates without deleting history, skipped stages stay null, and velocity uses
only the current valid path (null, never zero, when unavailable). Terminal
status (won/lost/reopened) comes from the detailed Stage field, separately
from record-type movement. Not wired into dashboards, Create HPP, or
attributions.

`docs/opportunity-ledger-storage.md` defines the storage for that contract
(Bite 5B): five `sf_opportunity_*` tables in an authored but UNAPPLIED
migration (`migrations/2026-07-24_opportunity_ledger_storage.sql`) covering
the Salesforce snapshot, an append-only event ledger (unique History ID,
UPDATE/DELETE blocked by trigger), 1:1-while-active deal links keyed only by
exact Salesforce Opportunity ID, a review inbox (channel mandatory before
approval, lead optional, constrained issue codes), and sync runs with
SystemModstamp/history-CreatedDate watermarks. RLS is enabled with no
policies (no anon access; service-role ingestion and a future authenticated
review API are the writers). `src/lib/opportunityImportStorage.ts` holds the
pure state-machine/approval/link/duplicate validation. Derived milestones
are never persisted; Bite 5A remains the only calculation path. Nothing is
activated: no ingestion, no live deal creation or linking, no dashboard
change.

`docs/salesforce-opportunity-sync.md` (Bite 5C1) proves the Opportunity
extraction read-only before any ingestion: a DISABLED, manual-trigger-only
n8n dry-run template (embedded in the doc, statically tested for zero
write-capable nodes and no embedded credentials) that describes the
Opportunity object for exact custom-field API names, pulls included deals
by RecordType.DeveloperName plus their OpportunityFieldHistory with full
timestamps, and emits an aggregates-only summary (dry_run: true,
writes_attempted: 0). `src/lib/salesforceOpportunitySync.ts` is the pure
mapping layer into the Bite 5A contract (batching, scope counts,
buildDryRunSummary via the real 5A derivation and 5B review seeding).
CreatedDate-only backfills are documented unsafe; watermarks are
SystemModstamp plus history CreatedDate. Nothing is written anywhere and
5C2 requires the listed approvals first.

`docs/opportunity-staging-ingestion.md` (Bite 5C2A) is the staging
ingestion foundation: `src/lib/opportunityIngestionPlanner.ts` turns 5C1
discovery results plus protected staging state into an allowlisted plan
(snapshot upserts, append-only event inserts, coupled review
creates/updates, sync-run diagnostics; the type system contains no
approval, link, deal, or attribution operation and only the six
`sf_opportunity_*` tables). Eligibility: current hpp/opp/pursuit, open or
created in the configured cohort year (2026 first run); Service and
unknown types are excluded from the queue but still staged; linked deals
sync without reapproval (Service moves preserve links and derive funnel
unavailability; returns restore without review); decided reviews are never
reopened. The applied restricted SECURITY DEFINER function from
`2026-07-27_opportunity_ingestion_apply_fn.sql` provides atomic batch writes
with watermarks only on full success. The 2026-08-12 v2 contract and state
reader are also applied. The generated daily workflow remains disabled and
closed to apply until its manual dry run reconciles. Staging never affects
visible reporting.

`docs/salesforce-lifecycle-history-mapping.md` extends this with the
Salesforce field-history ingestion foundation:
`src/lib/salesforceLifecycleHistory.ts` is a pure adapter from
LeadHistory/ContactHistory-shaped rows to the lifecycle contract. History
record Id is the idempotency key, field API names are configuration (the
exact lifecycle field name is still admin-unconfirmed), Lead/Contact identity
requires a verified conversion map, unknown or contradictory values route to
review, and persons whose lifecycle predates available history carry an
incomplete-baseline flag. API history retention (24 months maximum without
Field Audit Trail) is insufficient for the two-year cycle, so the long-term
pattern is a regular ingest into an application-owned append-only store; that
store, the n8n change, and all dashboard wiring remain unimplemented.

### Identity and deduplication

- Lead email is the canonical identity key and is stored lowercase.
- An import matching an existing email is an update, not an insert.
- System IDs are retained for provenance but are not the current match key.
- Every source upsert needs a documented natural key and must be idempotent.

### Regions

- Funnel reporting uses `src/constants/regions.ts`.
- Outreach uses `src/constants/outreachRegions.ts`.
- Do not silently merge these taxonomies.

### Schema changes

For an approved structural database change:

1. Verify the live catalog.
2. Add an incremental migration.
3. Update `SCHEMA.sql` in the same change.
4. Prefer idempotent SQL where practical.
5. Record actual migration status after execution.

Do not apply a migration without explicit authorization.

## 4. Reporting timeframe and delta standard

These rules apply to every current reporting surface as it is migrated and to
every future source, including email marketing. They do not authorize a bulk
rewrite.

### Standard periods

- Standard grains: Month, Quarter, Year.
- Week may remain as source detail or a diagnostic view, but it is not a
  standard executive-reporting grain.
- Month uses calendar-month boundaries.
- Q1 is January through March, Q2 April through June, Q3 July through
  September, and Q4 October through December.
- Year is January through December.
- Fiscal periods require an explicit product decision before implementation.
- Preserve the finest reliable source grain even when the UI reports a larger
  period.
- Treat ISO date-only values as calendar dates without browser-timezone
  conversion.
- Timestamped sources must declare their reporting timezone.
- Period endpoints are inclusive after source normalization.

### Standard timeframe behavior

Use this order:

`Timeframe: [Month | Quarter | Year] [period] [year]`

- Default dashboards to Month when reliable monthly data exists.
- Default to the latest available period.
- Mark incomplete periods as `Partial` or `Data through <date>`.
- Omit unsupported grains instead of fabricating data.
- Data-entry pages default to their storage grain.
- Page-level timeframe controls apply to all primary KPIs and charts.
- Put fixed full-year or all-time charts in a labeled context section.
- Time controls come before region, campaign, channel, sequence, and search.

### Source classification and aggregation

Classify a source before designing its filters:

| Model | Required aggregation |
|---|---|
| Additive flow | Sum deduplicated records in the period, then recompute rates from total numerators and denominators |
| Cumulative snapshot | Subtract the last value before the period from the last value in the period; detect resets and missing baselines |
| Point-in-time snapshot | Use the latest eligible snapshot at or before period end; never sum snapshots |
| Date range | Prorate by inclusive overlap with the selected period |
| Cohort | Anchor membership to one stated entry event and follow it consistently |
| Coarser historical fallback | Keep the stored grain and annotate it; never spread it into invented smaller periods |

Every report must disclose its reporting basis in plain language. Use one or
more of these standard labels:

- `Cohort`: records are grouped by a stated entry date and followed forward.
- `Activity`: events that occurred during the selected period.
- `Snapshot`: the latest known state as of a stated date. Snapshots are not
  summed across the period.
- `Derived activity`: period activity calculated from cumulative snapshots.
- `Allocation`: a date-range amount prorated into the selected period.

Place the disclosure beside the report title or directly below it. Include the
actual anchor or effective date in the explanation, such as `Cohort based on
marketing sourced date` or `Snapshot as of July 31, 2026`. If one page mixes
models, label each affected section instead of applying one misleading label to
the entire page.

Current source semantics:

| Domain | Model and anchor | Important constraint |
|---|---|---|
| Funnel lead stage | Cohort on `marketing_sourced_date` | Quarterly fallback cannot become monthly bars |
| Funnel MQL stage | Strict cohort on first MQL history date | Keep cohort and activity views distinct |
| Opportunities | HPP cohort or stage activity | Every surface must state which one it uses |
| Funnel spend | Date range plus dated events | Recalculate ratios from period totals |
| Events | Lead cohort with undated activation labels | Do not claim the activation happened in the selected period |
| LinkedIn Ads | Weekly additive flow on `snapshot_date` (week-ending Sunday) | Whole week assigned by its week-ending Sunday; never prorated across months |
| Outreach | Weekly cumulative snapshots on `export_date` (Derived activity, exact Thursday baselines) | Dashboard migrated to Month/Quarter/Year with reset, coverage, and completeness suppression; Data/Compare tabs pending |
| 6sense | Monthly point-in-time snapshot | Quarter and year use the latest snapshot, never a sum |
| BDR quota | HPP cohort against annual quota | Period quota interpretation needs business approval |
| Funnel Data Entry | Quarterly stored values | Do not create monthly editable cells |
| Campaign scorecards | Mixed source models | Each metric follows its source rule |

### Comparison periods

Use a separate control:

`Compare to: [Previous period | Previous year | Off]`

- Previous period means prior month, prior quarter, or prior year.
- Previous year means the same month or quarter in the prior year.
- For Year grain, Previous period and Previous year are identical, so show one
  option.
- Default to Previous period when prior data exists.
- Name the comparison, such as `vs June`, `vs Q2`, or `vs 2025`.
- Cross calendar boundaries correctly, including January and Q1.
- Never silently substitute one comparison mode for another.
- Current and comparison periods must use identical non-time filters and metric
  definitions.

### Delta calculations

For count, currency, duration, and other numeric metrics:

```text
absolute delta = current value - comparison value
relative delta = absolute delta / absolute value of comparison value * 100
```

Calculate at full precision and round only for display.

Rates must be recalculated separately for each period from aggregate
numerators and denominators. Show the absolute difference in percentage points,
using `pp`, plus relative change when valid.

Required zero and missing states:

| Current | Comparison | Display |
|---|---|---|
| Value | Positive | Absolute and relative delta |
| Positive | Zero | Absolute delta and `New`, no infinite percentage |
| Zero | Positive | Absolute and relative delta |
| Zero | Zero | `No change` |
| Value | Missing | `No comparison data` |
| Missing | Any | `No current data` |

Missing data and zero are different facts and must remain different.

### Partial periods and completeness

- Label a partial or incomplete current period.
- Do not compare a partial month with a complete month as equivalent.
- Use equal elapsed windows only when exact daily boundaries are reliable.
- Otherwise suppress the delta and show `Partial period`.
- A missed or stale import makes a completed calendar period incomplete.
- Every source integration needs a `data through` date or equivalent
  completeness signal before current-period deltas can be trusted.

### Delta direction and color

Every metric declares one direction:

- `higher_is_better`
- `lower_is_better`
- `neutral`

Use direction, not mathematical sign alone, to choose color. Leads, replies,
clicks, pipeline, and won revenue are generally higher-is-better. CPL, CPC,
bounce rate, opt-out rate, and days in stage are generally lower-is-better.
Spend and impressions without a goal are neutral.

Use an arrow, sign, label, and color. Color alone never carries meaning. Do not
guess a new metric's direction. Default to neutral until the business owner
approves it.

### New reporting-source checklist

Before adding a source or building its UI, document:

- Business and technical owners.
- Source system, import or workflow name, and destination table.
- Source timezone, source grain, and model classification.
- Period anchor and natural upsert key.
- Imported metrics and derived metrics.
- Supported and default reporting grains.
- Default comparison and metric directions.
- Delivery schedule and completeness signal.
- Late-arriving data, reset, and missing-run behavior.
- Source reconciliation method and PII classification.

For email marketing, first determine whether the provider supplies event rows,
daily totals, or lifetime counters. Prefer daily or event-level numerators,
idempotent imports, declared timezones, and rates derived from aggregate totals.

For n8n work, also record trigger timezone, row grain before and after workflow
aggregation, grouping keys, upsert target, rerun behavior, boundary behavior,
late corrections, alerts, and reconciliation. Sanitize exported workflow JSON
to remove credentials, tokens, secrets, and customer or prospect records.

## 5. Shared UI-control standard

Controls with the same purpose must share one implementation. Do not create
page-specific Tailwind versions of reporting controls.

### Reporting-basis disclosure

Use a consistent, accessible badge plus short explanatory text for `Cohort`,
`Activity`, `Snapshot`, `Derived activity`, and `Allocation` reports. The badge
is informational and must not look like a selectable filter.

- Show it near the report title or subtitle, before the timeframe controls.
- Include the anchor field or effective date in visible text or an accessible
  information popover.
- Do not rely on an unlabeled information icon.
- Use neutral styling so the disclosure is not mistaken for a warning or KPI
  status.
- Reuse one shared component for the badge, explanation, focus behavior, and
  responsive layout.

### Control roles

| Control | Use | Shape |
|---|---|---|
| Segmented control | One choice from a short fixed set | Joined rounded rectangle |
| Select | One choice from a longer or changing set | Rounded rectangle matching segmented-control height |
| Filter chip | One or more category selections | Full pill |
| Clear or reset | Remove category selection | Neutral outline control matching its neighbors |

### Visual rules

- Buttons and selects use a 32 px height.
- Segmented controls and selects use a 6 px corner radius.
- Filter chips use a full pill radius.
- Text is 12 px, medium weight, with tabular numerals for numbers.
- Inactive: white background, border token, charcoal text.
- Hover: slightly darker border without layout movement.
- Active: indigo background and border, white text.
- Disabled: muted background and text with an accessible explanation.
- Focus: visible indigo focus ring with offset.
- Use equal border widths across states.
- Put labels directly before their controls.
- Keep each control group together when wrapping.
- Use a month select on constrained layouts.
- Quarter may use a `Q1 | Q2 | Q3 | Q4` segmented control.
- Year uses a select.
- Do not mix isolated square buttons, rounded buttons, and pills for the same
  period-selection purpose.

### Accessibility and shared implementation

- Single-select segmented controls expose one selected value and support
  keyboard use.
- Use `aria-pressed` or an equivalent radio-group pattern.
- Every select has a visible label or accessible name.
- Selection must be understandable without color.
- Focus order is timeframe, period, year, comparison, then business filters.

Implement shared equivalents of:

- `ReportingFilterBar`
- `SegmentedControl`
- `ReportingSelect`
- `FilterChipGroup`
- `ComparisonControl`

Names may follow repository conventions, but appearance, accessibility, and
state behavior must have one shared implementation.

### Brand rules

- The UI wordmark is always lowercase `sourced`.
- Use sentence case for headings, labels, and buttons.
- Do not use all caps for headings.
- Do not use em dashes in user-facing or generated copy.
- Keep the style minimal and flat with generous whitespace.
- Use existing theme tokens in `src/index.css`: indigo `#4F46E5`, teal
  `#06B6D4`, charcoal `#0F172A`, slate `#64748B`, muted `#F8FAFC`, border
  `#E2E8F0`, success `#10B981`, warning `#F59E0B`, and danger `#EF4444`.
- Inter is the primary font with system fallbacks.
- Use the existing app as the first visual reference. Use DataVis 1 only when
  `sourced` has no established pattern.

## 6. Security and production safeguards

- Never commit CSV exports, contact lists, customer records, real PII,
  credentials, or `.env` files.
- Never print full lead records or secrets to logs, tests, documentation, or
  tool output.
- Do not expose environment values during diagnosis.
- `VITE_APP_PASSWORD`, `VITE_REVEAL_PII_PASSWORD`, and `VITE_BDR_PASSWORD` are
  browser-delivered convenience gates, not real authorization.
- Current Supabase RLS uses public-read and anonymous-write policies. Treat it
  as permissive.
- Real authentication and role-based RLS are a separate security project.
- Local development normally connects to production Supabase. UI actions can
  change production data.
- Read-only inspection is allowed when relevant.
- Creating, editing, importing, deleting, migrating, deploying, or otherwise
  changing production state requires explicit authorization.
- Do not contact people, push, open or merge PRs, deploy, or change external
  systems unless the user authorizes that action.

Environment variables referenced by the source:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_APP_PASSWORD`
- `VITE_REVEAL_PII_PASSWORD`
- `VITE_BDR_PASSWORD`

Real values belong only in ignored local files and approved hosting
configuration. `.env.example` contains placeholders only and must be updated
when a new required variable is introduced.

## 7. Development and testing requirements

### Working rules

- Inspect before changing. Prefer current code over historical plans and report
  conflicts.
- Preserve unrelated user changes and untracked files.
- Use `rg` for search and `apply_patch` for manual file edits.
- Do not add unrelated features or broaden a focused task without approval.
- Keep calculations and transformations pure where practical.
- Update this file when work changes architecture, data contracts,
  integrations, security assumptions, or reporting standards.
- Ask Benjamin before making a decision that materially changes scope or
  production behavior.

### Verification

Use npm and the committed lockfile:

```bash
npm ci
npm run dev
npm run test
npm run typecheck
npm run build
npm run verify
npm run lint
```

`npm run verify` runs tests, typecheck, and the production build. It is the
standard code gate. CI runs `npm ci` followed by `npm run verify` and has no
Supabase credentials.

Lint has an existing backlog and is not yet part of `verify`. Do not suppress
or increase existing findings.

### Testing rules

- Add proportional regression tests for calculations, imports, locks, and data
  contracts.
- Use fixed dates and deterministic inputs.
- Tests must not use the current clock, browser timezone, network access,
  secrets, or production data.
- Reconcile number-changing work against a trusted fixture or approved
  read-only diagnostic.
- Before migrating a reporting surface, reconcile current trusted totals.

Shared period and delta tests must cover:

- Month lengths of 28, 29, 30, and 31 days, including leap years.
- Q1 through Q4 and year boundaries.
- December to January and Q1 to prior-year Q4 comparisons.
- Previous-year comparisons for every supported grain.
- Missing comparison data versus a real zero.
- Zero comparison displayed as `New`.
- Rate deltas expressed in percentage points.
- Higher-is-better, lower-is-better, and neutral metrics.
- Partial-period suppression or valid equal-window comparison.
- Identical non-time filters for current and comparison periods.
- Additive, cumulative, snapshot, date-range, cohort, reset, and missing-run
  cases as applicable.
- Reconciliation against a known source total.

A reporting surface is complete only when its source classification, period
anchor, supported grains, aggregation, comparison, delta states, partial-data
behavior, direction, reporting-basis disclosure, tests, reconciliation, copy,
and shared controls all conform to this file.

## 8. Known deferred work

Do not turn a focused task into one of these projects without approval:

- Standardized Month, Quarter, Year, delta, comparison, and reporting controls
  are specified here but not yet implemented across the app.
- A complete n8n audit awaits sanitized workflow exports. The LEAD-SYNC
  workflow is now audited (Bite 4G1,
  `docs/lead-sync-current-workflow-audit.md`): it is live, nightly at
  hour 3 with no explicit timezone, create-window-only with no
  watermark, discards the CampaignMember Id, never selects the
  lifecycle field it reads (so every synced person defaults to
  `lead`), queries no field history, writes through an unversioned RPC
  that continues on error, and logs person-level data to a Sheet with
  no failure alerting. It cannot maintain `lead_campaign_touches`, so
  until the replacement is activated, new memberships reach reporting
  only through the manual report import. The read-only discovery plan and
  its DISABLED manual workflow template are in
  `docs/lead-sync-discovery.md`; the pure summary module is
  `src/lib/leadSyncDiscovery.ts`. No rebuild, schedule, or write path
  exists yet. DECISIVE 4G1 FINDING (live run 2026-08-03): Salesforce holds
  ZERO lifecycle-history rows for the confirmed field on either object, so
  no lifecycle transition can be reconstructed from the org today. Lead
  Status history is not a substitute, date-field edits cannot express
  repeated movement, and enabling tracking later backfills nothing. Bite
  4G2 must therefore build an append-only observation ledger going
  forward; current lifecycle values are snapshot evidence only and must
  never be reported as transitions. The simpler acquisition-cohort
  replacement is now generated at
  `src/generated/salesforceCampaignMemberDaily.workflow.json` and documented
  in `docs/salesforce-campaign-member-daily-sync.md`. It performs a complete
  daily approved-campaign read, counts every membership as Lead, preserves
  MQL evidence for the same membership, and writes leads plus
  `lead_campaign_touches` through the applied restricted function in
  `2026-08-11_sfdc_campaign_member_daily_apply.sql`. The first controlled
  production apply and reconciliation completed on 2026-08-11. A pending v2
  extension adds exact Salesforce Account identity and baseline-versus-
  transition provenance; do not switch the active workflow to v2 before that
  migration is applied and verified.
- Real authentication and restrictive role-based RLS are not implemented.
- `Channel.year` is used by the application and listed as applied in the
  migration ledger, but `SCHEMA.sql` lacks the column and the named
  `2026-05-19_channels_year.sql` migration is absent. Verify the live catalog
  before repairing this documentation drift.
- `.env.example` lacks the `VITE_BDR_PASSWORD` placeholder. Add it without a
  real value in a focused configuration-documentation change.
- ESLint convergence remains deferred. Do not suppress or increase findings.
- Splitting `src/lib/compute.ts` remains deferred.
- Leads-table virtualization is a separate performance project.
- Content Syndication budget allocation may be revisited separately.
- AWS migration is planning only. Production remains Vercel plus Supabase.
- The funnel stage-activity and cohort-conversion split is wired into Data
  Entry. Exact Account-ID completion, Opportunity history ingestion, reviewed
  promotion into reporting, and the authenticated live review queue remain
  separate gates; never present an unavailable cross-grain conversion as 0.
- The Opportunity Queue Manager (Bite 5C2B1, `docs/opportunity-queue.md`)
  exists as domain logic (`src/lib/opportunityQueue.ts`), a typed repository
  boundary (`src/lib/opportunityQueueRepository.ts`), and an unrouted UI
  (`src/components/opportunities/OpportunityQueueManager.tsx`), including
  the "Not selected" recovery view (stored review state `ignored`;
  reconsider requires a reason and reuses the `reopened` audit event). It
  runs only against a synthetic in-memory adapter in tests. Live wiring
  requires the authenticated server-side review API; the browser must never
  query the protected `sf_opportunity_*` tables directly. The portable API
  contract, capability authorization, and framework-neutral service layer
  for that API exist under `src/server/` (Bite 5C2B2A,
  `docs/opportunity-queue-api.md`): no runtime, framework, PingOne login,
  or database connection yet, and server code never imports React, Vite
  env, browser storage, Supabase, or test principals.
