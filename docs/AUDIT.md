# Sourced app discovery audit

Read-only static audit of `src/` (107 source files), completed 2026-07-16. No source files, migrations, or configs were modified. Findings are grep-confirmed; items that could involve dynamic or framework usage are marked "needs review".

Companion report: [`DATA_AUDIT.md`](./DATA_AUDIT.md) covers data correctness of every `compute.ts` function.

**Overall:** the codebase is disciplined. Realtime cleanup, error handling, cancelled-flag effect guards, and `useMemo` usage are consistent across the app. The real issues are concentrated: a god-module (`compute.ts`, 2734 lines), a cluster of unchecked type casts in the lead-merge path, four divergent copies of one money formatter, and one unvirtualized large-list render.

---

## 1. Dead code

### 1.1 Unused imports
**None found.** Every imported symbol across all 107 files was grep-checked against its file body. Zero unused imports, consistent with the ESLint `no-unused-vars` rule the project already enforces.

### 1.2 Unused exported functions / components / constants / types

**Fully dead (single occurrence in all of `src/`, definition only). Safe to delete: YES.**

| Symbol | File:line | Kind |
|---|---|---|
| `removeKey` | `src/lib/storage.ts:20` | function, never called |
| `LOCKABLE_LEAD_FIELDS` | `src/constants/leadFields.ts:34` | const Set, never read |
| `EVENT_ACTIVATION_SHORT_LABELS` | `src/constants/eventActivations.ts:35` | const record, never read |
| `MARKETING_SDR_BASE_NAME` | `src/constants/bdr.ts:34` | const, never read |
| `PROMOTE_TARGET_STAGES` | `src/constants/funnelStages.ts:61` | const array, never read |
| `MANUAL_ACTUAL_STAGES` | `src/constants/funnelStages.ts:51` | const array, never read |
| `Bdr` | `src/constants/bdr.ts:11` | type alias, never referenced |

**Exported but referenced only within their own file. Safe to delete the symbol: NO (code is live); safe to drop the `export` keyword: YES.** These are not dead code, only over-exported. Runtime functions/consts: `parseSfdcDate` (`csv.ts:109`), `normalizeName` / `normalizeSalesforceLink` / `nameSimilarity` (`dupeDetection.ts:15,19,38`), `CONVERSION_BENCHMARKS` / `ConversionBenchmark` (`benchmarks.ts:18,12`), `STAGE_FROM_LIFECYCLE` (`stageMapping.ts:3`), `COUNTRY_TO_REGION` (`regions.ts:24`), `OTHER_BDR` (`bdr.ts:16`), `REGISTERED_ACTIVATION` (`eventActivations.ts:22`). Plus the hook-result interfaces (`UseLeadsResult`, `UseBdrQuotasResult`, etc., one per hook) and the many `Compute*Input` / grid-shape interfaces in `compute.ts`.
Needs review: several of these read as intended public lib/hook API even if not yet consumed elsewhere; dropping `export` is a judgment call, not automatic.

### 1.3 Unreferenced files
**`src/pages/CohortPage.tsx`** (7-line placeholder stub, "Cohort and velocity reports arrive in milestone 8."). Its basename is imported nowhere and it is not routed in `App.tsx` or `constants/sidebar.ts`. Grep-confirmed zero references outside its own file. **Safe to delete: YES**, but it is a visible unshipped-feature stub, so confirm no roadmap intent first (the velocity half of that milestone did ship as `FunnelVelocityPage`, so the cohort stub is likely abandoned).

All other files under `src/` are imported at least once.

### 1.4 Commented-out code blocks (>3 lines)
**None found.** An AST-token scan for runs of 3+ commented lines containing code tokens (`const`/`return`/`=>`/trailing `;`/braces) found zero. The many long `//` runs in `compute.ts` and `campaignScorecard.ts` are prose documentation (algorithm and join-semantics notes), not dead code.

### 1.5 Feature flags / permanently-gated paths
**None problematic.** No `const FLAG = true/false`, no `if (false)`, no `&& false`. The only constant-ish gates are genuine runtime env config, not dead paths:
- `src/components/PasswordGate.tsx:8` — `VITE_APP_PASSWORD`
- `src/components/leads/LeadsGate.tsx:34` — `VITE_REVEAL_PII_PASSWORD`
- `src/components/bdr/BdrGate.tsx:25` — `VITE_BDR_PASSWORD`
- `src/lib/supabase.ts:3-4` — `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`

---

## 2. Best-practice violations

### 2.1 React

**Component / module files longer than 500 lines** (the stated threshold). 18 files exceed it:

