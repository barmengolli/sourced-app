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
unmapped). The workflow therefore performs a read-only RecordType query
(`SELECT Id, Name, DeveloperName, SobjectType FROM RecordType WHERE
SobjectType = 'Opportunity'`) and resolves values through a RUNTIME map,
RecordType Id to DeveloperName to normalized stage, indexing both 15- and
18-character id forms. RecordType ids are never hardcoded and never appear
in the aggregate summary. Historical labels and DeveloperNames keep
resolving directly; values that remain unresolved stay unknown and require
review. Value diagnostics separate blank historical baselines (a blank
OldValue on an initial row is normal, not unknown), unresolved
Salesforce-ID-shaped values, unmapped nonblank labels, and successful
resolutions, reporting value OCCURRENCES and affected ROWS as distinct
units. Unknown nonblank Stage labels (1,463 occurrences in the first run,
largely pre-standard picklist history) are collected as an aggregate-only
diagnostic (distinct label, occurrence count, seen as old/new/both) so the
Stage map can be extended deliberately; no label is ever fuzzy-matched.
Same-timestamp co-occurrence is CLASSIFIED, not alarmed: the first run's
274 candidates split into harmless cross-ledger groups, uniquely provable
chains, and materially ambiguous groups; only the material ones create
ambiguous_same_timestamp review issues, with Bite 5A as the authority.

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
        220,
        -120
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
      }
    },
    {
      "id": "n3",
      "name": "READ ONLY: Fetch included Opportunities",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        220,
        120
      ],
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
      "position": [
        440,
        120
      ],
      "parameters": {
        "jsCode": "// READ ONLY. Deduplicate ids in first-seen order and emit one item per\n// batch of 200 for the history IN clause. Mirrors chunkOpportunityIds in\n// src/lib/salesforceOpportunitySync.ts.\nconst seen = new Set();\nconst ids = [];\nfor (const item of $input.all()) {\n  const id = String(item.json.Id || '').trim();\n  if (!id || seen.has(id)) continue;\n  seen.add(id);\n  ids.push(id);\n}\nconst batches = [];\nfor (let i = 0; i < ids.length; i += 200) {\n  const batch = ids.slice(i, i + 200);\n  batches.push({ json: { inClause: batch.map((x) => `'${x}'`).join(',') } });\n}\nreturn batches.length ? batches : [{ json: { inClause: \"''\" } }];"
      }
    },
    {
      "id": "n5",
      "name": "READ ONLY: Fetch OpportunityFieldHistory",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        660,
        120
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
      }
    },
    {
      "id": "n6",
      "name": "DRY RUN: Aggregate summary (no writes, no identifiers)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        880,
        0
      ],
      "parameters": {
        "jsCode": "// READ ONLY / DRY RUN. Transport-level aggregates only. The committed\n// buildDryRunSummary (src/lib/salesforceOpportunitySync.ts) is the\n// authoritative full summary via the Bite 5A derivation; this node mirrors\n// its counters for the manual run. NO identifier, name, account, owner,\n// campaign, or RecordType Id leaves this node.\nconst opps = $('READ ONLY: Fetch included Opportunities').all().map((i) => i.json);\nconst hist = $('READ ONLY: Fetch OpportunityFieldHistory').all().map((i) => i.json);\nconst rts = $('READ ONLY: Fetch Opportunity RecordTypes').all().map((i) => i.json);\nconst YEAR_START = '2026-01-01';\nconst INCLUDED = { High_Potential_Prospect: 'hpp', Leads: 'opp', Licensing: 'pursuit' };\nconst RT_MAP = { 'High Potential Prospect': 'hpp', High_Potential_Prospect: 'hpp', Opportunity: 'opp', Leads: 'opp', 'Sales Accepted Opportunity': 'opp', Pursuit: 'pursuit', Licensing: 'pursuit', 'Sales Qualified Opportunity': 'pursuit', Nurture: 'out_of_scope' };\nconst RANK = { hpp: 1, opp: 2, pursuit: 3 };\nconst TERMINAL = ['100) Closed-Won', 'Closed-Lost-Competitor', 'Closed-Lost-InHouse', 'Closed-Disqualified', 'Closed-Nurture'];\nconst OPEN = ['1) Suspect', '2) Opportunity Assesment', '3) Qualification', '4) Discovery', '5) Pitching', '6) POC', '7) Proposal', '8) Negotiation', '10) Awaiting Execution'];\nconst ID_SHAPE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;\nconst validTs = (v) => /^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d/.test(String(v || ''));\n// Runtime RecordType Id map (never hardcoded, never emitted).\nconst idMap = {};\nfor (const rt of rts) {\n  const id = String(rt.Id || '').trim();\n  const dev = String(rt.DeveloperName || '').trim();\n  if (!id || !dev) continue;\n  idMap[id] = dev;\n  if (id.length === 18) idMap[id.slice(0, 15)] = dev;\n}\nconst rtValueCounts = { resolvedViaIdMap: 0, resolvedAsKnownValue: 0, blankBaseline: 0, unresolvedIdShaped: 0, unmappedNonblankLabel: 0, affectedRows: 0 };\nconst resolveRt = (raw) => {\n  const v = String(raw || '').trim();\n  if (!v) { rtValueCounts.blankBaseline += 1; return null; }\n  if (idMap[v] !== undefined) { rtValueCounts.resolvedViaIdMap += 1; return idMap[v]; }\n  if (RT_MAP[v] !== undefined) { rtValueCounts.resolvedAsKnownValue += 1; return v; }\n  if (ID_SHAPE.test(v)) { rtValueCounts.unresolvedIdShaped += 1; return v; }\n  rtValueCounts.unmappedNonblankLabel += 1;\n  return v;\n};\nconst scope = { discovered: opps.length, openNow: 0, closedNow: 0, createdInYear: 0, modifiedInYear: 0, closedWithCloseDateInYear: 0, olderOpen: 0 };\nconst byDev = {}; const byStage = { hpp: 0, opp: 0, pursuit: 0, out_of_scope: 0, unknown: 0 };\nfor (const o of opps) {\n  const dn = (o.RecordType && o.RecordType.DeveloperName) || 'missing';\n  byDev[dn] = (byDev[dn] || 0) + 1;\n  const st = INCLUDED[dn] || 'unknown';\n  byStage[st] = (byStage[st] || 0) + 1;\n  const created = String(o.CreatedDate || '').slice(0, 10);\n  const modified = String(o.SystemModstamp || o.LastModifiedDate || '').slice(0, 10);\n  if (o.IsClosed === false) scope.openNow += 1;\n  if (o.IsClosed === true) scope.closedNow += 1;\n  if (created >= YEAR_START) scope.createdInYear += 1;\n  if (modified >= YEAR_START) scope.modifiedInYear += 1;\n  if (o.IsClosed === true && String(o.CloseDate || '') >= YEAR_START) scope.closedWithCloseDateInYear += 1;\n  if (o.IsClosed === false && created && created < YEAR_START) scope.olderOpen += 1;\n}\nconst byId = new Map();\nlet exactDuplicates = 0; const conflicting = new Set();\nlet invalidTimestamps = 0; let rtRows = 0; let stageRows = 0;\nlet fwd = 0; let back = 0; let fskip = 0; let bskip = 0;\nconst stageValueCounts = { resolved: 0, blankBaseline: 0, unknownNonblank: 0, affectedRows: 0 };\nconst unknownStageLabels = new Map();\nconst rtGroups = new Map();\nconst stageStamps = new Set();\nfor (const h of hist) {\n  const key = String(h.Id || '');\n  const content = [h.OpportunityId, h.Field, h.OldValue, h.NewValue, h.CreatedDate].join(' ');\n  if (byId.has(key)) {\n    if (byId.get(key) === content) exactDuplicates += 1; else conflicting.add(key);\n    continue;\n  }\n  byId.set(key, content);\n  if (!validTs(h.CreatedDate)) { invalidTimestamps += 1; continue; }\n  const tsKey = h.OpportunityId + '|' + h.CreatedDate;\n  if (h.Field === 'RecordType') {\n    rtRows += 1;\n    const before = rtValueCounts.unresolvedIdShaped + rtValueCounts.unmappedNonblankLabel;\n    const from = RT_MAP[resolveRt(h.OldValue)];\n    const to = RT_MAP[resolveRt(h.NewValue)];\n    if (rtValueCounts.unresolvedIdShaped + rtValueCounts.unmappedNonblankLabel > before) rtValueCounts.affectedRows += 1;\n    if (RANK[from] && RANK[to]) {\n      const d = RANK[to] - RANK[from];\n      if (d > 0) { fwd += 1; if (d === 2) fskip += 1; }\n      if (d < 0) { back += 1; if (d === -2) bskip += 1; }\n    }\n    if (!rtGroups.has(tsKey)) rtGroups.set(tsKey, []);\n    rtGroups.get(tsKey).push({ from, to });\n  } else if (h.Field === 'StageName') {\n    stageRows += 1;\n    stageStamps.add(tsKey);\n    let rowAffected = false;\n    for (const side of ['old', 'new']) {\n      const s = String((side === 'old' ? h.OldValue : h.NewValue) || '').trim();\n      if (!s) { stageValueCounts.blankBaseline += 1; continue; }\n      if (TERMINAL.includes(s) || OPEN.includes(s)) { stageValueCounts.resolved += 1; continue; }\n      stageValueCounts.unknownNonblank += 1; rowAffected = true;\n      const e = unknownStageLabels.get(s) || { occurrences: 0, old: false, new: false };\n      e.occurrences += 1; e[side] = true; unknownStageLabels.set(s, e);\n    }\n    if (rowAffected) stageValueCounts.affectedRows += 1;\n  }\n}\n// Same-timestamp classification (mirror; Bite 5A is authoritative).\nlet candidateGroups = 0; let provable = 0; let materiallyAmbiguous = 0; let harmlessCrossLedger = 0;\nfor (const [tsKey, moves] of rtGroups) {\n  if (stageStamps.has(tsKey)) harmlessCrossLedger += 1;\n  if (moves.length < 2) continue;\n  candidateGroups += 1;\n  if (moves.length === 2 && (moves[0].to === moves[1].from || moves[1].to === moves[0].from)) provable += 1;\n  else materiallyAmbiguous += 1;\n}\nconst stageLabelDiagnostics = [...unknownStageLabels.entries()]\n  .map(([label, x]) => ({ label, occurrences: x.occurrences, seenAs: x.old && x.new ? 'both' : x.old ? 'old' : 'new' }))\n  .sort((a, b) => b.occurrences - a.occurrences || a.label.localeCompare(b.label));\nreturn [{ json: {\n  executedAt: new Date().toISOString(),\n  dry_run: true,\n  writes_attempted: 0,\n  scope,\n  countsByRecordTypeDeveloperName: byDev,\n  countsByNormalizedCurrentStage: byStage,\n  history: { rowsDiscovered: hist.length, recordTypeRows: rtRows, stageRows, otherFieldRows: hist.length - rtRows - stageRows, exactDuplicates, conflictingDuplicateHistoryIds: conflicting.size, invalidTimestamps, recordTypeValues: rtValueCounts, stageValues: { ...stageValueCounts, unknownLabels: stageLabelDiagnostics } },\n  movement: { forwardMoves: fwd, backwardMoves: back, forwardSkips: fskip, backwardSkips: bskip, sameTimestamp: { candidateGroups, harmlessCrossLedgerGroups: harmlessCrossLedger, uniquelyProvableByChaining: provable, materiallyAmbiguousConservative: materiallyAmbiguous } },\n  note: 'Mirror aggregates. Authoritative full summary: buildDryRunSummary in src/lib/salesforceOpportunitySync.ts (Bite 5A derivation is the authority on material ambiguity; the mirror is conservative for groups larger than two).'\n} }];"
      }
    },
    {
      "id": "n7",
      "name": "GUARD: fail unless dry run with zero writes",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1100,
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
        220,
        -260
      ],
      "credentials": {
        "salesforceOAuth2Api": {
          "id": "REPLACE_WITH_CREDENTIAL_ID",
          "name": "REPLACE_WITH_SFDC_CREDENTIAL_NAME"
        }
      },
      "parameters": {
        "resource": "search",
        "query": "SELECT Id, Name, DeveloperName, SobjectType FROM RecordType WHERE SobjectType = 'Opportunity'"
      }
    }
  ],
  "connections": {
    "Manual Trigger - DRY RUN ONLY": {
      "main": [
        [
          {
            "node": "READ ONLY: Describe Opportunity fields",
            "type": "main",
            "index": 0
          },
          {
            "node": "READ ONLY: Fetch included Opportunities",
            "type": "main",
            "index": 0
          },
          {
            "node": "READ ONLY: Fetch Opportunity RecordTypes",
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
    }
  }
}
```
