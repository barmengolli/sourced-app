# Salesforce lead-sync discovery (Bite 4G1)

Read-only discovery for the lead-sync rebuild. This bite answers, with
evidence instead of assumption, what the Salesforce org actually exposes,
so Bites 4G2+ can be designed against facts. **Nothing here writes to
Salesforce, Supabase, Google Sheets, Slack, or email**, and no workflow is
scheduled or activated.

The current production workflow's defects are catalogued separately in
`docs/lead-sync-current-workflow-audit.md`. This document is the plan for
replacing the guesswork in it.

## What must be discovered, and why

| # | Question | Why it blocks the rebuild |
|---|---|---|
| 1 | Lead lifecycle-related fields (FieldDefinition) | The current workflow reads a lifecycle field it never selects, so every person defaults to the `lead` stage |
| 2 | Contact lifecycle-related fields (FieldDefinition) | Lead and Contact may expose DIFFERENT API names; the current code assumes one shape |
| 3 | CampaignMember date/identity/modification fields | Needed for a real watermark and for the touch identity keys |
| 4 | Whether candidate lifecycle and supporting date fields are history tracked | Without tracking, LeadHistory/ContactHistory carry nothing for those fields and demotions stay invisible |
| 5 | Whether the credential can query LeadHistory and ContactHistory | Permission, not schema: the rebuild's whole lifecycle branch depends on it |
| 6 | Oldest and newest available lifecycle history | Salesforce retains roughly 24 months without Field Audit Trail; this bounds the historical backfill |
| 7 | Distinct lifecycle values actually observed | The value-to-stage map must be built from real org vocabulary, never guessed |
| 8 | CampaignMember incremental and reconciliation volumes | Tests the current 5,000-row assumption and sizes pagination |
| 9 | The exact field behind the report label "Member First Associated Date" | The sourced date is currently taken from CreatedDate with no confirmation |
| 10 | Converted Lead to Contact linkage coverage (ConvertedContactId) | Determines how many memberships would orphan when a Lead converts |
| 11 | Per-campaign membership counts (PRIVATE) | Decides which campaigns belong in Sourced; campaign identities never leave n8n |

## The aggregate summary contract

`src/lib/leadSyncDiscovery.ts` (`summarizeDiscovery`) turns discovery
results into the shareable summary. It always reports `dry_run: true` and
`writes_attempted: 0`, and it emits **aggregate values only**: field API
names and tracking flags, history queryability and window bounds, distinct
lifecycle values with counts, transition counts, volume counts, batch
estimates, and the unresolved-decision list.

Lifecycle classification is **not** reimplemented there. Transition
counting delegates to `adaptLifecycleHistory` (Bite 4B), which owns value
mapping, the closed `lead` / `mql` / `out_of_scope` union, duplicate and
conflict handling, and timestamp validation. Touch-identity gaps use the
Bite 4D vocabulary (CampaignMember Id preferred, then the
lead + campaign + date natural key). `assertNoIdentifierLeakage` throws if
a Salesforce-id-shaped or email-shaped value ever reaches the summary.

Field-name candidacy is a NAME heuristic used only to surface fields for a
human to confirm. It never maps a value to a stage: unknown values stay
visible as aggregate diagnostics, exactly as the program requires.

## Workflow safety design

- `active: false`, Manual Trigger only, **no schedule trigger**.
- No Supabase, Postgres, HTTP, Google Sheets, Slack, email, or webhook
  node. Every Salesforce node is a read-only search (SOQL) operation.
- No credentials bound and no pinned data in the committed template.
- Every global query sets `executeOnce`, so an upstream item count can
  never amplify one query into N identical queries.
- Required-result validation **fails loudly**: if FieldDefinition returns
  no rows for an object, the run throws rather than letting a silent zero
  be misread as "the field does not exist".
- Each node reference points at an executed ancestor on the single linear
  chain, so no node reads from a branch that never ran.
- The GUARD node is the **only successful terminal**: it asserts
  `dry_run: true` and `writes_attempted: 0`, and re-checks the shared
  summary for Salesforce-id-shaped and email-shaped values before emitting.
- One node is labeled `PRIVATE (n8n only): DO NOT SHARE` (per-campaign
  counts). Its output stays out of the guard summary, must be read in the
  n8n UI only, and must never be committed or pasted into a PR.