| Lines | File | >2000 |
|---|---|---|
| 2734 | `src/lib/compute.ts` | **yes** |
| 1073 | `src/components/charts/CampaignInfluenceView.tsx` | |
| 1057 | `src/pages/OutreachDashboardPage.tsx` | |
| 1029 | `src/components/attribution/AttributionEditorModal.tsx` | |
| 1000 | `src/pages/OutreachComparePage.tsx` | |
| 876 | `src/components/charts/YearLeadCharts.tsx` | |
| 870 | `src/pages/FunnelComparePage.tsx` | |
| 830 | `src/hooks/useLeads.ts` | |
| 821 | `src/pages/CampaignsOverviewPage.tsx` | |
| 813 | `src/components/attribution/CreateHPPModal.tsx` | |
| 784 | `src/lib/campaignScorecard.ts` | |
| 758 | `src/components/funnel/FunnelTable.tsx` | |
| 687 | `src/pages/SixSenseDashboardPage.tsx` | |
| 679 | `src/pages/FunnelVelocityPage.tsx` | |
| 613 | `src/components/channels/ChannelManager.tsx` | |
| 554 | `src/components/attribution/OpportunitiesListModal.tsx` | |
| 513 | `src/hooks/useAttributions.ts` | |
| 504 | `src/pages/OutreachDataPage.tsx` | |

**Effect-driven setState with a narrowed dependency array (stale-derivation risk).**
- `src/components/charts/YearLeadCharts.tsx:283-297` — a `useEffect` that calls `setSelectedChannelIds(...)` from `mergedChannels`, `pruned`, and `computeDefault()`, but the dep array is only `[channelKey, loading]` with an `exhaustive-deps` disable at line 297. If `mergedChannels` / `computeDefault` change without `channelKey` changing, the selection won't re-derive. This is derived state that would be safer as a `useMemo` plus a controlled reset. **Highest-confidence React finding.**
- `src/components/charts/TrendLineChartView.tsx:101-105, 164` — `exhaustive-deps` disables, but benign (reference the stable `priorKeyOf` closure). Noted as intentional suppressions only.

**Effect-as-mirror (acceptable pattern, listed for completeness).** Several effects mirror a prop into local editing state guarded by an `editing`/`open` flag, a legitimate controlled-input pattern, not a bug: `src/components/leads/LeadFieldRow.tsx:60`, `src/components/funnel/FunnelTable.tsx:142`, `src/components/leads/StageHistoryEditor.tsx:44`, `src/components/channels/BudgetEditor.tsx:86`.

