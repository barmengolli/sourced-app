# Funnel cohort, lifecycle, and source-attribution contract

Status: Evolved contract. The Data Entry grid now uses stage activity while
the Conversion panel follows explicit cohorts; these two questions are never
calculated by dividing the same visible totals.

Implementing modules:

- `src/lib/funnelCohorts.ts`: lifecycle event history, acquisition cohorts,
  deal uniqueness, HPP-anchored deal cohorts, cohort comparison.
- `src/lib/campaignAttribution.ts`: touch dedupe, primary-source resolution,
  campaign influence.
- `src/lib/funnelConversionCohorts.ts`: the live, explicitly followed cohorts
  used by the Data Entry conversion panel.

Both are pure: every calculation takes an explicit `asOf` date, nothing reads
the clock, and results carry explicit states (`complete`, `incomplete`,
`missing`, `invalid`) plus issue counts so a UI can explain an incomplete
value instead of rendering a silent zero.

This document contains no personal names, emails, company names, or Salesforce
identifiers. Source findings are described in aggregate only.

## 1. Non-additive funnel stages

Stage counts are memberships of the same people (or the same deals), never
separate populations.

- Lead side: if Content Syndication generates 100 unique people and 20
  eventually become MQL, the funnel shows Leads 100 and MQLs 20. Total unique
  people is 100, never 120. Lead-to-MQL efficiency is 20 / 100 = 20%.
- Opportunity side: one logical deal that reaches HPP, OPP, and Pursuit shows
  HPP 1, OPP 1, Pursuit 1. Total unique opportunities is 1, never 3.
  Uniqueness comes from the stable `deal_id`.
- Sales (New Logo) is intentionally deal-only. Its Lead and MQL cells remain
  empty because Marketing Operations does not source or manage those stages
  for Sales. New-logo Sales deals enter the report at HPP, Opp, or Pursuit.
  BDR Outbound remains a separate channel and carries its own Lead/MQL cohorts,
  so Sales-generated and BDR-generated deals never need to be inferred from a
  lifecycle label.

Never sum lifecycle-stage counts to produce a total-person or
total-opportunity count. The modules expose `uniqueLeads` and `uniqueDeals`
separately from stage counts and never derive one from the other.

## 2. Reporting models: cohort, activity, snapshot

Three distinct models apply to the funnel, matching the repository reporting
standard:

- Cohort: people (or deals) grouped by their original entry date and followed
  forward. The acquisition cohort anchors to the original Lead date; the deal
  cohort anchors to the HPP entry date.
- Activity: events that occurred inside the selected period, such as
  requalifications or stage transitions, regardless of which cohort the
  person belongs to.
- Snapshot: the current stage of a person as of a stated date. Current-stage
  reporting is point-in-time and separate from both cohort and activity
  reporting.

A surface must state which model it uses. A Q2 lead that becomes MQL in Q3 is
a Q2-cohort MQL, a Q3-activity transition, and a snapshot MQL as of any date
after the transition. All three statements are true at once; they answer
different questions.

The Data Entry table is the activity surface: it renders Lead in Q2 and MQL in
Q3. Its Conversion panel is the cohort surface: Lead-to-MQL follows selected-
period CampaignMember Leads forward, MQL-to-HPP dedupes exact Salesforce
Account IDs, and HPP-to-later stages follows selected-period HPP opportunities
through the reversible current-qualified projection.

## 3. Acquisition cohort progression

A lead belongs to the period in which it originally became a Lead.

- If a Q2 lead becomes MQL in Q3, the person remains in the Q2 acquisition
  cohort, and the Q2 cohort eventually shows Leads 1 and MQLs 1. The MQL is
  not lost because the transition happened in a later quarter.
- The same applies to deals: a deal entering HPP in Q2 remains in the Q2 HPP
  cohort. Later OPP or Pursuit entries update the Q2 cohort's progression.
  Each deal counts once at each stage it reached and once in the
  unique-opportunity total.

Every cohort calculation takes an explicit `asOf` (data-through) date. A
transition dated after `asOf` is invisible: it must not appear early.

### Cohort maturity limitation

