# Lead multi-attribution and sync automation program (Bites 4C-4H)

Status: program design, approved decisions locked 2026-07-29; this is the
committed repository copy (landed by Bite 4C as
`docs/lead-multi-attribution-program.md`). This document is the parent plan
for six bites.

Builds directly on two merged foundations:

- **Bite 4A** (`docs/funnel-source-contract.md`, `src/lib/funnelCohorts.ts`,
  `src/lib/campaignAttribution.ts`): lifecycle-event contract, cohort
  calculators, primary-source resolution, influence report, and the
  `LeadCampaignTouch` normalized touch contract (types only).
- **Bite 4B** (`docs/salesforce-lifecycle-history-mapping.md`,
  `src/lib/salesforceLifecycleHistory.ts`): verified Salesforce field-history
  sourcing (tracking confirmed enabled) and the pure adapter from
  LeadHistory/ContactHistory rows to 4A lifecycle events.

Nothing in this program re-derives what 4A/4B settled. This program is their
productionization plus the multi-attribution counting change.

---

## 1. Business decisions (locked 2026-07-29)

1. **Multi-attribution counting.** A contact who joins multiple campaigns
   counts in EACH campaign's funnel numbers. Channel lead counts are
   membership counts, not distinct-people counts.
2. **MQL rule.** When a contact MQLs, the MQL counts in EVERY campaign the
   contact belongs to, bucketed by the MQL date for all of them.
3. **Grid totals sum memberships.** The funnel grid total row is the sum of
   channel rows. Per the 4A contract, any surface showing overlapping totals
   must also expose distinct people: the grid gains a secondary
   "unique contacts" line (display detail decided in Bite 4E).
4. **Deals keep a single primary channel.** Attribution chains, spend, and
   ROI math continue to inherit one channel via primary-source resolution.
   Multi-campaign analysis on the deal side is the influence REPORT, not a
   change to deal records.
5. **Source-of-truth routing.** Campaign membership and lead identity: SFDC
   CampaignMember (the union for all origins, HubSpot-pushed or SFDC-native).
   Stage transition dates: SFDC field history (4B), which covers
   HubSpot-native and BDR/SFDC-native contacts alike. HubSpot is NOT queried
   directly by this program.
6. **Stage history is an append-only EVENT LOG, and demotion is real.**
   Contacts can be demoted (MQL back to Lead when they go cold) and can
   re-qualify later, including across years. Demotion and re-qualification
   transitions are both recorded as events; no event is ever deleted or
   rewritten. Two counting consequences (locked 2026-07-29):
   - **Closed periods never change.** A Q3 2026 MQL who is demoted in Q4
     still counts as a Q3 2026 MQL. Cohort principle: counts record when
     the event happened, not current state.
   - **Re-qualification is a new event.** The same person MQLing again in
     2027 counts as a 2027 MQL as well: one MQL count per qualification
     cycle, each bucketed in its own period. This is 4A's requalification
     model.
   `current_stage` mirrors the latest known state (so it CAN move backward);
   the event log is what reporting reads. First-touch primary source never
   changes on re-sync (4A rule; edit-locked corrections win).

## 2. Reconciliation with the 4A contract

4A maintains two models that must never merge. This program KEEPS both:

- The **influence model** becomes the funnel grid's counting basis
  (memberships, overlapping, labeled non-additive, unique people shown).
- The **primary-source model** remains authoritative for: deal channel
  inheritance, acquisition-efficiency denominators, spend/CPL math, and any
  "one number per person" reporting.

`leads.source_channel_id` and `marketing_sourced_date` keep their current
meaning (primary source, first touch) and their edit-lock semantics.

## 3. Data model

New table `lead_campaign_touches`, implementing the 4A `LeadCampaignTouch`
contract:

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `lead_id` | FK -> leads, cascade delete |
| `campaign_member_id` | SFDC CampaignMember Id. Preferred idempotency key. UNIQUE where non-null. |
| `campaign_id` | SFDC Campaign Id (sub-campaign level) |
| `channel_id` | FK -> channels, nullable until resolved |
| `touch_date` | date the membership/touch happened (Member First Associated Date) |
| `parent_campaign`, `sub_campaign` | provenance text as delivered |
| `observed_at` | ingestion timestamp |
| `source` | 'import' / 'n8n_sync' / 'backfill' / 'manual' |
| `raw` | jsonb audit payload |

