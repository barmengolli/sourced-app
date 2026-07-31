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

## Marketing Funnel: Leads & MQLs

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
| Data Entry grid (channel rows, totals) | Memberships | Switched in 4E; labeling verified (memberships subtitle + "Unique contacts" row present) |
| Data Entry drilldown panel | Memberships | Added in 4E; lists one row per touch |
| Events page (activation counts) | Primary source | Unchanged by design. `computeEventActivations` buckets each PERSON by their activation labels and primary channel; an event activation is a person-level fact, not a campaign membership. Basis subtitle added |
| Spend page (CPL / CPMQL denominators) | Primary source | **Unchanged in this bite by instruction.** See "Open question" below. Basis subtitle added |
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

## Open question for Benjamin (not decided in this bite)

**Should Spend/CPL denominators switch to memberships?** Today CPL and
CPMQL divide a channel's spend by its PRIMARY-SOURCE lead/MQL count.
Under membership counting the denominator would grow (a contact in three
campaigns counts in each), so every channel's CPL would fall while the
same contact is charged against several channels' budgets. That is a
business decision about how acquisition efficiency is defined, not a
technical one, so this bite deliberately leaves the math alone and only
labels it. Decide before quoting CPL alongside the new membership lead
counts, since the two numbers now come from different models.

Related: the Sankey and Funnel Compare surfaces are hidden today. Both
carry the legacy primary-source basis and must be classified (and
switched, if they are to show channel counts) before being un-hidden.
