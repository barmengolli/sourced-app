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
| CurrencyIsoCode | standard, EXISTS ONLY with multi-currency enabled | unresolved: confirm before adding to SOQL |

Custom fields remain UNRESOLVED and are never guessed. The workflow's first
node discovers them read-only via `FieldDefinition`:

```sql
SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked
FROM FieldDefinition
WHERE EntityDefinition.QualifiedApiName = 'Opportunity'
```

Filter the output (in the discovery node's Code step) to the labels:
Commercial Region, HPP Date, Opportunity Date, Pursuit Date, BDR / BDR
Contact, SaaS Revenue (and its currency), GTM - Cube, Customer Expansion,
Industry Vertical, Line of Business (LOB). Record for each: confirmed label,
confirmed API name, field type, whether queryable, and whether required for
first ingestion (Commercial Region: yes, review inbox seeds missing_region;
milestone dates: evidence only, Bite 5A derives milestones from history; the
rest: review-inbox context only). Do not commit describe output containing
org-specific IDs. Until confirmed, the Opportunity SOQL uses standard fields
only.

## 2. Current Opportunity query

Included record types by `RecordType.DeveloperName` (authoritative, never
RecordType IDs): `High_Potential_Prospect` (hpp), `Leads` (opp), `Licensing`
(pursuit). Historical aliases remain the Bite 5A mapping.

```sql
SELECT Id, Name, AccountId, Account.Name,
       RecordType.DeveloperName, RecordType.Name,
       StageName, IsClosed, IsWon,
       CreatedDate, LastModifiedDate, SystemModstamp,
       Amount, CloseDate, OwnerId, Owner.Name,
       CampaignId, Campaign.Name
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
types, created in 2026, modified in 2026, closed in 2026, and older-open) so
the production initial-backfill scope is chosen by a human from real
numbers, never silently.

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
Record-type changes are expected under `Field = 'RecordType'` and stage
changes under `Field = 'StageName'` via the API (the report showed labels);
the dry run's field distribution verifies the exact tokens on first
execution before anything depends on them. Unknown fields are counted in
`otherFieldRows` for diagnostics and never treated as funnel events.

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
  "settings": { "executionOrder": "v1" },
  "nodes": [
    {
      "id": "n1",
      "name": "Manual Trigger - DRY RUN ONLY",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 0],
      "parameters": {}
    },
    {
      "id": "n2",
      "name": "READ ONLY: Describe Opportunity fields",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [220, -120],
      "credentials": {
        "salesforceOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "REPLACE_WITH_SFDC_CREDENTIAL_NAME"
        }
      },
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Opportunity'"
      }
    },
    {
      "id": "n3",
      "name": "READ ONLY: Fetch included Opportunities",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [220, 120],
      "credentials": {
        "salesforceOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "REPLACE_WITH_SFDC_CREDENTIAL_NAME"
        }
      },
      "parameters": {
        "resource": "search",
        "query": "SELECT Id, Name, AccountId, Account.Name, RecordType.DeveloperName, RecordType.Name, StageName, IsClosed, IsWon, CreatedDate, LastModifiedDate, SystemModstamp, Amount, CloseDate, OwnerId, Owner.Name, CampaignId, Campaign.Name FROM Opportunity WHERE RecordType.DeveloperName IN ('High_Potential_Prospect', 'Leads', 'Licensing') AND (IsClosed = false OR CreatedDate >= 2026-01-01T00:00:00Z OR SystemModstamp >= 2026-01-01T00:00:00Z OR (IsClosed = true AND CloseDate >= 2026-01-01)) ORDER BY SystemModstamp ASC"
      }
    },
    {
      "id": "n4",
      "name": "DRY RUN: Batch Opportunity IDs (no writes)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [440, 120],
      "parameters": {
        "jsCode": "// READ ONLY. Deduplicate ids in first-seen order and emit one item per\n// batch of 200 for the history IN clause. Mirrors chunkOpportunityIds in\n// src/lib/salesforceOpportunitySync.ts.\nconst seen = new Set();\nconst ids = [];\nfor (const item of $input.all()) {\n  const id = String(item.json.Id || '').trim();\n  if (!id || seen.has(id)) continue;\n  seen.add(id);\n  ids.push(id);\n}\nconst batches = [];\nfor (let i = 0; i < ids.length; i += 200) {\n  const batch = ids.slice(i, i + 200);\n  batches.push({ json: { inClause: batch.map((x) => `'${x}'`).join(',') } });\n}\nreturn batches.length ? batches : [{ json: { inClause: \"''\" } }];"
      }
    },
    {
      "id": "n5",
      "name": "READ ONLY: Fetch OpportunityFieldHistory",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [660, 120],
      "credentials": {
        "salesforceOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "REPLACE_WITH_SFDC_CREDENTIAL_NAME"
        }
      },
      "parameters": {
        "resource": "search",
        "query": "=SELECT Id, OpportunityId, Field, OldValue, NewValue, CreatedDate FROM OpportunityFieldHistory WHERE OpportunityId IN ({{ $json.inClause }}) ORDER BY CreatedDate ASC, Id ASC"
      }
    },
    {
      "id": "n6",
      "name": "DRY RUN: Aggregate summary (no writes, no identifiers)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [880, 0],
      "parameters": {
        "jsCode": "// READ ONLY / DRY RUN. Transport-level aggregates only: counts, per-row\n// movement facts, and duplicate/unknown/timestamp checks. The committed\n// buildDryRunSummary (src/lib/salesforceOpportunitySync.ts) is the\n// authoritative full summary via the Bite 5A derivation; export the raw\n// arrays from this execution to run it locally. NO identifier, name,\n// account, owner, or campaign leaves this node.\nconst opps = $('READ ONLY: Fetch included Opportunities').all().map((i) => i.json);\nconst hist = $('READ ONLY: Fetch OpportunityFieldHistory').all().map((i) => i.json);\nconst YEAR_START = '2026-01-01';\nconst INCLUDED = { High_Potential_Prospect: 'hpp', Leads: 'opp', Licensing: 'pursuit' };\nconst RT_MAP = { 'High Potential Prospect': 'hpp', High_Potential_Prospect: 'hpp', Opportunity: 'opp', Leads: 'opp', 'Sales Accepted Opportunity': 'opp', Pursuit: 'pursuit', Licensing: 'pursuit', 'Sales Qualified Opportunity': 'pursuit', Nurture: 'out_of_scope' };\nconst RANK = { hpp: 1, opp: 2, pursuit: 3 };\nconst TERMINAL = ['100) Closed-Won', 'Closed-Lost-Competitor', 'Closed-Lost-InHouse', 'Closed-Disqualified', 'Closed-Nurture'];\nconst OPEN = ['1) Suspect', '2) Opportunity Assesment', '3) Qualification', '4) Discovery', '5) Pitching', '6) POC', '7) Proposal', '8) Negotiation', '10) Awaiting Execution'];\nconst validTs = (v) => /^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d/.test(String(v || ''));\nconst scope = { discovered: opps.length, openNow: 0, closedNow: 0, createdInYear: 0, modifiedInYear: 0, closedInYear: 0, olderOpen: 0 };\nconst byDev = {}; const byStage = { hpp: 0, opp: 0, pursuit: 0, out_of_scope: 0, unknown: 0 };\nfor (const o of opps) {\n  const dn = (o.RecordType && o.RecordType.DeveloperName) || 'missing';\n  byDev[dn] = (byDev[dn] || 0) + 1;\n  const st = INCLUDED[dn] || 'unknown';\n  byStage[st] = (byStage[st] || 0) + 1;\n  const created = String(o.CreatedDate || '').slice(0, 10);\n  const modified = String(o.SystemModstamp || o.LastModifiedDate || '').slice(0, 10);\n  if (o.IsClosed === false) scope.openNow += 1;\n  if (o.IsClosed === true) scope.closedNow += 1;\n  if (created >= YEAR_START) scope.createdInYear += 1;\n  if (modified >= YEAR_START) scope.modifiedInYear += 1;\n  if (o.IsClosed === true && String(o.CloseDate || '') >= YEAR_START) scope.closedInYear += 1;\n  if (o.IsClosed === false && created && created < YEAR_START) scope.olderOpen += 1;\n}\nconst byId = new Map();\nlet exactDuplicates = 0; const conflicting = new Set();\nlet invalidTimestamps = 0; let rtRows = 0; let stageRows = 0;\nlet unknownRt = 0; let unknownStage = 0;\nlet fwd = 0; let back = 0; let fskip = 0; let bskip = 0;\nconst sameTs = new Map();\nfor (const h of hist) {\n  const key = String(h.Id || '');\n  const content = [h.OpportunityId, h.Field, h.OldValue, h.NewValue, h.CreatedDate].join('\\u0000');\n  if (byId.has(key)) {\n    if (byId.get(key) === content) exactDuplicates += 1; else conflicting.add(key);\n    continue;\n  }\n  byId.set(key, content);\n  if (!validTs(h.CreatedDate)) { invalidTimestamps += 1; continue; }\n  if (h.Field === 'RecordType') {\n    rtRows += 1;\n    const from = RT_MAP[String(h.OldValue || '').trim()];\n    const to = RT_MAP[String(h.NewValue || '').trim()];\n    if (h.OldValue && from === undefined) unknownRt += 1;\n    if (h.NewValue && to === undefined) unknownRt += 1;\n    if (RANK[from] && RANK[to]) {\n      const d = RANK[to] - RANK[from];\n      if (d > 0) { fwd += 1; if (d === 2) fskip += 1; }\n      if (d < 0) { back += 1; if (d === -2) bskip += 1; }\n    }\n    const tsKey = h.OpportunityId + '|' + h.CreatedDate;\n    sameTs.set(tsKey, (sameTs.get(tsKey) || 0) + 1);\n  } else if (h.Field === 'StageName') {\n    stageRows += 1;\n    for (const v of [h.OldValue, h.NewValue]) {\n      const s = String(v || '').trim();\n      if (s && !TERMINAL.includes(s) && !OPEN.includes(s)) unknownStage += 1;\n    }\n  }\n}\nconst ambiguityCandidates = [...sameTs.values()].filter((n) => n > 1).length;\nreturn [{ json: {\n  executedAt: new Date().toISOString(),\n  dry_run: true,\n  writes_attempted: 0,\n  scope,\n  countsByRecordTypeDeveloperName: byDev,\n  countsByNormalizedCurrentStage: byStage,\n  history: { rowsDiscovered: hist.length, recordTypeRows: rtRows, stageRows, otherFieldRows: hist.length - rtRows - stageRows, exactDuplicates, conflictingDuplicateHistoryIds: conflicting.size, invalidTimestamps, unknownRecordTypeValues: unknownRt, unknownStageValues: unknownStage },\n  movement: { forwardMoves: fwd, backwardMoves: back, forwardSkips: fskip, backwardSkips: bskip, sameTimestampAmbiguityCandidates: ambiguityCandidates },\n  note: 'Transport-level aggregates. Authoritative full summary: buildDryRunSummary in src/lib/salesforceOpportunitySync.ts (Bite 5A derivation + Bite 5B review seeding).'\n} }];"
      }
    },
    {
      "id": "n7",
      "name": "GUARD: fail unless dry run with zero writes",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1100, 0],
      "parameters": {
        "jsCode": "// Final safety guard. This execution must prove itself a write-free dry\n// run; anything else fails loudly. Static repository tests additionally\n// assert this template contains no write-capable destination node types,\n// so introducing one fails CI before it can ever run.\nconst s = $input.first().json;\nif (s.dry_run !== true) throw new Error('GUARD: summary is not marked dry_run');\nif (s.writes_attempted !== 0) throw new Error('GUARD: writes were attempted in a dry run');\nreturn $input.all();"
      }
    }
  ],
  "connections": {
    "Manual Trigger - DRY RUN ONLY": {
      "main": [[
        { "node": "READ ONLY: Describe Opportunity fields", "type": "main", "index": 0 },
        { "node": "READ ONLY: Fetch included Opportunities", "type": "main", "index": 0 }
      ]]
    },
    "READ ONLY: Fetch included Opportunities": {
      "main": [[{ "node": "DRY RUN: Batch Opportunity IDs (no writes)", "type": "main", "index": 0 }]]
    },
    "DRY RUN: Batch Opportunity IDs (no writes)": {
      "main": [[{ "node": "READ ONLY: Fetch OpportunityFieldHistory", "type": "main", "index": 0 }]]
    },
    "READ ONLY: Fetch OpportunityFieldHistory": {
      "main": [[{ "node": "DRY RUN: Aggregate summary (no writes, no identifiers)", "type": "main", "index": 0 }]]
    },
    "DRY RUN: Aggregate summary (no writes, no identifiers)": {
      "main": [[{ "node": "GUARD: fail unless dry run with zero writes", "type": "main", "index": 0 }]]
    }
  }
}
```