- `settings.timezone` records `America/Denver` for the FUTURE scheduled
  workflow, so the rebuild does not repeat the current unstated-timezone
  defect. This discovery workflow is manual and schedules nothing.

## Manual import and execution

1. In n8n choose **Import from File** and select the generated file (path
   in the bite report). It arrives **disabled**; leave it disabled.
2. Bind the existing Salesforce credential to the Salesforce nodes. The
   committed template binds none by design.
3. Before running, open `DISCOVER: observed lifecycle values (aggregate)`
   and replace `FIELD_API_NAME` with the lifecycle API name that the
   FieldDefinition nodes report. Do not guess it.
4. Click **Execute Workflow** manually. Never activate it.
5. Read the GUARD node's output and paste those aggregate values into the
   Results section below. Read the PRIVATE node in the n8n UI only.
6. If a node errors, that is the design: an empty required result is a
   failure, not a pass. Fix access and re-run.

## Results

_Not yet run. Paste the aggregate GUARD output here after the manual run,
then record the confirmed field names and the value-to-stage map for 4G2._

## Open decisions (not made in this bite)

1. **Which API field backs "Member First Associated Date."** The current
   workflow assumes CampaignMember CreatedDate without confirmation.
2. **The confirmed lifecycle field API name on Lead and on Contact**, and
   whether they differ.
3. **The value-to-stage map**, built from observed values only, restricted
   to `lead`, `mql`, and `out_of_scope`. Deal stages must never be written
   as lead lifecycle.
4. **Alerting channel: Slack versus email.** The current workflow has no
   failure notification at all. This needs a decision before 4G ships a
   scheduled workflow, along with who receives the alerts.
5. **Whether the RPC write path is versioned into `migrations/`** or
   replaced. Today it exists only in the live environment.
6. **Historical backfill depth**, bounded by whatever retention window the
   discovery reports.

## The workflow template

Disabled, read-only, manual. Import a copy; do not paste run output back
into this block.