**Prop drilling.** The `*Section` wrappers (`BdrSection`, `CampaignsSection`, `LinkedinAdsSection`) pass hook results down one level to their child pages. This is deliberate section-composition (one mount of the data, shared across a tab's sub-pages), not accidental drilling, and stays within 2 levels. No action.

### 2.2 TypeScript

**`as unknown as` double casts (defeat type-checking).**
- `src/hooks/useLeads.ts:319, 320, 330, 386, 387, 397` — six casts in the lead-merge path (`{...next} as unknown as Record<...>` then back `as unknown as Lead`). The compiler cannot verify the merge that implements the edit-lock contract, the app's most important write-side invariant. **Riskiest TS smell in the repo.**
- `src/components/import/ImportDiff.tsx:75, 76` — same pattern for diff comparison.
- `src/pages/OutreachDashboardPage.tsx:786` — `metric.compute(s as unknown as OutreachSnapshot)`.

**`any` types**, concentrated in chart render props (some avoidable):
- `src/components/charts/CampaignInfluenceView.tsx:109, 195, 197, 316, 369, 375` — 6, including `nodes: any[]` and `sortedNodes: any[]` which are the app's own data (not Recharts) and should be typed.
- `src/components/charts/FunnelSankeyView.tsx:151, 198, 249` — Recharts node/link/tooltip render props.

**Non-const type assertions inside compute logic** (bypass validation of externally-sourced string keys). In `src/lib/compute.ts`: lines 87, 314 (`p.stage_key as FunnelStageKey`), 515, 743, 1584 (`as PeriodIndex`), 1739 (`as RegionKey`), 1992, 2026, 2031, 2616, 2648 (`Number(filter.slice(1)) as PeriodIndex`), 2687 (`r.stage_key as BdrStage`), 2728. The string→enum casts (314, 2648, 2687) are the ones worth guarding. `campaignScorecard.ts` is clean of non-const assertions.

**Missing return types on exported functions.** Sampled lib/ and hooks/; most exported functions do declare return types. No systematic gap found worth enumerating.

### 2.3 Data fetching
- **Error handling:** consistently present. Every fetch hook checks `error` and sets or throws. No missing-error-check occurrences found.
- **Loading states:** present (`setLoading` in every fetch hook).
- **Race conditions:** the cancelled-flag pattern is used correctly, e.g. `src/hooks/useLeads.ts:283-296`, `src/hooks/useCampaignCosts.ts:73`. No un-guarded post-unmount setState found.
- **N+1:** none. The `Promise.allSettled(updates.map(u => supabase...))` patterns in `useChannelMutations.ts:97,328` and `useLeads.ts:197,776` are parallel batched writes (error-checked), not sequential N+1, though they would ideally be single bulk upserts.

### 2.4 Naming and structure

**Duplicate helpers (real dupes).**
- **`fmtMoney` defined 4 times with diverging behavior** — the most bug-prone dupe:
  - `src/components/attribution/OpportunitiesListModal.tsx:60` — returns `''` on null
  - `src/components/channels/BudgetEditor.tsx:27` — no null handling
  - `src/pages/FunnelVelocityPage.tsx:73` — returns `'—'` on null
  - `src/pages/CampaignsOverviewPage.tsx:660` — abbreviates to `$1.2M` / `$3K` (different output entirely)

  Four sources of truth with different null and formatting behavior. Consolidate into one `lib/format.ts` helper with an explicit null-handling option.
- **`STAGE_RANK` defined twice, and the two are NOT identical:**
  - `src/hooks/useAttributions.ts:97` (exported) — `closeWon: 4, closeLost: 4` (same rank)
  - `src/lib/campaignScorecard.ts:264` (local) — `closeLost: 4, closeWon: 5` (won outranks lost, deliberately, so a won deal is never mis-collapsed to lost)

  This is a subtle finding: they look like an accidental dupe but encode **different intentional semantics**. Do NOT naively merge them, that would reintroduce the bug `campaignScorecard`'s comment (lines 220-222) explicitly guards against. The fix is to rename one (e.g. `DEDUPE_STAGE_RANK` in the scorecard) so nobody assumes they are interchangeable. `AttributionEditorModal.tsx` imports the `useAttributions` copy.

**Helpers that belong in `lib/`.**
- `quarterOfWeek` defined locally in `src/hooks/useOutreachSnapshots.ts:54` — a date helper that belongs alongside `quarterOfIsoDate` in `src/lib/dates.ts`.

**Inconsistent naming.** No systematic `useX` vs `getX` collisions for the same shape found.

### 2.5 CSS / Tailwind
- **Hardcoded hex colors in className / style**, concentrated in `CampaignInfluenceView.tsx` (9), `OutreachDashboardPage.tsx` (7), `OutreachComparePage.tsx` (3), `CampaignTagsPage.tsx` (3). Chart-series hexes are defensible (series palettes). The non-chart ones in `CampaignTagsPage.tsx` and the Outreach pages should move to theme tokens; the codebase otherwise uses `text-charcoal`, `border-border`, `bg-bg`.
- **Duplicated utility-class strings.** The input/chip string `border border-border rounded bg-bg text-charcoal ...` repeats across many controls, e.g. `OutreachDashboardPage.tsx:790, 803, 804, 811, 853, 867, 972, 976`. Extract a shared className constant or a small `<Input>`/`<Chip>` component.

---

## 3. Performance concerns

- **Large lists rendered without virtualization.** `src/components/leads/LeadsTable.tsx:186` maps the entire `sorted` leads array into table rows (keys present, no windowing or pagination). With a large lead set this renders every row on every relevant change. No `react-window` / `react-virtual` / `virtuoso` dependency exists. The same unbounded-map concern applies to `OpportunitiesListModal.tsx` and the outreach data tables (`OutreachDataPage.tsx`). This is the top runtime-perf item.
- **Missing `key` props:** none found. Every sampled `.map(` in JSX supplies a `key`.
- **Heavy-library imports:** none. `recharts` is imported via named (tree-shakeable) imports; no `lodash` / `moment` / `date-fns` namespace imports; no `import * as`.
- **Waterfall fetches:** none intra-hook (each hook fetches one table). Cross-hook parallelism comes free from independent hooks mounting together.
- **Realtime channel cleanup:** all 15 `.channel(` sites were audited; every one returns a cleanup that calls `removeChannel`, including the two-channel hook `useCampaignTags.ts` (cleans both at lines 161-162). **No leaks found.**
- **Inline expensive chains without memo:** none in JSX bodies. The app memoizes heavily (182 `useMemo` uses) and routes heavy compute through `lib/compute.ts` behind memos.

---

## 4. Structural observations

### 4.1 Coupling (page importing another page)
No leaf-page → leaf-page imports. The only page→page edges are deliberate tab-container wrappers:
- `src/pages/BdrSection.tsx:15-16` → `BdrDashboardPage`, `BdrQuotasPage`
- `src/pages/CampaignsSection.tsx:15-16` → `CampaignTagsPage`, `CampaignsOverviewPage`
- `src/pages/LinkedinAdsSection.tsx:5` → `LinkedinDashboardPage`

These `*Section` files exist to render their child pages under one tab. Coupling is by design; no extraction needed. No `components/ → pages/` edges exist.

### 4.2 Circular imports
All detected cycles are **type-only** and route through `App.tsx`, which owns the shared navigation types. 17 page/constant files do `import type { PageKey | CompareView | ... } from '../App'` while `App.tsx` imports those same modules as values, forming a type↔value cycle hub. Because these are `import type`, they are erased at compile time and cause **no runtime cycle**, but they are a real structural smell.

**Recommendation:** extract `PageKey`, `CompareView`, `OutreachSubPageProps`, `SixSenseSubPageProps` out of `App.tsx` into `src/types/navigation.ts`. No cycles found purely among `lib/` or `hooks/`.

### 4.3 `compute.ts` size
**2734 lines** — the single largest file, exceeding the 2000-line threshold. It is already organized into self-contained function+interface clusters that map cleanly to a split:

| Suggested module | Functions |
|---|---|
| `compute/grid.ts` | `computeGrid`, `conversionPercent`, `onTargetPercent`, `funnelEfficiencyPercent`, `isAttributionStage` |
| `compute/compare.ts` | `computeWeekly`, `computeMonthly`, `shiftMonth`, `computeMonthlyLeadsForYear` |
| `compute/sankey.ts` | `computeFunnelSankey` |
| `compute/velocity.ts` | `computeDealVelocities`, `computeStageVelocityStats`, `isDealOpen` |
| `compute/distribution.ts` | `computeRegionDistribution`, `computeChannelDistribution`, `NO_CHANNEL_KEY` |
| `compute/events.ts` | `computeEventActivations` |
| `compute/spend.ts` | `periodBoundsFor`, `dealMatchesPeriod`, `compareTouchesChronologically`, `computeChannelSpend` |
| `compute/bdr.ts` | `computeBdrQuotaProgress` |

A barrel `compute/index.ts` re-exporting all of them keeps every existing import path working, so the split is mechanical and low-risk (move + re-export, no call-site edits).

---

## 5. Recommended next steps (top 10 by risk / reward)

Ranked by reward-per-unit-risk. LOC estimates are the change size, not the file size.

| # | Finding | File | ~LOC | Risk |
|---|---|---|---|---|
| 1 | Consolidate the 4 divergent `fmtMoney` copies into `lib/format.ts` (different null/abbreviation behavior is a latent display bug) | 4 call sites + 1 new | ~40 | low |
| 2 | Rename the scorecard `STAGE_RANK` to signal it differs from the `useAttributions` one (they encode different semantics; a naive merge reintroduces a bug) | `campaignScorecard.ts:264` | ~5 | low |
| 3 | Delete the 7 fully-dead exports + `CohortPage.tsx` stub | 8 sites | ~30 del | low |
| 4 | `computeChannelSpend`: don't drop cost on out-of-array channels (DATA_AUDIT MEDIUM #1: silent spend under-count) | `compute.ts:2436` | ~15 | medium |
| 5 | `computeChannelSpend`: preserve a parent's own direct cost in roll-up (DATA_AUDIT MEDIUM #2) | `compute.ts:2494-2515` | ~15 | medium |
| 6 | Type the lead-merge path to remove the 6 `as unknown as` casts, so the edit-lock contract is compiler-checked | `useLeads.ts:319-397` | ~30 | medium |
| 7 | Reconcile the dedupe granularity between compute passes and quarterly `funnel_actuals` backfill (DATA_AUDIT MEDIUM #3 + #4, shared root cause) | `compute.ts:288-305, 1004-1034` | ~30 | medium |
| 8 | Virtualize `LeadsTable` (and the other large tables) with `react-window` | `LeadsTable.tsx:186` + dep | ~50 | medium |
| 9 | Split `compute.ts` into the 8 modules above behind a barrel export | new `compute/` dir | ~2734 moved | low |
| 10 | Extract navigation types out of `App.tsx` to break the type-cycle hub | `App.tsx` + 17 importers | ~40 | low |

**Fastest wins (do first):** #1, #2, #3 are low-risk, high-clarity cleanups touching little logic. **Highest correctness value:** #4 and #5 (silent spend miscounts on the Spend tab a CMO reads). **Biggest structural payoff:** #9 (the god-module split is mechanical because the clusters are already clean).

Note: #2 and #4-#7 are correctness findings; their full failure scenarios are in [`DATA_AUDIT.md`](./DATA_AUDIT.md). This table is the reward-ranked view; the DATA_AUDIT follow-up list is the severity-ranked view.
