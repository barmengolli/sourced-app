# Lifecycle observation ledger (Bite 4G2A)

Storage and calculation contract for future Salesforce lifecycle
synchronization. **Nothing in this bite ingests, activates, schedules, or
writes anything**: the migration is PENDING and unapplied, the planner is
pure, and no n8n workflow exists.

## Why an observation ledger exists at all

Bite 4G1 established the fact this design is built around
(`docs/lead-sync-discovery.md`): the Salesforce org holds **zero**
lifecycle-history rows on Lead and Contact for `Hubspot_lead_lifecycle__c`.
Lead history tracking is enabled but empty; Contact tracking is disabled.
Salesforce will not recreate that history retroactively, Lead Status is a
different field answering a different question, and Became Lead / Became
MQL dates cannot express repeated movement.

So the past is not recoverable. The only honest path is to start observing
the present and accumulate truth going forward, which is what this ledger
does. Every day without it is a day of lifecycle movement lost permanently.

## The baseline rule, and its boundary with Bite 4A

**The first successfully observed lifecycle value for a person is a
baseline, never a transition.** A baseline records *the state the person
was first observed in*, and nothing more. It never invents a Lead
acquisition date, an earlier stage, a conversion, a return, or a
requalification. This holds whether the first observed value is Lead, MQL,
Opportunity, Customer, or any other out-of-scope value.

Read the event direction carefully, because the notation is easy to
misread:

> `null -> mql` means **"first observed as MQL."**
> It does **not** mean "observed moving from Lead to MQL."

The `null` origin is precisely the statement that **pre-baseline history is
unknown**. Only an observed change between two consecutive observations is
a transition, a return, or a requalification.

Bite 4A's `eventsFromObservation` is the authoritative transition
calculator and this bite reuses it rather than writing a competing one. On
a first observation already at `mql`, 4A emits **two** candidate events,
`null -> lead` and `null -> mql`, because its original feed treated a first
sighting at MQL as implying an earlier Lead stage. Choosing between those
candidates is a 4G2 concern, and the rule is simple:

> **The retained baseline is the one landing on the normalized state
> actually observed.** The planner selects by destination, not by
> `fromStage === null`, because both candidates satisfy that condition.

Selecting the `null -> lead` candidate for a person Salesforce currently
reports as MQL would be actively harmful, not merely imprecise. It would
put the event ledger in contradiction with the projection for the same
person from their very first observation, and `assessLeadLifecycle` takes
the acquisition date from the first event entering `lead`, so a fabricated
Lead baseline would hand back a confident Lead acquisition date for someone
never observed as a Lead. With the correct `null -> mql` baseline, that
lookup finds nothing and truthfully reports the acquisition date as
unknown, which is the answer the source can actually support.

Every observed change after the baseline flows through 4A with no
modification.

## Normalized lifecycle states

The approved mapping from Bite 4G1 (`APPROVED_LIFECYCLE_VALUE_MAP` in
`src/lib/leadSyncDiscovery.ts`) is reused verbatim; it is not redefined
here. `Lead` maps to `lead`, `Marketing Qualified Lead` to `mql`, and the
eight remaining observed values to `out_of_scope`. Any value absent from
that map normalizes to `unknown` and routes to review. No fuzzy matching,
ever, and deal stages are never lead lifecycle.

Out-of-scope and unknown observations are **stored**, not dropped: they are
evidence of where a person went, and discarding them would create a false
impression of continuity.

## Event kinds

Every stored event carries an explicit `event_kind`, so a baseline is never
re-inferred from its shape at the write boundary:

| Kind | Meaning |
|---|---|
| `baseline` | The state the person was **first observed** in. `from_state` is NULL. Asserts nothing about earlier movement |
| `transition` | An observed Lead to MQL move between consecutive observations |
| `return` | An observed MQL back to Lead move |
| `requalification` | An observed Lead to MQL move for a person whose MQL state had already been seen |

A **requalification requires an observed return to Lead followed by an
observed move back to MQL.** A person first observed at MQL who later
returns to Lead and moves back to MQL is a requalification, because their
MQL state was already seen; that later move is not their original observed
conversion, and the ledger never claims to know what their original
conversion was.

## Transition sequence rule

A Lead to MQL transition is only recognized between **consecutive**
observations. When an `out_of_scope` or `unknown` observation sits between
a `lead` and a later `mql`, the planner does **not** collapse across it to
manufacture a transition. It preserves the sequence and reports the
ambiguity as a reviewable issue. Inferring across an unexplained gap would
be a guess wearing the costume of a calculation.

## Storage design

Six tables, following the Bite 5B `sf_opportunity_*` precedent exactly
(protected server-side ledger, RLS on with zero policies, append-only
enforced by trigger, not in realtime).

| Table | Role |
|---|---|
| `sf_lifecycle_sync_runs` | One row per sync attempt: status, page accounting, diagnostics, and the watermarks it proposes |
| `sf_lifecycle_persons` | The canonical internal person. UUID primary key; carries no Salesforce identifier itself |
| `sf_lifecycle_person_aliases` | One row per Salesforce source record (Lead or Contact) pointing at a canonical person. This is the only place a Salesforce Id lives as identity |
| `sf_lifecycle_observations` | APPEND-ONLY. One row per materially-changed observation, plus the first baseline |
| `sf_lifecycle_events` | APPEND-ONLY. Derived lifecycle events (baseline, transition, return, requalification) |
| `sf_lifecycle_state` | The mutable CURRENT projection: one row per person holding their latest known state |
| `sf_lifecycle_issues` | Reviewable conflicts and ambiguities: identity conflicts, same-timestamp content conflicts, unknown values, malformed dates |

