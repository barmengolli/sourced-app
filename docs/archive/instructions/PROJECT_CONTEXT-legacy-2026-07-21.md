# Archived project context

> Archived on 2026-07-21. Historical reference only. The active project
> instructions are in `../../../CLAUDE.md`. Do not use this file as current
> guidance.

# sourced: current project context

Status: Canonical repository context for agent work  
Last verified against the repository: 2026-07-21  
Owner: Marketing Operations

Read this document before making changes in this repository. It describes the
application that exists now, not the original build plan.

The checked-in code and the live database are the final evidence when they
conflict with documentation. Do not silently choose one. Investigate the
difference, tell the user, and update the relevant documentation as part of an
approved change.

## 1. Product purpose

`sourced` is an internal B2B marketing attribution and lead-tracking SPA for
EIS Group's Marketing Operations team. It is a corrected mirror of Salesforce
lead data with field-level edit locks, computed funnel reporting, deal
attribution, campaign tagging, spend reporting, and source-specific performance
dashboards.

The central product problem is imperfect CRM data. Marketing can correct a lead
without allowing a later Salesforce import to overwrite that correction.

The app is not a CRM and does not replace Salesforce. It contains customer and
prospect business-contact data and must be treated as sensitive.

## 2. Current application areas

The current navigation is defined in `src/constants/sidebar.ts` and routed in
`src/App.tsx`.

| Area | Current pages |
|---|---|
| Marketing Funnel | Data Entry, Leads & MQLs, Opportunities, Events, Spend, Compare |
| Reach & Engagement | 6sense Dashboard, Import |
| BDR Quota | Dashboard, Quotas |
| Outreach | Data, Dashboard, Compare |
| LinkedIn Ads | Dashboard |
| Campaigns | Overview, Tags |
| Utilities | User Manual, Feedback & Bug Reports, Leads, Channels, Funnel Import, Settings |

Some pages are marked Beta in the sidebar. Beta does not mean their numbers may
be changed casually. Calculation changes still require regression tests and
before-and-after reconciliation.

`src/pages/CohortPage.tsx` exists as a retained file but is not currently routed
in `PageKey` or the sidebar.

## 3. Technology and delivery

| Layer | Current implementation |
|---|---|
| Frontend | React 19, TypeScript 5.9, Vite 8 |
| Styling | Tailwind CSS 4 through the Vite plugin |
| Charts | Recharts 3 |
| Database | Supabase PostgreSQL with realtime subscriptions |
| Hosting | Vercel, automatic production deployment from `main` |
| CI | GitHub Actions on Node 24 |
| Tests | Vitest, pure tests plus file-level jsdom component tests |
| Package manager | npm with a committed lockfile |

The application is currently hosted on Vercel and uses Supabase. AWS hosting is
being discussed but has not replaced the current production architecture.

The CI workflow runs `npm ci` and `npm run verify`. It intentionally has no
Supabase credentials, and tests must not make network calls.

## 4. Current data sources and ingestion

### Salesforce lead data

- Imported through the Funnel Import CSV workflow.
- Email is the canonical match key and is normalized to lowercase.
- Parent Campaign and Campaign Name values can populate the channel hierarchy.
- Imports must honor lead field locks and update source provenance.
- Event Activation is imported as a validated array of labels. The values do
  not currently carry individual activation timestamps.

### Opportunity and attribution data

- HPP and later deal stages are managed in the application.
- A logical deal is linked across stage rows by `deal_id`.
- `stage_entered_at` records when each deal stage was entered.
- Ordered attribution touches are stored separately.
- An HPP may be created without a linked lead because Salesforce associations
  are incomplete. A source channel is the required attribution evidence.

### Outreach

- `outreach_snapshots` is populated by an n8n schedule.
- Source rows are weekly cumulative sequence snapshots.
- The app derives period activity by differencing snapshots.
- Outreach uses a legacy five-region taxonomy inferred from sequence names.

### LinkedIn Ads

- `linkedin_ads_snapshots` is populated by n8n from a weekly Google Sheet.
- The stored rows are additive weekly totals per ad set, not cumulative
  counters.
- CTR, CPC, and CPM are derived from aggregate numerators and denominators.
- The mapping specification is `docs/linkedin-n8n-mapping.md`.

### 6sense

- Imported manually through the 6sense CSV Import page.
- The source is a monthly point-in-time summary per segment.
- The legacy `week_number` column is currently repurposed as month number
  `1..12`. Do not interpret it as an ISO week in 6sense code.

### Campaigns

- Campaigns are a manual tag layer over assets from multiple sources.
- Tags can link channels, 6sense segments, Outreach sequences, and LinkedIn ad
  sets.
- One asset may belong to multiple campaign tags.
- A shared asset counts in full for every campaign claiming it, so campaign
  totals may overlap and must not be summed into a company total.

### n8n documentation status

The repository contains the LinkedIn mapping specification but not sanitized
exports of every live n8n workflow. Do not claim a complete n8n audit from this
repository alone. Workflow exports must exclude credentials, secrets, tokens,
and customer or prospect records.

## 5. Core database model

