# Archived reporting timeframe and delta standard

> Archived on 2026-07-21. Historical reference only. The active project
> instructions are in `../../../CLAUDE.md`. Do not use this file as current
> guidance.

# Reporting timeframe and delta standard

Status: Current reporting contract for new work  
Established: 2026-07-20  
Owner: Marketing Operations

This document defines how Sourced selects reporting periods, compares periods,
calculates deltas, and presents change. It applies to existing reporting
surfaces as they are migrated and to every future data source, including email
marketing.

Existing screens do not all conform yet. This contract does not authorize a
bulk rewrite. Each surface must be migrated and verified in a separate,
reviewable change.

## 1. Goals

The standard has five goals:

1. Month, quarter, and year mean the same thing throughout the app.
2. A comparison changes only the period. Metric definitions and all other
   filters remain identical.
3. Delta cards use the same formulas, labels, colors, and missing-data rules.
4. Each source is aggregated according to what its records represent. A flow,
   a cumulative counter, and a point-in-time snapshot do not use the same math.
5. Future integrations can follow a documented onboarding checklist instead of
   inventing new filter behavior.

## 2. Non-negotiable rules

- The standard reporting grains are `month`, `quarter`, and `year`.
- Week is not a standard executive-reporting grain. Weekly source data may be
  retained and may appear on a clearly labeled diagnostic or data-detail view.
- Do not discard finer-grained source data merely because the UI reports by
  month, quarter, or year.
- Do not invent monthly values from quarterly-only data.
- Do not sum cumulative counters or point-in-time snapshots.
- Do not average row-level rates. Aggregate their numerators and denominators,
  then recalculate the rate.
- Do not treat missing data as zero.
- Do not show an infinite percentage when the prior value is zero.
- Do not color a change green or red until the metric's desired direction is
  explicitly defined.
- A delta must compare the same metric, source membership, region, channel,
  campaign, sequence, and other filters. Only the period may change.
- Any intentional exception must be visible next to the affected chart. Hidden
  exceptions are not allowed.

## 3. Reporting vocabulary

Use these terms consistently in code, documentation, tests, and UI copy.

### Grain

The size of the reporting bucket: month, quarter, or year.

### Selected period

The period currently displayed, such as July 2026, Q3 2026, or 2026.

### Comparison period

The period used to calculate change, such as June 2026 or July 2025.

### Source grain

The smallest reliable unit delivered by the source, such as a daily event,
weekly total, or monthly snapshot. Source grain and reporting grain are not the
same thing.

### Flow metric

A value accumulated during a period, such as leads created, emails sent,
clicks, spend, or opportunities created.

### Cumulative snapshot

An odometer-like value that contains everything recorded up to a point in time.
Outreach counters are the current example.

### Point-in-time snapshot

A photograph of the state at one point, such as a monthly 6sense account
snapshot.

### Cohort metric

A value whose membership is anchored to an entry event, then followed forward.
The Marketing Funnel conversion view is the current example.

### Partial period

A selected period that is still in progress or whose source import is not yet
complete.

## 4. Calendar and date contract

Sourced currently uses calendar periods:

- Month: first through last calendar day.
- Q1: January 1 through March 31.
- Q2: April 1 through June 30.
- Q3: July 1 through September 30.
- Q4: October 1 through December 31.
- Year: January 1 through December 31.

Changing to fiscal periods requires an explicit product decision and an update
to this contract before implementation.

Date handling rules:

- Treat ISO date-only values such as `2026-07-20` as calendar dates. Do not
  convert them through the browser's local timezone.
- A timestamped source must declare its reporting timezone before integration.
- An n8n workflow must normalize a timestamp to the declared reporting date in
  one place. The app must not guess the source timezone later.
- A cross-source dashboard must use compatible period boundaries for every
  source it combines.
- Period endpoints are inclusive unless a source API explicitly uses an
  exclusive end boundary. The normalization layer must resolve that difference.

## 5. Standard timeframe control

The standard control order is:

`Timeframe: [Month | Quarter | Year] [period] [year]`

Behavior by grain:

| Grain | Required selectors | Example |
|---|---|---|
| Month | Month and year | July, 2026 |
| Quarter | Quarter and year | Q3, 2026 |
| Year | Year | 2026 |

UI rules:

- Use the labels `Month`, `Quarter`, and `Year` in that order.
- Reporting dashboards default to Month when reliable monthly data exists.
- Default to the latest available period. If it is incomplete, show `Partial`
  or `Data through <date>`.
- A page may omit an unsupported grain. It must not fabricate data to make all
  three buttons appear.
- Data-entry pages should default to their storage grain. For example,
  quarterly projections remain quarterly.
- Page-level timeframe controls apply to every primary KPI and chart.
- A fixed full-year or all-time context chart must live in a separately labeled
  section such as `Full-year context`.
