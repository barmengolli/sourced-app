# sourced cleanup execution plan

This is the execution-ready cleanup plan for the sourced app. It consolidates the application audit, data-correctness audit, production diagnostics, business decisions, and review recommendations. It supersedes earlier cleanup-plan drafts, but it does not replace `docs/AUDIT.md` or `docs/DATA_AUDIT.md` as the detailed evidence record.

## 1. Objective

Improve correctness, type safety, test coverage, performance, and maintainability without changing unrelated product behavior or mixing cleanup with active Events work.

The program addresses:

- Eight dead-code candidates: six confirmed unused symbols, one decision-gated symbol, and one decision-gated file.
- The highest-value type and duplication risks identified by the audit.
- Five conditional MEDIUM data-correctness scenarios.
- The current red ESLint baseline.
- Large-table performance only where measurement justifies a change.
- The size of `src/lib/compute.ts` after its behavior is protected by tests.

No blocker or high-severity correctness issue was identified in the audited paths.

## 2. Execution rules

1. Each numbered implementation step is a separate PR unless the step explicitly says otherwise.
2. Do not combine a correctness change with an unrelated structural refactor.
3. Add each regression test in the same PR as the fix it protects. The merged suite must be green.
4. Do not merge tests that assert known-wrong behavior.
5. Unit tests and CI must never connect to production Supabase.
6. Production diagnostics are read-only, aggregate-only, and recorded without PII.
7. Work starts from an isolated branch or clean worktree after the current Events changes are committed, merged, or otherwise safely isolated.
8. Existing user-facing output stays unchanged unless a step explicitly identifies the intended correction.
9. Every correctness PR records the before value, after value, affected surface, diagnostic result, and rollback path.
10. No schema change is planned. If implementation reveals that one is necessary, stop and revise this plan before adding a migration.

## 3. Finding disposition

| ID | Finding | Production status | Planned disposition |
|---|---|---|---|
| M1 | Cost associated with a channel outside the selected year disappears from the view | No matching production rows | Approved behavior: exclude it. Protect with an active policy test. |
| M2 | Parent spend roll-up can discard the parent's own budget | Parent configuration identified around the $60,000 Content Syndication budget | Reproduce the exact filtered output, then fix first. |
| M3 | `computeGrid` can show a manual fallback after source-backed data is filtered or gated to zero | No current overlap | Preventative fix using source coverage before view filters. |
| M4 | `computeMonthlyLeadsForYear` can mix real monthly leads with a quarterly backfill | No current overlap | Preventative fix at quarter grain. Stop spreading fallback into monthly values. |
| M5a | A lead with HPP but no MQL history creates an HPP flow from the MQL node | No current rows | Preventative Sankey source fix. |
| M5b | A leadless manual deal needs an explicit source in the Sankey | Diagnostic not yet recorded | Run diagnostic, then support explicit Sales-sourced entry. |

Static unit tests validate behavior for these shapes. Repeated diagnostics detect whether the shapes exist in production. Unit tests do not monitor production data.

## 4. Locked product and technical decisions

### 4.1 Spend outside the selected year

Exclude cost rows whose channel is not present in the caller's selected-year channel set. The exclusion is intentional and must be tested. The view must not create an unassigned-spend row for this case.

### 4.2 Quarterly fallback in a monthly view

Do not distribute a quarterly manual actual across invented months. Monthly bars contain source-dated monthly values only.

When a quarterly fallback is in use, show a separate summary annotation above the chart, such as:

```text
Q1 Lead actual: 30 (quarterly backfill)
```

The annotation is a count, not currency. It must not be plotted as a monthly point or reference line.

### 4.3 Fallback coverage proxy

The current schema does not contain an import-completeness table. For this cleanup, source coverage is defined by the presence of an eligible source record before view-level region and cohort filters are applied.

- `computeGrid`: coverage is keyed by direct channel, year, quarter, and stage using unfiltered lead or attribution records.
- `computeMonthlyLeadsForYear`: coverage is keyed by resolved top-level channel, year, quarter, and `lead`, using real lead source dates before the region filter.

This proxy specifically prevents a filtered or partially populated source-backed period from being mixed with a manual backfill. It does not claim that a completely empty import is distinguishable from a true zero. If that distinction becomes necessary, add an explicit import-coverage model in a separately approved schema change.