Newer cohorts have had less time to mature. A Q3 cohort observed 30 days after
its period end has had less conversion time than a Q2 cohort observed 120 days
after its end, so their conversion efficiencies are not directly comparable.

`compareAcquisitionCohorts` therefore:

- always computes volume deltas (leads, MQLs), which remain meaningful;
- computes the efficiency delta but sets `suppressEfficiencyDelta` with
  reason `unequal_cohort_maturity` whenever the two cohorts' maturity windows
  differ;
- only lifts that suppression under an explicit `compare_anyway` rule. No
  maturity-alignment rule (for example, equal-window comparison at N days) has
  been selected by the business yet; choosing one is an open product decision.

## 4. Repeatable lifecycle transitions

Lifecycle is not monotonic. A person may follow Lead > MQL > Lead > MQL.
Lifecycle is represented as an append-only event history
(`LifecycleEvent`) that permits repeated transitions. Each event carries:

- stable lead identity;
- previous stage (`fromStage`, null for a first observation) and new stage;
- effective date when a source asserts one;
- the recorded/observed timestamp;
- a date source: `salesforce_confirmed`, `n8n_observed`, or `unknown`;
- optional raw source values for provenance;
- quality flags.

Rules enforced by `assessLeadLifecycle` and `eventsFromObservation`:

- Lead and MQL on the same date is valid and is a zero-day conversion.
- MQL dated before Lead is invalid: it is flagged (`mql_before_lead`), never
  silently swapped.
- If the automation observes Lead > MQL without a Salesforce-confirmed MQL
  date, the observation date is recorded with source `n8n_observed`. It is an
  upper bound on when the transition happened, not a confirmed historical
  date.
- If the first record received is already MQL with no MQL date, the current
  stage is known but the transition date is unknown. The date stays null with
  source `unknown`; it is never invented.
- A return from MQL to Lead is recorded as an event.
- A later Lead > MQL transition creates another event.
- The first synchronization is a baseline observation, not proof of when the
  stage began.

### Reporting definitions

- Original acquisition efficiency: a unique person counts at MQL once if they
  ever reached MQL after entering the cohort, evaluated as of `asOf`.
- The first valid Lead > MQL event supplies the original cohort conversion.
- Later Lead > MQL events are requalifications. They never increase the
  original cohort's unique-MQL count and are reported as a separate
  requalification metric.
- A member whose MQL transition date is unknown still counts as having
  reached MQL (the stage was directly observed by `asOf`) but is flagged
  `mql_timing_unknown` and makes the cohort `incomplete`, because the timing
  cannot be proven.
- Current-stage reporting is a point-in-time snapshot, separate from cohort
  and activity reporting.

### Migration concern: the current single-entry history

The current sync builder (`buildSyncPatch` in `src/lib/leadSync.ts`) appends a
stage-history entry only when no entry for that stage exists yet, and only for
upgrades away from `lead`. Consequences:

- at most one MQL entry can ever exist per lead, so a Lead > MQL > Lead > MQL
  path collapses to a single MQL record;
- a return from MQL to Lead is not recorded at all;
- the appended entry is dated with the import day and carries no date-source
  marker, so an observed baseline is indistinguishable from a confirmed
  transition date.

This is insufficient for the contract above and is a documented migration
concern. Existing `stage_history` entries created by imports should be treated
as `n8n_observed`-quality dates unless a Salesforce-confirmed date replaces
them. No schema or code change is made in this bite.

## 5. Primary-source attribution and campaign influence

Two models are maintained and must never be merged:

Primary-source funnel (`resolvePrimarySources`):

- Each lead has one original qualifying source, established by the earliest
  valid dated campaign touch. Ties on the same day break on the earlier
  observation timestamp, then input order, so recomputation is deterministic.
- A later campaign interaction never replaces the primary source.
- Manual Marketing corrections (edit-locked source fields) always win over
  recomputation.
- Totals are mutually exclusive and reconcile: assigned + unresolved equals
  unique people.
- A lead with no dated touch is `unresolved` with issue `no_dated_touch`,
  never silently assigned.

Campaign-influence report (`influenceReport`):

- Every meaningful campaign membership is retained. A person who downloads a
  Product Overview and later books a call has two touches: they remain
  primarily sourced to the earlier campaign and appear as influenced by both.