- Timeframe controls come before region, campaign, channel, sequence, and search
  filters.
- Keep a selection across related sub-tabs only when the selected period has
  the same meaning on those sub-tabs.

### Visual control contract

Controls with the same purpose must have the same shape and states throughout
the app. A page must not create its own Tailwind variation of a reporting
control.

Use this visual hierarchy:

| Control type | Purpose | Shape |
|---|---|---|
| Segmented control | Choose one of a short fixed set, such as Month, Quarter, Year | One joined rounded rectangle |
| Select | Choose from a longer or changing set, such as month or year | Rounded rectangle matching the segmented-control height |
| Filter chip | Toggle one or more categories, such as region | Pill, used only for multi-select categories |
| Clear or reset | Remove a category selection | Neutral outline chip or button matching its neighboring control |

Standard dimensions and colors:

- All reporting buttons and selects use a 32 px control height.
- Segmented buttons and selects use a 6 px corner radius.
- Filter chips use a full pill radius because they represent removable or
  multi-select categories, not time periods.
- Controls use 12 px text with medium weight and tabular numerals where numbers
  are shown.
- Inactive state: white background, `border`, charcoal text.
- Inactive hover: slightly darker border and no layout shift.
- Active state: indigo background, indigo border, white text.
- Disabled state: muted background and text, with the disabled reason available
  in nearby copy or a tooltip.
- Keyboard focus: visible indigo focus ring with an offset. Never remove the
  focus indicator.
- Use the same border width in active and inactive states so selection does not
  move surrounding controls.

Layout rules:

- Put the label immediately before its control group, such as `Timeframe`,
  `Period`, `Compare to`, or `Region`.
- Use the same horizontal and vertical spacing between control groups.
- Keep one control group together when the bar wraps. Do not split the buttons
  within a segmented control across lines.
- Use a month select instead of twelve month buttons on constrained layouts.
- Quarter may use one `Q1 | Q2 | Q3 | Q4` segmented control.
- Year uses a select.
- Comparison uses one shared control. It may collapse from a segmented control
  to a select on narrow layouts, but its values and states do not change.
- Do not mix isolated square buttons, rounded buttons, and pills for the same
  period-selection purpose.

Interaction and accessibility rules:

- A single-select segmented control exposes one selected value and supports
  keyboard operation.
- Toggle buttons use `aria-pressed` or an equivalent radio-group pattern.
- Every select has a visible label or an accessible name.
- Active state must be understandable without color alone.
- Focus order follows the visual order: timeframe, period, year, comparison,
  then business filters.

### Shared implementation requirement

When Bite 3 begins, implement reporting controls as shared primitives rather
than copied page markup. The implementation should provide equivalents of:

- `ReportingFilterBar`
- `SegmentedControl`
- `ReportingSelect`
- `FilterChipGroup`
- `ComparisonControl`

Exact component names may follow the existing folder conventions, but there
must be one shared implementation for appearance, accessibility, and state.
Pages may configure labels and values. They may not duplicate the styling.

## 6. Standard comparison control

The comparison control is separate from the timeframe control:

`Compare to: [Previous period | Previous year | Off]`

### Previous period

| Selected period | Comparison period |
|---|---|
| July 2026 | June 2026 |
| Q3 2026 | Q2 2026 |
| Q1 2026 | Q4 2025 |
| 2026 | 2025 |

### Previous year

| Selected period | Comparison period |
|---|---|
| July 2026 | July 2025 |
| Q3 2026 | Q3 2025 |
| 2026 | 2025 |

For Year grain, `Previous period` and `Previous year` are identical. Show only
one option in that case.

Comparison rules:

- Default to `Previous period` when prior data exists.
- Always name the comparison period in the UI, such as `vs June`, `vs Q2`, or
  `vs 2025`.
- Comparison is optional when the surface is not intended to measure change.
- The previous-period lookup must cross month, quarter, and year boundaries
  correctly.
- Do not silently fall back from previous period to previous year, or the other
  way around.

## 7. Delta calculation contract

For count, currency, duration, and other numeric metrics:

```text
absolute delta = current value - comparison value
relative delta = absolute delta / absolute value of comparison value * 100
```

Calculate with full precision. Round only for display.

Example:

```text
Impressions
74,843
▲ 6,120 (+8.9%) vs June
```

### Rate metrics

Rates must first be recomputed from each period's aggregate numerator and
denominator. Their primary absolute change is expressed in percentage points.

Example:

```text
CTR
1.29%
▲ 0.14 pp (+12.2%) vs June
```

The `pp` label is required. A move from 1.15% to 1.29% is an increase of 0.14
percentage points, not 0.14 percent.

### Zero and missing-data rules

