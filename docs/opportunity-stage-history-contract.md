# Opportunity movement and velocity contract

Status: Bite 5A foundation. Pure calculation, audit, and documentation only.
Not connected to the dashboard, Create HPP, attributions, Supabase, n8n, or
production. No database schema, migration, or import workflow was created.
This document contains no Opportunity IDs, names, accounts, owners, or
campaign names; source-export findings are aggregate facts only.

Implementing module: `src/lib/opportunityStageHistory.ts`.

## 1. The funnel level is the Record Type

The Salesforce funnel level of an Opportunity (HPP / Opportunity / Pursuit)
is determined by its Opportunity Record Type, not by the detailed Stage
field. Detailed Stage values are never funnel levels; they feed the separate
terminal status (open / won / lost / disqualified / nurture / unknown).

Classification uses a closed, validated, configurable mapping of exact
record-type values. RecordType IDs are never hardcoded or used. The confirmed
mapping, exported as `DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP`:

| Sourced state | Record-type values (labels, legacy labels, developer names) |
|---|---|
| `hpp` | High Potential Prospect, High_Potential_Prospect |
| `opp` | Opportunity, Leads, Sales Accepted Opportunity |
| `pursuit` | Pursuit, Licensing, Sales Qualified Opportunity |
| `out_of_scope` | Nurture, Service (business-confirmed 2026-07-27) |
| unknown (review) | any unmapped value |

This mapping was verified complete against the July 2026 history export:
every observed old/new record-type value maps. Unknown values are retained as
ledger evidence, flagged for review, and never shown as a funnel stage.

## 2. Verified export audit (aggregate facts)

Current-fields export:

- 49 opportunities: 13 HPP, 20 Opportunity, 16 Pursuit.
- Primary Campaign Source missing on 26 of 49. It is supporting attribution
  evidence, not guaranteed truth; a channel is never invented from it.
- HPP Date present on 11 of 49; Opportunity Date on 8; Pursuit Date on 6.

Field-history export:

- 3,926 rows across 493 opportunities; 585 record-type rows on 248
  opportunities (245 have no retained record-type history).
- 171 opportunities have at least one backward movement; 100 have both
  forward and backward movement; 22 have a forward skip; 21 a backward skip;
  11 touched the excluded/Nurture state.
- The report contains two identically named `Last Stage Change Date` columns
  that disagree on 136 rows. Neither is trustworthy; future ingestion must
  use the Salesforce field-history CreatedDate timestamp instead.

The movement numbers prove the funnel is non-monotonic in practice, which is
why this contract models regression, skips, re-entry, and excluded states as
first-class behavior rather than edge cases.

## 3. Append-only movement ledger

Every record-type change becomes one `OpportunityStageEvent`:
`sourceHistoryId` (the idempotency key), `salesforceOpportunityId`,
`fromState`, `toState`, `changedAt` (full source timestamp), provenance
(`salesforce_history` or `baseline_observation`), a baseline-observation
flag, a history-known-before flag, and the raw record-type values for
diagnostics.

The ledger is append-only: historical events are never deleted or
overwritten. A regression may invalidate downstream milestone dates in the
DERIVED current view, but the original events stay available for audit and
historical reporting. Transitions into and out of excluded record types
remain in the ledger and are never silently removed.

Terminal-status changes (from the detailed Stage field) form a separate
`OpportunityTerminalEvent` ledger. Closures and reopenings both stay on
record; reopening is supported when history proves it. Moves between two
open detail stages are not terminal changes.

The observed org Stage labels are covered by two CLOSED sets, exported as
defaults:

| Terminal label (exact source spelling) | Status |
|---|---|
| `100) Closed-Won` | won |
| `Closed-Lost-Competitor` | lost |
| `Closed-Lost-InHouse` | lost |
| `Closed-Disqualified` | disqualified |
| `Closed-Nurture` | nurture |

Known open labels: `1) Suspect`, `2) Opportunity Assesment` (the org's own
spelling, matched as-is and never silently corrected), `3) Qualification`,
`4) Discovery`, `5) Pitching`, `6) POC`, `7) Proposal`, `8) Negotiation`,
`10) Awaiting Execution`. A known open label keeps the deal open or reopens
a previously closed one. A Stage value in NEITHER set is unknown: it is
retained and flagged for review (`unknown_stage_value`) and never silently
closes or reopens the opportunity on its own.

## 4. Derived current state

`adaptOpportunityHistory` derives, per Opportunity:

- current visible funnel stage (null while out of scope or unknown);
- ACTIVE entry dates for HPP, Opportunity, and Pursuit;
- terminal status;
- forward and backward movement counts, forward/backward skip counts, and
  re-entry counts by stage;
- an incomplete-baseline flag;
- current-path velocity intervals;
- per-deal issues and a reportability flag.

Rules:

1. Moving backward clears higher-stage dates from the derived current path
   only; the ledger keeps every event.
2. Re-entering a stage uses the latest valid entry date for the current
   path.
3. Skipped stages remain null. An Opportunity date is never invented for an
   HPP-to-Pursuit skip.
4. A deal first observed at a stage without earlier retained history keeps
   that stage as the observed baseline with UNKNOWN entry dates; earlier
   stages are unknown, and no HPP or Opportunity event is invented.
   Baseline observations apply only to deals with no retained record-type
   history; witnessed history always supersedes an observation.