Natural-key fallback for touches without a CampaignMember Id follows
`dedupeTouches` (4A). RLS and realtime publication mirror the existing
`leads` policies. No change to `leads`, `attributions`, or stage_history
storage. Stage dates continue to live in `leads.stage_history`, upgraded to
Salesforce-confirmed quality when field history is ingested (4A quality
tiers).

## 4. Counting semantics (formulas)

For channel C, year Y, period Q:

```
leads(C,Y,Q)  = count of lead_campaign_touches t
                where t.channel_id = C AND t.touch_date in (Y,Q)
                [region filter applies via t.lead's region]

mql(C,Y,Q)    = count of MQL EVENTS x memberships:
                for each mql entry e in each lead's stage_history
                (one entry per qualification cycle; a re-qualification
                after a demotion is a new entry),
                count (e, C) where the lead has a touch in channel C
                AND e.entered_at in (Y,Q)

unique(Y,Q)   = count of DISTINCT lead_id across the same scope
                (secondary display line; 4A uniquePeople)
```

A lead with touches in channels A (Q1) and B (Q3): Lead count Q1 for A, Q3
for B. If they MQL in Q3: MQL count in Q3 for BOTH A and B. If they are
demoted in Q4 and re-qualify in Q1 2027: the Q3 2026 MQL counts stand, AND
both channels count a new MQL in Q1 2027. Re-engagement within an existing
campaign does not create a new lead count (the touch already exists); a new
campaign join does. Conversion cells divide same-channel MQL counts by
same-channel lead memberships and can exceed 100% for channels with heavy
re-qualification; the UI should tolerate and label that. Projections are
unchanged (already per channel). funnel_actuals fallback for pre-Sourced
years is unchanged.

## 5. Sync architecture (target state)

One n8n workflow, three branches, plus a safety net:

1. **Membership branch (nightly).** SOQL: CampaignMembers created OR modified
   in the window, tracked campaigns only. Upsert `lead_campaign_touches` by
   `campaign_member_id`; create the person if new (primary source assigned
   only when the lead is new, per 4A resolution). Fixes from the 4B section-7
   findings: keep the CampaignMember Id end-to-end, explicit timezone, stage
   map constrained to lead/mql.
2. **Lifecycle-history branch (nightly).** SOQL on LeadHistory/ContactHistory
   for tracked lifecycle fields in the window; run rows through the 4B
   adapter semantics server-side; append stage_history entries with
   Salesforce-confirmed dates for BOTH directions: qualifications (Lead to
   MQL) AND demotions (MQL back to Lead / cold). Idempotency by history row
   Id so re-runs never duplicate events. Updates `current_stage` to the
   latest state (backward moves allowed). Never touches locked fields, never
   deletes or rewrites existing events.
3. **Weekly full reconciliation (Sunday).** Paginated full pull of tracked
   campaigns' members; diff against `lead_campaign_touches` and stage
   history; auto-heal inserts/upgrades; log deltas only. Replaces the manual
   Monday import as the self-healing layer.
4. **Alerting.** Any errored run posts a failure notification (channel TBD:
   email or Slack). Applies to all Sourced workflows, closing the
   monitoring gap that hid the June 4-5 and Q3-MQL incidents.

The manual Funnel Import remains as an emergency/backfill tool and is
upgraded in 4D to write touches.

## 6. Bite breakdown

Sequencing is strict; each bite is a worktree + PR in the established
pattern, with tests in the same PR.

### Bite 4C: touches schema + program doc
- Migration for `lead_campaign_touches` (+ RLS, realtime, indexes: lead_id,
  channel_id, touch_date; unique partial on campaign_member_id).
- TypeScript row types aligned with the 4A `LeadCampaignTouch` contract.
- Seed backfill: one touch per existing lead from
  (source_channel_id, marketing_sourced_date), source='backfill'.
- Commit this document as `docs/lead-multi-attribution-program.md`.
- No UI, no compute, no n8n change. Grid output identical before/after.
- Acceptance: migration applies cleanly; seed count = lead count; types
  compile; existing tests green.