`SCHEMA.sql` is intended to describe a fresh database. Incremental SQL lives in
`migrations/`. The live catalog must be verified before applying or reapplying
a migration because migration status documentation may lag production.

| Table | Purpose |
|---|---|
| `channels` | Hierarchical marketing channel taxonomy |
| `leads` | Corrected Salesforce lead mirror with edit locks and provenance |
| `attributions` | One row per deal stage |
| `attribution_touches` | Ordered channel touches for attribution rows |
| `campaign_costs` | Date-range budgets and costs by channel |
| `funnel_projections` | Stored quarterly projections |
| `funnel_actuals` | Manual quarterly fallback actuals |
| `cell_comments`, `cell_links` | Funnel-cell annotations |
| `outreach_snapshots` | Weekly cumulative Outreach sequence snapshots |
| `linkedin_ads_snapshots` | Weekly additive LinkedIn ad-set totals |
| `sixsense_snapshots` | Monthly point-in-time 6sense summaries |
| `bdr_quotas` | Annual HPP and Opp targets by BDR |
| `campaign_tags` | Canonical manual campaign tags |
| `campaign_tag_links` | Multi-tag links between campaigns and source assets |

When a schema change is approved:

1. Add an incremental migration.
2. Update `SCHEMA.sql` in the same change.
3. Prefer idempotent SQL where practical.
4. Verify production state before execution.
5. Record the actual application status after execution.

Do not run migrations or write directly to production without explicit user
authorization.

## 6. Non-negotiable business rules

### Lead edit-lock contract

When a user edits an editable lead field:

1. Save the corrected value.
2. Set `field_locks[field] = true`.
3. Set `last_edited_by` and update timestamps.

During Salesforce import or future synchronization:

1. A locked field keeps the Marketing value.
2. The incoming Salesforce value still updates `source_sfdc[field]` so drift is
   visible.
3. An unlocked field may be overwritten and also updates `source_sfdc`.
4. `last_synced_at` is always updated.

The typed pure builders in `src/lib/leadSync.ts` are the core implementation.
Changes require edit-lock regression tests.

### Computed actuals and stored planning values

- Current lead-level actuals are computed from source records.
- The Lead stage uses `marketing_sourced_date`.
- MQL uses stage history under the view's documented cohort or activity rule.
- HPP and later stages use attribution records.
- Projections are stored quarterly in `funnel_projections`.
- `funnel_actuals` provides quarterly fallback data where source-level records
  do not cover a stored cell.
- Never invent monthly values from a quarterly fallback.

The detailed timeframe, aggregation, and delta rules are in
`docs/REPORTING_TIMEFRAME_DELTA_STANDARD.md`.

### Deal and HPP contract

- `lead_id` is optional.
- Source channel is required when creating an HPP.
- Do not fabricate or require a lead merely to make a deal count.
- A null `lead_id` does not prove Sales origin.
- A leadless deal is labeled `Sales-sourced` only when its top-level channel is
  `Sales Generated`. Otherwise use the neutral `No linked lead` label.
- Preserve the unique logical deal and stage relationship.

### Identity and deduplication

- Lead email is the canonical identity key and is stored lowercase.
- Existing-email imports are updates, not inserts.
- System IDs are retained for provenance and future integrations but are not the
  current lead matching key.
- Source upserts must have a documented natural key and be idempotent.

### Regions

- Funnel reporting uses the EIS taxonomy in `src/constants/regions.ts`.
- Outreach retains its separate legacy taxonomy in
  `src/constants/outreachRegions.ts` because region is inferred from sequence
  names.
- Do not silently combine these taxonomies.

## 7. Reporting standard

Before adding or changing a reporting source, timeframe filter, comparison,
delta, KPI card, or period chart, read
`docs/REPORTING_TIMEFRAME_DELTA_STANDARD.md` completely.

The reporting contract requires:

- Month, Quarter, and Year as the standard reporting grains.
- Week only as a retained source or diagnostic grain.
- Source classification before aggregation.
- Standard comparison and delta behavior.
- Explicit partial, stale, missing, and zero states.
- Declared metric direction before using success or danger colors.
- Shared visual control primitives rather than page-local Tailwind copies.
- Source reconciliation and boundary tests before rollout.

## 8. Security and sensitive data

The application contains sensitive business-contact data.

- Never commit CSV exports, contact lists, customer records, or real PII.
- Never print full lead records or secrets to logs, tests, documentation, or
  tool output.
- Never commit `.env` or real environment-variable values.
- Do not expose credentials while diagnosing configuration.

Current access limitations:

- `VITE_APP_PASSWORD`, `VITE_REVEAL_PII_PASSWORD`, and
  `VITE_BDR_PASSWORD` are browser-delivered convenience gates.
- Browser-delivered `VITE_*` values are discoverable and are not real
  authorization.
- Current Supabase RLS uses public-read and anonymous-write policies across the
  application tables. Treat it as permissive, not as strong protection for
  sensitive data.
- Real authentication and role-based RLS are a separate security project.
- Local development normally connects to the same Supabase project as
  production. UI actions can change production data.

Read-only inspection is allowed when relevant. Creating, editing, importing,
deleting, migrating, deploying, or otherwise changing production state
requires explicit user authorization.

