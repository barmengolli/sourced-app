# Leads table performance measurement: 2026-07-16

Step 12 of the cleanup program. This is a **measurement and recommendation only**;
no pagination or virtualization was implemented (per the plan's rule that no
table is virtualized on row count alone, and per explicit direction to stop at
measurement).

## Method

Synthetic render of the real `LeadsTable` component at three row counts in jsdom
(`src/components/leads/LeadsTable.bench.test.tsx`), recording wall-clock render
time and exact DOM node count. Synthetic anonymized rows only, no production
lead data pulled into the harness (no PII).

**Caveats on the numbers:**
- jsdom has no layout/paint engine, so the millisecond figures **overstate**
  real-browser cost in some ways and understate it in others (no style
  recalc/reflow). Treat them as a **relative** signal across sizes, not an
  absolute frame budget.
- The **DOM node count is exact** and is the dominant driver of real-browser
  cost for a large static table (style recalc, memory, scroll paint all scale
  with node count). This is the number to weight.
- A real-browser measurement (Playwright + real render) was not run: it would
  require seeding the worktree with production credentials and loading real
  lead rows into a browser session, which risks PII exposure for a
  measurement that the node count already answers.

## Production scale

Live `leads` row count on 2026-07-16 (aggregate `count(*)`, no rows returned):
**2,642 leads.** The table renders every row unvirtualized (`LeadsTable.tsx:186`,
`sorted.map(...)`), so the production table is the 2,642-row case below.

## Results

| Rows | Render (jsdom, relative) | DOM nodes | Nodes/row |
|---|---|---|---|
| 100 | ~98 ms | 1,557 | ~15.6 |
| 500 | ~233 ms | 7,717 | ~15.4 |
| 2,642 (production) | ~796 ms | **40,708** | ~15.4 |

DOM nodes scale linearly at ~15.4 nodes/row (10 columns plus row/cell wrappers
and the lock icon). At production scale the table materializes **~40,700 DOM
nodes** in one mount.

## Assessment

- **~40k DOM nodes is a genuinely heavy table.** Browsers handle it, but it
  costs real time on initial mount, on every sort (full re-render of all rows),
  and on style recalc. The linear scaling means it only gets worse as the lead
  ledger grows (this is a 2-year-cycle B2B dataset that accrues leads).
- The render is already reasonably lean per row (no per-row heavy work beyond
  `formatDate`, lock counting, and channel name lookup, all cheap). The cost is
  purely the **node volume**, which is exactly what virtualization addresses.
- This clears the plan's bar: the change is justified by a **measured**, growing
  cost at real production volume, not by an arbitrary row threshold.

## Recommendation

**Virtualize the Leads table** (windowing, e.g. `@tanstack/react-virtual` or
`react-window`) as a **separate, dedicated PR**, not folded into this cleanup.
Rationale and constraints for that PR:

1. It is a semantic `<table>`. Virtualizing it must preserve, and be tested for:
   column alignment, sticky header, keyboard navigation, screen-reader table
   semantics (`role`/`aria-rowcount`), sorting, filtering, row selection, and
   the lead-detail-drawer open interaction. The plan enumerates exactly this
   test matrix (Step 12).
2. Record before/after metrics in a real browser (initial render, sort, filter,
   DOM node count) to confirm a material, repeatable improvement.
3. Pagination is a weaker fit here: the page offers global sort across all
   leads, which pagination breaks unless sorting moves server-side. Windowing
   keeps client-side sort/filter intact.

**Opportunities list and Outreach tables (Step 12 surfaces 2 and 3):** not
measured here because they are gated behind "if measurement shows a problem."
The Opportunities list renders at most the open-deal count (tens of rows in
production) and the Outreach tables render per-sequence rows (also small), so
neither currently approaches the Leads table's node volume. Re-measure only if
those datasets grow.

## Status

Measured. **No implementation.** The virtualization PR is a scoped follow-up
with its own accessibility + interaction test suite.
