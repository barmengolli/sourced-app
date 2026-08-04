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

## Person references are typed, never guessed

A person is referenced in exactly one of three unambiguous ways, as a
discriminated union rather than a bare string, so the SQL never infers
what a reference means:

| Kind | Resolution |
|---|---|
| `new_handle` | A person created in **this batch**. Resolves **only** through the batch handle map. There is no table-lookup fallback |
| `person_id` | An existing internal UUID. Validated as a UUID and confirmed to exist |
| `alias` | The **complete** `(source_object, source_record_id)` identity |

The alias case carries both columns deliberately. An earlier version
resolved a person with `WHERE source_record_id = handle LIMIT 1`, omitting
`source_object`: a Lead and a Contact sharing an id string could collide,
and `LIMIT 1` would pick an arbitrary winner, silently attaching evidence
to the wrong person. That lookup no longer exists, and the unique
constraint means no `LIMIT` is needed at all.

An unresolvable or ambiguous reference fails the batch with a sanitized
`LC005` rather than guessing. Temporary handles are never written to a
column; they exist only for the duration of one apply.

## Key construction

Keys hash a JSON **array** of explicitly ordered values with a leading
type tag. An array rather than an object, so property ordering cannot
change a key; JSON rather than a delimiter join, so a value containing the
delimiter cannot forge a different record's key; and JSON's distinction
between `null` and `""` means an absent timestamp and a blank one produce
different keys. Every input is readable text, so these files stay text to
git and to ordinary tools.

## Idempotency and conflict

| Situation | Behavior |
|---|---|
| Exact retry of a whole batch | Every insert collapses on its key **after its full content is verified**. No duplicates, no error |
| Key reused with different content | `LC002`. The batch fails; **no version is chosen** |
| Same source timestamp, same content | Idempotent no-op |
| Same source timestamp, different content | `LC002`. **No winner is chosen** |
| Stale source timestamp | Projection no-op under a row lock |
| Unchanged re-observation | Counted in run diagnostics, no row inserted |

Declaring a unique constraint is not the guarantee; the insert has to
*use* it. Each insert's `ON CONFLICT ... DO NOTHING` is asserted against
its own statement, because a constraint that exists while the insert
ignores it turns a silent no-op into a failed batch.

**A matching key is not proof of a matching row.** On every key conflict,
for observations, events, and issues alike, the existing row is loaded
`FOR UPDATE` and its **complete canonical identity** is compared with
null-safe `IS DISTINCT FROM` comparisons. Only a full match counts as an
exact retry. Any difference raises `LC002` and neither version wins.
Neither append-only table is ever updated on either path.

### What is excluded from canonical identity

Under a **first-observation-wins** policy, some columns record *which run
first saw* the evidence rather than what the evidence says, so a later run
re-observing identical content must not be treated as a conflict:

- **Observations and events**: `sync_run_id` and `created_at` are
  excluded.
- **Issues**: additionally `review_state`, `detail`, and `updated_at` are
  excluded. A human may have resolved an issue, and the detail wording may
  change, without the same standing evidence becoming a conflict.

## Projection ordering truth table

Undated evidence proves *less* than dated evidence, so it may never
overwrite a known timestamp, and two rows whose order cannot be proven are
a conflict rather than silent last-writer-wins. All comparisons are on
parsed `TIMESTAMPTZ` instants, so `+0000` and `Z` are the same moment.

| Existing | Incoming | Result |
|---|---|---|
| known | older | stale no-op |
| known | NULL | **no-op; never overwrites** |
| NULL | known | accept |
| known | newer | accept |
| same instant | same fingerprint | idempotent no-op |
| same instant | different fingerprint | `LC002` conflict, no winner |
| NULL | NULL, same fingerprint | idempotent no-op |
| NULL | NULL, different fingerprint | `LC002` conflict, order unprovable |

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

The run row is created **genuinely first**: the insert uses only
`pg_catalog.now()` and constant zeros, and **nothing reads, validates, or
casts any caller-controlled value before it**. That ordering is the whole
guarantee. An earlier version validated `syncRunId` and cast five payload
values inside the insert itself, so a blank id or an unparseable timestamp
aborted the function with **zero** run rows and the attempt vanished
without a trace.

`syncRunId`, `runStartedAt`, the four page counts, completeness, and the
watermark are all validated and cast **inside** the protected block, which
then corrects the run row's page counts and start time. Every invocation
produces exactly one run row, malformed input included. All business work
happens inside that same block, whose failure rolls everything back.

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

## Execution validation (PostgreSQL 15.18)

The contract above is not only statically asserted: the migration and
function were executed against a real PostgreSQL 15.18 cluster in a
disposable local environment (never production, never a shared database).
Two defects surfaced that static analysis had missed, and both are fixed
in the still-unapplied migration:

1. **Every exact retry failed with a bogus `LC003`.** On a retry the
   payload still contains `create_person` for a `new_handle`, so the
   function minted a fresh person and then compared it against the alias's
   established owner. They differed, so the merge refusal fired. Those are
   not two real people: one is a speculative row the same invocation just
   created. The refusal is now narrowed to references that named a person
   which existed *before* the batch (`person_id` and `alias`), and the
   speculative person is discarded so no orphan remains. A retry is now a
   clean success with every counter at zero.

2. **Native cast failures were miscategorized.** An unparseable timestamp
   raises `22007` and a non-integer page count raises `22P02`; both were
   recorded as `unexpected_error`. They are malformed caller input and are
   now categorized as `malformed_payload`.

Verified in execution: both migrations apply and rerun idempotently; all
seven tables, three key constraints, two functions, and both append-only
triggers exist; RLS is on with zero policies; the tables are absent from
the realtime publication; `anon`, `authenticated`, and `PUBLIC` cannot
execute either function while `service_role` can; direct `UPDATE` and
`DELETE` against observations and events are rejected by the triggers; the
full projection truth table behaves exactly as tabulated above, including
undated evidence refusing to overwrite a known timestamp; a Lead and a
Contact sharing one source-id string resolve to **different** people; and
genuinely concurrent sessions produce no duplicates, no silent competing
winner, no unintended merge, a deterministic final projection, and zero
deadlocks.

**The central transaction guarantee was confirmed in practice.** A batch
that wrote two valid people and then failed on a poisoned third rolled
back every business write (persons, aliases, observations, events, and
projections all unchanged), while the run row created before the protected
block survived as `failed` with a NULL watermark and a sanitized
`LC004 malformed_payload` summary. Exactly one run row was added, and no
run row anywhere contains text outside the allowlisted SQLSTATE/category
vocabulary.

### Caller contract

The function returns its result as JSON with a successful SQL status even
when the batch failed. **A caller must treat any `outcome` other than
`success` as a workflow failure.** PostgreSQL returning a row means the
function ran, not that the batch applied: `incomplete` and `failure` both
come back as ordinary result rows, and `watermark_advanced` is `false` for
both. Ingestion must never interpret "the RPC returned 200" as "the data
landed".

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