### 4.4 Sankey units and sources

The Sankey crosses a real unit boundary:

- Channel, Lead, and MQL values are unique people.
- HPP and later values are deals.
- One lead may source more than one deal.

Global flow conservation cannot be asserted across the Lead/MQL to HPP boundary without misrepresenting one of those units. The cleanup therefore uses these rules:

- A lead without recorded MQL history must never create an `MQL -> HPP` edge.
- Its deal enters through `No recorded MQL -> HPP`.
- A leadless manual deal enters through `Sales-sourced -> HPP`.
- Every distinct deal enters HPP exactly once.
- HPP and later deal-stage nodes conserve deal volume after explicit open or terminal sink links are included.
- Lead and MQL values remain unique-person counts and are not duplicated to force visual conservation.

Tooltips and the chart description must state the unit change at HPP.

### 4.5 Sankey terminal representation

Represent open and terminal deal states as actual outgoing links. With sink links materialized, the deal-stage invariant is:

```text
deal-stage inflow = sum(all outgoing deal-stage and sink links)
```

Example sinks include `Open at HPP`, `Open at Opp`, `Open at Pursuit`, `Won`, and `Lost`. Do not add retained or terminal values a second time outside the outgoing-link sum.

### 4.6 Lint gating

The full ESLint command is currently red. Until the lint-convergence step:

- `npm run verify` gates tests, typecheck, and production build.
- Full lint is informational and its error/warning counts are recorded in every PR.
- No PR may increase either count without an explicit explanation.

After lint convergence, `npm run lint` becomes a required part of `npm run verify` and CI.

## 5. Decisions that do not block early execution

These decisions block only their named cleanup item:

| Item | Decision needed | Blocks |
|---|---|---|
| `CohortPage.tsx` | Delete if the cohort report is off the roadmap; otherwise leave it until implementation begins. | Only deletion of this file |
| `EVENT_ACTIVATION_SHORT_LABELS` | Adopt it as the canonical compact-label map after Events work settles, or delete it if it remains unused. | Only deletion or adoption of this symbol |
| Sara notification | Send a one-line heads-up before or after the corrected spend number ships. | Communication only, never the merge |

The six confirmed dead symbols can be removed without waiting for these decisions.

## 6. Reproducible diagnostics

Create `docs/diagnostics/<actual-run-date>.md` before the first implementation PR. Record:

- Exact read-only SQL.
- Supabase execution date and timezone.
- Aggregate row counts and amounts only.
- Selected year, period filter, and region set when a UI result depends on them.
- No emails, names, titles, lead IDs, account names, or full rows.

Required baseline diagnostics:

1. M1: costs attached to channels excluded from the selected year.
2. M2a: parents with both their own direct cost and descendant direct cost.
3. M2b: parents with direct cost, zero direct child cost, and zero descendant leads in the exact affected view.
4. M3: manual actuals overlapping source records at channel, quarter, and stage grain.
5. M4: quarterly lead actuals overlapping at least one real lead in the same top-level channel and quarter.
6. M5a: leads with an HPP attribution and no MQL history entry.
7. M5b: HPP+ deals with no `lead_id`.

The $60,000 Content Syndication claim is considered reproduced only when the diagnostic or an anonymized local fixture captures the exact year, filter, regions, descendant lead counts, direct costs, and current computed output that produce the hidden value.

## 7. Testing and verification architecture

### 7.1 Package scripts

