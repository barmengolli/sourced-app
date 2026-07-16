# Sourced — Project Instructions for Codex

This file is read on every Codex session. Adhere strictly. These instructions OVERRIDE any default Codex behavior.

---

## What this app is

Sourced is a B2B marketing attribution and lead-tracking SPA for EIS Group's Marketing Operations function. It is a corrected mirror of Salesforce lead data, owned by Marketing, with editable fields and per-field edit-locks so MOps can fix incorrect dates, owners, and stages without those edits being overwritten by SFDC sync.

The app's defining capabilities:

1. **Lead-level ledger.** One row per lead, every field editable, with provenance tracking (what SFDC says vs. what Marketing corrected to).
2. **Computed funnel reporting.** The funnel grid (channel x quarter x stage) is computed from leads, not stored. Fix a lead's date and the grid recomputes automatically.
3. **Two-tier campaign hierarchy.** Parent Campaigns (e.g. "2026 Pet Campaign") with Sub-Campaigns and channels attached to them.
4. **Multi-touch attribution at the deal level.** Ordered touches (1st Touch, 2nd Touch, etc.) per opportunity, linked back to the originating lead.
5. **Spend tracking.** Quarterly spend per campaign, enabling CPL, CPMQL, CPHPP, and ROI by campaign.
6. **Cohort and velocity reporting.** Track cohorts over the full 2-year B2B sales cycle. Compute stage velocity (median days Lead to MQL, MQL to HPP, etc.).

---

## Brand and visual identity

- **Name**: Sourced (always lowercase in UI, "sourced" not "Sourced")
- **Mark**: lowercase "s" from two converging ribbons, indigo to teal gradient. Located at `/brand/sourced-logo-v1.png` once vectorized to `/public/sourced-mark.svg`
- **Palette**:
  - Indigo `#4F46E5` (primary)
  - Teal `#06B6D4` (secondary)
  - Charcoal `#0F172A` (text primary)
  - Slate `#64748B` (text secondary)
  - Background `#FFFFFF`
  - Muted `#F8FAFC`
  - Border `#E2E8F0`
  - Success `#10B981`
  - Warning `#F59E0B`
  - Danger `#EF4444`
- **Typography**: Inter (loaded from `https://rsms.me/inter/inter.css`). Use system-ui as fallback. All headings sentence case, never Title Case, never ALL CAPS.
- **Style**: minimal, flat, no gradients except in the logo mark, no drop shadows beyond Tailwind's default `shadow-sm` on cards. Generous whitespace.

Define these as Tailwind theme colors and CSS variables in `tailwind.config.js` and `index.css` so they are referenceable everywhere.

---

## Tech stack (mirror DataVis 1)

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS v4
- **Charts**: Recharts (BarChart, Sankey, LineChart, PieChart)
- **Database**: Supabase (PostgreSQL with realtime subscriptions)
- **Hosting**: Vercel (auto-deploy from GitHub main branch)
- **Auth**: Client-side password gate. Password: `HWWQa4yD5vkX` (same as DataVis 1)
- **Package manager**: npm

Use the same versions as the existing DataVis app at `/MarketingOps Cowork/DataVis/`. When in doubt, copy from there.

---

## Folder structure