- Influence totals intentionally overlap. The report exposes
  `participationTotal` (sum of per-campaign unique leads), `uniquePeople`
  (deduplicated), and `peopleInMultipleCampaigns`, plus a constant
  `nonAdditive: true`.
- Overlapping influence counts are never the denominator for overall
  acquisition efficiency; `uniquePeople` exists for that purpose.
- Any surface showing influence totals must visibly label them as
  overlapping/non-additive and show overall unique people separately.

### Future normalized touch contract

`LeadCampaignTouch` (types only in this bite; no table or migration exists):

| Field | Meaning |
|---|---|
| `leadId` | Stable application lead identity |
| `campaignMemberId` | Salesforce CampaignMember Id, the preferred idempotency key |
| `campaignId` | Campaign identity at the sub-campaign level |
| `channelId` | Optional channel resolution for funnel bucketing |
| `touchDate` | The day the touch happened, when known |
| `parentCampaign` / `subCampaign` | Provenance as delivered by the source |
| `observedAt` | Import/observation timestamp |
| `raw` | Raw source values for audit |

`dedupeTouches` is idempotent: reprocessing the same CampaignMember Id changes
nothing. Touches without a CampaignMember Id fall back to the natural key
(lead + campaign + touch date) and are flagged `missing_campaign_member_id`.
Touches missing lead or campaign identity are rejected into a review list with
issues, never guessed.

## 6. Opportunity identity and attribution

- HPP and later stages use the stable `deal_id`. One deal may have one row per
  stage; stage rows are progression evidence, not separate opportunities.
- A lead may source more than one deal; each distinct `deal_id` is one
  opportunity.
- `lead_id` remains optional for HPP creation and source channel remains the
  required attribution evidence.
- A null `lead_id` does not prove Sales origin. The existing labeling rule is
  preserved: a leadless deal is `Sales-sourced` only when its top-level
  channel is `Sales Generated`; otherwise it is `No linked lead`.
- A missing or blank `deal_id` prevents a trustworthy unique-opportunity
  total: `summarizeDealStages` flags `missing_deal_id`, excludes the row from
  unique totals, and sets `uniqueTotalTrustworthy: false`.

## 7. Current Salesforce/n8n workflow findings

Observed from the exported workflow definition and its append-only
verification sheet (July 2026). No workflow, sheet, or database change is made
in this bite.

- The workflow runs nightly and queries CampaignMember records created in the
  last 2 days, ordered by creation date.
- It transforms each row and POSTs it to a Sourced/Supabase RPC
  (`sourced_apply_sfdc_lead`), then appends a verification row to a Google
  Sheet. The Sheet is an append-only execution log, not a unique-lead
  reporting table.
- The supplied verification sheet contains 1,467 log rows representing 587
  unique Sourced lead ids; 550 of the 587 people appear in more than one row
  (up to 8 rows for one person).
- The SOQL query does not request the lifecycle-stage field the transform
  reads (a HubSpot lifecycle field on Contact/Lead). The transform therefore
  always falls back to its default, and all 1,467 supplied rows contain
  `current_stage = lead`.
- Because only recently created CampaignMembers are queried, later lifecycle
  changes on older Campaign Members are not reliably detected.
- The transform's stage map converts HPP/OPP/Won-like lifecycle values into
  the lead `current_stage` field. The application schema constrains
  `leads.current_stage` to `lead` or `mql`, so that mapping is incompatible
  with the schema if the lifecycle path ever becomes active.
- The transform uses CampaignMember CreatedDate (date part of a UTC
  timestamp) as `marketing_sourced_date`.
- One person with multiple campaign memberships sends multiple dates and
  channels: in the supplied log, 23 people carry more than one distinct
  sourced date and 30 carry more than one distinct sub-campaign.
- The query selects the CampaignMember Id, but the transform discards it, so
  no idempotency key reaches the RPC or the log.
- The exported workflow definition has no explicit timezone; it inherits the
  instance default.
- The RPC implementation is not versioned in this repository, so exact
  server-side merge behavior (including edit-lock handling on that path)
  cannot be claimed from repository evidence.