### Bite 4D: importer writes touches + full membership backfill
- Funnel Import upserts touches per CSV row (natural key; CampaignMember Id
  not present in report exports) alongside its current behavior.
- Import diff view shows new-touch counts.
- Then run one full SFDC export through it: every membership row becomes a
  touch. Multi-campaign people get their additional touches here.
- Acceptance: touch count reconciles with the SFDC report's membership rows
  (allowing for excluded/hidden campaigns); re-import is idempotent.

### Bite 4E: compute switch + grid
- `compute.ts` actuals derive from touches per Section 4 formulas, behind
  thorough unit tests (fixtures: multi-campaign person, MQL multi-count,
  region filter, fallback years).
- Grid totals sum memberships; a visible "unique contacts" secondary line
  satisfies the 4A non-additive labeling rule.
- Drilldown panels list touches, not just leads.
- Acceptance: single-campaign-only dataset produces identical numbers to the
  old model (regression fixture); multi-campaign fixture produces the agreed
  overlapping counts; unique line always <= summed total.

### Bite 4F: lead drawer + surfaces polish
- LeadDetailDrawer shows all campaign touches with dates and provenance.
- Any surface still reading source_channel_id for COUNTING migrates or is
  explicitly documented as primary-source-based (donuts, Sankey, Compare,
  Events: audit and align each).
- Acceptance: no counting surface silently mixes the two models; each chart
  subtitle states its basis (memberships vs unique vs primary source).

### Bite 4G: n8n sync rework
- Rebuild the leads workflow per Section 5 (branches 1-3), new/updated
  Postgres function(s) versioned in `migrations/` (closing the 4B finding
  that the RPC is unversioned).
- Pre-flight with the SFDC admin: confirm which lifecycle fields are
  history-tracked (4B unresolved item) and volume vs the 5,000-row SOQL
  ceiling for the weekly scan.
- Failure alerting on all branches.
- One-time historical run: ingest available field history (up to retention
  limit) to replace import-day MQL approximations with true dates, including
  the Q3 backfill.
- Acceptance: staged dry-run diff before first live apply; Q3 MQL counts in
  Sourced reconcile with HubSpot segment counts within documented deltas;
  workflow JSON exported and committed to docs/.

### Bite 4H: overlap & influence report + docs
- New report surface from 4A's `influenceReport`: campaign overlap matrix,
  peopleInMultipleCampaigns, multi-campaign vs single-campaign progression
  rates (the pipeline-influence question).
- Update `sourced/CLAUDE.md` + root CLAUDE.md attribution language (strict
  first-touch becomes "primary source for deals; memberships for funnel
  counting"), HANDOFF.md sync section, User Manual page.
- Acceptance: report renders from production data; docs match reality.

## 7. Rollout and communication

- 4C and 4D are invisible to users. 4E is the visible flip: every channel's
  lead counts increase (suppressed memberships appear) and totals exceed
  distinct contacts by design. Brief Sara BEFORE 4E deploys, with a
  before/after of one quarter and the unique-contacts line pointed out.
- 4G retires the routine manual import. HANDOFF weekly-operations section
  changes accordingly.

## 8. Risks and open items

- **History retention.** Salesforce retains field history ~24 months without
  Field Audit Trail; older MQL dates stay at import-day quality. Documented,
  acceptable.
- **Tracked-fields confirmation.** If the lifecycle field is NOT among the
  tracked fields, branch 2 falls back to modified-date detection (±1 day)
  until the admin adds tracking. 4G pre-flight resolves this.
- **Volume.** ~2.3k leads, ~2.6k memberships today; weekly full scan is well
  under limits with pagination; revisit if campaign scope grows 10x.
- **Report export lacks CampaignMember Id.** Import-created touches use the
  natural key; the n8n branch is the Id-quality path. Weekly reconciliation
  upgrades natural-key touches to Id-keyed when it re-observes them.
- **The tpg.com orphan class.** Touches whose membership disappears from
  SFDC are kept (a touch is a historical event, not a mirror of current
  membership) but flagged by the weekly scan's delta log for review.
