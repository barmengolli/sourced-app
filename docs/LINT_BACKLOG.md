# ESLint backlog (Step 11, deferred)

As of 2026-07-16 on `chore/cleanup-program`: **42 errors, 8 warnings** (down from
the program baseline of 43 errors / 10 warnings; Steps 4B and 10 removed the
difference by fixing real dependency arrays, not by suppressing).

Step 11 (converge lint to zero and add it to `verify` + CI) is **deferred** by
decision. Almost every error is pre-existing and fixing it changes real
component behavior, so it warrants its own focused effort rather than being
rushed at the end of the correctness program. This document is the categorized
work list for that effort. **No blanket rule disables**; each group is fixed on
its merits.

Until then, `npm run verify` gates tests + typecheck + build (lint is
informational), and no PR may increase either count.

## By rule, with disposition

### `react-hooks/set-state-in-effect` — 27 errors (the bulk)
Effects that call `setState` synchronously. Two distinct sub-populations:

**(a) Data-fetch hooks seeding state after an async load** — the dominant,
lowest-risk group. Each fetch hook does `fetchAll().then(setState)` inside an
effect (`useLeads:319`, `useAttributions:153`, `useCampaignCosts:74`,
`useCampaignTags:100`, `useCollapsedChannels:52`, `useLinkedinSnapshots:72`,
`useOutreachSnapshots:100`, `useSixSenseSnapshots:74`, `useAttributionTouches:66`).
The rule fires on the settle-time `setState`. Disposition: these are legitimate
async loads, not render-time cascades. The correct fix is either the documented
data-loading pattern the rule endorses, or a scoped, justified disable per
occurrence. **Safe but repetitive; do as one hook-focused pass.**

**(b) Controlled-input mirror effects** — a prop mirrored into local editing
state, guarded by an `editing`/`open` flag (`LeadFieldRow:61`, `FunnelTable:143`,
`StageHistoryEditor:45`, `BudgetEditor:80`, `AttributionEditorModal:109,153,168`,
`ChannelManager:148`, `CampaignInfluenceView:977`). Disposition: these are the
class Step 10 fixed for YearLeadCharts (derive instead of mirror). Each is a
**real behavior change** and needs the same derive-or-key-reset rework plus a
component test. **Do per-component, not in bulk.**

**(c) Gate/page one-shot state** (`App:269,289`, `BdrGate:117`, `LeadsGate:140`,
`LeadsPage:106`, `FunnelVelocityPage:210`, `OutreachComparePage:332,849`,
`SixSenseDashboardPage:159`). Mixed; triage individually.

### `react-hooks/exhaustive-deps` — 7 warnings
Missing/narrowed dep arrays (`TrendLineChartView:167`, `useOutreachSnapshots:146`,
`useSixSenseSnapshots:122`, `LinkedinDashboardPage:126-128`,
`OutreachComparePage:931`). Disposition: each needs the real dependency added or
a documented reason it's intentionally omitted. Low-to-medium risk; verify no
stale-closure behavior change. Some (like the LinkedIn trio) may be the same
stable-callback pattern YearLeadCharts had.

### `react-refresh/only-export-components` — 5 errors
A file exports both a component and a non-component value, which breaks Fast
Refresh (`BdrGate:36,42`, `FunnelTable:51`, `LeadsGate:49,60`). Disposition:
**mechanical and safe.** Move the non-component export (a constant/helper) to a
sibling module. No runtime behavior change. Good first batch.

### `react-hooks/purity` — 5 errors
Impure calls during render, all `Math.random()` used to build a realtime channel
suffix (`useCampaignTags:82`, `useLeads:252`, `useLinkedinSnapshots:57`,
`useOutreachSnapshots:84`, `useSixSenseSnapshots:58`). Disposition: **mechanical
and safe** — replace with React's `useId()` for subscription-name uniqueness, as
the plan explicitly suggests. Good first batch alongside react-refresh.

### `react-hooks/refs` — 4 errors
Ref access during render (`useAttributions:137`, `useCampaignCosts:58`,
`useChannelMutations:67`, `useLeads:239`). Disposition: needs per-site review;
reading a ref during render is sometimes a real bug and sometimes benign. Medium
risk; treat individually.

### `react-hooks/immutability` — 1 error
`useChannelMutations:287` mutates a value that should be treated as immutable.
Disposition: review the mutation; likely a small local-copy fix. Low risk.

### `(parse)` — 1 warning
`CampaignInfluenceView:192` — a parser warning (not a rule violation). Inspect;
likely a syntax construct the parser flags. Low priority.

## Suggested order for the Step 11 PR(s)

1. **Batch 1 (mechanical, zero behavior change):** `react-hooks/purity`
   (Math.random -> useId, 5) + `react-refresh/only-export-components` (move
   non-component exports, 5) + `react-hooks/immutability` (1). ~11 errors gone
   with no behavior risk.
2. **Batch 2 (data-fetch hooks):** the `set-state-in-effect` sub-population (a)
   across the fetch hooks, one consistent pattern. ~9 errors.
3. **Batch 3 (per-component reworks):** the mirror-effect sub-population (b) and
   the refs group, each with a component test, the way Step 10 handled
   YearLeadCharts. The slowest, highest-judgment batch.
4. **Batch 4:** exhaustive-deps warnings + the remaining gate/page cases.
5. **Final:** once zero, change `verify` to run `npm run lint` first; the CI
   workflow inherits it with no YAML change. Then enable the required check.

## Note on the safe fixes not yet applied

The direction for this program was to fix only the clearly-safe lint errors and
document the rest. In practice, doing the safe batch (1) cleanly still means
touching 6+ hook files and moving exports, which is better done as its own
reviewable PR than appended to the correctness work. It is therefore listed here
as Batch 1 rather than applied now, so the cleanup branch stays scoped to
correctness + the one derived-state fix (Step 10) that was already in scope.