## 9. Environment variables

The source currently references:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_APP_PASSWORD`
- `VITE_REVEAL_PII_PASSWORD`
- `VITE_BDR_PASSWORD`

Real values belong only in ignored local environment files and approved hosting
configuration. `.env.example` must contain placeholders only. If code adds a
required variable, update `.env.example` in the same change.

## 10. Brand and interface rules

- The product wordmark is always lowercase `sourced` in the UI.
- Use sentence case for headings, labels, and buttons.
- Do not use all caps for headings.
- Do not use em dashes in user-facing or generated copy.
- Visual style is minimal and flat, with generous whitespace.
- Use the existing theme tokens in `src/index.css`:
  - Indigo `#4F46E5`
  - Teal `#06B6D4`
  - Charcoal `#0F172A`
  - Slate `#64748B`
  - Background `#FFFFFF`
  - Muted `#F8FAFC`
  - Border `#E2E8F0`
  - Success `#10B981`
  - Warning `#F59E0B`
  - Danger `#EF4444`
- Inter is the primary font with system fallbacks.
- Use the existing app as the first visual reference. Use DataVis 1 only when
  Sourced has no established pattern for the component being changed.
- Reporting controls must follow the shared-control requirements in the
  reporting standard.

## 11. Repository map

| Path | Responsibility |
|---|---|
| `src/App.tsx` | Top-level page routing and shared section state |
| `src/constants/sidebar.ts` | Navigation structure and labels |
| `src/pages/` | Page-level reporting and operations surfaces |
| `src/components/` | Reusable UI grouped by domain |
| `src/hooks/` | Supabase reads, writes, realtime, and domain mutations |
| `src/lib/compute.ts` | Current consolidated reporting calculations |
| `src/lib/leadSync.ts` | Typed edit-lock import and merge logic |
| `src/lib/dates.ts` | Calendar and ISO-week helpers |
| `src/lib/campaignScorecard.ts` | Cross-source campaign scoring |
| `src/types/db.ts` | Application data interfaces |
| `src/constants/` | Taxonomies, labels, stages, and thresholds |
| `src/test/` | Test setup and factories |
| `SCHEMA.sql` | Intended fresh-database schema |
| `migrations/` | Incremental SQL and migration ledger |
| `docs/` | Standards, audits, diagnostics, and operational documentation |

## 12. Development and verification

Use npm and the committed lockfile.

```bash
npm ci
npm run dev
npm run test
npm run typecheck
npm run build
npm run verify
npm run lint
```

`npm run verify` runs tests, typecheck, and production build. It is the required
code gate. Lint has a documented existing backlog and is not yet part of
`verify`; do not suppress or increase findings. See `docs/LINT_BACKLOG.md`.

Testing rules:

- Add proportional regression tests for calculation, import, lock, and
  data-contract changes.
- Tests must use fixed dates and deterministic inputs.
- Tests must not call production services or require secrets.
- Reconcile number-changing work against a trusted before-and-after fixture or
  read-only diagnostic.

## 13. Documentation map

| Document | Use |
|---|---|
| `docs/PROJECT_CONTEXT.md` | Current application and non-negotiable rules |
| `docs/REPORTING_TIMEFRAME_DELTA_STANDARD.md` | Timeframe, aggregation, comparison, delta, and reporting-control standard |
| `SCHEMA.sql` | Intended current schema for a fresh database |
| `migrations/README.md` | Migration process and status ledger, verify live state before use |
| `docs/linkedin-n8n-mapping.md` | LinkedIn Sheet to Supabase mapping |
| `docs/LINT_BACKLOG.md` | Deferred lint-convergence plan |
| `docs/DATA_AUDIT.md` | Historical calculation audit, some findings have since been fixed |
| `docs/HANDOFF.md` | Historical handoff document, not canonical for current architecture |

When a change invalidates this context, update this document in the same work.
Do not leave agents with a stale architecture or data-contract description.

## 14. Known deferred work and boundaries

- Standardized Month, Quarter, Year, comparison, delta, and reporting controls
  are documented but not yet implemented across the app.
- The complete n8n workflow audit is pending sanitized workflow exports.
- Authentication and restrictive role-based RLS are not implemented.
- Repository schema documentation needs a separate reconciliation pass:
  `Channel.year` is used by the application and listed as applied in the
  migration ledger, but `SCHEMA.sql` does not contain the column and the named
  `2026-05-19_channels_year.sql` migration is not present in `migrations/`.
  Verify the live catalog before repairing either source.
- `.env.example` does not yet list the `VITE_BDR_PASSWORD` placeholder used by
  the BDR gate. Add it in a focused configuration-documentation change without
  including a real value.
- ESLint convergence is deferred; follow `docs/LINT_BACKLOG.md`.
- Splitting `src/lib/compute.ts` remains deferred.
- Leads-table virtualization remains a separate performance project.
- Content Syndication budget allocation may be revisited separately.
- AWS migration is planning context only. The current deployment remains
  Vercel plus Supabase.

Do not turn a focused task into one of these larger projects without explicit
authorization.