## 8. Future ingestion validation rules

When the feed is upgraded, ingestion must:

- request the Salesforce lifecycle field explicitly in the query;
- request the become-a-lead and became-MQL date fields once their exact API
  names are confirmed (open item below);
- capture the CampaignMember Id and use it as the idempotency key;
- capture record modification information, not only recent CampaignMember
  creation, so later lifecycle changes are seen;
- preserve raw values and normalize dates without inventing them;
- accept same-day Lead/MQL as a valid zero-day conversion;
- flag reverse dates (`mql_before_lead`) instead of swapping them;
- flag lifecycle/date contradictions (`stage_date_contradiction`);
- flag missing confirmed dates instead of substituting the import day;
- record n8n-observed transitions separately from confirmed Salesforce dates
  (`n8n_observed` versus `salesforce_confirmed`);
- route questionable records to a review result (`reviewRequired`) instead of
  silently correcting them;
- make the workflow timezone explicit;
- make upserts idempotent under a documented natural key;
- preserve the lead edit-lock contract.

### The observation-to-event seam

`eventsFromObservation` (one observation) and `eventsFromObservations` (a
series for one lead) in `src/lib/funnelCohorts.ts` are the pure seam that
encodes these rules. Implemented behavior, exactly:

- First known observation (no prior stage): establishes the original Lead
  acquisition event exactly once, using the confirmed became-a-lead date when
  available (source `unknown` plus an issue when it is missing). If the
  record is already MQL, the MQL transition is also recorded: with its
  confirmed date when supplied, otherwise with a null date and source
  `unknown` (the stage is known, the historical transition date is not
  invented).
- Unchanged stage (Lead then Lead, or MQL then MQL): no lifecycle transition
  is emitted, so reprocessing the same observation is idempotent. One flag
  still applies: a confirmed MQL date appearing while the stage claims Lead
  and MQL has never been seen is routed to review as a stage/date
  contradiction. After a seen MQL, the residual historical MQL date that
  Salesforce keeps on later records is expected and not flagged.
- Lead to MQL: the transition uses the confirmed MQL date when valid,
  otherwise the observation day with `n8n_observed` provenance. The original
  Lead cohort date is never altered.
- MQL to Lead: a return event is recorded with `fromStage: mql` and
  `toStage: lead`, dated by the observation day with `n8n_observed`
  provenance. The became-a-lead date is never reused for the return, because
  it represents the original acquisition, not the later regression.
- Requalification: after a return, a later Lead-to-MQL observation produces
  another transition event; `assessLeadLifecycle` counts it as a
  requalification, never as the original MQL, and the person still belongs
  to exactly one original acquisition cohort.

Ordering: `assessLeadLifecycle` processes events in the order given and
requires observation order. `eventsFromObservations` enforces this by stably
sorting observations by `observedAt` (ties keep input order) and threading
prior-stage and MQL-seen state automatically, so shuffled input produces the
same history. Late-arriving confirmed dates on unchanged observations are not
retroactively applied to earlier events; a correction path is future work.

## 9. Open decisions and questions

- Exact Salesforce API names for the become-a-lead date and became-MQL date
  fields are unconfirmed. Do not guess them; confirm with the Salesforce
  administrator.
- Salesforce Field History Tracking availability is unconfirmed. Do not
  design around it; treat it as an optional future enhancement.
- The maturity-alignment rule for cross-cohort efficiency comparison (for
  example, equal-window at N days) is an open business decision; until it is
  selected, efficiency deltas across cohorts of different maturity are
  suppressed with a stated reason.
- The RPC's server-side merge behavior needs to be exported and reviewed
  before any claim about how the nightly feed interacts with edit locks.
- Migration of existing single-entry `stage_history` data onto the event
  contract (including date-source backfill semantics) is future work.

## 10. Scope of this bite

This bite adds pure calculation modules, tests, and this contract. It does not
wire anything into a dashboard, does not modify `computeGrid` or any
production calculation, and makes no schema, migration, workflow, Sheet, or
production-data change. Current funnel pages continue to bucket MQLs by the
quarter of the first MQL history entry; adopting the acquisition-cohort view
on a page is a later, explicitly scoped change.