```json
{
  "name": "[Sourced] - 4G1 Lead Sync Discovery - READ ONLY - DISABLED",
  "nodes": [
    {
      "parameters": {},
      "id": "manual-trigger",
      "name": "When clicking Execute (manual only)",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [
        -560,
        300
      ]
    },
    {
      "parameters": {
        "jsCode": "// Bite 4G1 read-only discovery. This workflow is MANUAL ONLY and has no\n// schedule trigger. The timezone below is recorded so the FUTURE\n// scheduled sync (Bite 4G2+) is built with an explicit zone instead of\n// inheriting the n8n instance default, which is the current production\n// workflow's unstated-timezone defect.\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  future_schedule_timezone: 'America/Denver',\n  incremental_window_days: 2,\n  planned_batch_size: 2000,\n  current_workflow_row_limit: 5000\n} }];"
      },
      "id": "config-discovery-settings",
      "name": "CONFIG: discovery settings",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -340,
        300
      ],
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Lead'"
      },
      "id": "discover-lead-fields-fielddefinition",
      "name": "DISCOVER: Lead fields (FieldDefinition)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        -120,
        300
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Read-only metadata query. Discovers Lead field API names, labels, data types, and history-tracking flags. No field VALUES are read."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Contact'"
      },
      "id": "discover-contact-fields-fielddefinit",
      "name": "DISCOVER: Contact fields (FieldDefinition)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        100,
        300
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Read-only metadata query. Discovers Contact field API names, labels, data types, and history-tracking flags. No field VALUES are read."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'CampaignMember'"
      },
      "id": "discover-campaignmember-fields-field",
      "name": "DISCOVER: CampaignMember fields (FieldDefinition)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        320,
        300
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Read-only metadata query. Discovers CampaignMember field API names, labels, data types, and history-tracking flags. No field VALUES are read."
    },
    {
      "parameters": {
        "jsCode": "// Empty required results FAIL rather than passing as a false success.\n// A silent zero here would make every downstream 'not found' finding\n// meaningless (absence of evidence read as evidence of absence).\n//\n// Each source node is referenced by LITERAL name so the reference is\n// statically checkable against the executed-ancestor chain.\nconst sources = [\n  ['Lead', $('DISCOVER: Lead fields (FieldDefinition)').all()],\n  ['Contact', $('DISCOVER: Contact fields (FieldDefinition)').all()],\n  ['CampaignMember', $('DISCOVER: CampaignMember fields (FieldDefinition)').all()]\n];\nconst out = {};\nfor (const [obj, items] of sources) {\n  const rows = items.map((i) => i.json).filter((r) => r && r.QualifiedApiName);\n  if (rows.length === 0) {\n    throw new Error('DISCOVERY FAILED: FieldDefinition returned no rows for ' + obj\n      + '. Check the integration user metadata read access; do not treat this as \"field absent\".');\n  }\n  out[obj] = rows.length;\n}\nreturn [{ json: { dry_run: true, writes_attempted: 0, field_rows_by_object: out } }];"
      },
      "id": "validate-field-discovery-returned-ro",
      "name": "VALIDATE: field discovery returned rows",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        540,
        300
      ],
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT Id, LeadId, Field, OldValue, NewValue, CreatedDate FROM LeadHistory ORDER BY CreatedDate DESC LIMIT 1"
      },
      "id": "probe-leadhistory-access",
      "name": "PROBE: LeadHistory access",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        760,
        200
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Read-only probe: can the integration credential query LeadHistory at all? One row only; classification of values happens in the repository module."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT Id, ContactId, Field, OldValue, NewValue, CreatedDate FROM ContactHistory ORDER BY CreatedDate DESC LIMIT 1"
      },
      "id": "probe-contacthistory-access",
      "name": "PROBE: ContactHistory access",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        760,
        400
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Read-only probe: can the integration credential query ContactHistory at all?"
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT MIN(CreatedDate) oldest, MAX(CreatedDate) newest, COUNT(Id) rows FROM LeadHistory"
      },
      "id": "discover-leadhistory-window-bounds",
      "name": "DISCOVER: LeadHistory window bounds",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        980,
        200
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Aggregate-only: oldest/newest available lifecycle history and row count. No person or record identifiers are selected."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT MIN(CreatedDate) oldest, MAX(CreatedDate) newest, COUNT(Id) rows FROM ContactHistory"
      },
      "id": "discover-contacthistory-window-bound",
      "name": "DISCOVER: ContactHistory window bounds",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        980,
        400
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Aggregate-only: oldest/newest available lifecycle history and row count."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "-- Replace FIELD_API_NAME with the confirmed lifecycle field from the\n-- FieldDefinition discovery above before running this node.\nSELECT FIELD_API_NAME value, COUNT(Id) total FROM Contact GROUP BY FIELD_API_NAME"
      },
      "id": "discover-observed-lifecycle-values-a",
      "name": "DISCOVER: observed lifecycle values (aggregate)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        1200,
        300
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Aggregate GROUP BY: distinct lifecycle picklist values and counts only. Unknown values stay visible as diagnostics; nothing is fuzzy-mapped."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT COUNT(Id) total FROM CampaignMember WHERE CreatedDate >= LAST_N_DAYS:2"
      },
      "id": "discover-campaignmember-incremental-",
      "name": "DISCOVER: CampaignMember incremental volume",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        1420,
        200
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Aggregate count for the CURRENT nightly window, to test the 5,000-row assumption. Uses a relative date literal; no private values."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT COUNT(Id) total FROM CampaignMember"
      },
      "id": "discover-campaignmember-reconciliati",
      "name": "DISCOVER: CampaignMember reconciliation volume",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        1420,
        400
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Aggregate count for a FULL reconciliation scope, to size pagination."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT COUNT(Id) total FROM Lead WHERE IsConverted = true AND ConvertedContactId != null"
      },
      "id": "discover-converted-lead-linkage-cove",
      "name": "DISCOVER: converted-lead linkage coverage",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        1640,
        300
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "Aggregate coverage of ConvertedContactId on converted Leads. Counts only; no ids are returned to the shared summary."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT CampaignId, COUNT(Id) members FROM CampaignMember GROUP BY CampaignId"
      },
      "id": "private-n8n-only-do-not-share---camp",
      "name": "PRIVATE (n8n only): DO NOT SHARE - campaign scope counts",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        1860,
        460
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "PRIVATE (n8n only): DO NOT SHARE. Per-campaign membership counts used to decide which campaigns belong in Sourced. Campaign ids/names must NEVER be pasted into the repository, a PR, or the shared summary. Read this in the n8n UI only; do not commit populated output."
    },
    {
      "parameters": {
        "jsCode": "// The ONLY successful terminal node. It asserts the run performed no\n// writes and emits an AGGREGATE-ONLY summary safe to share.\n//\n// The authoritative summary shape is built by\n// src/lib/leadSyncDiscovery.ts (summarizeDiscovery) in the repository,\n// which also owns lifecycle classification via the Bite 4B adapter.\n// This node reports counts and asserts the safety invariants; it does\n// NOT re-implement classification.\nconst cfg = $('CONFIG: discovery settings').first().json;\nif (cfg.dry_run !== true || cfg.writes_attempted !== 0) {\n  throw new Error('GUARD: discovery must be dry_run with zero writes.');\n}\nconst fieldRows = $('VALIDATE: field discovery returned rows').first().json.field_rows_by_object;\nconst count = (node) => {\n  const rows = $(node).all().map((i) => i.json).filter(Boolean);\n  return rows.length;\n};\n// Aggregate scalars only. No ids, emails, names, or campaign names.\nconst summary = {\n  dry_run: true,\n  writes_attempted: 0,\n  future_schedule_timezone: cfg.future_schedule_timezone,\n  field_rows_by_object: fieldRows,\n  lead_history_probe_rows: count('PROBE: LeadHistory access'),\n  contact_history_probe_rows: count('PROBE: ContactHistory access'),\n  lifecycle_value_groups: count('DISCOVER: observed lifecycle values (aggregate)'),\n  note: 'Paste the aggregate values from the n8n run into the 4G1 discovery doc. '\n    + 'Do NOT paste the PRIVATE campaign-scope node output anywhere.'\n};\nconst serialized = JSON.stringify(summary);\nif (/\\b(001|003|00Q|00v|701|005|006)[A-Za-z0-9]{12}([A-Za-z0-9]{3})?\\b/.test(serialized)) {\n  throw new Error('GUARD: summary contains a Salesforce-record-id-shaped value.');\n}\nif (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/.test(serialized)) {\n  throw new Error('GUARD: summary contains an email-shaped value.');\n}\nreturn [{ json: summary }];"
      },
      "id": "guard-dry-run-summary-shared,-aggreg",
      "name": "GUARD: dry-run summary (shared, aggregate only)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        2080,
        300
      ],
      "executeOnce": true
    }
  ],
  "connections": {
    "When clicking Execute (manual only)": {
      "main": [
        [
          {
            "node": "CONFIG: discovery settings",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "CONFIG: discovery settings": {
      "main": [
        [
          {
            "node": "DISCOVER: Lead fields (FieldDefinition)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DISCOVER: Lead fields (FieldDefinition)": {
      "main": [
        [
          {
            "node": "DISCOVER: Contact fields (FieldDefinition)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DISCOVER: Contact fields (FieldDefinition)": {
      "main": [
        [
          {
            "node": "DISCOVER: CampaignMember fields (FieldDefinition)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DISCOVER: CampaignMember fields (FieldDefinition)": {
      "main": [
        [
          {
            "node": "VALIDATE: field discovery returned rows",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "VALIDATE: field discovery returned rows": {
      "main": [
        [
          {
            "node": "PROBE: LeadHistory access",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "PROBE: LeadHistory access": {
      "main": [
        [
          {
            "node": "PROBE: ContactHistory access",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "PROBE: ContactHistory access": {
      "main": [
        [
          {
            "node": "DISCOVER: LeadHistory window bounds",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DISCOVER: LeadHistory window bounds": {
      "main": [
        [
          {
            "node": "DISCOVER: ContactHistory window bounds",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DISCOVER: ContactHistory window bounds": {
      "main": [
        [
          {
            "node": "DISCOVER: observed lifecycle values (aggregate)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DISCOVER: observed lifecycle values (aggregate)": {
      "main": [
        [
          {
            "node": "DISCOVER: CampaignMember incremental volume",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DISCOVER: CampaignMember incremental volume": {
      "main": [
        [
          {
            "node": "DISCOVER: CampaignMember reconciliation volume",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DISCOVER: CampaignMember reconciliation volume": {
      "main": [
        [
          {
            "node": "DISCOVER: converted-lead linkage coverage",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "DISCOVER: converted-lead linkage coverage": {
      "main": [
        [
          {
            "node": "PRIVATE (n8n only): DO NOT SHARE - campaign scope counts",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "PRIVATE (n8n only): DO NOT SHARE - campaign scope counts": {
      "main": [
        [
          {
            "node": "GUARD: dry-run summary (shared, aggregate only)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": false,
  "settings": {
    "executionOrder": "v1",
    "timezone": "America/Denver"
  },
  "pinData": {},
  "tags": []
}
```