Add:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc -b --pretty false --noEmit",
  "build:app": "vite build",
  "build": "npm run typecheck && npm run build:app",
  "verify": "npm run test && npm run build"
}
```

After lint convergence, change `verify` to run lint first.

### 7.2 CI

Add a GitHub Actions workflow that runs on pull requests and pushes to `main`:

1. Use the project's supported Node 20 release.
2. Run `npm ci`.
3. Run `npm run verify`.

Enable the workflow as a required GitHub branch-protection check. Vercel continues to run the production build. No Supabase credentials are provided to the test workflow.

### 7.3 Initial test environment

- Install Vitest only for pure tests.
- Use the Node test environment initially.
- Add React Testing Library, `@testing-library/jest-dom`, `@testing-library/user-event`, and jsdom in the first PR that adds component tests.
- Prefer explicit fixture assertions. Do not use snapshot tests.
- Inject dates into pure helpers rather than reading the real clock in tests.
- Store anonymized fixtures under `src/test/fixtures/`.

## 8. Spend calculation contract

The spend implementation has two different concepts that must remain separate:

- `directCost`: cost owned by the channel's own `campaign_costs` rows.
- `allocatedCost`: cost used for that channel's CPL, CPMQL, and ROI after parent-only budget allocation.

Parent-only budget allocation can copy a parent's direct cost into descendant rows. A naive `parent direct + child allocated` roll-up would double-count that copied amount.

Track how much of each channel's own direct cost was successfully distributed to descendants:

```text
retained direct cost = direct cost - distributed own direct cost
rolled allocated cost = retained direct cost + sum(child rolled allocated cost)
```

This produces the intended outcomes:

- Parent $60K, allocated to children by lead share: parent remains $60K, not $120K.
- Parent $60K, no descendant leads, nothing allocated: parent remains $60K, not $0.
- Parent $10K plus child $5K direct: parent displays $15K.
- Root totals equal the sum of included prorated direct cost rows exactly once, within floating-point tolerance.

Do not change the approved M1 exclusion policy.

## 9. Execution sequence

### Step 1: Isolate work and record baselines

Scope:

- Finish or isolate the current Events changes.
- Create the cleanup branch using the project branch prefix.
- Create the dated diagnostics document described in Section 6.
- Record baseline results for:
  - `npm run lint`, including error and warning counts.
  - `tsc -b --pretty false --noEmit`.
  - `npm run build`.
  - Existing tests, currently none.
- Record the exact reproduction state for M2.

Acceptance:

- No production source changes.
- Diagnostics contain no PII.
- Baselines and M2 reproduction status are committed.
- If M2 cannot be reproduced as described, keep the code-level regression scenarios but remove any claim that the live view currently hides exactly $60,000.

### Step 2: Add Vitest and required CI

Scope:

- Add Vitest and the scripts in Section 7.
- Add the GitHub Actions workflow.
- Add active pure tests for already-correct, accessible behavior:
  - M1 exclusion policy.
  - Period-boundary and proration helpers used by spend.
  - Representative currently correct `computeChannelSpend` leaf behavior.
- Do not test React hooks, Supabase paths, local formatter functions, or local stage-rank maps in this PR.

Acceptance:

- `npm run verify` passes locally and in GitHub Actions.
- Tests make no network calls.
- No React or jsdom testing dependencies are installed.
- No production behavior changes.

Manual repository task:

- Enable the GitHub Actions check as required branch protection.

### Step 3: Fix M2 spend ownership and roll-up

Scope:

- Add regression fixtures before changing the function:
  - Parent $60K, children $0, descendant leads present, full parent allocation.
  - Parent $60K, children $0, zero descendant leads, no allocation possible.
  - Parent $60K and child $10K, allocation skipped, expected parent total $70K.
  - Multiple cost rows on one parent.
  - Three-level hierarchy.
  - Partial period overlap.
  - Decimal proration and rounding.
- Track distributed own direct cost separately from inherited allocation.
- Use the retained-direct roll-up formula in Section 8.
- Recalculate CPL, CPMQL, and ROI from corrected rolled allocated cost.
- Re-run the M2 diagnostics.

Required invariants:

```text
parent rolled allocated cost
  = parent retained direct cost
  + sum(child rolled allocated cost)

sum(root rolled allocated cost)
  = sum(included prorated direct cost rows)
