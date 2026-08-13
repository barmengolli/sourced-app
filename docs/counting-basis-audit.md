# Counting-basis audit (Bite 4F)

Every surface that renders a lead- or MQL-derived number, its counting
basis, and the action taken. Per
`docs/lead-multi-attribution-program.md` section 2, the app maintains TWO
models that must never silently mix:

- **Memberships (overlapping)**: counted from `lead_campaign_touches`. A
  contact in three campaigns counts in all three. Totals intentionally
  exceed distinct people and are never a denominator for overall
  acquisition efficiency.
- **Primary source**: one channel per person (`leads.source_channel_id`),
  used for deal channel inheritance, spend/CPL math, and any
  "one number per person" reporting.
- **Unique contacts**: distinct people. Shown alongside membership totals
  wherever they overlap.

Every visible surface below carries a basis subtitle in the UI so a
reader never has to guess which model produced a number.

**No currently visible, in-scope surface required a calculation switch in
Bite 4F**: every channel x lead/MQL count already flowed through the
Bite 4E computation path, so this bite added labeling, the drawer touch
history, and this classification. That statement covers visible, in-scope
surfaces only. The hidden Funnel Flow Sankey and Funnel Compare page were
NOT audited and are NOT approved; they remain classified as hidden legacy
surfaces requiring a decision before restoration (see Follow-ups).

## Marketing Funnel Overview

| Surface | Basis | Action (Bite 4F) |
|---|---|---|
| Year lead charts (per-month bars, YoY overlay) | Memberships | Already switched in 4E via `computeMonthlyLeadsForYear`; basis subtitle added |
| Actuals vs Projections (bar) | Memberships | Consumes `grid.rows`/`grid.totals` (switched in 4E); basis subtitle added |
| Channel Distribution (donut) | Memberships | Consumes `grid.rows` (switched in 4E); basis subtitle added |
| Conversion Funnel (chart) | Memberships | Consumes `grid.totals` (switched in 4E); basis subtitle added |
| Quarterly Trend (line) | Memberships | Consumes per-quarter `computeGrid` totals (switched in 4E); basis subtitle added |
| Unassigned-leads notice | Memberships | Wording corrected: counts dated touches with no channel, not leads |
| Funnel Flow Sankey | Primary source (legacy) | **Hidden, unaudited, legacy basis.** Commented out since 2026-05-21 and NOT wired to the 4E path: `computeFunnelSankey` has a bespoke per-lead derivation (`leads` + `source_channel_id` + first-MQL), not `computeGrid`. Per the 4F rule, no new logic was built for a hidden surface. Listed as a follow-up: it must be switched to memberships (or explicitly labeled primary-source) BEFORE it is ever un-hidden |

## Marketing Funnel: other tabs

| Surface | Basis | Action (Bite 4F) |
|---|---|---|
| Operations grid (channel rows, totals) | Memberships | Switched in 4E; labeling verified (memberships subtitle + "Unique contacts" row present) |
| Operations drilldown panel | Memberships | Added in 4E; lists one row per touch |
| Events page (activation counts) | Primary source | Unchanged by design. `computeEventActivations` buckets each PERSON by their activation labels and primary channel; an event activation is a person-level fact, not a campaign membership. Basis subtitle added |
| Spend page (CPL / CPMQL denominators) | Primary source | **Unchanged: locked by the program.** See "Recorded decision" below. Basis subtitle added |
| Opportunities page (deal donuts, velocity) | Primary source (deal-side) | Unchanged by design: deals inherit one channel via primary-source resolution (program decision 1.4). Out of scope for membership counting |
| Funnel Compare page | Primary source (legacy) | Hidden from the sidebar in `chore/sidebar-cleanup`; not audited. Must be classified before it is ever un-hidden |

## Utilities and other sections

| Surface | Basis | Action (Bite 4F) |
|---|---|---|
| Leads utility page (row-per-person table) | Unique contacts | Unchanged by design (one row per person). Basis subtitle added |
| Lead detail drawer | Both, explicitly separated | Primary channel remains the lead's `source_channel_id` field; the new "Campaign touches" section lists every membership with provenance, source badge, and a primary marker |
| Channels utility page (per-channel lead counts) | Primary source | Unchanged by design: `useChannelLeadCounts` counts `leads.source_channel_id` to answer "how many people would this channel orphan if deleted", a person-level question. Basis note added |
| Campaigns scorecard (leads/MQLs per campaign tag) | Primary source | Unchanged in this bite. Counts distinct people via `leads.source_channel_id` across a tag's linked channels. Switching it to memberships is deferred to Bite 4H (campaign overlap/influence), where overlapping campaign totals are the explicit subject. Basis subtitle added |
| BDR dashboards / quotas | Deal-side only | Out of scope: no lead/MQL counting (HPP+ from attributions) |
| 6sense, Outreach, LinkedIn Ads sections | Own sources | Out of scope: no `lead_campaign_touches` or `leads` consumption |

## Recorded decision: Spend stays primary-source-based

This is **not** an open question. `docs/lead-multi-attribution-program.md`
section 2 already locks it: the primary-source model remains authoritative
for "deal channel inheritance, acquisition-efficiency denominators,
spend/CPL math, and any 'one number per person' reporting". Campaign
memberships are overlapping influence counts and must never become Spend
denominators.

The reason is arithmetic. A membership denominator counts one contact once
per campaign they joined, so a contact in three campaigns would be credited
against three channel budgets at once. Every channel's CPL and CPMQL would
fall without a cent of spend changing or a single new person being acquired,
and the resulting efficiency figures would not sum to anything meaningful at
the portfolio level. Acquisition efficiency is a per-person question, so it
keeps a per-person denominator.

Practical consequence, which the Spend page states in its own basis line:
**Spend numbers and funnel membership totals come from different models on
purpose and will not reconcile.** The funnel grid's lead count for a channel
is expected to exceed the lead count behind that channel's CPL. That gap is
the multi-campaign overlap, not an error. Quote CPL with its primary-source
basis attached whenever it appears next to membership counts.

## Follow-ups before any hidden surface returns

The Funnel Flow Sankey and the Funnel Compare page are hidden today and
were **not** audited in this bite. Both carry the legacy primary-source
basis and neither is wired to the Bite 4E computation path. Before either
is un-hidden it must be explicitly classified and then either switched to
memberships or labeled primary-source; restoring one as-is would put an
unlabeled, unswitched surface back in front of users.