```
sourced-app/
├── public/
│   ├── sourced-mark.svg           # Logo mark
│   ├── favicon.svg                # 32x32 mark crop
│   └── icons.svg                  # Sprite for UI icons
├── src/
│   ├── App.tsx                    # Top-level routing, password gate
│   ├── main.tsx
│   ├── index.css                  # Tailwind + CSS variables
│   ├── components/
│   │   ├── PasswordGate.tsx
│   │   ├── common/
│   │   ├── leads/                 # Lead table, lead detail drawer, edit cell
│   │   ├── campaigns/             # Campaign list, campaign detail
│   │   ├── import/                # CSV importer, column mapper, diff view
│   │   ├── funnel/                # Funnel grid (computed)
│   │   ├── charts/                # Sankey, Bar, Donut, Funnel chart, Trends
│   │   ├── attribution/           # Attribution editor modal, touches list
│   │   └── reports/               # Cohort, velocity, CPL by campaign
│   ├── pages/
│   │   ├── LeadsPage.tsx
│   │   ├── CampaignsPage.tsx
│   │   ├── DashboardPage.tsx
│   │   ├── CohortPage.tsx
│   │   └── SettingsPage.tsx
│   ├── hooks/
│   │   ├── useSupabase.ts
│   │   ├── useLeads.ts
│   │   ├── useCampaigns.ts
│   │   └── useFunnelGrid.ts
│   ├── lib/
│   │   ├── supabase.ts            # Supabase client
│   │   ├── csv.ts                 # CSV parsing and import helpers
│   │   ├── dates.ts               # Quarter math, date helpers
│   │   └── compute.ts             # Funnel grid computation from leads
│   ├── types/
│   │   └── db.ts                  # TypeScript interfaces for all tables
│   └── constants/
│       ├── stages.ts              # Stage keys and labels
│       └── countries.ts
├── .env                           # NOT committed
├── .env.example
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── vite.config.ts
└── README.md
```

---

## Database schema

The full schema lives in `./SCHEMA.sql` at the repo root. Paste into the Supabase SQL Editor on first setup. Incremental changes go in `./migrations/` (see `./migrations/README.md` for naming, status, and apply order). When the schema changes, update `./SCHEMA.sql` in the same commit so the canonical file stays current.

Tables:
- `channels` — channel taxonomy (LinkedIn Ads, BDR Outreach, Website, Content Syndication, etc.)
- `campaigns` — parent and sub-campaigns (self-referencing via `parent_campaign_id`)
- `campaign_channels` — M2M between campaigns and channels
- `campaign_spend` — quarterly spend per campaign
- `leads` — the corrected mirror of SFDC, one row per person
- `lead_campaigns` — M2M between leads and campaigns with `joined_at` and `reason`
- `attributions` — deal-level opportunity records (HPP, Opp, Pursuit, Won)
- `attribution_touches` — ordered touches per attribution
- `funnel_projections` — manually-entered projections by channel x quarter x stage
- `cell_comments`, `cell_links` — annotations on funnel grid cells (ported from DataVis 1)

RLS policies follow the DataVis 1 pattern: public read, anon write (gated by the client-side password).

---

## TypeScript data model

Define all interfaces in `src/types/db.ts`. Mirror the DB schema exactly. Stage keys are typed:

```typescript
export type StageKey = 'lead' | 'mql' | 'hpp' | 'opp' | 'pursuit' | 'closeWon' | 'cold' | 'disqualified';
export type AttributionStageKey = 'hpp' | 'opp' | 'pursuit' | 'closeWon';
export type PeriodIndex = 1 | 2 | 3 | 4;

export interface StageHistoryEntry {
  stage: StageKey;
  entered_at: string;            // ISO date
  edited_by?: string;
  edit_locked?: boolean;
  notes?: string;
}

export interface Lead {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  sfdc_lead_id?: string;
  sfdc_contact_id?: string;
  hubspot_contact_id?: string;
  account?: string;
  title?: string;
  country?: string;
  owner?: string;
  lead_source?: string;
  current_stage: StageKey;
  marketing_sourced_date?: string;
  source_channel_id?: string;
  stage_history: StageHistoryEntry[];
  field_locks: Record<string, boolean>;
  source_sfdc: Record<string, unknown>;
  notes?: string;
  created_at: string;
  updated_at: string;
  last_synced_at?: string;
  last_edited_by?: string;
}
```

Define the rest in the same shape.

---

## Core conventions

### The edit-lock contract

This is the most important behavior in the app. Read carefully.

Every Lead field except `id`, `email`, system IDs, and timestamps has an entry in `field_locks` (a JSONB object). When the user edits a field in the UI:

1. The new value is saved.
2. `field_locks[fieldName] = true`.
3. `last_edited_by` is set to the current user (for now, hardcode "Benjamin" or "Marketing").
4. `updated_at` is set.

When CSV import runs (or, in v2, n8n sync):

1. For each lead matched by email, compare incoming SFDC values to existing values.
2. For each field where `field_locks[fieldName] === true`: do NOT overwrite the field. Instead, only update `source_sfdc[fieldName]` so the user can see drift.
3. For unlocked fields: overwrite normally and update `source_sfdc[fieldName]` as well.
4. Always update `last_synced_at`.

The Leads table UI must visually indicate locked fields (small lock icon next to the value) and show a tooltip on hover with: current value, SFDC value, who edited and when, and a "Revert to SFDC" button.

### Computed actuals, stored projections

Funnel grid actuals are NEVER stored. They are always computed live from `leads.stage_history`:

```
actuals(channel, year, quarter, stage) =
  count(leads where
    source_channel_id = channel
    AND any stage_history entry has stage = stage AND entered_at in quarter
    AND (no country filter OR country matches selected filter)
  )
```

The Lead-stage actual specifically uses `marketing_sourced_date` instead of stage_history for the 'lead' stage:

```
actuals(channel, year, quarter, 'lead') =
  count(leads where
    source_channel_id = channel
    AND marketing_sourced_date in quarter
  )
```

Projections ARE stored, in `funnel_projections`, keyed by (channel_id, year, period_index, stage_key).

### Date semantics

`marketing_sourced_date` is the bucketing field for Lead-stage attribution. It is the editable mirror of SFDC's Member First Associated Date. The default rule for stage transition dates: take whatever SFDC provides, allow the user to override, lock if overridden.

For the cold-and-re-source edge case (lead joined a campaign 2+ years ago, went cold, re-engaged): default to the strict rule (first-touch wins) and add a "Re-source" action on the lead detail page that pushes a new entry into stage_history. We can revisit if it doesn't match Benjamin's mental model.

### Identity and dedupe

Email is the canonical identity key. Lower-case all emails on save. When CSV import finds a row with an email that already exists, treat it as an update, not an insert. Show the diff to the user before committing.

System IDs (sfdc_lead_id, sfdc_contact_id, hubspot_contact_id) are tracked but not used for matching. They exist for future bidirectional sync.

### Stage transitions

When a user changes `current_stage` in the UI, automatically append an entry to `stage_history` with `entered_at` defaulting to today. The user can edit the date. The new entry is NOT edit-locked by default.

### Country and territory

Country is a free-text field for now (use ISO country names: "United States", "United Kingdom", "Germany"). On the funnel grid, country becomes a top-level filter alongside year and quarter. Aggregate views can group by country to show territory traction.

### Outreach.io domain

NOT in scope for v1. The Outreach domain stays in DataVis 1 for now. Do not build sequence performance views in Sourced. We may port them in a later phase.

---

## Build order (strict)

Build features in this order. Do not start a later feature until the prior one is working end-to-end.

### Milestone 1: Foundation
1. Scaffold Vite + React 19 + TS + Tailwind v4 project
2. Install Supabase JS client, recharts, uuid
3. Wire up `.env` and `src/lib/supabase.ts`
4. Implement password gate (mirror `DataVis/src/components/PasswordGate.tsx`)
5. Stub all five page routes (Leads, Campaigns, Dashboard, Cohort, Settings) with placeholder content

### Milestone 2: Lead ledger
6. Build `src/types/db.ts` with all interfaces
7. Build `useLeads` hook (CRUD, realtime subscription)
8. Build LeadsPage table view: sortable columns, basic filtering by stage, country, owner
9. Build LeadDetailDrawer: edit any field inline, lock indicator, provenance tooltip, stage history editor

