# Salesforce Opportunity sync: read-only dry run (Bite 5C1)

Status: extraction and validation proof only. The workflow template below is
DISABLED, manual-trigger-only, and write-free. Nothing in this bite writes to
Supabase, Salesforce, Google Sheets, or the six `sf_opportunity_*` tables
(applied but still empty), and no Sourced deal or attribution is created.
Companions: `docs/opportunity-stage-history-contract.md` (Bite 5A),
`docs/opportunity-ledger-storage.md` (Bite 5B),
`src/lib/salesforceOpportunitySync.ts` (the pure mapping layer).

## 1. Field API names: confirmed versus unresolved

The report exports carry field LABELS, not API names. Standard Opportunity
fields are confirmed by the Salesforce object model and used directly:

| Field | API name | Status |
|---|---|---|
| Id, Name, AccountId, Account.Name | standard | confirmed |
| RecordType.DeveloperName, RecordType.Name | standard (via RecordTypeId) | confirmed |
| StageName, IsClosed, IsWon | standard | confirmed |
| CreatedDate, LastModifiedDate, SystemModstamp | standard | confirmed |
| Amount, CloseDate | standard | confirmed |
| OwnerId, Owner.Name | standard | confirmed |
| Primary Campaign Source | standard `CampaignId` (+ `Campaign.Name`) | confirmed |
| Currency | standard `CurrencyIsoCode` (multi-currency enabled) | confirmed via runtime describe |

Custom fields CONFIRMED via the runtime FieldDefinition/describe step
(second live run), recorded in `CONFIRMED_CUSTOM_FIELDS`:

| Label | API name |
|---|---|
| Commercial Region | `Commercial_Region__c` |
| HPP Date | `HPP_Date__c` |
| Opportunity Date | `Opportunity_Date__c` |
| Pursuit Date | `Pursuit_Date__c` |
| Sales Development Rep / BDR | `Sales_Development_Rep__c` |
| SaaS Revenue | `SaaS_Revenue__c` |
| SaaS Revenue USD | `SaaS_Revenue_USD__c` |
| GTM - Cube | `GTM_Cube__c` |
| Customer Expansion | `Existing_Customer_or_New_Business__c` |
| Line of Business (LOB) | `Business_Units__c` |

Industry Vertical remains INTENTIONALLY UNRESOLVED: Salesforce carries
three candidates (`Insurance_vertical__c`, `Industry_Vertical__c`,
`Pursuit_Industry_Vertical__c`). The dry run pulls ALL THREE and reports,
per field, the nonblank count and distinct-value count, plus pairwise
overlap (records where both are populated) and disagreement (both
populated with different normalized values), so the canonical field is a
data-informed business decision. No canonical field is chosen yet. The
discovery query stays available for future fields:

```sql
SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked
FROM FieldDefinition
WHERE EntityDefinition.QualifiedApiName = 'Opportunity'
```

Milestone dates are evidence only (Bite 5A derives milestones from
history); Commercial Region feeds the missing_region review seed; the rest
are review-inbox context. Do not commit describe output containing
org-specific field IDs or internal FieldDefinition URLs.

## 2. Current Opportunity query

Included record types by `RecordType.DeveloperName` (authoritative, never
RecordType IDs): `High_Potential_Prospect` (hpp), `Leads` (opp), `Licensing`
(pursuit). Historical aliases remain the Bite 5A mapping.

```sql
SELECT Id, Name, AccountId, Account.Name,
       RecordType.DeveloperName, RecordType.Name,
       StageName, IsClosed, IsWon,
       CreatedDate, LastModifiedDate, SystemModstamp,
       Amount, CurrencyIsoCode, CloseDate, OwnerId, Owner.Name,
       CampaignId, Campaign.Name,
       Commercial_Region__c, HPP_Date__c, Opportunity_Date__c,
       Pursuit_Date__c, Sales_Development_Rep__c,
       SaaS_Revenue__c, SaaS_Revenue_USD__c, GTM_Cube__c,
       Existing_Customer_or_New_Business__c, Business_Units__c,
       Industry_Vertical__c, Pursuit_Industry_Vertical__c
FROM Opportunity
WHERE RecordType.DeveloperName IN ('High_Potential_Prospect', 'Leads', 'Licensing')
  AND (IsClosed = false
       OR CreatedDate >= 2026-01-01T00:00:00Z
       OR SystemModstamp >= 2026-01-01T00:00:00Z
       OR (IsClosed = true AND CloseDate >= 2026-01-01))
ORDER BY SystemModstamp ASC
```

CreatedDate-only filtering is UNSAFE: older Opportunities are still open and
still move during the current year, and a CreatedDate cutoff silently drops
them. The dry run therefore reports separate counts (all open in the three
types, created in 2026, modified in 2026, closed with CloseDate in 2026,
and older-open) so the production initial-backfill scope is chosen by a
human from real numbers, never silently. The count is deliberately named
`closedWithCloseDateInYear`: Salesforce CloseDate is a plan/report field,
not proof of when closure actually happened; true closure timing comes from
Stage history.

First live dry run (2026-07-27, aggregates only): 455 discovered (83 open,
372 closed), 39 created in 2026, 455 modified in 2026, 347 closed with
CloseDate in 2026, and 50 older-open deals that a CreatedDate-only backfill
would have silently dropped. 3,730 history rows (578 record-type, 1,244
stage), 143 forward and 104 backward moves, 13 forward and 9 backward
skips, zero writes attempted.

## 3. History query and batching

Canonical fields, full timestamp, never either duplicated report date
column:

```sql
SELECT Id, OpportunityId, Field, OldValue, NewValue, CreatedDate
FROM OpportunityFieldHistory
WHERE OpportunityId IN (<one batch of ids>)
ORDER BY CreatedDate ASC, Id ASC
```