5. A first witnessed transition whose old value is a real state means the
   earlier movement predates retained history: the prior stage's entry date
   stays unknown and the deal is marked `incomplete_baseline`.
6. An excluded-state visit (Nurture) suspends the visible stage without
   erasing known entry dates; returning re-enters with the return date.
7. Detailed Stage values never change the funnel level; closing status is
   represented separately from record-type movement.

Worked examples (all covered by tests):

- HPP Jan 1, Opportunity Feb 1, back to HPP Mar 1: current path shows HPP
  entered Mar 1 with Opportunity and Pursuit null; the ledger retains all
  three movements.
- HPP Jan 1, Pursuit Feb 1: HPP Jan 1, Opportunity null (skipped), Pursuit
  Feb 1.
- Pursuit Feb 1, Opportunity Mar 1, Pursuit Apr 1: current Pursuit entry is
  Apr 1; the February visit stays in history.
- First observed as Pursuit with no earlier history: Pursuit is the observed
  baseline, entry dates unknown, nothing invented.

## 5. Reporting lenses

Two distinct views, never mixed:

1. Current operational funnel (`currentFunnelSnapshot`): each Opportunity
   appears exactly once at its current visible stage, plus out-of-scope and
   unknown buckets. A deal that historically occupied several stages is
   never counted more than once here.
2. Historical movement (the ledgers plus `movementSummary`): every recorded
   transition, regression, skip, re-entry, excluded-state visit, and
   terminal-state change.

## 6. Velocity contract

Velocity describes the latest currently valid forward path only:

- HPP-to-Opportunity and Opportunity-to-Pursuit intervals are computed only
  when both ACTIVE dates belong to the valid current path.
- A skipped Opportunity makes that interval unavailable (null), not zero;
  the direct HPP-to-Pursuit interval is exposed only in that skip case.
- A regression suppresses the invalidated downstream interval until the
  stage is reached again; re-entry restores velocity using the new date.
- Unknown or incomplete history (baselines, pre-history entries) suppresses
  the affected intervals.
- Missing stages never produce zero-day velocity; only a real same-day
  transition can be 0 days.
- Historical cycle durations remain derivable from the append-only ledger
  for future analysis; they are never mixed into current-path velocity.

Compatibility: the interval names and null semantics match the existing
manual-attribution `DealVelocity` (`hppToOppDays`, `oppToPursuitDays`, null
when unreached) in `src/lib/compute.ts`, so a future reconciliation between
manual attributions and Salesforce-derived movement can compare like for
like. Nothing is wired together in this bite.

## 7. Validation and deduplication

Follows the hardened lead-history adapter patterns:

- Blank History ID or Opportunity ID: review (`invalid_source_row`), no
  event.
- Invalid or impossible timestamp (bad calendar date or time): review
  (`invalid_history_timestamp`), no event; today's date is never
  substituted.
- Exact repeated History ID with identical content: informational, counted
  in `duplicatesIgnored`, result stays complete.
- Same History ID with conflicting content: conflicting duplicate; no event
  for that ID, review required, result incomplete.
- Invalid configuration (blank field name, empty or illegal record-type
  mapping, illegal terminal mapping): invalid result, zero records
  processed.
- Unknown record-type value: retained as out_of_scope/unknown ledger
  evidence, flagged for review, never mapped to a visible stage.
- Events order by the full Salesforce CreatedDate timestamp with History ID
  as the stable STORAGE tie-break. Date-only ordering is never used: the
  audit CSV's date-only columns are unsuitable for production ordering, and
  ingestion must pull `OpportunityFieldHistory.CreatedDate` as a full
  timestamp.
- History ID never decides BUSINESS order. When several record-type
  transitions for one Opportunity share one exact timestamp, the order is
  accepted only when the rows' own old values prove a unique chain, or when
  every possible ordering produces the identical outcome. Otherwise the
  group is `ambiguous_same_timestamp`: reviewed rather than guessed, the
  affected current-path dates (and their velocity) are suppressed, the
  current stage becomes unknown when even the resulting stage depends on the
  ordering, and every source event stays in the ledger for audit.
  Same-timestamp events in separate ledgers (a record-type move plus a Stage
  closure) and harmless simultaneous changes to unrelated fields never
  create this issue.

## 8. Future ingestion recommendation (not implemented)

- Initial sync must not rely only on Opportunity CreatedDate: older
  Opportunities move during the current year.
- Incremental sync should use SystemModstamp / history CreatedDate
  watermarks: pull the currently included Opportunities plus new history
  since the saved watermark.
- Use RecordType.DeveloperName for current classification;
  OpportunityFieldHistory.CreatedDate as a full timestamp for movement.
- Preserve transitions into and out of excluded record types.
- Records lacking reliable campaign/channel attribution (Primary Campaign
  Source is missing on 26 of 49 current deals) go to a review inbox in a
  later bite; a channel is never invented.

## 9. Explicit non-changes

The existing dashboard, Create HPP flow, attributions behavior, Supabase,
schema, migrations, n8n, Google Sheets, dependencies, and environment are
all unchanged. The source exports were read-only inputs and are not
committed.
