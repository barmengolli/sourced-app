# Data correctness audit: `src/lib/compute.ts`

Read-only static audit of every exported function in `src/lib/compute.ts` (2734 lines, 22 exports), completed 2026-07-16. No source files were modified.

Severity scale: **BLOCKER** (produces wrong numbers on normal data, must fix before trusting the view), **HIGH** (wrong numbers on plausible data shapes), **MEDIUM** (wrong numbers on a specific data shape that may or may not exist yet), **LOW** (latent, cosmetic, or data-quality dependent).

**Headline:** no BLOCKER or HIGH issues found. The heavy math (percentages, velocity, ROI, period bounds) is division-guarded and boundary-correct. Five MEDIUM issues cluster in three functions (`computeGrid`, `computeMonthlyLeadsForYear`, `computeFunnelSankey`, `computeChannelSpend`) and all depend on a specific data shape (manual `funnel_actuals` overlapping real data, MQL-less leads, or a channel-taxonomy shape) that could not be confirmed from code alone. Each is spelled out with a concrete failure scenario in the per-function entries and re-listed in the [follow-up ticket list](#follow-up-ticket-list-blocker--high).

---

### `computeGrid`
- **Purpose (from comments):** Build the Data Entry funnel grid: per-channel rows with actual/projection cells for all 7 stages, rolled up the channel tree, DFS-ordered, plus totals and an unassigned-lead count. Leads bucket lead/mql by date; attributions bucket HPP+; `funnel_actuals` is a fallback only where no compute pass already covers a cell (lines 127-168, 214-305).
- **Inputs:** `ComputeInput`: `leads`, `channels`, `projections`, `manualActuals`, optional `attributions`, `year`, `filter: PeriodFilter`, optional `regions: Set<RegionKey>` (lines 68-84).
- **Output:** `ComputedGrid` = `{ rows, totals, unassignedLeadCount }` (lines 62-66).
- **Math / logic summary:** For the selected (year, period): count leads/MQLs into their source channel by `marketing_sourced_date` (MQL gated on a strict cohort where the lead's source date is also in-period), count attribution rows into their leaf channel with a strict "HPP-in-period" cohort gate on non-HPP stages, add `funnel_actuals` only for uncovered cells, layer in projections, then roll actuals (all stages) and projections (lead/mql only) up the channel tree and sum roots into totals.
- **Edge cases audited:**
  - Empty input: all maps empty, `rows: []`, `totals` all-null, `unassignedLeadCount: 0`. Correct.
  - Single-item input: one channel/one lead buckets correctly; a lone root becomes its own total. Correct.
  - All-nulls input: leads with null `marketing_sourced_date` → `quarterOfIsoDate` returns null → not counted, not unassigned (lines 173-176). A lead with a valid date but null `source_channel_id` counts as unassigned (line 178). Correct.
  - Boundary date at year/quarter edges: uses `quarterOfIsoDate` (string-parse, local-safe) + `matchesPeriod`. Dec 31 2025 → Q4 2025; Jan 1 2026 → Q1 2026. No off-by-one.
  - Rows with missing channel_id / region / stage_key: null `source_channel_id` → unassigned or skipped; `rowMap.get` miss → silently dropped; null region routed through `matchesRegionFilter` → treated as 'Other'; projection with a `stage_key` not in `FUNNEL_STAGES` skipped (line 315). Handled.
- **Filters applied:** Region via `matchesRegionFilter(l.region / a.region, regions)` (lines 171, 247, 268), shared helper. Period via `matchesPeriod`. Strict-cohort gates: MQL requires lead in-period (line 195); non-HPP attribution stages require the deal's HPP in-period (lines 276-278).
- **Field-lock interaction:** N/A. `field_locks` is not read here.
- **Concerns:**
  - **MEDIUM (verified in source, lines 288-305):** the manual `funnel_actuals` fallback double-counts against partial compute coverage. `handledByLeads` / `handledByAttribution` are populated only for the specific (channel, year, period, stage) cells a lead or attribution actually landed in. If a `funnel_actuals` row exists for a cell where the compute pass produced zero rows (e.g. attributions all removed by the HPP-cohort gate at 276-278, or a region toggle emptied the cell), the fallback value is *added* (line 304, `cell.actual = (cell.actual ?? 0) + m.actual`) rather than suppressed. In a year with both real attributions and backfill actuals for the same channel, gated-to-zero cells receive the manual value on top. Latent on the seeded 2025 taxonomy (actuals-only), hence MEDIUM. Failure scenario: channel X has real HPP attributions in Q1 but a region filter removes them all from the view; a `funnel_actuals` HPP row for (X, 2026, Q1) then appears as if it were real, inflating the filtered total.
  - **LOW:** `unassignedLeadCount` surfaces only lead-stage unassigned leads; MQL-stage-only unassigned contributions are never counted (by design, undocumented at the count site).

---

### `conversionPercent`
- **Purpose (from comments):** "Conversion %: numerator / denominator * 100. null if denom is 0 or null." (line 434).
- **Inputs:** `num: number | null`, `den: number | null`.
- **Output:** `number | null`.
- **Math / logic summary:** null if either arg null or denom 0; else `(num/den)*100`.
- **Edge cases audited:** All-nulls → null; division-by-zero guarded (line 440). Scalar, so empty/single/boundary N/A.
- **Filters applied:** None.
- **Field-lock interaction:** N/A.
- **Concerns:** LOW. Does not guard negative num/den, not expected here. None material.

---

### `onTargetPercent`
- **Purpose (from comments):** "On-target %: actual / projection. null if projection is 0/null." (line 444).
- **Inputs:** `actual: number | null`, `projection: number | null`.
- **Output:** `number | null`.
- **Math / logic summary:** null if actual/projection null or projection 0; else `(actual/projection)*100`.
- **Edge cases audited:** Null and zero-projection guarded (line 449). Correct.
- **Filters applied:** None.
- **Field-lock interaction:** N/A.
- **Concerns:** None found.

---

### `funnelEfficiencyPercent`
- **Purpose (from comments):** "Funnel efficiency: actual at this stage / actual at previous stage." (line 453).
- **Inputs:** `thisActual: number | null`, `prevActual: number | null`.
- **Output:** `number | null`.
- **Math / logic summary:** null if either null or prev 0; else `(this/prev)*100`.
- **Edge cases audited:** Guarded (line 458). Correct.
- **Filters applied:** None.
- **Field-lock interaction:** N/A.
- **Concerns:** None found.

---

### `isAttributionStage`
- **Purpose (from comments):** "Used by the manual-actual upsert UI; returns the AttributionStageKey type guard since FunnelStageKey is wider." (lines 463-464).
- **Inputs:** `s: FunnelStageKey`.
- **Output:** type-predicate `s is AttributionStageKey`.
- **Math / logic summary:** True iff `s` is one of hpp/opp/pursuit/closeWon/closeLost.
- **Edge cases audited:** Exhaustive over the 5 attribution stages; `lead`/`mql` → false. Matches `AttributionStageKey` in `db.ts`. Correct.
- **Filters applied:** None.
- **Field-lock interaction:** N/A.
- **Concerns:** None found.

---

### `computeWeekly`
- **Purpose (from comments):** Per-channel × stage actuals bucketed by ISO week for the Compare tab. Lead/MQL from `marketing_sourced_date` / `stage_history`; HPP+ from `attributions.created_at` (week-of-logging, NOT the SFDC transition date), deliberately, to match Data Entry (lines 522-527).
- **Inputs:** `ComputeWeeklyInput`: `leads`, `channels`, optional `attributions`, `weeks: IsoWeek[]`, optional `regions` (lines 501-508).
- **Output:** `WeeklyGrid` = `{ weeks, rows, totals, unassignedLeadCount }`.
- **Math / logic summary:** Bucket each lead's lead/MQL date into its ISO-week column, each attribution's `created_at` into its week column; roll up per-week counts through the tree; DFS order; sum roots.
- **Edge cases audited:**
  - Empty input: `numWeeks=0`, all cells `counts: []`, no rows. Correct.
  - Single-item: single week/lead buckets correctly.
  - All-nulls: null dates → `isoWeekOf` null → skipped. Correct.
  - Boundary date: `isoWeekOf` uses the ISO week-numbering year, so late-Dec/early-Jan dates map to the ISO year (can differ from calendar year), consistent with how `weeks` are generated. Correct per ISO semantics.
  - Missing channel_id / region / stage_key: null `channel_id` on attribution skipped (line 579); null region → `matchesRegionFilter`; unassigned leads counted; `rowMap.get` miss dropped.
- **Filters applied:** Region via `matchesRegionFilter` (lines 550, 580), shared helper. Week membership via `weekIndex` lookup. **No strict-cohort gate** (unlike `computeGrid`).
- **Field-lock interaction:** N/A.
- **Concerns:**
  - **MEDIUM:** no HPP-in-period cohort gate here, unlike `computeGrid` (276-278). A weekly Opp/Pursuit/Won count includes deals whose HPP is outside the window, so any week-over-week conversion ratio built from this grid is not guaranteed ≤ 100% and is not cohort-consistent with the quarterly grid. Arguably intentional for a raw week-of-activity view, but it is a silent semantic divergence from `computeGrid` and undocumented as such.
  - **LOW:** a deeply-nested cross-year child under a filtered-out parent is skipped with no orphan pickup (latent given the seeded taxonomy has no sub-channels).

---

### `computeMonthly`
- **Purpose (from comments):** Same shape as `computeWeekly` but by calendar month; two differences: dates use month+year, and HPP+ bucket by `stage_entered_at` (the actual transition day), not `created_at`, because MoM answers "how many deals progressed to this stage this month" (lines 674-684).
- **Inputs:** `ComputeMonthlyInput`: `leads`, `channels`, optional `attributions`, `months: MonthBucket[]`, optional `regions` (lines 712-718).
- **Output:** `MonthlyGrid` = `{ months, rows, totals, unassignedLeadCount }`.
- **Math / logic summary:** Bucket lead/MQL dates and attribution `stage_entered_at` into month columns via `monthOfIsoDate` (string-parse); tree rollup; DFS order; root totals.
- **Edge cases audited:**
  - Empty input: `numMonths=0`, empty cells, no rows. Correct.
  - Single-item: correct.
  - All-nulls: null dates → `monthOfIsoDate` null → skipped. Correct.
  - Boundary date: `monthOfIsoDate` parses leading `YYYY-MM`, so Dec 31 → month 12, Jan 1 → month 1, no UTC drift. Correct.
  - Missing channel_id / region / stage_key: null `channel_id` skipped (line 803); null region → `matchesRegionFilter`; `rowMap.get` miss dropped.
- **Filters applied:** Region via `matchesRegionFilter` (lines 773, 804). Month membership via `monthIndex` lookup. No strict-cohort gate.
- **Field-lock interaction:** N/A.
- **Concerns:**
  - **MEDIUM:** same missing cohort gate as `computeWeekly`, compounded because lead/MQL bucket by their own date while HPP+ bucket by `stage_entered_at`, so a deal's HPP can land in a different month than the lead's source month. Any UI dividing monthly Opp by monthly HPP measures two unrelated cohorts. Fine for a "stage activity per month" view; undocumented risk otherwise.

---

### `shiftMonth`
- **Purpose (from comments):** "Shift a MonthBucket by `delta` months. Wraps year correctly via Date arithmetic." (lines 897-898).
- **Inputs:** `m: MonthBucket`, `delta: number`.
- **Output:** `MonthBucket` = `{ year, month }` (month 1..12).
- **Math / logic summary:** `Date.UTC(year, month-1+delta, 1)` (day 1 avoids month-length rollover), reads back UTC year/month.
- **Edge cases audited:** `{2026,1}` −1 → `{2025,12}`; `{2025,12}` +1 → `{2026,1}`; large delta wraps years; delta 0 identity. All correct. UTC + day-1 correctly avoids both timezone drift and the 31st-of-month rollover.
- **Filters applied:** None.
- **Field-lock interaction:** N/A.
- **Concerns:** None found.

---

### `computeMonthlyLeadsForYear`
- **Purpose (from comments):** Powers the Leads & MQLs year bar charts; always 12 months of the input year; region filter applies; each lead rolls up to its top-level channel; leads without `source_channel_id` dropped. Historical-year backfill spreads quarterly `funnel_actuals` lead rows across the quarter's 3 months (remainder front-loaded), deduped against real leads per (channel, month) cell (lines 905-922).
- **Inputs:** `ComputeMonthlyLeadsForYearInput`: `leads`, `channels`, `year`, `regions: Set<RegionKey>`, optional `manualActuals` (lines 940-950).
- **Output:** `MonthlyLeadsForYear` = `{ byChannel, monthTotals: number[12] }`.
- **Math / logic summary:** For each in-year lead, resolve top-level channel and increment its month bucket + `monthTotals`; then for each quarterly `funnel_actuals` lead row, spread the count across its 3 months via `spreadQuarterlyToMonths`, skipping any (topChannel, month) cell already covered by a real lead; sort channels by year total desc.
- **Edge cases audited:**
  - Empty input: `byChannel: []`, `monthTotals: [0×12]`. Correct.
  - Single-item: one lead → one channel row, one month bumped. Correct.
  - All-nulls: null `source_channel_id` skipped (line 988); null `marketing_sourced_date` → `monthOfIsoDate` null → skipped (line 991). Correct.
  - Boundary date: filters `leadMonth.year !== year` (line 991) via string-parsed month/year. Dec 31 of prior year excluded, Jan 1 of `year` included. Correct.
  - Missing channel/region: unresolvable top-level id falls back to itself via `resolveTopLevelChannelId` (cycle-guarded); name miss → 'Unknown'; null region → `matchesRegionFilter`.
- **Filters applied:** Region via `matchesRegionFilter` (line 989). Year via explicit `!== year` checks. Only `stage_key === 'lead'` funnel_actuals feed this (line 1011).
- **Field-lock interaction:** N/A.
- **Concerns:**
  - **MEDIUM (verified):** dedupe granularity mismatch creates a partial double-count. The leads pass keys `handledByLeads` on the resolved top-level channel per month (`cellKey(topId, idx)`, line 1004), but the quarterly fallback spreads across all 3 months of the quarter while dedupe-checking per (topId, month). If a channel has real leads in only month 1 of a quarter but a `funnel_actuals` lead row also exists for that quarter, months 2 and 3 are not in `handledByLeads`, so the spread value is added to months 2-3 on top of the real month-1 leads, mixing real and backfill within one quarter and inflating the channel's year total. The comment (916-922) claims per-cell dedupe prevents double-counting, but the cell unit (month) is finer than the fallback's unit (quarter), so within-quarter mixing slips through. Failure scenario: channel Y has 5 real leads in Jan 2025 and a `funnel_actuals` Q1 lead row of 30; Jan is deduped but Feb+Mar receive the spread, so Y shows 5 + (spread over Feb, Mar) instead of max(real, backfill).

---

### `computeFunnelSankey`
- **Purpose (from comments):** 7-column Sankey (Channels → Leads → MQL → HPP → Opp → Pursuit → Won|Lost). Cohort = leads with `marketing_sourced_date` in period AND region in set; manual-entry deals (no `lead_id`) enter at HPP matched by (year, period_index) + region. Once in cohort, downstream transitions are NOT re-filtered (lines 1056-1071).
- **Inputs:** `ComputeFunnelSankeyInput`: `leads`, `attributions`, `channels`, `year`, `filter`, optional `regions` (lines 1095-1102).
- **Output:** `FunnelSankeyData` = `{ nodes, edges }`.
- **Math / logic summary:** Pass 1 traces each cohort lead by top-level channel to Leads, then Leads→MQL, MQL→HPP and deal-stage edges via its attribution chain; Pass 2 emits Channel→HPP + deal edges for lead-less deals (matched on the HPP row's period + derived region), skipping deals already counted via a lead; Pass 2b handles HPP rows with no `deal_id`; finally `stage:closeWon` edges retarget to `terminal:closeWon`.
- **Edge cases audited:**
  - Empty input: no edges; nodes still emitted for every top-level channel + all stage/terminal nodes. Correct.
  - Single-item: one lead with a channel → one Channel→Leads edge. Correct.
  - All-nulls: null lead region → `matchesRegionFilter`; null `marketing_sourced_date` → skipped (1233); null `source_channel_id` skipped (1234); null `channel_id` on a manual HPP → skipped (1297, 1317).
  - Boundary date: cohort via `quarterOfIsoDate` + `matchesPeriod` for leads (1233) and the HPP row's `{year, period_index}` for manual deals (1294). Consistent, no off-by-one.
  - Missing channel/region/stage: handled; `deriveDealRegion` null → 'Other'.
- **Filters applied:** Region via `matchesRegionFilter` (1231, 1293, 1313) and `deriveDealRegion` for manual deals. Period via `matchesPeriod`. Cohort leads filtered on the lead's region; the deal chain they seed is NOT re-region-filtered (documented, 1069-1071).
- **Field-lock interaction:** N/A.
- **Concerns:**
  - **MEDIUM (verified in source, lines 1242 vs 1269-1271):** `stage:mql → stage:hpp` is emitted for any cohort lead whose deal chain has an HPP row (line 1269), but `stage:lead → stage:mql` is only emitted when `firstMqlDate(lead) !== null` (line 1242). A cohort lead with an HPP but no stored MQL transition contributes to `mql→hpp` without a matching `lead→mql` inflow, so the MQL node's outflow can exceed its inflow and the Sankey visually "creates" volume at MQL (flow not conserved). Failure scenario: one cohort lead, no `mql` in `stage_history`, one HPP attribution → edges `channel→lead (1)` and `mql→hpp (1)` but no `lead→mql`. The code comment (1264-1268) acknowledges the "reached MQL OR went straight to HPP" intent, so this is a known modelling choice, but it breaks flow conservation for any downstream ratio math.
  - **LOW:** a lead may seed multiple deals, each emitting its own `mql→hpp`, so one lead with two HPP deals yields `lead→mql` = 1 but `mql→hpp` = 2. Same conservation caveat, by design.

---

### `computeDealVelocities`
- **Purpose (from comments):** One `DealVelocity` per distinct `deal_id`; walk the chain in canonical order (hpp→opp→pursuit→won|lost) using `stage_entered_at`; lead/MQL ignored; region derived from the chain (HPP row, else earliest by priority) (lines 1390-1401, 1514-1523).
- **Inputs:** `ComputeDealVelocityInput`: `attributions`, `regions: Set<RegionKey>`, optional `today: string` (injectable) (lines 1469-1474).
- **Output:** `DealVelocity[]`.
- **Math / logic summary:** Group by `deal_id` (rows without one skipped); pick current stage (closeLost > closeWon > highest progression rank); region-filter via `deriveDealRegion`; compute days-in-current-stage, days-since-HPP, HPP→Opp and Opp→Pursuit gaps via UTC day subtraction; flag `isStale` when the current-stage threshold exists and is exceeded; collect sorted `stageEnteredAts`.
- **Edge cases audited:**
  - Empty input: `[]`. Correct.
  - Single-item: one row with a `deal_id` → one velocity. Correct.
  - All-nulls: rows without `deal_id` skipped (1486); null label/account/amount/sf_link defaulted (1571-1572, 1588).
  - Boundary date: `daysBetween` parses `T00:00:00Z` and floors the UTC-day difference, no DST issue; `hppYear`/`hppPeriodIndex` copied verbatim from the HPP row. Correct.
  - Missing channel/region/stage: `channel_id` not read; null region → `deriveDealRegion` null → 'Other'; `stage_entered_at` required non-null.
- **Filters applied:** Region via `matchesRegionFilter(deriveDealRegion(rows), regions)` (line 1523). No period filter (the page filters on `stageEnteredAts` downstream).
- **Field-lock interaction:** N/A.
- **Concerns:**
  - **MEDIUM:** "current stage" ignores dates. When both closeLost and closeWon rows exist on one deal, closeLost always wins (1498-1500) regardless of which was entered later; among open stages the pick is by static progression rank, not latest `stage_entered_at`. A deal lost-then-re-won (or with a stray closeLost row) is reported as Lost, and a deal with a later HPP re-entry after an Opp would still report Opp. Failure scenario: a deal has closeWon on 2026-03-01 and a mistaken closeLost on 2026-02-01; it is labelled Lost.
  - **LOW:** `hppToOppDays` / `oppToPursuitDays` can be negative if `stage_entered_at` values are out of order; no guard, feeds directly into `computeStageVelocityStats`. Data-quality dependent.
  - **LOW:** `daysBetween` returns 0 on unparseable input (1425), masking bad data as "0 days".

---

### `computeStageVelocityStats`
- **Purpose (from comments):** "One entry per transition key in VELOCITY_THRESHOLDS. Reads the per-deal gap field that matches each transition key." (lines 1602-1603).
- **Inputs:** `velocities: DealVelocity[]`.
- **Output:** `StageVelocityStats[]` = `{ transitionKey, average, median, count }` per threshold key.
- **Math / logic summary:** For each key, map to its gap field, collect numeric values, compute mean + median (two-sided average for even counts); empty → nulls, count 0.
- **Edge cases audited:**
  - Empty input: every key emits `{average:null, median:null, count:0}`, no division by zero (1623). Correct.
  - Single-item: median = the single value. Correct.
  - All-nulls: deals whose gap field is null excluded by `typeof raw === 'number'` (1620). Correct.
  - Boundary date: N/A (precomputed day counts).
  - Missing fields: unrecognized transition key → `fieldFor` null → empty → count 0.
- **Filters applied:** None (consumes already-filtered velocities).
- **Field-lock interaction:** N/A.
- **Concerns:**
  - **LOW:** inherits negative/zero gaps from `computeDealVelocities` (no lower-bound guard), so a data-entry inversion drags the average/median negative. Upstream data-quality issue surfaced here, not a logic bug.

---

### `isDealOpen`
- **Purpose (from comments):** "Returns true when a deal's attribution chain is open: at least one row at hpp/opp/pursuit AND no row at closeWon/closeLost." (lines 1673-1677).
- **Inputs:** `rows: Attribution[]` (all rows sharing one `deal_id`).
- **Output:** `boolean`.
- **Math / logic summary:** Returns false on any closeWon/closeLost row; sets `hasOpen` on any hpp/opp/pursuit; returns `hasOpen`.
- **Edge cases audited:**
  - Empty input: `hasOpen=false` → false. Correct (empty chain is not open).
  - Single-item: lone hpp → true; lone closeWon → false. Correct.
  - All-nulls: `stage_key` typed non-null; unknown value neither opens nor closes.
  - Boundary date: no date logic.
  - Missing stage_key: type-guaranteed present.
- **Filters applied:** Stage-key membership only.
- **Field-lock interaction:** N/A.
- **Concerns:** None found. Order-independent and a valid classifier.

---

### `computeRegionDistribution`
- **Purpose (from comments):** Keep only OPEN deals with at least one row whose `stage_entered_at` is in the selected period; pick the deal's "first" row by `REGION_STAGE_PRIORITY` and tally per region; a first row with no region falls into 'Other' (lines 1710-1727).
- **Inputs:** `{ attributions, year, filter: PeriodFilter }`.
- **Output:** `RegionDistribution` = `{ regions, totalDeals, totalAmount }`, sorted by dealCount desc.
- **Math / logic summary:** Group by `deal_id` (skip rows with none); drop non-open and out-of-period deals; per deal pick the highest-priority stage row, tally count+amount into that row's region (null → 'Other'), compute `percentageOfCount`.
- **Edge cases audited:**
  - Empty input: `{ regions: [], totalDeals: 0, totalAmount: 0 }`. Correct.
  - Single-item: one open in-period deal → one region at 100%. Correct.
  - All-nulls: null `deal_id` skipped (1704); null region → 'Other' (1739); null amount → 0 (1742). Correct.
  - Boundary date: delegated to `dealMatchesPeriod` / `periodBoundsFor`, inclusive endpoints. Correct.
  - Missing region/stage_key: null region → 'Other'; a deal with none of the five priority stages is dropped (1738), but `isDealOpen` already guarantees an hpp/opp/pursuit row, so this can't hit open deals.
- **Filters applied:** `deal_id` present; `isDealOpen`; `dealMatchesPeriod`. **No region filter** (intentional: distribution builders are region-agnostic per `regionFilter.ts` lines 4-6).
- **Field-lock interaction:** N/A.
- **Concerns:** **LOW.** Division guarded. The donut deliberately ignores the page's region toggle; a reconciliation surprise for product, not a bug. See [cross-cutting](#region-filtering-consistency).

---

### `NO_CHANNEL_KEY` (constant, line 1779)
- **Purpose (from comments):** Sentinel bucket id for deals whose first-stage row has no `channel_id`, so they aren't silently dropped (lines 1775-1777).
- **Concerns:** None. Value `'__no_channel__'` is namespaced and won't collide with a UUID.

---

### `computeChannelDistribution`
- **Purpose (from comments):** Parallels `computeRegionDistribution` but buckets per TOP-LEVEL channel; a deal's channel comes from its earliest stage row (`REGION_STAGE_PRIORITY`), resolved to root via `parent_channel_id`; no-channel deals land in `NO_CHANNEL_KEY` (lines 1770-1777).
- **Inputs:** `{ attributions, channels, year, filter }`.
- **Output:** `ChannelDistribution` = `{ channels, totalDeals, totalAmount }`.
- **Math / logic summary:** Build `channelById` + cycle-safe `rootIdFor` walk; group by `deal_id`; drop non-open / out-of-period; bucket each deal by its priority-stage row's root channel (or `NO_CHANNEL_KEY`); tally count/amount, compute percentages.
- **Edge cases audited:**
  - Empty input: empty distribution. Correct.
  - Single-item: one bucket at 100%. Correct.
  - All-nulls: null `channel_id` → `NO_CHANNEL_KEY` named "No channel" (1871-1873). Correct.
  - Boundary date: `dealMatchesPeriod` path, correct at edges.
  - Missing channel_id/stage: no-channel handled; unknown channel_id → `rootIdFor` returns the id, name falls back to 'Unknown' (1876); no-priority-stage deal dropped (1868) but can't happen for open deals.
  - `rootIdFor` cycle: `seen` set guards against infinite loop (1822).
- **Filters applied:** `deal_id`; `isDealOpen`; `dealMatchesPeriod`. No region filter (intentional).
- **Field-lock interaction:** N/A.
- **Concerns:** **LOW.** Division guarded. `filterChannelsByYear` is not applied, so a channel from a different year than `year` could appear if an in-period attribution points at it; in practice the period filter constrains this.

---

### `computeEventActivations`
- **Purpose (from comments):** Per-event aggregation of contacts and SFDC `event_activations`; events = descendants of the year's parent "2026 - Events" channel; counts unique contacts bucketed by `source_channel_id` and `marketing_sourced_date` in period; region filter applies; empty events dropped (lines 1915-1927).
- **Inputs:** `{ leads, channels, parentChannelName, year, filter, regions: Set<RegionKey> }`.
- **Output:** `EventActivationCounts[]` sorted by `totalContacts` desc.
- **Math / logic summary:** Find the parent by name; BFS-collect descendant channel ids; per lead in an event channel passing region + period, increment `totalContacts`, compute `recognized` (all 5 values) and `activeSet` (4 active only), then bump `withAnyActivation` (activeSet≥1), `multiActivation` (activeSet≥2), `preAndPost`, and `perType` for every recognized value.
- **Edge cases audited:**
  - Empty input: `[]`; also `[]` if parent missing (1955) or no descendants (1976). Correct.
  - Single-item: one lead → one event with `totalContacts:1`. Correct.
  - All-nulls: null `source_channel_id` skipped (1998); `event_activations ?? []` guards null (2024); empty array → `activeSet` empty → contributes only to `totalContacts`. Correct.
  - Boundary date: `quarterOfIsoDate` + `matchesPeriod`, quarter-granularity, inclusive. `2026-04-01` → Q2. Correct.
  - Missing channel: lead's channel not in `channelById` → 'Unknown' (2009).
- **Filters applied:** `source_channel_id` present; `eventChannelIds` membership; `matchesRegionFilter(lead.region, regions)` (shared helper); `matchesPeriod`.
- **Field-lock interaction:** N/A.
- **Active-vs-Registered set logic (specifically requested):** Correct. `recognized` filters against `EVENT_ACTIVATION_ALL` (5 values incl. Registered) and drives `perType` so Registered gets its own column (2038-2040); `activeSet` filters against `EVENT_ACTIVATION_VALUES` (4 active) and gates `withAnyActivation` / `multiActivation` / `preAndPost` (2028-2037). A contact with only "Registered" counts in `totalContacts` and the Registered column but NOT in `withAnyActivation`, exactly per the constants file and the interface comments. Duplicated values in one lead's array are de-duped by the `Set`, so `perType` is unique-per-contact.
- **Concerns:** **LOW.** `parentChannelName` matched by exact channel `name` (1954); if two channels share that name (cross-year duplicates) `find` takes the first. Safe for "2026 - Events" naming; a rename/duplication would silently pick one subtree.

---

### `periodBoundsFor`
- **Purpose (from comments):** Inclusive day endpoints, stringly-typed so date math is lexicographic against cost rows (lines 2116-2117).
- **Inputs:** `year: number`, `filter: PeriodFilter`.
- **Output:** `PeriodBounds` = `{ start, end }` inclusive ISO dates.
- **Math / logic summary:** `'year'` → `YYYY-01-01`..`YYYY-12-31`. Else parse quarter `q`; `startMonth=(q-1)*3`, `endMonth=startMonth+2`; last day via `Date.UTC(year, endMonth+1, 0)`.
- **Edge cases audited:** Q1 → `-01-01`..`-03-31`; Q2 → `-04-01`..`-06-30` (June 30); Q4 → `-10-01`..`-12-31`; leap-year Q1 end always March 31; no cross-year bleed. All correct, no off-by-one.
- **Filters applied:** N/A.
- **Field-lock interaction:** N/A.
- **Concerns:** None found.

---

### `dealMatchesPeriod`
- **Purpose (from comments):** True when at least one attribution row's `stage_entered_at` is within the period; used to include deals that originated in a prior year but transitioned stage in the selected period (lines 2134-2137).
- **Inputs:** `rows: Attribution[]`, `year`, `filter`.
- **Output:** `boolean`.
- **Math / logic summary:** Compute `periodBoundsFor`; return true on the first row whose `stage_entered_at` is lexicographically within `[start, end]` inclusive (2147).
- **Edge cases audited:**
  - Empty input: false. Correct.
  - Single-item: in-range → true. Correct.
  - All-nulls: code defensively skips falsy `d` (2145-2146); all-null → false.
  - Boundary date: `'2026-03-31'` for Q1 → `d <= '2026-03-31'` true (inclusive); `'2026-04-01'` excluded from Q1. Correct, no off-by-one.
- **Filters applied:** period only.
- **Field-lock interaction:** N/A.
- **Concerns:** **LOW/MEDIUM (conditional):** the lexicographic compare assumes `stage_entered_at` is a pure `YYYY-MM-DD`. If the field ever carried a time suffix (`...T10:00`), `'2026-03-31T10:00' > '2026-03-31'` would wrongly exclude the period's last day. Correct given the documented schema (`db.ts` 140-142); would break only if the data format drifts.

---

### `compareTouchesChronologically`
- **Purpose (from comments):** Earliest `touched_at` first, nulls LAST, tie-broken by `touch_order` ascending; `touch_order` is entry order, not chronology, so only a tie-breaker (lines 2200-2206).
- **Inputs:** two `AttributionTouch`.
- **Output:** `number` comparator result.
- **Math / logic summary:** If exactly one has null `touched_at`, the null sorts last; else if both non-null and differ, compare strings; else fall through to `touch_order`.
- **Total-order validity (specifically requested):** Valid total order. The comparator induces keys `(touched_at===null ? +∞ : touched_at, touch_order)` compared lexicographically; both keys are totally ordered, so it is antisymmetric, transitive, and consistent. No intransitivity.
- **Edge cases audited:** Both-null falls to `touch_order`; equal on both keys returns 0 (ties allowed). Correct.
- **Filters applied:** N/A.
- **Field-lock interaction:** N/A.
- **Concerns:** None found.

---

### `computeChannelSpend`
- **Purpose (from comments):** Joins `campaign_costs` with leads/attributions/touches for pro-rated cost, lead/MQL counts, first-touch pipeline, and ROI per channel; pro-rating via inclusive-day overlap; region filter applies to leads and attributions but NOT to cost; first-touch = smallest `touched_at` (nulls last), tie `touch_order` (lines 2048-2067).
- **Inputs:** `{ campaignCosts, channels, leads, attributions, attributionTouches, year, filter, regions }`.
- **Output:** `ChannelSpendBreakdown[]` (one per channel, with parent roll-ups).
- **Math / logic summary:** (1) pro-rated `directCost` per channel by day-overlap; (2) region-filtered, period-bound lead/MQL counts; (3) group attributions by deal; (4) index touches; (5) `firstTouchByDeal` = channel of the chronologically-first channel-bearing touch (fallback HPP row channel); (6) aggregate first-touch opps/pipeline/won; (7) allocate parent-only cost to descendants by lead share; (8) materialize rows with CPL/CPMQL/ROI; (9) post-order roll children into parents.
- **Edge cases audited:**
  - Empty input: one zeroed row per channel. Correct.
  - Single-item: one in-period lead → that channel's `leads:1`. Correct.
  - All-nulls: null `source_channel_id` skipped (2271); null `marketing_sourced_date` skipped (2274); null-channel touches filtered before sort (2319); null amount → 0.
  - Boundary date: `d >= start && d <= end` inclusive; `overlapDays`/`daysInclusive` UTC-midnight + `+1` inclusive. Correct at edges.
  - Missing channel/region/stage: deal with no first-touch and no HPP-row channel skipped from opps (2338-2339); a cost row whose `channel_id` isn't in `channels` accrues `directCost` but produces no output row (see concern).
- **First-touch resolution (audited):** `firstTouchByDeal` flattens touches across all of a deal's rows, filters to channel-bearing touches BEFORE sorting (2317-2319), sorts by `compareTouchesChronologically`, takes `[0]`, falls back to the HPP row channel. Correct, matches the comment.
- **Region filter (audited):** Leads via `matchesRegionFilter(lead.region, regions)` (2272); deals via `deriveDealRegion(rows)` → `matchesRegionFilter` (2343-2344). Both shared helper. Cost intentionally not region-scoped. Correct.
- **Period filter (audited):** Leads by `marketing_sourced_date`; deals by `dealCohortDate` (earliest `stage_entered_at`), NOT `dealMatchesPeriod` (deliberate, documented at 2174-2177). Consistent.
- **Amount aggregation (audited):** Pipeline uses `dealAmount(rows)` = MAX amount across rows (2191-2198); won uses the `closeWon` row's own `amount` (2367). Asymmetric but intentional.
- **Field-lock interaction:** N/A.
- **Concerns:**
  - **MEDIUM (verified in source, lines 2436-2438):** a `campaign_costs` row whose `channel_id` is not in the `channels` array has its `directCost` computed (step 1) but is then dropped from output, because the materialization loop iterates `channels` only. The money silently vanishes from every total. Concrete scenario: the caller commonly passes `filterChannelsByYear(channels, year)`; a cost row that references a channel filtered out by that year scope is pro-rated then discarded, so the Spend tab under-reports total spend with no indication.
  - **MEDIUM (verified in source, lines 2494-2515):** the step-9 roll-up unconditionally sets `parent.allocatedCost = sum(children.allocatedCost)` for any channel with children (2515). If a parent has BOTH its own direct cost AND a child with direct cost, step 7's allocation is skipped (`anyChildDirect` true → continue, 2390-2393), so the parent keeps its own `directCost`; then step 9 overwrites it with the children's sum, discarding the parent's own budget from the displayed Cost/ROI. Concrete scenario: parent "Paid" has a $10k direct budget plus child "Paid - LinkedIn" $5k → parent row displays $5k, losing its own $10k. The comment (2477-2487) reasons only about the two seeded shapes (Content Syndication, Events), neither of which is parent-with-own-and-child cost.
  - **LOW:** won uses the `closeWon` row's amount while pipeline uses MAX across rows; if the won row's amount is null/lower, won under-reports relative to pipeline.
  - All CPL/CPMQL/ROI division is guarded (2250, 2410, 2444-2449, 2521-2523).

---

### `computeBdrQuotaProgress`
- **Purpose (from comments):** A deal counts toward a BDR purely by its `bdr_name` tag (the earlier first-touch = Marketing SDR requirement was removed). Actuals = counts of the deal's hpp/opp rows whose created-quarter matches the scope; quotas from `bdr_quotas`; program totals sum the roster; plus a YoY quarterly HPP-created chart (lines 2530-2539, 2594-2597).
- **Inputs:** `{ attributions, quotas: BdrQuota[], year, filter }`.
- **Output:** `BdrQuotaProgress` = `{ rows: [program, ...perBDR], quarterly: [Q1..Q4] }`.
- **Math / logic summary:** Group by deal; build quota lookup for the year; compute each deal's created quarter from its HPP row (fallback earliest stage); bucket HPP-created counts into a YoY series; for gauge roster (active BDRs), deals whose created year==year and (if quarter-scoped) quarter match increment hpp/opp actuals; attach quotas/pct and roll up the Program row.
- **Edge cases audited:**
  - Empty input: every roster BDR renders at 0, program 0, `quarterly` all zeros. Correct.
  - Single-item: one HPP deal for an active BDR in period → that BDR's hpp 1, program hpp 1. Correct.
  - All-nulls: null `deal_id` skipped (2600); null `bdr_name` → skipped (2663-2664); `quarterOfIsoDate(undefined)` → null → excluded.
  - Boundary date: created quarter via `quarterOfIsoDate` (correct for `-04-01` edges); YoY uses `created.year === year` / `=== year-1`; gauge rejects `created.year !== year`. No off-by-one.
  - Missing stage_key: only hpp/opp contribute to actuals (2686); a deal with only pursuit/closeWon contributes nothing to gauges.
- **Filters applied:** `deal_id` present; `bdr_name` in roster; created year == `year`; quarter == selected when quarterly; quota year == `year`.
- **Field-lock interaction:** N/A.
- **Concerns:**
  - **LOW:** the deal's BDR is the first row with a `bdr_name` (2663) and `createdQtr` from the HPP row (2636); the schema asserts `bdr_name` is deal-level, so `find` is safe unless rows drift.
  - **LOW:** gauge scoping counts both hpp and opp of a deal under the deal's HPP-created quarter (2676-2698) even if the opp transition was a later quarter (explicitly intended). A Q3 gauge won't show a SAO whose HPP landed in Q2; a reporting semantic to confirm with product.
  - All pct division guarded. No div-by-zero.

---

## Cross-cutting concerns

### Region filtering consistency
Every function that region-filters routes through `matchesRegionFilter` from `lib/regionFilter.ts` (and `deriveDealRegion` for deal chains). No hand-rolled region comparisons anywhere in `compute.ts`. **Confirmed consistent.**

Two functions deliberately do NOT region-filter: `computeRegionDistribution` and `computeChannelDistribution`. This is documented as intentional (the distribution donuts are region-agnostic), but it means those donuts ignore a page's region toggle. Not a bug, but a reconciliation surprise worth a one-line note in the UI.

Stale-comment note (not a correctness bug): `ComputeInput` (line 82) and several UI comments say "all five regions," but `REGIONS` now has 4 entries. Callers consistently build sets from `REGIONS` / use `REGIONS.length`, so the all-selected short-circuit is internally consistent; only the comments are stale.

### Period / quarter / year boundary handling
Every period filter uses the string-parsing date helpers (`quarterOfIsoDate`, `monthOfIsoDate`, `isoWeekOf`, and `periodBoundsFor` with lexicographic compares), all of which deliberately avoid the `new Date(iso)` UTC-shift pitfall. No off-by-one at year/quarter/month/leap boundaries was found in any of the 22 functions. `periodBoundsFor` endpoints are inclusive and correct.

The one conditional risk is `dealMatchesPeriod`'s lexicographic compare, which assumes `stage_entered_at` is date-only; a timestamp suffix would break the last-day boundary. Correct under the current schema.

**Semantic divergence to flag (not a boundary bug):** `computeGrid` applies a strict HPP-in-period cohort gate to non-HPP stages, but `computeWeekly` and `computeMonthly` do not. Conversion ratios derived from the weekly/monthly grids are therefore not cohort-consistent with the quarterly grid and are not guaranteed ≤ 100%.

### Channel resolution
Channel-string-to-id mapping is consistent: functions resolve to a root via cycle-guarded `parent_channel_id` walks (`rootIdFor`, `resolveTopLevelChannelId`), fall back to the id itself on an unknown id, and label unknowns 'Unknown' or route no-channel deals to `NO_CHANNEL_KEY`. Year-prefixed names (`"2026 - Events"`) are matched by exact `name`, which is safe today but silently picks the first match if a name is duplicated across years (`computeEventActivations`, line 1954).

The one channel-resolution correctness gap is in `computeChannelSpend`: cost keyed on a `channel_id` absent from the `channels` array is dropped from output (MEDIUM, above).

### Field locks
No function in `compute.ts` reads or writes `field_locks`. `compute.ts` is purely read-side (it computes views from already-fetched rows); the field-lock contract lives entirely in the write path (`useLeads.ts` merge logic and the CSV import diff). So there is nothing to respect here, and nothing violates it. Writers are audited separately in `AUDIT.md` (the `as unknown as` casts around the `useLeads` merge are the relevant risk surface).

### Idempotency
Every exported function in `compute.ts` is a **pure function of its inputs** with no side effects, no I/O, and no hidden state. All 22 are safe to call any number of times with the same input and return the same output. The only non-determinism to be aware of is `computeDealVelocities` / `computeBdrQuotaProgress` taking an optional injectable `today`; called without it they read the current date, so their "days in stage" / "is stale" outputs are time-dependent by design (the injectable exists precisely so tests can pin it).

---

## Follow-up ticket list (BLOCKER / HIGH)

**No BLOCKER or HIGH severity issues were found.** The five MEDIUM issues below are the recommended ticket list, ordered by likelihood of hitting real data. Each was verified against the source, and each fires only on a specific data shape that could not be confirmed present from code alone, which is why none is rated HIGH.

1. **`computeChannelSpend` drops cost on out-of-array channels** (lines 2436-2438). Total spend silently under-reports when a `campaign_costs` row references a channel filtered out by the caller's year scope. Highest real-world likelihood because callers routinely pass a year-filtered channel array.
2. **`computeChannelSpend` roll-up discards a parent's own direct cost** when the parent has both its own budget and a child with a budget (lines 2494-2515). Wrong Cost/ROI for a mixed parent+child cost taxonomy.
3. **`computeMonthlyLeadsForYear` within-quarter double-count** when a channel has real leads in part of a quarter and a quarterly `funnel_actuals` backfill for the same quarter (lines 1004, 1029-1034).
4. **`computeGrid` manual-fallback double-count** when a `funnel_actuals` row exists for a cell the compute pass gated to zero (lines 288-305).
5. **`computeFunnelSankey` flow non-conservation** (`mql→hpp` without `lead→mql` for MQL-less cohort leads), lines 1242 vs 1269-1271. Cosmetic in the diagram, but breaks any ratio math that reads Sankey edge volumes.

Issues 1 and 2 share a fix surface (the spend roll-up / output loop) and could be one ticket. Issues 3 and 4 share a root cause (dedupe granularity between compute passes and quarterly `funnel_actuals` backfill) and could be one ticket.