### Why observations are stored on change, not nightly

A nightly insert per person would add roughly 2,900 rows per night for a
population that changes rarely, so within a year the ledger would be
overwhelmingly composed of rows proving nothing happened. Instead:

- the **first** observation of a person is always stored (the baseline);
- later observations are stored only when the lifecycle evidence
  **materially changes** (normalized state, raw value, or supporting
  dates);
- unchanged re-observations are **counted in the sync-run diagnostics**,
  so "we looked and nothing moved" is still recorded, at O(1) per run
  instead of O(people).

The audit tradeoff is explicit: the ledger proves *when a state changed*
and *that a run observed the population*, but not *which individual rows a
given run re-confirmed*. That is the right trade, because the run
diagnostics answer the operational question ("did the sync see everyone?")
without paying per-person storage for a non-event.

### What every observation preserves

Canonical person id; source object (`Lead` or `Contact`); the Salesforce
source record id (server-side evidence only); the raw lifecycle value; the
normalized state; the source `SystemModstamp` / `LastModifiedDate`; the n8n
observation timestamp; a canonical content fingerprint; the sync-run id;
provenance (`n8n_observed`, or `salesforce_confirmed` if field history ever
becomes available); whether the row is a baseline or a change; and the
supporting Became Lead / Became MQL dates when present.

### Key database properties

UUID internal primary keys. Salesforce ids are stored as evidence and never
exposed to browser-facing APIs in this bite. Alias identity is unique on
(source object, source record id) and both must be nonblank. Observations
and events are append-only, enforced by the same trigger mechanism 5B uses.
All source and observation timestamps are `timestamptz`. Dedupe keys are
deterministic, and content fingerprints make same-timestamp conflicts
detectable. Foreign keys use `RESTRICT` so no deletion can quietly destroy
audit history; nothing cascades from observations or events. Normalized
states, provenance, run status, and issue types are all check-constrained.
The current projection is only ever updated through a future reviewed
server-side apply boundary, never from the browser. Watermarks advance only
after a complete, fully paginated, successful run. RLS is enabled with zero
policies, the tables stay out of the permissive anon-policy loop and out of
Supabase Realtime, and no service-role key appears in browser code.

## Identity across Lead and Contact

A Salesforce Lead begins with one canonical person and one alias. When
Salesforce reports an exact `Lead.ConvertedContactId`, the Contact alias
resolves to that **same** canonical person, so the chronology stays
unbroken across conversion and a demotion spanning the boundary is still
visible as one history.

Matching is by exact Salesforce relationship only. Never by name, email,
company, or similarity of any kind.

If the Lead alias and the Contact alias already point at **different**
canonical people, the planner raises an `identity_conflict` for review and
changes nothing. Append-only history is never rewritten and two people are
never silently merged; a human decides, because an automatic merge of two
real people is unrecoverable.

## Supporting dates

Became a Lead Date and Became a Marketing Qualified Lead Date are stored as
**evidence only**. They never create, move, or rewrite a lifecycle event.
They exist to corroborate, to detect contradiction, to support review, and
to label confidence later. Malformed or reversed dates are flagged and
preserved exactly as received; they are never swapped or silently
corrected.

## Pagination, completeness, and watermarks

Extraction pages deterministically by `SystemModstamp` with the Salesforce
Id as tie-break, so a page boundary landing inside a shared timestamp
cannot drop or repeat a record. First-page-only ingestion is rejected by
construction: 4G1 measured 103,070 CampaignMember rows and 12,986 converted
identity pairs, both far beyond a single page.

Two **independent** completeness axes are tracked, because they fail
independently: lifecycle extraction and converted-identity extraction. A
duplicate source id across pages fails the run loudly rather than being
deduplicated silently, since it means the pagination key is wrong. A missing
page or failed query makes the run incomplete.

An incomplete run may still produce diagnostics, but it may **not** apply
state changes and may **not** advance a watermark. The proposed watermark
is persisted only after every required page of both axes succeeds.

## Planner operations

The pure planner emits typed, allowlisted operations only:
`create_person`, `create_alias`, `baseline_observation`,
`changed_observation`, `unchanged_noop`, `lifecycle_event`,
`update_projection`, `stale_noop`, `duplicate_noop`, `raise_issue`, and
`record_sync_run`. It never touches Supabase or Salesforce, never reads the
clock, and reports `writes_attempted: 0`.

## Diagnostics

Aggregate only, suitable for a future n8n log: rows discovered, Lead and
Contact record counts, baselines, changes, unchanged, Lead to MQL, MQL to
Lead, requalifications, out-of-scope observations, unknown values, stale
rows, exact duplicates, conflicting rows, identity links created, identity
conflicts, malformed supporting dates, pages expected and completed, run
completeness, whether the watermark advanced, and `writes_attempted: 0`.

No names, emails, Salesforce ids, or source rows ever appear in shared
diagnostics.

## Explicitly not in this bite

No n8n workflow, activation, or schedule. No live Salesforce query. No
migration execution. No production writes. No change to leads, campaign
memberships, touches, attribution, or any dashboard. No historical
backfill, no alerting, no Queue UI, no browser database access, and no
dependency or authentication change.
