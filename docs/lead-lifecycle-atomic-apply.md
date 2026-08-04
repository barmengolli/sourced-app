# Lifecycle observation ledger: atomic apply boundary (Bite 4G2B1)

The write boundary between the pure planner
(`docs/lead-lifecycle-observation-ledger.md`) and the applied
`sf_lifecycle_*` storage.

**Nothing in this bite ingests, activates, schedules, or writes
anything.** The serializer is pure, the migration is PENDING and
unapplied, and no n8n workflow exists. Bite 4G2B2 (ingestion) and 4G2C
(reporting and UI) are unstarted.

## What this bite adds

1. `src/lib/lifecycleApplyPayload.ts`: a pure, type-safe serializer from
   one `LifecyclePlan` to one allowlisted apply payload.
2. `migrations/2026-08-04_lifecycle_observation_apply_fn.sql`: three
   forward-only idempotency constraints plus
   `sf_apply_lifecycle_observations`, a restricted atomic apply function.

It reuses existing authorities and duplicates none of them: Bite 4G1 for
value normalization, Bite 4A for transitions after the baseline, and Bite
4G2A for baseline, identity, completeness, and the planner operations.

## Gaps found at the planner/write boundary

The planner was designed to stop short of persistence, so three things
were genuinely undecided. Two of them required schema additions.

### 1. Events had no idempotency key (schema addition)

`sf_lifecycle_observations` already deduped on `(source_object,
source_record_id, source_modified_at, content_fingerprint)`.
`sf_lifecycle_events` had **no unique constraint at all**.

This is the most consequential gap in the bite. Events are append-only by
trigger, so an exact retry of a batch, the ordinary outcome of a network
timeout or a rerun, would have inserted **permanent duplicate events**
that nothing could remove. Every downstream transition, return, and
requalification count would inflate silently, and the append-only
guarantee that makes the ledger trustworthy would have made the damage
irreversible.

Added: `event_key` plus `sf_lifecycle_event_key_unique`, content-addressed
over the evidencing observation, the event kind, and the direction.

### 2. Issues had no idempotency key (schema addition)

The same unresolved conflict re-observed nightly would append one row per
night forever, burying the review queue in copies of one problem.

Added: `issue_key` plus `sf_lifecycle_issue_key_unique`, keyed on the
**evidence** (kind, source object, source record, person) and deliberately
**not** on the run or the detail wording, so rewording a message cannot
defeat deduplication.

### 3. Events were not bound to their evidence (serializer)

`lifecycle_event` operations carry a person and the 4A event, but no link
to the observation that produced them, and `observation_id` is nullable.
Events would have landed as orphans with no audit path back to the
evidence.

The serializer binds each event to the observation emitted for the same
person in the same plan, by an explicit key. The SQL refuses any event
that is not bound. Neither side infers the relationship from array
position.

An `observation_key` column and unique constraint were also added so the
key the serializer computes and the constraint the database enforces are
the same fact rather than two things that must be kept in agreement.

## Temporary handles and database UUIDs

The planner emits content-free handles (`new-person-<runId>-<n>`) because
it cannot know a UUID it has not created. The function maps them:

- A `create_person` operation inserts a row and records
  `handle -> real UUID` in an in-memory map.
- Every later alias, observation, event, projection, and issue resolves
  its person through that map.
- A handle that is not in the map must resolve through an existing alias;
  if it resolves to nothing, the batch fails (`LC005`) rather than
  inventing or guessing a person.
- Handles are never stored in a column. They exist only for the duration
  of one apply.

## Idempotency and conflict

| Situation | Behavior |
|---|---|
| Exact retry of a whole batch | Every insert collapses on its key. No duplicates, no error |
| Same source timestamp, same content | Idempotent no-op |
| Same source timestamp, different content | `LC002`. The batch fails; **no winner is chosen** |
| Stale source timestamp | Projection no-op under a row lock. Newer state is never overwritten |
| Unchanged re-observation | Counted in run diagnostics, no row inserted |

Declaring a unique constraint is not the guarantee; the insert has to
*use* it. Each insert's `ON CONFLICT ... DO NOTHING` is asserted against
its own statement, because a constraint that exists while the insert
ignores it turns a silent no-op into a failed batch.

## Identity

Aliases come only from an exact source record or an exact
`Lead.ConvertedContactId` link. There is no name, email, company, or
similarity matching anywhere in the payload types or the function.

Races are resolved by the unique constraint, not by an unlocked read
followed by a write. If a concurrent batch already claimed an alias, the
function adopts the winner's person. If that person differs from the one
this batch intended, two **existing** people would be merged, so the batch
fails (`LC003`) for human review. An automatic merge of two real people is
unrecoverable, which is why it is never attempted.

## Atomicity, failure, and the watermark

The run row is created **first**, from server-generated values only, so a
malformed payload still produces a recorded failure. All business work
then happens inside a block whose failure rolls everything back.

- **Success**: run marked `completed`, watermark persisted, counts
  returned.
- **Incomplete** (`LC001`, either extraction axis incomplete): refused
  before any state change, run marked `incomplete`, watermark NULL.
- **Failure**: every business write rolls back, one failed run row
  survives with a NULL watermark.

The watermark is written in exactly one place, on the success path, after
everything else succeeded. It can never accompany a partial batch.

Failure diagnostics are SQLSTATE plus an allowlisted category. `SQLERRM`
is never persisted, because it can embed a lifecycle value, a Salesforce
Id, or other source data.

## Security

`SECURITY DEFINER` with `search_path` pinned to `pg_catalog` and every
reference schema-qualified, so a hostile `search_path` cannot redirect a
write. Execution is revoked from `PUBLIC`, `anon`, and `authenticated`,
and granted only to `service_role`. RLS on the seven tables remains
enabled with zero policies; the browser anon key can reach neither the
tables nor the function.

The payload types can only address the seven `sf_lifecycle_*` tables. A
write to `leads`, `lead_campaign_touches`, `attributions`, `channels`, any
opportunity table, or any dashboard table is not merely forbidden, it is
**unrepresentable** in the type system.

## Diagnostics

Aggregate only: counts of persons, aliases, observations, events,
projections, and issues, split by event kind, plus no-op counts and
whether the watermark would advance. `writes_attempted` is `0`. No names,
emails, Salesforce Ids, or source rows appear in shared diagnostics.

## Baseline invariant

Enforced independently at three levels: the serializer, the function body,
and the table's `sf_lifecycle_event_baseline_shape` constraint.

- A baseline has `event_kind = 'baseline'` and `from_state IS NULL`.
- A first Lead baseline ends at `lead`; a first MQL baseline ends at
  `mql`.
- `null -> mql` means "first observed as MQL" and is **never** rewritten
  as `null -> lead` or reinterpreted as a transition.
- A baseline increments no transition, return, or requalification counter.
- Every non-baseline event requires a non-null `from_state`.