History is limited to the Opportunities selected by the current query. The
IDs are batched by `chunkOpportunityIds` (default 200 per IN clause, well
under SOQL's clause limits): deduplicated, first-seen order, every unique id
in exactly one batch, no omission, no duplication. `CreatedDate` plus
History `Id` give deterministic TRANSPORT ordering only; Bite 5A's
same-timestamp ambiguity rules remain the authority on business ordering.
The first live dry run CONFIRMED the field tokens: record-type changes
arrive under `Field = 'RecordType'` (578 rows) and stage changes under
`Field = 'StageName'` (1,244 rows). Unknown fields are counted in
`otherFieldRows` for diagnostics and never treated as funnel events.

CRITICAL, confirmed by the first live run: `OpportunityFieldHistory`
returns RecordTypeId VALUES in OldValue/NewValue, not labels or
DeveloperNames (612 unknown record-type values across 578 rows: both sides
unmapped). The workflow therefore performs a read-only RecordType query,
now over ALL objects (`SELECT Id, Name, DeveloperName, SobjectType FROM
RecordType`), and resolves values through a RUNTIME map, RecordType Id to
DeveloperName to normalized stage, indexing both 15- and 18-character id
forms. Querying all objects lets the 34 values that remained unmapped
after the second run be NAMED: the summary's `recordTypeDiagnostics` lists
each unmapped value's Record Type Name, DeveloperName, occurrence count,
old/new/both, and whether runtime metadata confirms it belongs to
Opportunity. Those values are reported for a business decision, never
auto-classified, and RecordType ids are never hardcoded and never appear
in the aggregate summary. Historical labels and DeveloperNames keep
resolving directly; values that remain unresolved stay unknown and require
review. Value diagnostics separate blank historical baselines (a blank
OldValue on an initial row is normal, not unknown), unresolved
Salesforce-ID-shaped values, unmapped nonblank labels, and successful
resolutions, reporting value OCCURRENCES and affected ROWS as distinct
units.

The second run's Stage-label diagnostics produced explicit LEGACY ALIASES,
now in `LEGACY_TERMINAL_STAGE_ALIASES` and `LEGACY_OPEN_STAGE_ALIASES`
(exact matches after whitespace and zero-width-character normalization;
never fuzzy): Recycle/Nurture variants map to nurture, Close-Lost-No
Decision variants to lost, Closed-Won variants to won, CP DQ - Project
Cancelled to disqualified, and twenty-three legacy open labels (Suspect,
Opportunity Assessment, Demo / Oral Presentations, Contract Agreement
variants, and the rest) stay open or reopen. Current aliases are
preserved, and only genuinely unknown nonblank labels remain in the
`unknownLabels` diagnostic.

Same-timestamp co-occurrence is CLASSIFIED, not alarmed, in MUTUALLY
EXCLUSIVE categories satisfying candidateGroups =
harmlessCrossLedgerGroups + uniquelyProvableOrOrderIndependent + the last
category. In the authoritative summary the last category is
`materiallyAmbiguous` (decided by Bite 5A, the only place that creates
ambiguous_same_timestamp review issues). The n8n mirror labels its last
category `remainingForAuthoritativeEvaluation` and never creates review
issues: those groups simply require the authoritative Bite 5A evaluation.

Pagination: the n8n Salesforce node follows `queryMore` for large results;
leave "Return All" on for both queries. API cost is modest (one describe,
one Opportunity query, one history query per 200 ids) and read-only.
Timezone: Salesforce returns UTC timestamps (`+0000`); they are preserved
verbatim end to end and validated by the Bite 5A timestamp rules. Failure
behavior: any node error fails the manual execution loudly; there is no
retry loop and nothing to roll back because nothing writes. Re-running the
dry run is always safe.

## 4. Dry-run output

The final summary emits AGGREGATES ONLY (shape:
`DryRunSummary` in the mapping module): execution timestamp, discovery and
scope counts, counts by DeveloperName and by normalized current stage,
history row counts (record-type / stage / other), exact duplicates,
conflicting duplicate History IDs, invalid timestamps, unknown record-type
and Stage values, forward/backward moves and skips, same-timestamp
ambiguities, opportunities requiring review with counts by issue, and the
constants `dry_run: true`, `writes_attempted: 0`. No names, accounts,
owners, campaigns, Salesforce IDs, emails, or raw records appear in the
summary. Raw records exist only transiently inside the user-controlled n8n
execution.

The workflow's summary node computes transport-level aggregates and
per-row movement facts. The committed `buildDryRunSummary` is the
AUTHORITATIVE version of the full summary: it runs the real Bite 5A
derivation and Bite 5B review seeding, is what Bite 5C2's server-side
ingestion will call, and is what the tests exercise. To validate a live
pull fully, export the two raw arrays from the n8n execution locally and
feed them to `buildDryRunSummary` (a local uncommitted script; see the
run instructions in the Bite 5C1 report).

## 4b. Business-scope diagnostic (diagnostic groups only)

The dry run continues to DISCOVER every Opportunity in the three included
record types; nothing is excluded, and no inclusion decision is made or
applied. These are DIAGNOSTIC GROUPS for a business decision:

- Customer Expansion (`Existing_Customer_or_New_Business__c`): new_logo,
  existing_customer_or_expansion, other (nonblank but unrecognized, kept
  visible so the value map is extended deliberately), missing.
- Sales Development Rep (`Sales_Development_Rep__c`, a Lookup(User) whose
  value is a Salesforce USER ID): approved_bdr when the id matches a
  resolved approved User Id (15- and 18-character forms), other_sdr for
  any other id, missing when blank. The field is never compared to names;
  a BDR name string cannot match an id.
- Creator (`CreatedById` with safe related User metadata): approved_bdr,
  other_creator, missing. Diagnostics only; no channel, including Sales
  Generated, is ever inferred from CreatedBy.
- Campaign evidence (`CampaignId`): primary_campaign_present or missing.
- Current normalized record type: hpp, opp, pursuit.

Aggregate outputs: totals for each dimension plus the cross-tabs New Logo
by SDR category, New Logo by campaign presence, SDR by creator category,
record type by Customer Expansion, and record type by SDR category.

The workflow executes as one DETERMINISTIC SERIAL CHAIN (Manual Trigger,
BDR config, User resolution, BDR VALIDATION, describe, RecordTypes,
Opportunities, batch, FieldHistory, Aggregate, GUARD), so every node the
Aggregate references through a cross-node expression is a guaranteed
executed ancestor; no dependency relies on parallel-branch timing. Only
the private creator diagnostic branches off (from Opportunities), because
the Aggregate does not depend on it. Static graph tests enforce the
ancestry and that GUARD is the ONLY successful terminal of the shared
path.

Expected execution cardinality, enforced with Execute Once on the global
queries because n8n otherwise runs a node once per upstream item (the
live amplification: 341 describe rows caused 11,935 RecordType rows and
began amplifying the Opportunity query before the run was cancelled; no
writes occurred):

- Describe: ONE Salesforce query, many field rows.
- RecordTypes: ONE Salesforce query (`executeOnce`), many rows.
- Opportunities: ONE Salesforce query (`executeOnce`) with Salesforce
  pagination.
- FieldHistory: one query PER 200-Opportunity-ID batch (deliberately not
  Execute Once).

Runtime guards back this up: a duplicate RecordType or Opportunity Id in
a global query's output fails the run with a clear QUERY AMPLIFICATION
error, in the batch node, the Aggregate, and the pure mapping layer.
Duplicates are never silently deduplicated into counts or history
batching.

A dry run must never report success without reaching GUARD. All five
Salesforce read nodes set alwaysOutputData so a zero-item result cannot
silently end the run (n8n otherwise stops at the empty node and reports
success); the always-output empty sentinel is filtered before anything is
counted as a record. The dedicated VALIDATE node requires each privately
configured BDR name to resolve to exactly one active Salesforce User and
otherwise fails with a clear message; it passes ONLY the approved User
Ids downstream, and the Aggregate consumes them without repeating name
resolution. The Aggregate then fails fast when required Opportunity
fields are absent from the describe, when any of the three included
DeveloperNames is missing from RecordTypes, or when the Opportunity query
returns zero records. Zero HISTORY rows can be legitimate and continue to
GUARD.

The approved BDR list is PRIVATE RUNTIME CONFIGURATION: the committed
template carries `REPLACE_WITH_BDR_NAME_1/2` placeholders, and the real
names are entered only inside the user's n8n (see the config node). Names
resolve to Salesforce User Ids through a read-only User query restricted
to active users; a configured name resolving to zero or multiple active
users FAILS the run rather than guessing. No employee names, emails, or
User Ids appear in committed files, tests, docs, or the shared GUARD
aggregates. A separate, clearly-labeled PRIVATE n8n-only node lists
creators by display name with counts for the user's own understanding; it
must never be committed or shared outside n8n.

## 5. Incremental watermark plan (for 5C2, not implemented here)

Two independent high-water marks, matching the `sf_opportunity_sync_runs`
columns already applied:

- `Opportunity.SystemModstamp`: each incremental run pulls included
  Opportunities with `SystemModstamp > watermark_system_modstamp`, catching
  every field change and record-type move on old and new deals alike.
- `OpportunityFieldHistory.CreatedDate`: each run pulls history rows with
  `CreatedDate > watermark_history_created_at` for the included deals,
  appending only-new events idempotently on the History ID.

Watermarks advance only after a successful run, use full timestamptz
values, and are never derived from either report date column. The one-time
backfill (scope chosen from this dry run's counts) seeds both marks.

## 6. What must be approved before 5C2

1. The confirmed custom-field API names from the describe step.
2. The exact history Field tokens observed for record type and stage.
3. The initial-backfill scope, chosen from the dry run's counts.
4. The dry run's review-issue counts (how much lands in the inbox).
5. Whether CurrencyIsoCode exists (multi-currency).
6. The ingestion identity (service role) and where the n8n workflow runs.

Only after those approvals does 5C2 wire ingestion into the applied
`sf_opportunity_*` tables. Until then no data is written anywhere: 5C1
exists precisely to make 5C2 boring.

## 7. Workflow template (sanitized, disabled)

The template below is the committed, tested source of truth. It contains a
Manual Trigger only (no Schedule Trigger), read-only Salesforce query nodes,
a mapping/summary Code node, and a final guard that fails the execution
unless the summary proves `dry_run: true` and `writes_attempted: 0`. It is
exported `"active": false`, embeds no credentials (placeholders only), no
pinned data, and no static Salesforce IDs. The repository has no dedicated
workflow-template directory, so this documented block is canonical; a
convenience import file generated from it lives outside the repository.
Static tests parse this block and assert there are no write-capable nodes
and no embedded secrets.

```json
{
  "name": "[Sourced] - SFDC Opportunity Dry Run - DISABLED",
  "active": false,
  "settings": {
    "executionOrder": "v1"
  },
  "nodes": [
    {
      "id": "n1",
      "name": "Manual Trigger - DRY RUN ONLY",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [
        0,
        0
      ],
      "parameters": {}
    },
    {
      "id": "n2",
      "name": "READ ONLY: Describe Opportunity fields",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        720,
        0
      ],
      "credentials": {
        "salesforceOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "REPLACE_WITH_SFDC_CREDENTIAL_NAME"
        }
      },
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Opportunity'"
      },
      "alwaysOutputData": true
    },
    {
      "id": "n3",
      "name": "READ ONLY: Fetch included Opportunities",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        1080,
        0
      ],
      "credentials": {
        "salesforceOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "REPLACE_WITH_SFDC_CREDENTIAL_NAME"
        }
      },
      "parameters": {
        "resource": "search",
        "query": "SELECT Id, Name, AccountId, Account.Name, RecordType.DeveloperName, RecordType.Name, StageName, IsClosed, IsWon, CreatedDate, LastModifiedDate, SystemModstamp, CreatedById, CreatedBy.Name, Amount, CurrencyIsoCode, CloseDate, OwnerId, Owner.Name, CampaignId, Campaign.Name, Commercial_Region__c, HPP_Date__c, Opportunity_Date__c, Pursuit_Date__c, Sales_Development_Rep__c, SaaS_Revenue__c, SaaS_Revenue_USD__c, GTM_Cube__c, Existing_Customer_or_New_Business__c, Business_Units__c, Insurance_vertical__c, Industry_Vertical__c, Pursuit_Industry_Vertical__c FROM Opportunity WHERE RecordType.DeveloperName IN ('High_Potential_Prospect', 'Leads', 'Licensing') AND (IsClosed = false OR CreatedDate >= 2026-01-01T00:00:00Z OR SystemModstamp >= 2026-01-01T00:00:00Z OR (IsClosed = true AND CloseDate >= 2026-01-01)) ORDER BY SystemModstamp ASC"
      },
      "alwaysOutputData": true,
      "executeOnce": true
    },
    {
      "id": "n4",
      "name": "DRY RUN: Batch Opportunity IDs (no writes)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1260,
        0
      ],
      "parameters": {
        "jsCode": "// READ ONLY. Emit one item per batch of 200 unique Opportunity ids for\n// the history IN clause. A duplicate Opportunity Id in the query output\n// means a global query executed more than once (amplification): FAIL\n// loudly, never silently deduplicate it away.\nconst seen = new Set();\nconst ids = [];\nfor (const item of $input.all()) {\n  const id = String(item.json.Id || '').trim();\n  if (!id) continue;\n  if (seen.has(id)) {\n    throw new Error('QUERY AMPLIFICATION: duplicate Opportunity Id in query output; a global query executed more than once per run.');\n  }\n  seen.add(id);\n  ids.push(id);\n}\nconst batches = [];\nfor (let i = 0; i < ids.length; i += 200) {\n  const batch = ids.slice(i, i + 200);\n  batches.push({ json: { inClause: batch.map((x) => `'${x}'`).join(',') } });\n}\nreturn batches.length ? batches : [{ json: { inClause: \"''\" } }];"
      }
    },
    {
      "id": "n5",
      "name": "READ ONLY: Fetch OpportunityFieldHistory",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        1440,
        0
      ],
      "credentials": {
        "salesforceOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "REPLACE_WITH_SFDC_CREDENTIAL_NAME"
        }
      },
      "parameters": {
        "resource": "search",
        "query": "=SELECT Id, OpportunityId, Field, OldValue, NewValue, CreatedDate FROM OpportunityFieldHistory WHERE OpportunityId IN ({{ $json.inClause }}) ORDER BY CreatedDate ASC, Id ASC"
      },
      "alwaysOutputData": true
    },
    {
      "id": "n6",
      "name": "DRY RUN: Aggregate summary (no writes, no identifiers)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1620,
        0
      ],
      "parameters": {
        "jsCode": "// READ ONLY / DRY RUN. Transport-level aggregates only; this mirror NEVER\n// creates ambiguous_same_timestamp review issues. Only the authoritative\n// Bite 5A calculation (buildDryRunSummary in\n// src/lib/salesforceOpportunitySync.ts) may do that. NO identifier, name of\n// a deal/account/owner/campaign, or RecordType Id leaves this node; record\n// type NAMES and Stage LABELS are configuration metadata and may appear.\n// Always-output sentinels (empty objects) are never counted as records.\nconst real = (items, key) => items.map((i) => i.json).filter((x) => x && x[key] !== undefined);\nconst opps = real($('READ ONLY: Fetch included Opportunities').all(), 'Id');\nconst hist = real($('READ ONLY: Fetch OpportunityFieldHistory').all(), 'Id');\nconst rts = real($('READ ONLY: Fetch Opportunity RecordTypes').all(), 'Id');\nconst describeRows = real($('READ ONLY: Describe Opportunity fields').all(), 'QualifiedApiName');\n// FAIL FAST: a dry run must never report success without reaching\n// GUARD on real data. Zero history rows may be valid; the rest is not.\nconst REQUIRED_FIELDS = ['StageName', 'IsClosed', 'IsWon', 'CreatedDate', 'SystemModstamp', 'CloseDate', 'CampaignId', 'Sales_Development_Rep__c', 'Existing_Customer_or_New_Business__c', 'Commercial_Region__c'];\nconst describedNames = new Set(describeRows.map((f) => f.QualifiedApiName));\nconst missingFields = REQUIRED_FIELDS.filter((f) => !describedNames.has(f));\nif (missingFields.length) throw new Error('DESCRIBE: required Opportunity fields absent: ' + missingFields.join(', '));\nconst devNames = new Set(rts.map((r) => r.DeveloperName));\nfor (const dn of ['High_Potential_Prospect', 'Leads', 'Licensing']) {\n  if (!devNames.has(dn)) throw new Error('RECORD TYPES: included DeveloperName absent: ' + dn);\n}\nif (opps.length === 0) throw new Error('OPPORTUNITIES: query returned zero records; refusing to report an empty dry run as success.');\n// Amplification guards: a duplicate Id in a GLOBAL query's output means\n// the query executed more than once per run. Fail, never dedupe.\nconst dupCheck = (list, label) => {\n  const seenIds = new Set();\n  for (const x of list) {\n    const id = String(x.Id);\n    if (seenIds.has(id)) throw new Error('QUERY AMPLIFICATION: duplicate ' + label + ' Id in query output; a global query executed more than once per run.');\n    seenIds.add(id);\n  }\n};\ndupCheck(rts, 'RecordType');\ndupCheck(opps, 'Opportunity');\nconst YEAR_START = '2026-01-01';\nconst INCLUDED = { High_Potential_Prospect: 'hpp', Leads: 'opp', Licensing: 'pursuit' };\nconst RT_MAP = { 'High Potential Prospect': 'hpp', High_Potential_Prospect: 'hpp', Opportunity: 'opp', Leads: 'opp', 'Sales Accepted Opportunity': 'opp', Pursuit: 'pursuit', Licensing: 'pursuit', 'Sales Qualified Opportunity': 'pursuit', Nurture: 'out_of_scope' };\nconst RANK = { hpp: 1, opp: 2, pursuit: 3 };\nconst TERMINAL = ['100) Closed-Won', 'Closed-Lost-Competitor', 'Closed-Lost-InHouse', 'Closed-Disqualified', 'Closed-Nurture', '0. Recycle/Nurture', 'Recycle / Nurture', '0) Recycle / Nurture', 'Close-Lost-No Decision', 'Close-No Decision', 'Closed-Won', '9) Closed-Won', 'CP DQ - Project Cancelled'];\nconst OPEN = ['1) Suspect', '2) Opportunity Assesment', '3) Qualification', '4) Discovery', '5) Pitching', '6) POC', '7) Proposal', '8) Negotiation', '10) Awaiting Execution', 'Suspect', '1. Suspect', 'Opportunity Assessment', '2. Opportunity Assessment', 'Qualification', '1) Qualification', 'Demo / Oral Presentations', 'Pitching', '3) Pitching', 'Proposal', 'Discovery', '2) Discovery', 'Initial Proposal / Term Sheet', 'Proof of Concept', 'Negotiation', 'Risk Assessment', '4.1) Pursuit Evaluation', '9) Contract Agreement', 'Contract Agreement / Awaiting Execution', 'Awaiting Execution', 'Contract Creation', 'Contract Agreement', '7) Contract Agreement'];\nconst IV_CANDIDATES = ['Industry_Vertical__c', 'Pursuit_Industry_Vertical__c'];\nconst ID_SHAPE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;\nconst norm = (v) => String(v == null ? '' : v).replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();\nconst validTs = (v) => /^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d/.test(String(v || ''));\n// Runtime RecordType map over ALL objects so non-Opportunity or retired\n// types can be NAMED in diagnostics. Ids never leave this node.\nconst idMap = {};\nfor (const rt of rts) {\n  const id = norm(rt.Id); const dev = norm(rt.DeveloperName);\n  if (!id || !dev) continue;\n  const entry = { dev, name: norm(rt.Name) || dev, isOpp: norm(rt.SobjectType) === 'Opportunity' };\n  idMap[id] = entry;\n  if (id.length === 18) idMap[id.slice(0, 15)] = entry;\n}\nconst rtValueCounts = { resolvedViaIdMap: 0, resolvedAsKnownValue: 0, blankBaseline: 0, unresolvedIdShaped: 0, unmappedNonblankLabel: 0, affectedRows: 0 };\nconst rtDiagnostics = new Map();\nconst noteRt = (key, name, dev, isOpp, side) => {\n  const d = rtDiagnostics.get(key) || { name, developerName: dev, occurrences: 0, old: false, new: false, confirmedOpportunityType: isOpp };\n  d.occurrences += 1; d[side] = true; rtDiagnostics.set(key, d);\n};\nconst resolveRt = (raw, side) => {\n  const v = norm(raw);\n  if (!v) { rtValueCounts.blankBaseline += 1; return null; }\n  const ref = idMap[v];\n  if (ref !== undefined) {\n    rtValueCounts.resolvedViaIdMap += 1;\n    if (RT_MAP[ref.dev] === undefined) noteRt(ref.dev, ref.name, ref.dev, ref.isOpp, side);\n    return ref.dev;\n  }\n  if (RT_MAP[v] !== undefined) { rtValueCounts.resolvedAsKnownValue += 1; return v; }\n  if (ID_SHAPE.test(v)) { rtValueCounts.unresolvedIdShaped += 1; return v; }\n  rtValueCounts.unmappedNonblankLabel += 1;\n  noteRt(v, v, null, false, side);\n  return v;\n};\nconst scope = { discovered: opps.length, openNow: 0, closedNow: 0, createdInYear: 0, modifiedInYear: 0, closedWithCloseDateInYear: 0, olderOpen: 0 };\nconst byDev = {}; const byStage = { hpp: 0, opp: 0, pursuit: 0, out_of_scope: 0, unknown: 0 };\nconst ivCoverage = {};\nfor (const f of IV_CANDIDATES) ivCoverage[f] = 0;\nfor (const o of opps) {\n  const dn = (o.RecordType && o.RecordType.DeveloperName) || 'missing';\n  byDev[dn] = (byDev[dn] || 0) + 1;\n  const st = INCLUDED[dn] || 'unknown';\n  byStage[st] = (byStage[st] || 0) + 1;\n  for (const f of IV_CANDIDATES) { if (norm(o[f])) ivCoverage[f] += 1; }\n  const created = String(o.CreatedDate || '').slice(0, 10);\n  const modified = String(o.SystemModstamp || o.LastModifiedDate || '').slice(0, 10);\n  if (o.IsClosed === false) scope.openNow += 1;\n  if (o.IsClosed === true) scope.closedNow += 1;\n  if (created >= YEAR_START) scope.createdInYear += 1;\n  if (modified >= YEAR_START) scope.modifiedInYear += 1;\n  if (o.IsClosed === true && String(o.CloseDate || '') >= YEAR_START) scope.closedWithCloseDateInYear += 1;\n  if (o.IsClosed === false && created && created < YEAR_START) scope.olderOpen += 1;\n}\nconst byId = new Map();\nlet exactDuplicates = 0; const conflicting = new Set();\nlet invalidTimestamps = 0; let rtRows = 0; let stageRows = 0;\nlet fwd = 0; let back = 0; let fskip = 0; let bskip = 0;\nconst stageValueCounts = { resolved: 0, blankBaseline: 0, unknownNonblank: 0, affectedRows: 0 };\nconst unknownStageLabels = new Map();\nconst stamps = new Map();\nfor (const h of hist) {\n  const key = String(h.Id || '');\n  const content = [h.OpportunityId, h.Field, h.OldValue, h.NewValue, h.CreatedDate].join(' ');\n  if (byId.has(key)) {\n    if (byId.get(key) === content) exactDuplicates += 1; else conflicting.add(key);\n    continue;\n  }\n  byId.set(key, content);\n  if (!validTs(h.CreatedDate)) { invalidTimestamps += 1; continue; }\n  const tsKey = h.OpportunityId + '|' + h.CreatedDate;\n  if (h.Field === 'RecordType') {\n    rtRows += 1;\n    const before = rtValueCounts.unresolvedIdShaped + rtValueCounts.unmappedNonblankLabel;\n    const from = RT_MAP[resolveRt(h.OldValue, 'old')];\n    const to = RT_MAP[resolveRt(h.NewValue, 'new')];\n    if (rtValueCounts.unresolvedIdShaped + rtValueCounts.unmappedNonblankLabel > before) rtValueCounts.affectedRows += 1;\n    if (RANK[from] && RANK[to]) {\n      const d = RANK[to] - RANK[from];\n      if (d > 0) { fwd += 1; if (d === 2) fskip += 1; }\n      if (d < 0) { back += 1; if (d === -2) bskip += 1; }\n    }\n    const c = stamps.get(tsKey) || { rt: [], stage: 0 };\n    c.rt.push({ from, to }); stamps.set(tsKey, c);\n  } else if (h.Field === 'StageName') {\n    stageRows += 1;\n    const c = stamps.get(tsKey) || { rt: [], stage: 0 };\n    c.stage += 1; stamps.set(tsKey, c);\n    let rowAffected = false;\n    for (const side of ['old', 'new']) {\n      const s = norm(side === 'old' ? h.OldValue : h.NewValue);\n      if (!s) { stageValueCounts.blankBaseline += 1; continue; }\n      if (TERMINAL.includes(s) || OPEN.includes(s)) { stageValueCounts.resolved += 1; continue; }\n      stageValueCounts.unknownNonblank += 1; rowAffected = true;\n      const e = unknownStageLabels.get(s) || { occurrences: 0, old: false, new: false };\n      e.occurrences += 1; e[side] = true; unknownStageLabels.set(s, e);\n    }\n    if (rowAffected) stageValueCounts.affectedRows += 1;\n  }\n}\n// MUTUALLY EXCLUSIVE same-timestamp categories:\n// candidateGroups = harmlessCrossLedgerGroups\n//   + uniquelyProvableOrOrderIndependent + remainingForAuthoritativeEvaluation.\nlet candidateGroups = 0; let harmless = 0; let provable = 0; let remaining = 0;\nfor (const c of stamps.values()) {\n  if (c.rt.length + c.stage < 2) continue;\n  candidateGroups += 1;\n  if (c.rt.length < 2) { harmless += 1; continue; }\n  if (c.rt.length === 2 && (c.rt[0].to === c.rt[1].from || c.rt[1].to === c.rt[0].from)) provable += 1;\n  else remaining += 1;\n}\nconst stageLabelDiagnostics = [...unknownStageLabels.entries()]\n  .map(([label, x]) => ({ label, occurrences: x.occurrences, seenAs: x.old && x.new ? 'both' : x.old ? 'old' : 'new' }))\n  .sort((a, b) => b.occurrences - a.occurrences || a.label.localeCompare(b.label));\nconst rtDiagList = [...rtDiagnostics.values()]\n  .map((d) => ({ name: d.name, developerName: d.developerName, occurrences: d.occurrences, seenAs: d.old && d.new ? 'both' : d.old ? 'old' : 'new', confirmedOpportunityType: d.confirmedOpportunityType }))\n  .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));\n\n// ---- Business-scope diagnostic (DIAGNOSTIC GROUPS ONLY; no inclusion or\n// exclusion decision is made or applied) ----\n// Approved ids come from the upstream validator; this node never repeats\n// name resolution and never outputs names or ids.\nconst validation = $('VALIDATE: approved BDR resolution').first().json;\nconst approvedIds = new Set(validation.approvedUserIds || []);\nconst EXPANSION_MAP = { 'New Logo': 'new_logo', 'New Business': 'new_logo', 'Existing Customer': 'existing_customer_or_expansion', 'Expansion': 'existing_customer_or_expansion', 'Existing Customer or Expansion': 'existing_customer_or_expansion', 'Customer Expansion': 'existing_customer_or_expansion' };\nconst scopeDiag = {\n  note: 'Diagnostic groups only. No inclusion or exclusion decision is made or applied here.',\n  bdrConfigured: validation.bdrConfigured === true,\n  customerExpansion: { new_logo: 0, existing_customer_or_expansion: 0, other: 0, missing: 0 },\n  sdr: { approved_bdr: 0, other_sdr: 0, missing: 0 },\n  creator: { approved_bdr: 0, other_creator: 0, missing: 0 },\n  campaign: { primary_campaign_present: 0, primary_campaign_missing: 0 },\n  crossTabs: {\n    newLogoBySdr: { approved_bdr: 0, other_sdr: 0, missing: 0 },\n    newLogoByCampaign: { primary_campaign_present: 0, primary_campaign_missing: 0 },\n    sdrByCreator: { approved_bdr: { approved_bdr: 0, other_creator: 0, missing: 0 }, other_sdr: { approved_bdr: 0, other_creator: 0, missing: 0 }, missing: { approved_bdr: 0, other_creator: 0, missing: 0 } },\n    recordTypeByExpansion: {},\n    recordTypeBySdr: {}\n  }\n};\nconst IV_ALL = ['Insurance_vertical__c', 'Industry_Vertical__c', 'Pursuit_Industry_Vertical__c'];\nconst ivValues = {}; const ivNonblank = {};\nfor (const f of IV_ALL) { ivValues[f] = new Set(); ivNonblank[f] = 0; }\nconst ivPairCounters = [];\nfor (let i = 0; i < IV_ALL.length; i += 1) for (let j = i + 1; j < IV_ALL.length; j += 1) ivPairCounters.push({ fields: [IV_ALL[i], IV_ALL[j]], bothPopulated: 0, disagreements: 0 });\nfor (const o of opps) {\n  const expRaw = norm(o.Existing_Customer_or_New_Business__c);\n  const expCat = !expRaw ? 'missing' : (EXPANSION_MAP[expRaw] || 'other');\n  // Sales_Development_Rep__c is Lookup(User): the value is a USER ID.\n  const sdrId = norm(o.Sales_Development_Rep__c);\n  const sdrCat = !sdrId ? 'missing' : (approvedIds.has(sdrId) ? 'approved_bdr' : 'other_sdr');\n  // Diagnostic only: no channel (including Sales Generated) is inferred\n  // from the creator.\n  const creatorId = norm(o.CreatedById);\n  const creatorCat = !creatorId ? 'missing' : (approvedIds.has(creatorId) ? 'approved_bdr' : 'other_creator');\n  const campCat = norm(o.CampaignId) ? 'primary_campaign_present' : 'primary_campaign_missing';\n  const rt = INCLUDED[(o.RecordType && o.RecordType.DeveloperName) || ''] || 'unknown';\n  scopeDiag.customerExpansion[expCat] += 1;\n  scopeDiag.sdr[sdrCat] += 1;\n  scopeDiag.creator[creatorCat] += 1;\n  scopeDiag.campaign[campCat] += 1;\n  if (expCat === 'new_logo') { scopeDiag.crossTabs.newLogoBySdr[sdrCat] += 1; scopeDiag.crossTabs.newLogoByCampaign[campCat] += 1; }\n  scopeDiag.crossTabs.sdrByCreator[sdrCat][creatorCat] += 1;\n  if (!scopeDiag.crossTabs.recordTypeByExpansion[rt]) scopeDiag.crossTabs.recordTypeByExpansion[rt] = { new_logo: 0, existing_customer_or_expansion: 0, other: 0, missing: 0 };\n  scopeDiag.crossTabs.recordTypeByExpansion[rt][expCat] += 1;\n  if (!scopeDiag.crossTabs.recordTypeBySdr[rt]) scopeDiag.crossTabs.recordTypeBySdr[rt] = { approved_bdr: 0, other_sdr: 0, missing: 0 };\n  scopeDiag.crossTabs.recordTypeBySdr[rt][sdrCat] += 1;\n  for (const f of IV_ALL) { const v = norm(o[f]); if (v) { ivNonblank[f] += 1; ivValues[f].add(v); } }\n  for (const pc of ivPairCounters) {\n    const va = norm(o[pc.fields[0]]); const vb = norm(o[pc.fields[1]]);\n    if (va && vb) { pc.bothPopulated += 1; if (va !== vb) pc.disagreements += 1; }\n  }\n}\nconst ivDiag = {\n  candidates: IV_ALL,\n  perField: Object.fromEntries(IV_ALL.map((f) => [f, { nonblank: ivNonblank[f], distinctValues: ivValues[f].size }])),\n  pairwise: ivPairCounters\n};\n\nreturn [{ json: {\n  executedAt: new Date().toISOString(),\n  dry_run: true,\n  writes_attempted: 0,\n  scope,\n  countsByRecordTypeDeveloperName: byDev,\n  countsByNormalizedCurrentStage: byStage,\n  history: { rowsDiscovered: hist.length, recordTypeRows: rtRows, stageRows, otherFieldRows: hist.length - rtRows - stageRows, exactDuplicates, conflictingDuplicateHistoryIds: conflicting.size, invalidTimestamps, recordTypeValues: rtValueCounts, recordTypeDiagnostics: rtDiagList, stageValues: { ...stageValueCounts, unknownLabels: stageLabelDiagnostics } },\n  movement: { forwardMoves: fwd, backwardMoves: back, forwardSkips: fskip, backwardSkips: bskip, sameTimestamp: { candidateGroups, harmlessCrossLedgerGroups: harmless, uniquelyProvableOrOrderIndependent: provable, remainingForAuthoritativeEvaluation: remaining } },\n  industryVertical: ivDiag,\n  businessScope: scopeDiag,\n  note: 'Mirror aggregates; remainingForAuthoritativeEvaluation groups REQUIRE the authoritative Bite 5A evaluation (buildDryRunSummary) and are not review issues yet. The mirror never creates ambiguous_same_timestamp issues.'\n} }];"
      }
    },
    {
      "id": "n7",
      "name": "GUARD: fail unless dry run with zero writes",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1800,
        0
      ],
      "parameters": {
        "jsCode": "// Final safety guard. This execution must prove itself a write-free dry\n// run; anything else fails loudly. Static repository tests additionally\n// assert this template contains no write-capable destination node types,\n// so introducing one fails CI before it can ever run.\nconst s = $input.first().json;\nif (s.dry_run !== true) throw new Error('GUARD: summary is not marked dry_run');\nif (s.writes_attempted !== 0) throw new Error('GUARD: writes were attempted in a dry run');\nreturn $input.all();"
      }
    },
    {
      "id": "n8",
      "name": "READ ONLY: Fetch Opportunity RecordTypes",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        900,
        0
      ],
      "credentials": {
        "salesforceOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "REPLACE_WITH_SFDC_CREDENTIAL_NAME"
        }
      },
      "parameters": {
        "resource": "search",
        "query": "SELECT Id, Name, DeveloperName, SobjectType FROM RecordType"
      },
      "alwaysOutputData": true,
      "executeOnce": true
    },
    {
      "id": "n9",
      "name": "CONFIG (PRIVATE): approved BDR names",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        180,
        0
      ],
      "parameters": {
        "jsCode": "// PRIVATE RUNTIME CONFIGURATION. Enter the two approved BDR full names\n// here, inside your n8n only. NEVER export, commit, or share this\n// workflow with real names filled in; the committed template carries\n// placeholders only.\nreturn [{ json: { approvedBdrNames: ['REPLACE_WITH_BDR_NAME_1', 'REPLACE_WITH_BDR_NAME_2'] } }];"
      }
    },
    {
      "id": "n10",
      "name": "READ ONLY: Resolve approved BDR users",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        360,
        0
      ],
      "credentials": {
        "salesforceOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "REPLACE_WITH_SFDC_CREDENTIAL_NAME"
        }
      },
      "parameters": {
        "resource": "search",
        "query": "=SELECT Id, Name, IsActive FROM User WHERE IsActive = true AND Name IN ({{ $json.approvedBdrNames.filter(n => !String(n).startsWith('REPLACE_WITH_')).map(n => \"'\" + String(n).replace(/'/g, \"\\\\'\") + \"'\").join(',') || \"''\" }})"
      },
      "alwaysOutputData": true
    },
    {
      "id": "n11",
      "name": "PRIVATE (n8n only): creators by name - DO NOT SHARE",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1260,
        200
      ],
      "parameters": {
        "jsCode": "// PRIVATE n8n-only diagnostic: who creates Opportunities, by display\n// name, with counts. For the user's eyes inside n8n ONLY. Never commit,\n// paste into tests or docs, or include in the shared GUARD aggregates.\nconst counts = new Map();\nfor (const item of $input.all()) {\n  const name = (item.json.CreatedBy && item.json.CreatedBy.Name) || '(missing creator)';\n  counts.set(name, (counts.get(name) || 0) + 1);\n}\nreturn [...counts.entries()]\n  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))\n  .map(([creatorName, count]) => ({ json: { PRIVATE_do_not_share: true, creatorName, count } }));"
      }
    },
    {
      "id": "n12",
      "name": "VALIDATE: approved BDR resolution",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        540,
        0
      ],
      "parameters": {
        "jsCode": "// VALIDATE: approved BDR resolution. Runs even when the User query\n// returned zero rows (alwaysOutputData upstream) and fails LOUDLY instead\n// of letting n8n end the run as a false success.\nconst norm = (v) => String(v == null ? '' : v).replace(/\\u200B|\\u200C|\\u200D|\\uFEFF/g, '').trim();\nconst configured = ($('CONFIG (PRIVATE): approved BDR names').first().json.approvedBdrNames || [])\n  .map((n) => norm(n))\n  .filter((n) => n && !n.startsWith('REPLACE_WITH_'));\n// Ignore the always-output empty sentinel; only rows with an Id are users.\nconst users = $input.all().map((i) => i.json).filter((u) => u && u.Id !== undefined);\nconst approvedUserIds = [];\nfor (const name of configured) {\n  const matches = users.filter((u) => u.IsActive !== false && norm(u.Name) === name);\n  if (matches.length !== 1) {\n    throw new Error('BDR CONFIG: configured BDR name resolved to ' + matches.length + ' active Salesforce users; verify the exact Salesforce User display name.');\n  }\n  approvedUserIds.push(String(matches[0].Id));\n  if (String(matches[0].Id).length === 18) approvedUserIds.push(String(matches[0].Id).slice(0, 15));\n}\n// Approved USER IDS flow downstream for classification only; neither names\n// nor ids ever enter the GUARD aggregate output.\nreturn [{ json: { approvedUserIds, bdrConfigured: configured.length > 0 } }];"
      }
    }
  ],
  "connections": {
    "Manual Trigger - DRY RUN ONLY": {
      "main": [
        [
          {
            "node": "CONFIG (PRIVATE): approved BDR names",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "CONFIG (PRIVATE): approved BDR names": {
      "main": [
        [
          {
            "node": "READ ONLY: Resolve approved BDR users",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "READ ONLY: Resolve approved BDR users": {
      "main": [
        [
          {
            "node": "VALIDATE: approved BDR resolution",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "READ ONLY: Describe Opportunity fields": {
      "main": [
        [
          {
            "node": "READ ONLY: Fetch Opportunity RecordTypes",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "READ ONLY: Fetch Opportunity RecordTypes": {
      "main": [
        [
          {
            "node": "READ ONLY: Fetch included Opportunities",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "READ ONLY: Fetch included Opportunities": {
      "main": [
        [
          {
            "node": "DRY RUN: Batch Opportunity IDs (no writes)",
            "type": "main",
            "index": 0
          },
          {
            "node": "PRIVATE (n8n only): creators by name - DO NOT SHARE",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DRY RUN: Batch Opportunity IDs (no writes)": {
      "main": [
        [
          {
            "node": "READ ONLY: Fetch OpportunityFieldHistory",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "READ ONLY: Fetch OpportunityFieldHistory": {
      "main": [
        [
          {
            "node": "DRY RUN: Aggregate summary (no writes, no identifiers)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DRY RUN: Aggregate summary (no writes, no identifiers)": {
      "main": [
        [
          {
            "node": "GUARD: fail unless dry run with zero writes",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "VALIDATE: approved BDR resolution": {
      "main": [
        [
          {
            "node": "READ ONLY: Describe Opportunity fields",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  }
}
```