```

Acceptance:

- Every fixture passes within a documented numeric tolerance.
- Every included cost row contributes once.
- Child allocations remain unchanged except where the prior output was mathematically wrong.
- `npm run verify` passes.
- Lint count does not increase.
- PR body includes exact before and after Spend-tab values for the reproduced selector state.
- Screenshot is supporting evidence only.

Communication:

- Sara notification is independent of merge approval.

### Step 4A: Extract and test the SFDC edit-lock sync contract

Scope:

- Move the pure lock-aware builders out of `useLeads.ts` into `src/lib/leadSync.ts`:
  - Existing-lead sync patch construction.
  - New-lead insert-row construction.
- Replace `SfdcSync.values: Partial<Record<EditableLeadField, unknown>>` with a mapped domain type based on `Lead[K]`.
- Inject `nowIso` and `todayIso` values so tests are deterministic.
- Keep Supabase orchestration in `useLeads.ts`.
- Add pure tests for:
  - Locked field preserves the Marketing value.
  - Locked field still updates `source_sfdc`.
  - Unlocked field overwrites normally.
  - Locked null is preserved.
  - Fresh MQL insert seeds stage history.
  - Lead-to-MQL sync appends one history entry.
  - Same-stage resync does not duplicate history.
  - Email normalization and system-ID behavior.

Acceptance:

- Tests use no Supabase client or network mocks because the builders are pure.
- Both single and bulk sync paths use the extracted builders.
- Edit-lock behavior is unchanged and compiler-checked.
- `npm run verify` passes.
- Lint count does not increase.

### Step 4B: Type realtime pending-field merge and import diff

Scope:

- Extract a typed pure helper for merging a realtime lead row with optimistic fields still pending locally.
- Replace the duplicated realtime INSERT, UPDATE, and DELETE handler bodies with one shared handler used by initial subscription and resume.
- Remove all six `as unknown as` double casts from the realtime merge blocks.
- Replace the two `ImportDiff.tsx` double casts with a shared typed comparable-lead-field accessor.
- Add pure tests for pending-field preservation and field-diff classification.

Acceptance:

- No `as unknown as` remains in the realtime merge or import-diff path.
- Optimistic edits survive their own realtime echo and later settle to server state.
- Locked import changes remain drift-only.
- `npm run verify` passes.
- Lint count does not increase.

Deferred from this PR:

- The separate Outreach metric cast.
- Safe internal assertions in `compute.ts`.
- Runtime guards for external domain strings, which receive a separately scoped PR only if still valuable after correctness work.

### Step 5: Consolidate money formatters and name stage precedence by purpose

Scope:

- Extend the existing `src/lib/formatters.ts`.
- Add `formatCurrency` and `formatCompactCurrency` with explicit null display behavior.
- Replace the four local money formatters without changing their rendered output.
- Do not add `formatPercent` unless a concrete duplicate is found.
- Rename:
  - Attribution progression map to `PROMOTION_STAGE_RANK`.
  - Scorecard dedupe map to `DEAL_DEDUPE_PRECEDENCE`.
- Preserve won-equals-lost progression behavior and won-over-lost scorecard behavior.
- Test formatter cases and observed stage behavior through public pure functions. If a behavior is trapped inside a hook, extract the smallest pure decision helper rather than exporting an implementation constant solely for testing.

Acceptance:

- One formatter module is the implementation source of truth.
- Existing currency UI output is unchanged.
- Tests prove the two stage-precedence semantics differ intentionally.
- `npm run verify` passes.
- Lint count does not increase.

### Step 6: Fix M3 and M4 fallback computation

Scope for `computeGrid`:

- Build source-coverage keys before applying the region filter and strict cohort gate.
- Use source record stage and quarter to mark coverage.
- Continue computing displayed counts with the current region and cohort rules.
- Apply a manual actual only when its source-coverage key is absent.
- Evaluate coverage per stored quarter even when the selected view is the full year.

Scope for `computeMonthlyLeadsForYear`:

- Resolve each real lead to its top-level channel and source quarter before region filtering.
- Mark coverage at top-level channel and quarter grain.
- If any real source lead covers the quarter, suppress the entire quarterly manual fallback for that channel and quarter.
- Do not spread a quarterly fallback into three monthly buckets.
- Return quarterly fallback data separately from monthly arrays so the UI can annotate it in Step 7.

Required tests:

- Source record present but region-filtered to zero.
- Attribution stage record present but removed by the HPP cohort gate.
- Real lead in one month and manual actual in the same quarter.
- Covered positive, covered zero after filter, and uncovered fallback.
- Full-year selection with mixed quarter coverage.

Acceptance:

- No source-backed quarter mixes with manual fallback.
- Monthly bars contain no invented monthly allocation.
- Existing manual-only historical quarters continue to expose their quarterly total separately.
- `npm run verify` passes.
- Lint count does not increase.

Documented limitation:

- Without explicit import-coverage metadata, a completely empty source period cannot be distinguished from an unimported period. The presence-based proxy in Section 4.3 is intentional for this cleanup.

### Step 7: Present quarterly fallback separately in monthly views

Scope:

- Add React Testing Library and jsdom if this is the first component-test PR.
- Show compact, labeled summary annotations above the relevant monthly chart when quarterly backfill data is present.
- Use count labels such as `Q1 Lead actual: 30 (quarterly backfill)`.
- Do not render quarterly totals as monthly bars, points, or reference lines.
- Do not add quarterly backfill to monthly chart totals.

Acceptance:

- Component tests cover no fallback, one fallback quarter, and multiple fallback quarters.
- Labels identify metric, quarter, value, and backfill status.
- Monthly values remain source-dated values only.
- `npm run verify` passes.
- Lint count does not increase.

### Step 8: Fix M5 Sankey source semantics and deal-stage accounting

Scope:

- Re-run M5a and M5b diagnostics.
- Remove false `MQL -> HPP` emission for leads without an MQL history entry.
- Add `No recorded MQL -> HPP` for those deals.
- Add `Sales-sourced -> HPP` for leadless manual deals.
- Ensure each distinct deal enters HPP once.
- Add explicit open and terminal sink links for the HPP+ deal subgraph.
- Preserve unique lead counts upstream and document the person-to-deal unit transition at HPP.
- Update Sankey chart node ordering, colors, labels, tooltips, empty states, and description for the new nodes.
- Preserve `DEAL_DEDUPE_PRECEDENCE` when terminal records conflict.

Required tests:

- Recorded-MQL lead with one deal.
- MQL-less lead with one deal.
- Leadless sales-sourced deal.
- One lead with multiple deals.
- Open HPP, open Opp, open Pursuit, won, and lost deals.
- Deal-stage conservation through explicit sink links.
- No MQL-less deal contributes to an `MQL -> HPP` edge.

Acceptance:

- Each deal has one HPP ingress source.
- HPP+ deal-stage inflow equals all outgoing progression and sink links.
- No global conservation assertion is applied across the unique-person to deal boundary.
- Tooltips clearly identify whether a value is people or deals.
- Component and pure tests pass.
- `npm run verify` passes.
- Lint count does not increase.

### Step 9: Remove confirmed dead code

Scope:

- Reconfirm with `rg` immediately before deletion.
- Delete the six confirmed unused symbols:
  - `removeKey`
  - `LOCKABLE_LEAD_FIELDS`
  - `MARKETING_SDR_BASE_NAME`
  - `PROMOTE_TARGET_STAGES`
  - `MANUAL_ACTUAL_STAGES`
  - `Bdr` type
- Handle `EVENT_ACTIVATION_SHORT_LABELS` only after the Events decision.
- Handle `CohortPage.tsx` only after the roadmap decision.
- Do not create a dedicated over-export cleanup PR.

Acceptance:

- PR lists each deletion and each intentionally retained candidate.
- `npm run verify` passes.
- Lint count does not increase.

### Step 10: Fix the stale-derived selection

Scope:

- Replace the narrowed-dependency effect in `YearLeadCharts` with:
  - A memoized computed default selection.
  - A separately stored explicit user override.
  - An effective selection equal to user override or computed default.
- Reset the override only when the relevant dataset identity changes.
- Add component tests for initial default, user override persistence, and data-key change.

Acceptance:

- No exhaustive-dependency suppression is needed for this behavior.
- User selections do not reset during unrelated rerenders.
- Defaults update when the underlying channel dataset changes.
- `npm run verify` passes.
- Lint count decreases or remains unchanged.

### Step 11: Converge ESLint and make it a required gate

Scope:

- Fix the recorded ESLint baseline in focused commits or sub-PRs grouped by rule and behavior.
- Prioritize:
  - Impure `Math.random()` usage during render. Prefer React `useId` for subscription-name uniqueness.
  - Effect-driven state that can be represented as initialization, explicit user state, or derived values.
  - Missing hook dependencies that can produce stale behavior.
- Do not apply blanket rule disables.
- Use a targeted disable only when the pattern is intentional, documented, and safer than the alternative.
- After full lint passes, update `verify` to run `npm run lint` first.
- Update the GitHub required check automatically through the changed `verify` script.

Acceptance:

- `npm run lint` returns zero errors.
- Warnings are either fixed or explicitly documented with a planned disposition.
- `npm run verify` includes lint and passes in CI.
- No behavior regression in existing tests.

### Step 12: Measure and improve large-table performance

Measurement scope:

- Leads table first.
- Opportunities list second if measurement shows a problem.
- Outreach tables third if measurement shows a problem.

For each surface:

1. Record anonymized row count, browser, hardware profile, initial render duration, filter duration, and DOM row count.
2. Choose pagination or virtualization based on measured behavior and interaction requirements.
3. Implement one surface per PR after the shared approach is established.

If virtualizing a semantic table, test:

- Column alignment.
- Sticky headers.
- Keyboard navigation.
- Screen-reader semantics.
- Sorting and filtering.
- Row selection.
- Lead detail drawer or opportunity modal interaction.

Acceptance:

- Before and after metrics are recorded.
- The selected approach produces a material, repeatable improvement.
- Accessibility and interaction tests pass.
- No table is virtualized solely because it crosses an arbitrary row threshold.

### Step 13: Split `compute.ts` behind a compatibility barrel

Prerequisite:

- Steps 3, 6, and 8 are complete and protected by active tests.

Scope:

- Keep `src/lib/compute.ts` as the public compatibility barrel.
- Move implementations into cohesive modules under `src/lib/compute/`, such as:
  - `grid.ts`
  - `compare.ts`
  - `monthly.ts`
  - `spend.ts`
  - `sankey.ts`
  - `velocity.ts`
  - `distribution.ts`
  - `events.ts`
  - `bdr.ts`
  - Shared internal helpers where genuinely cross-cutting
- Preserve existing import paths for callers.
- Do not change behavior or rename public exports during the move.

Acceptance:

- Representative fixture outputs deep-equal the pre-split outputs.
- Existing tests pass unchanged.
- No call-site import migration is required.
- `npm run verify` passes.

### Step 14: Opportunistic cleanup policy

These are not batch PRs:

- Split other files over 500 lines only when actively modifying them or when a clear boundary reduces cognitive load.
- Remove unnecessary exports when touching the same file for another approved reason.
- Extract Tailwind patterns only when controls share semantics and behavior, not merely identical class strings.
- Address the Outreach metric cast in a small nearby PR when that dashboard is next modified.
- Review external-string assertions in `compute.ts` after the module split and add runtime guards only where input is genuinely untrusted.

## 10. PR template for this program

Each PR should include:

```text
Cleanup step:
Behavior changed:
Behavior intentionally unchanged:
Production diagnostic rerun:
Before value:
After value:
Tests added:
npm run verify:
ESLint errors/warnings before:
ESLint errors/warnings after:
Manual verification:
Rollback:
```

Do not include production lead data or screenshots containing PII.

## 11. Communication track

- The Content Syndication correction may change a visible Spend-tab number. Notify Sara before or after merge based on stakeholder preference, but never block the technical merge on that communication.
- Every number-changing PR states which view changed and why.
- Preventative fixes with no current production rows are described as guardrails, not as repairs to live data.

## 12. Explicit non-goals

- No broad feature work.
- No Outreach feature expansion.
- No contact-list data added to the repository.
- No production-data writes from tests or diagnostics.
- No blanket Tailwind deduplication.
- No immediate split of all files over 500 lines.
- No goal of eliminating every TypeScript assertion.
- No snapshot tests.
- No dedicated PR for cosmetic over-export cleanup.
- No global Sankey conservation claim across the unique-lead to deal-count boundary.
- No schema or migration change without a separate review.

## 13. Completion definition

The cleanup program is complete when:

- M2, M3, M4, and M5 behavior is implemented and covered by active tests.
- M1 approved behavior has an active policy test.
- The SFDC edit-lock contract and realtime pending-field merge are pure, typed, and tested.
- Money formatting and stage precedence have intentional names and one implementation source of truth.
- Confirmed dead code is removed and decision-gated candidates are documented.
- The stale-derived selection is fixed.
- ESLint is green and part of the required CI check.
- High-volume tables have been measured and only justified performance changes were made.
- `compute.ts` is split behind a compatibility barrel with unchanged public behavior.
- `npm run verify` passes locally and in required CI.

Document owner: Ben Armengolli. Update this plan only when a locked decision, diagnostic result, or execution step changes.
