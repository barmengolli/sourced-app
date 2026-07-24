# Salesforce lifecycle history: source verification and adapter mapping

Status: Bite 4B foundation. Read-only verification plus a pure adapter. No
production ingestion, no database table, no migration, no n8n change, and no
dashboard wiring was created. This document contains no customer names,
emails, Salesforce record identifiers, or credential identifiers.

Implementing module: `src/lib/salesforceLifecycleHistory.ts` (pure). It
translates Salesforce field-history rows into the Bite 4A lifecycle-event
contract and reuses the Bite 4A calculator for all cohort, uniqueness, and
requalification questions (`docs/funnel-source-contract.md`).

## 1. What is verified versus unresolved

Field History Tracking is confirmed to be enabled for the org (confirmed by
the business owner). Everything below is split strictly into what official
documentation or repository evidence proves, and what still requires the
Salesforce administrator.

### Verified from official Salesforce documentation

- History is read from standard history objects: `LeadHistory` for Lead and
  `ContactHistory` for Contact. Each row carries its own `Id`, the parent id
  (`LeadId` / `ContactId`), `Field`, `OldValue`, `NewValue`, and
  `CreatedDate`.
  Sources: [LeadHistory field reference](https://developer.salesforce.com/docs/atlas.en-us.sfFieldRef.meta/sfFieldRef/salesforce_field_reference_LeadHistory.htm),
  [StandardObjectName History object reference](https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_associated_objects_history.htm).
- Up to 20 standard and custom fields per object can be tracked.
  Source: [Field history tracking limit](https://help.salesforce.com/s/articleView?id=000386871&language=en_US&type=1).
- Retention without the Field Audit Trail add-on: Salesforce retains field
  history for up to 18 months through the org and up to 24 months via the
  API; data 18 to 24 months old must be retrieved with `queryAll()` or Data
  Loader, and data past the retention period is subject to deletion.
  Sources: [Field history tracking](https://developer.salesforce.com/docs/atlas.en-us.securityImplGuide.meta/securityImplGuide/tracking_field_history.htm),
  [Field history retention enforcement release note](https://help.salesforce.com/s/articleView?id=release-notes.rn_general_field_tracking_retention.htm&language=en_US&release=238&type=5).
- With Field Audit Trail, history is archived after 18 months into the
  `FieldHistoryArchive` big object and kept until deliberately deleted, with
  definable retention policies.
  Source: [Field Audit Trail implementation guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/field_history_retention.pdf).
- A converted Lead links to the resulting person via the standard
  `Lead.ConvertedContactId` field (with `IsConverted` and `ConvertedDate`).
  Source: [Lead conversion mapping](https://help.salesforce.com/s/articleView?id=sf.lead_conversion_mapping.htm&language=en_US&type=5).

### Evidence from this repository (not yet org-verified)

- The nightly n8n workflow's transform reads
  `Contact.Hubspot_Lifecycle_Stage__c` and `Lead.Hubspot_Lifecycle_Stage__c`,
  so that is the lifecycle field API name the integration author believed in.
  It is NOT verified: the workflow's SOQL never selects the field, every
  supplied verification row fell back to the default stage, and no repository
  evidence proves the field exists with that exact name.
- The workflow's stage map lists the candidate picklist values `Lead`,
  `Subscriber`, `Marketing Qualified Lead`, `Sales Qualified Lead`,
  `Opportunity`, `Customer`, and `Other`. These are candidates, not a
  verified picklist.
- The workflow authenticates with a Salesforce OAuth2 integration credential.
  Whether that identity can read `LeadHistory` and `ContactHistory` is
  unresolved.

### Unresolved (requires the Salesforce administrator)

1. The exact API name of the lifecycle field on Lead and on Contact, and
   whether both objects carry it.
2. The exact API names of the become-a-lead date and became-MQL date fields.
3. Whether the lifecycle field (and the date fields) are included in Field
   History Tracking on each object, and since when.
4. The oldest and newest available history rows for the lifecycle field, and
   therefore when tracking effectively started.
5. Whether the n8n integration identity can query the history objects.
6. Whether the org has the Field Audit Trail add-on.

## 2. Read-only checks for the Salesforce administrator

All checks are read-only. Replace `<LIFECYCLE_FIELD>` with the confirmed API
name before running the history queries. Run the history queries with
`queryAll()` or Data Loader so 18-to-24-month-old rows are included.

Field discovery (exact API names, no guessing):

```sql
SELECT QualifiedApiName, DataType, IsFieldHistoryTracked
FROM FieldDefinition
WHERE EntityDefinition.QualifiedApiName = 'Lead'
  AND (QualifiedApiName LIKE '%Lifecycle%' OR QualifiedApiName LIKE '%Became%')
```

Repeat with `EntityDefinition.QualifiedApiName = 'Contact'`.

Tracking coverage and effective start:

```sql
SELECT Id, Field, CreatedDate FROM LeadHistory
WHERE Field = '<LIFECYCLE_FIELD>' ORDER BY CreatedDate ASC LIMIT 1
```

```sql
SELECT Id, Field, CreatedDate FROM LeadHistory
WHERE Field = '<LIFECYCLE_FIELD>' ORDER BY CreatedDate DESC LIMIT 1
```

Repeat both against `ContactHistory`. The ASC result approximates the
tracking start; the DESC result confirms the feed is current.

Distinct picklist values actually seen in history (validates the stage map):

```sql
SELECT NewValue FROM LeadHistory WHERE Field = '<LIFECYCLE_FIELD>' LIMIT 200
```

Integration access: run the ASC query above while logged in as (or via) the
n8n integration user. If it fails, grant read access to Lead and Contact plus
field-level security on the lifecycle field; history rows follow the parent
object's visibility.

Conversion linkage sanity (admin eyes only; do not export into this repo):

```sql
SELECT Id, IsConverted, ConvertedContactId, ConvertedDate
FROM Lead WHERE IsConverted = true LIMIT 5
```

## 3. Retention risk for the two-year sales cycle

The sales cycle is approximately two years. Without Field Audit Trail, the
API retains at most 24 months of history and Salesforce may delete older
rows. That means:

- A person acquired more than 24 months ago can lose their earliest
  lifecycle transitions from the queryable window.
- Even for current people, by the time a deal closes, the original Lead and
  MQL transitions can be at or past the edge of the window.

Conclusion: Salesforce history retention alone is NOT sufficient for the
funnel contract. The long-term pattern is a regular (for example nightly)
ingestion of new history rows into an application-owned append-only store,
bootstrapped by a one-time `queryAll()` backfill of everything still
available. That store is deliberately NOT implemented in this bite; this
adapter defines the translation those future rows will go through. If the
Field Audit Trail add-on is present, the risk window changes and the
`FieldHistoryArchive` big object becomes the bootstrap source; that is part
of admin question 6.

## 4. Adapter contract

Input: `SalesforceHistoryRow` (source-neutral mirror of LeadHistory and
ContactHistory rows), a `LifecycleHistoryConfig`, a verified
`PersonIdentityMap`, and optional per-person supporting dates.

- Field API names are configuration. Nothing is hardcoded, because the exact
  lifecycle field name is unresolved. Rows for other tracked fields are
  counted and ignored.
- The stage map translates exact picklist values to `lead`, `mql`, or
  `out_of_scope` (deal-side values such as SQL-or-later; the funnel tracks
  those in attributions, not lead lifecycle). Values missing from the map are
  unknown and route the row to review.

### Input validation

Configuration and rows are validated before anything is processed:

- Only `lead`, `mql`, and `out_of_scope` are legal stage mappings. Deal
  stages (HPP, OPP, Pursuit, closed states) can never become lead-lifecycle
  events: the mapping type is a closed literal union at compile time, and
  untyped (for example JSON-loaded) configuration is re-validated at runtime.
  An illegal mapping, a blank field API name, or a malformed
  `historyAvailableSince` rejects the whole run as `invalid_config` without
  processing any record.
- Every row must carry a nonblank history Id, a nonblank parent Id, and a
  well-formed timestamp whose calendar date is real (2026-02-30 or a 25th
  hour is malformed). Malformed rows are routed to review
  (`invalid_source_row` / `invalid_history_timestamp`); a malformed source
  timestamp is never accepted as a confirmed lifecycle date, the current
  date is never substituted, and no emitted event can pair
  `salesforce_confirmed` with a missing date.
- Supporting dates must be real calendar dates. An invalid one routes that
  person to review (`invalid_supporting_date`) and is excluded from every
  date comparison.

### Identity and idempotency

- The history record's own `Id` is the source event identity and the
  idempotency key: reprocessing the same row can never produce a second
  lifecycle event.
- Exact duplicates (same Id, every relevant field identical) are
  informational: they cannot change the result, so they are counted in
  `duplicatesIgnored` and do not degrade a complete result or present the
  data as unreliable.
- Rows sharing an Id with DIFFERENT content are a conflicting duplicate: a
  quality failure. No version is trusted, the Id is routed to review
  (`conflicting_duplicate_history_id`), no event is emitted for it, and the
  result is marked incomplete.
- A person's email is never an identity.
- Lead Ids and Contact Ids are never assumed to be the same person. The
  caller supplies a verified `PersonIdentityMap` (built from
  `Lead.ConvertedContactId` once admin checks confirm it). A row whose
  parent id is not in the map is routed to review
  (`unmapped_person_identity`), never merged heuristically.

### Ordering

- Rows are processed per person in stable source event-time order:
  `CreatedDate` ascending, with the history `Id` as the deterministic
  tie-break for changes in the same timestamp.
- The adapter is a pure full recompute over all rows collected so far. A
  history row that arrives late therefore sorts into its correct logical
  position and keeps its own source date; it is never treated as a new
  current-day transition.

### Transition mapping

| Old value | New value | Result |
|---|---|---|
| blank | Lead-mapped | Baseline event (`fromStage: null`, `toStage: lead`) |
| blank | MQL-mapped | Baseline event at MQL (first sighting already MQL) |
| Lead-mapped | MQL-mapped | Conversion or requalification event |
| MQL-mapped | Lead-mapped | Return event |
| same mapped stage | same mapped stage | Relabel, no event (counted) |
| any | out-of-scope | Deal-side progression, no lifecycle event (counted) |
| out-of-scope | in-scope | Routed to review (`out_of_scope_transition`) |
| any | blank | Cleared field, routed to review (`blank_lifecycle_value`) |
| unknown either side | | Routed to review (`unknown_lifecycle_value`) |

Every emitted event uses the history row's `CreatedDate`: date part as the
transition's effective date, full timestamp as `observedAt`, with provenance
`salesforce_confirmed` (Salesforce's own record of when the field changed;
note this can lag the real-world event if an upstream system syncs late).
First MQL versus requalification, returns, cohort membership, and uniqueness
are decided by the Bite 4A calculator over these events; the adapter never
reimplements them, and the original Lead acquisition cohort stays fixed.

If two consecutive rows disagree (a row's old value does not match the last
known stage), the adapter flags `history_continuity_gap` and still emits the
row's own values; it never silently rewrites either side.

### Supporting dates

The become-a-lead and became-MQL date fields are supporting evidence only:

- They never create a lifecycle event (no invented transitions).
- Reversed dates (`becameMqlDate` before `becameLeadDate`) are routed to
  review, never swapped.
- A became-MQL date inside the covered history window with no matching
  history row is a contradiction routed to review.
- A became-MQL or became-a-lead date before the covered window marks the
  person's historical baseline incomplete instead.

### Incomplete history

`historyAvailableSince` records the earliest date from which history is known
to be available (admin check 4; null until verified). A person is marked
`incompleteHistoricalBaseline` when their earliest relevant row shows a
pre-existing value, or their confirmed acquisition predates the window. The
absence of an older history row is never treated as proof that no older
transition occurred.

### Results

The adapter returns explicit state (`complete`, `incomplete`, `missing`,
`invalid`), per-person events ready for `assessLeadLifecycle`, a `lifecycles`
view ready for `acquisitionCohortReport`, a review list with reasons, counts
of everything ignored, and aggregated issue counts, so future UI disclosures
can explain exactly why a value is incomplete.

## 5. Recommended future n8n ingestion pattern

Not implemented in this bite; recorded for the next one:

- Nightly pull of new `LeadHistory` and `ContactHistory` rows for the
  confirmed lifecycle field using a `CreatedDate` watermark (modification
  driven, not CampaignMember-creation driven).
- One-time `queryAll()` backfill of everything still inside the retention
  window (or `FieldHistoryArchive` if Field Audit Trail exists) to bootstrap.
- Idempotent upsert on the history record Id into an application-owned
  append-only store, with raw values preserved, an explicit workflow
  timezone, and a completeness signal (newest ingested `CreatedDate`).
- A parallel pull of `Lead.ConvertedContactId` for converted leads to
  maintain the verified person identity map.
- Review-queue output for every row this adapter routes to review.

## 6. Explicit non-changes

No production ingestion was created or modified. No database table, schema
change, migration, RLS change, n8n change, Google Sheet change, or dashboard
wiring exists for this feature yet. The adapter and its tests are pure and
synthetic-only.