| Current | Comparison | Required display |
|---|---|---|
| Value | Positive value | Absolute and relative delta |
| Positive value | Zero | Absolute delta plus `New`, no relative percentage |
| Zero | Positive value | Absolute and relative delta |
| Zero | Zero | `No change` |
| Value | Missing | `No comparison data` |
| Missing | Any | `No current data` |

`Missing` and `0` are different facts and must remain different in storage,
calculation, and presentation.

### Partial-period rules

- A current partial period must be labeled.
- A partial month must not be compared with a complete previous month as if the
  two windows were equivalent.
- Use an equal elapsed window only when the source reliably supports exact
  daily boundaries. Example: July 1 through July 20 compared with June 1
  through June 20.
- If equal-window comparison is not reliable, show the current value and
  suppress the delta with `Partial period`.
- Import recency matters as much as the calendar. A completed month with a
  failed source workflow is still incomplete.
- A source integration must identify its latest reliable `data through` date or
  equivalent completeness signal before final-period deltas are trusted.

## 8. Delta direction and color

Every metric used in a delta component must declare one direction:

- `higher_is_better`
- `lower_is_better`
- `neutral`

Use direction to determine color, not the mathematical sign alone.

| Metric examples | Direction |
|---|---|
| Leads, MQLs, replies, clicks, pipeline, won revenue | Higher is better |
| CPL, CPC, bounce rate, opt-out rate, days in stage | Lower is better |
| Spend, impressions without a goal, account universe size | Neutral |

Rules:

- Positive beneficial change uses success color.
- Negative harmful change uses danger color.
- Neutral metrics use neutral text regardless of direction.
- Use an arrow, sign, label, and color. Color alone must never carry meaning.
- Do not guess a direction for a new metric. Default it to neutral until the
  business owner approves otherwise.

## 9. Aggregation rules by data model

### Additive flow

Examples: leads created, emails sent, LinkedIn spend, impressions, clicks.

- Sum records whose reporting dates fall inside the selected period.
- Deduplicate at the source's documented natural key before summing.
- Recalculate derived rates from the summed numerator and denominator.

### Cumulative snapshot

Example: Outreach lifetime sequence counters.

- Derive period activity by subtracting the last snapshot before the period
  from the last snapshot in the period.
- Detect counter resets. A negative difference is not automatically zero and
  must be investigated or handled by a documented reset rule.
- A sequence's first-ever imported snapshot may include historical lifetime
  activity. Do not call it period activity without a prior baseline.
- Missing scheduled snapshots must affect the completeness state.

### Point-in-time snapshot

Example: 6sense monthly account state.

- Use the latest eligible snapshot at or before the selected period end.
- Do not sum snapshots across a quarter or year.
- Delta compares the selected snapshot with the equivalent comparison
  snapshot.
- Show the effective snapshot date so the user knows when the photograph was
  taken.

### Date-range allocation

Example: campaign budgets and costs.

- Prorate the amount by the inclusive overlap between the source range and the
  selected period.
- Use the same period boundaries for current and comparison calculations.
- Do not allocate a parent amount to children unless the allocation rule is
  separately documented and tested.

### Cohort

Example: Marketing Funnel conversion reporting.

- Declare the cohort anchor date, such as `marketing_sourced_date` or the HPP
  entry date.
- Preserve that same anchor definition in the comparison period.
- Do not mix cohort counts with stage-activity counts in one conversion rate.
- Label a stage-activity view as activity, progression, or movement so it is not
  mistaken for a cohort conversion view.

### Coarser historical fallback

Example: quarterly manual funnel actuals for a year with no lead-level source
data.

- Keep the value at its stored quarter grain.
- A monthly view may show a separate quarterly annotation.
- Do not divide or spread the quarter across invented months.

## 10. Current Sourced source map

This table documents the current source semantics that a migration must respect.
It is not a claim that every current screen already follows the UI standard.

| Domain | Data model | Current period anchor | Standard grains | Important constraint |
|---|---|---|---|---|
| Funnel lead stage | Cohort event | `marketing_sourced_date` | Month, quarter, year | Quarterly fallback cannot become monthly bars |
| Funnel MQL stage | Strict cohort event | First MQL stage-history date, with the lead in the same cohort period | Month, quarter, year | Keep cohort and activity views distinct |
| Opportunities | Cohort or stage activity, depending on surface | HPP cohort date or `stage_entered_at` | Month, quarter, year | The surface must state which semantic it uses |
| Funnel spend | Date range plus dated events | Cost overlap and lead or deal dates | Month, quarter, year | Ratios are recomputed from period totals |
| Events | Lead cohort with undated activation labels | `marketing_sourced_date` | Month, quarter, year | It cannot claim the activation occurred in that period |
| LinkedIn Ads | Weekly additive flow | `snapshot_date` | Month, quarter, year | Exact month boundaries require the source-grain audit |
| Outreach | Weekly cumulative snapshot | `export_date` | Month, quarter, year | Requires baselines, reset handling, and completeness checks |
| 6sense | Monthly point-in-time snapshot | `snapshot_date` | Month, quarter, year | Quarter and year use the latest snapshot, never a sum |
| BDR quota reporting | HPP-anchored cohort against annual quota | HPP entry date | Month, quarter, year where defined | Period quota interpretation requires explicit approval |
| Funnel Data Entry | Quarterly stored projections and fallback actuals | `year` plus `period_index` | Quarter and year | Do not invent monthly editable cells |
| Campaign scorecards | Mixed source models | Source-specific | Month, quarter, year | Each tile must use its source's aggregation rule |