### Milestone 3: CSV import
10. Build CSV importer: drag-and-drop CSV file, parse with PapaParse
11. Build column mapper: map CSV columns to Lead fields, save mapping to localStorage for re-use
12. Build diff view: show new leads, updated leads (with field-level diff), unchanged leads. Indicate which fields are locked and would NOT be updated. Allow user to confirm or cancel.
13. Apply changes respecting field_locks contract

### Milestone 4: Channels and campaigns
14. Build ChannelManager (mirror DataVis 1 channels manager)
15. Build CampaignsPage: list parent campaigns, expand to show sub-campaigns and member counts
16. Build CampaignDetail: edit name, dates, owner, attached channels, quarterly spend table
17. Wire lead_campaigns membership: surface in LeadDetailDrawer, allow add/remove

### Milestone 5: Funnel grid (computed)
18. Build `lib/compute.ts`: pure functions to compute funnel grid actuals from leads array. Memoize.
19. Port `FunnelTable` component from DataVis 1, point at computed inputs. Drop the cell-edit handlers for actuals (they are read-only now). Keep cell-edit for projections.
20. Port `EditableCell`, `CommentsList`, `CellLinks` from DataVis 1
21. Click an actual cell -> show the underlying leads in a side panel (drilldown)

### Milestone 6: Charts
22. Port BarChartView (Actuals vs Projections), DonutChartView (channel distribution), FunnelChartView (conversion funnel), TrendLineChartView (quarterly trends), AttributionSummaryView (Sankey)
23. Re-point all of them at computed lead aggregates instead of stored cells

### Milestone 7: Attribution
24. Build attributions and attribution_touches CRUD
25. Port CreateHPPModal, AttributionEditorModal, OpportunitiesListModal from DataVis 1
26. Wire attribution.lead_id back to leads so an attribution can show "Sourced from: [lead name] via [channel] on [date]"

### Milestone 8: Reports
27. Build CohortPage: cohort survival curve (Q3 2024 leads, what % HPP today). Use stage_history.
28. Build velocity report: median days Lead to MQL, MQL to HPP, by channel. Box plot or simple table.
29. Build CPL by campaign: campaign_spend / leads sourced. Show CPL, CPMQL, CPHPP, CPOpp, CPWon.
30. Build marketing-sourced revenue: sum of attribution.amount where stage = closeWon, grouped by first-touch channel.

---

## Things to avoid

- Do NOT store funnel grid actuals as numbers in the DB. Always compute from leads.
- Do NOT use Title Case anywhere in the UI. Sentence case for labels, headings, buttons. The lowercase wordmark "sourced" is the brand standard.
- Do NOT use em dashes in any user-facing copy or generated text. Use commas, colons, parentheses, or periods.
- Do NOT add features not on the build-order list without checking in. The scope is intentionally tight.
- Do NOT pull contact lists into the codebase or print full lead records to logs. Treat lead data as sensitive PII.
- Do NOT fabricate field names that aren't in this spec. If a needed field is missing, flag it.
- Do NOT use localStorage to persist anything beyond user preferences (column visibility, last-used CSV column mapping). All real data lives in Supabase.

---

## Reference: DataVis 1

The existing DataVis app at `/Users/barmengolli/Desktop/MarketingOps Cowork/DataVis/` is the design reference. Visual style, component shape, and reporting layout should match. Specifically:

- `DataVis/src/components/table/FunnelTable.tsx` — port to `sourced-app/src/components/funnel/FunnelTable.tsx`
- `DataVis/src/components/charts/*` — port directly, re-point inputs
- `DataVis/src/components/PasswordGate.tsx` — port directly with new password and brand colors
- `DataVis/src/components/table/AttributionEditorModal.tsx`, `CreateHPPModal.tsx`, `OpportunitiesListModal.tsx` — port to attribution/

Do NOT port: `App.tsx` reducer logic (the data model is different), the migrations chain, the JSONB write paths.

---

## When in doubt

Match DataVis 1 visually. Keep the data model lean. Ask Benjamin before adding scope.