## 11. Future source onboarding contract

Complete this record before adding any reporting source. Do not start with UI
buttons.

```text
Source name:
Business owner:
Technical owner:
Source system:
Workflow or import name:
Destination table:
Source timezone:
Source grain:
Data model: additive flow | cumulative snapshot | point-in-time snapshot |
            date range | cohort
Period anchor field:
Natural key or upsert key:
Metrics imported:
Metrics derived in Sourced:
Supported reporting grains:
Default reporting grain:
Default comparison:
Metric directions:
Expected delivery schedule:
Data-through or completeness signal:
Late-arriving data behavior:
Counter-reset behavior, if applicable:
Missing-run behavior and alert:
Source reconciliation method:
PII classification:
```

### Email marketing example

Before implementing email marketing, determine whether the provider gives
event-level rows, daily incremental totals, or lifetime cumulative counters.
That answer selects the aggregation rule.

Preferred design when the source supports it:

- Preserve daily or event-level counts rather than pre-aggregating to month.
- Store or derive a declared reporting date and source timezone.
- Use an idempotent natural key so a rerun corrects data without duplicating it.
- Import raw numerators such as delivered, opens, clicks, and unsubscribes.
- Derive open rate, click rate, click-to-open rate, and unsubscribe rate from
  aggregate numerators and denominators.
- Support Month, Quarter, and Year from the same underlying records.
- Default comparison to Previous period and offer Previous year.
- Mark incomplete periods and missing workflow runs.
- Declare directions before coloring: higher delivery, open, and click rates
  may be beneficial; lower bounce and unsubscribe rates are beneficial; send
  volume is neutral unless a target is defined.

## 12. n8n workflow review checklist

The workflow audit is read-only until a separate change is approved. For each
workflow, record:

- Workflow name and business purpose.
- Trigger schedule and timezone.
- Source platform and report or API endpoint.
- Whether source values are incremental, cumulative, or point-in-time.
- Earliest reliable date field and its timezone.
- Row grain before and after any n8n aggregation.
- Grouping keys, natural key, and Supabase upsert conflict target.
- Whether a rerun is idempotent.
- Month, quarter, and year boundary behavior.
- Late-arriving correction behavior.
- Missing-run detection and alerting.
- Counter-reset handling.
- Destination table and column mapping.
- Data completeness signal.
- Source-to-Sourced reconciliation query or report.

Exported workflow JSON must have credentials, tokens, secrets, and customer or
prospect records removed before it is added to the repository or shared for
review.

## 13. Required tests for implementation

Every shared period or delta implementation must cover:

- Month lengths of 28, 29, 30, and 31 days.
- Leap year February.
- Q1 through Q4 boundaries.
- December to January previous-period comparison.
- Q1 to prior-year Q4 comparison.
- Previous-year comparison for month, quarter, and year.
- Missing comparison data versus a real zero.
- Zero comparison with a positive current value, displayed as `New`.
- Rate differences in percentage points.
- Higher-is-better, lower-is-better, and neutral directions.
- Partial-period suppression or equal-window comparison.
- Same non-time filters applied to current and comparison periods.
- Additive flow, cumulative snapshot, point-in-time snapshot, date range, and
  cohort examples.
- Counter reset and missing scheduled snapshot behavior where applicable.
- Reconciliation against a known source total.

Tests should use fixed dates and pure functions. They must not depend on the
current clock, browser timezone, network access, or production data.

## 14. Definition of done for a migrated surface

A reporting surface is compliant only when:

1. Its source is classified using this document.
2. Its period anchor and aggregation rule are documented.
3. Supported grains are explicit and unsupported grains are omitted.
4. Current and comparison periods use identical non-time filters.
5. Delta math and edge cases use the shared contract.
6. Partial and missing data are visible.
7. Metric direction is declared or left neutral.
8. Boundary and delta tests pass.
9. Existing trusted totals are reconciled before and after migration.
10. User-facing copy accurately describes cohort, activity, snapshot, or
    allocation semantics.
11. Timeframe, comparison, select, and filter controls use the shared visual
    primitives and pass keyboard and focus-state checks.
