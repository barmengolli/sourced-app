# Lifecycle ingestion dry run (Bite 4G2B2A)

Scope, extraction, and authoritative dry-run contract for lifecycle
ingestion.

**Nothing in this bite writes, activates, schedules, or ingests
anything.** The workflow template is `active: false` with a Manual
Trigger and no write-capable node of any kind. No apply-function call
exists in 4G2B2A. Bite 4G2B2B and 4G2C are unstarted.

## The scope question, and why it is the whole bite

Bite 4G1's live run measured **103,070** CampaignMember rows and
**12,986** converted Lead-to-Contact links, organization-wide. Those are
discovery measurements. They are **not** an approved ingestion
population, and treating them as one would import tens of thousands of
people Sourced has never tracked, inventing a population rather than
mirroring one.

### How Sourced actually anchors Salesforce identity

Verified in the code, not assumed:

- `leads.sfdc_lead_id` and `leads.sfdc_contact_id` (SCHEMA.sql) hold the
  exact Salesforce ids. Both are **nullable with no unique constraint**;
  `leads.email` is the table's unique key.
- The CSV importer maps both columns (`src/lib/csv.ts`,
  `src/components/import/ColumnMapper.tsx`).
- The typed sync path writes them and **only fills a blank id, never
  overwrites one** (`src/lib/leadSync.ts`).
- The production n8n workflow **does** retain both: its transform emits
  `sfdc_contact_id: row.ContactId` and `sfdc_lead_id: row.LeadId`.

That last point corrects a reading of the 4G1 audit. The audit correctly
found that CampaignMember `Id` and Campaign `Id` are discarded, so
membership identity is lost, but **person identity survives**. The
identity-anchored hypothesis is therefore implementable today.

### The eight populations, kept separate

They are reported separately and never summed into one "in scope"
number, because each answers a different question:

| # | Population | Meaning |
|---|---|---|
| 1 | Existing Sourced people with an exact Lead identity | `sfdc_lead_id` present and well-formed |
| 2 | Existing Sourced people with an exact Contact identity | `sfdc_contact_id` present and well-formed |
| 3 | Both identities joined by a confirmed `ConvertedContactId` | Salesforce's own conversion link, both sides on one Sourced person |
| 4 | Current production-workflow candidates | What the approved import path would admit |
| 5 | Candidates already represented | Already anchored in Sourced |
| 6 | New candidates | Not yet represented |
| 7 | Organization-wide records in none of the above | Deliberately excluded. `null` when unmeasured, because unknown is not zero |
| 8 | Missing, malformed, conflicting, ambiguous | Reported for review, never repaired silently |

A Sourced person with **no** exact Salesforce identity cannot be
observed. Email is Sourced's unique key, but email matching is precisely
the fuzzy path this program has refused since 4G2A. Those people are
counted in population 8 and left alone.

Matching is by exact Salesforce Id string, per source object, so a Lead
id and a Contact id that happen to share a string can never collide.

## Existing production workflow audit

Read-only inspection of the live export. **The production workflow was
not modified, imported, executed, or activated**, and its byte hash is
asserted unchanged by a test.

| Aspect | Finding |
|---|---|
| Trigger | Schedule, `triggerAtHour: 3`, **no timezone key**, so it follows the instance default rather than a stated `America/Denver` |
| Query window | `CampaignMember` where `CreatedDate >= now - 2 days`, evaluated in UTC |
| Ordering | `ORDER BY CreatedDate DESC` |
| Row limit | Hard `LIMIT 5000`, no pagination |
| CampaignMember scope | Campaign and parent campaign **names** selected; no Campaign Id, and CampaignMember `Id` is selected then discarded |
| Lead vs Contact | One query covering both sides via `Contact.*` / `Lead.*` fields |
| Source identity retained | **`ContactId` and `LeadId` ARE retained** as `sfdc_contact_id` / `sfdc_lead_id` |
| Lifecycle field | Code reads `Hubspot_Lifecycle_Stage__c`, which is **not** the confirmed name and **is not in the SELECT**, so every synced person defaults to `lead` |
| Pagination | None |
| Retry | None configured |
| Partial-run behavior | No durable watermark; a missed run is never made up |
| Supabase calls | One HTTP POST to an unversioned RPC absent from this repository |
| Google Sheet | Appends a log row containing email, names, and Salesforce ids |
| Error handling | The RPC node is `onError: continueRegularOutput`, so a failed write proceeds and is logged as success |
| Duplicate/skipped people | Possible: no watermark, a create-window-only scope, and a silent 5,000-row ceiling |
| Durable watermark | **None** |
| Hardcoded campaign/channel decisions | Channel is inferred from campaign **names** in the transform |

The two findings that matter most for this bite: person identity **is**
available (enabling the whole scope hypothesis), and the lifecycle field
is **not** actually queried (so today's feed carries no usable lifecycle
value at all).

## Extraction contract

Confirmed by 4G1's live run: the lifecycle field is
`Hubspot_lead_lifecycle__c`, the **same API name on both Lead and
Contact**.

| Field | Lead | Contact | Purpose | Status |
|---|---|---|---|---|
| `Id` | ✅ | ✅ | Exact source identity | Confirmed |
| `Hubspot_lead_lifecycle__c` | ✅ | ✅ | Lifecycle value | Confirmed |
| `SystemModstamp` | ✅ | ✅ | Pagination key and staleness guard | Confirmed |
| `LastModifiedDate` | ✅ | ✅ | Secondary change evidence | Confirmed |
| `IsConverted` | ✅ | — | Conversion state | Confirmed |
| `ConvertedContactId` | ✅ | — | Exact cross-object identity | Confirmed |
| Became Lead date | ? | ? | Supporting evidence only | **UNRESOLVED** |
| Became MQL date | ? | ? | Supporting evidence only | **UNRESOLVED** |

The two Became date API names were deliberately left unresolved by 4G1
pending human confirmation. They are **optional** supporting evidence, so
their absence is reported rather than fatal, and the preflight node
**fails loudly** on any unresolved *required* field. A guessed date field
would silently corroborate the wrong thing.

## Pagination and completeness

Ordering is `SystemModstamp ASC, Id ASC`. Ordering by timestamp alone is
unsafe: records sharing one `SystemModstamp` straddle a page boundary and
are silently skipped or repeated. The `Id` tie-break makes the ordering
total.

- A **duplicate Id across pages is a hard failure**, never deduplicated:
  it means the pagination key is wrong, and quietly removing it would
  hide the defect.
- **Lifecycle extraction and converted-identity extraction are
  independent completeness axes.** They fail independently, so a complete
  lifecycle sweep with a truncated identity sweep is still an incomplete
  run.
- A first run's watermark floor is the beginning of time. **A two-day
  window cannot produce a first baseline**: 4G1 measured 103,070 org-wide
  rows against a workflow that assumes 5,000.
- An incomplete run **may not propose a watermark**. `proposedWatermark`
  returns `null` unless *both* axes completed.

## First-run semantics: baseline only

The first successful run observes current state and asserts nothing about
the past:

- First observed Lead → `null -> lead`, kind `baseline`.
- First observed MQL → `null -> mql`, kind `baseline`. This means "first
  observed as MQL", **never** "moved from Lead to MQL".
- First observed out-of-scope or unknown → stored as evidence with **no**
  invented funnel event.
- **Zero** Lead-to-MQL transitions, **zero** returns, **zero**
  requalifications.
- Became Lead / Became MQL dates never manufacture an event.

This is not a new rule; it is Bite 4G2A's contract, reused unchanged. The
current lifecycle values are a photograph of today, and 4G1 proved the
org holds **zero** lifecycle-history rows, so no transition exists to be
read.

## Authoritative calculation

**No second lifecycle planner is written inside n8n.** n8n cannot execute
repository TypeScript, and a hand-copied planner in a Code node would
drift from the authority the moment either side changed.

The established 4G1 pattern is reused:

1. The disabled n8n workflow produces a **private raw export** for local
   evaluation.
2. A **local, uncommitted evaluator** invokes the real
   `planLifecycleObservations` and the real `serializeLifecycleApply`
   from this repository.
3. The evaluator emits **aggregate diagnostics only**.
4. The raw export is **deleted after evaluation**.

The evaluator is deliberately not committed: it exists to be pointed at a
private file containing real Salesforce records, and committing it would
invite exactly the leak the whole program guards against.

## Required aggregate output

The GUARD node emits counts only, and asserts `transitions`, `returns`,
and `requalifications` are all `0`, alongside `dry_run: true`,
`writes_attempted: 0`, and `apply_payload_created: false`.

**No Salesforce ids, names, emails, companies, campaign names, or source
rows appear in GUARD output.** Unknown lifecycle values are reported as
normalized label plus count so a new picklist entry is visible without
exposing a record.

Campaign names may exist **only** in the clearly marked PRIVATE n8n-only
scope-decision node. That node is currently empty: **no campaign scope is
approved**, and the default basis is identity-anchored.

## Workflow safety

`active: false` · Manual Trigger only · no schedule node · no webhook ·
no write-capable Salesforce operation (`search` only) · no
Supabase/Postgres/RPC write · no Google Sheets write · no HTTP write · no
credentials or credential ids · no pinned data · no real record ids.

`executeOnce: true` on every Salesforce node prevents query
amplification. **GUARD is the only successful terminal**: truncation,
duplicate ids, broken ordering, or placeholder configuration all throw.

The intended future schedule timezone is recorded as **`America/Denver`**
in node notes and GUARD output, but **no schedule node exists**.

## The eventual write boundary

When ingestion is eventually built (4G2B2B), the serialized payload goes
to `sf_apply_lifecycle_observations`, whose contract is documented in
`docs/lead-lifecycle-atomic-apply.md`. Two properties matter most for the
caller:

- PostgreSQL returns the function's JSON with a **successful SQL status
  even when the batch failed**. Any `outcome` other than `success` is a
  workflow failure.
- The watermark advances **only** on a fully successful batch.

Neither applies yet: nothing calls that function today, and all seven
lifecycle tables remain empty.

## The workflow template

Sanitized, `active: false`, read-only. Import it into n8n only if you
intend to run the dry run manually; it carries no credentials, so every
Salesforce node needs one attached before it can execute.

A convenience copy lives outside the repository at
`~/Downloads/[Sourced] 4G2B2A Lifecycle Dry Run (DISABLED).json`.

```json
{
  "name": "[Sourced] 4G2B2A Lifecycle Ingestion DRY RUN (DISABLED, READ-ONLY)",
  "nodes": [
    {
      "parameters": {},
      "id": "node-manual-trigger",
      "name": "Manual Trigger (no schedule)",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [
        -260,
        300
      ],
      "notes": "DISABLED DRY RUN. Manual only. The intended future schedule timezone is America/Denver, deliberately NOT configured here."
    },
    {
      "parameters": {
        "jsCode": "// Fails BEFORE any query when configuration is a placeholder. A dry run\n// that silently queries with an unresolved field name would produce\n// confident nonsense.\nconst UNRESOLVED = 'UNRESOLVED';\nconst LIFECYCLE_FIELD = 'Hubspot_lead_lifecycle__c';\n\n// The Became Lead / Became MQL date API names were deliberately left\n// UNRESOLVED by Bite 4G1 pending human confirmation. They are optional\n// supporting evidence, so their absence is reported, not fatal. A\n// REQUIRED unresolved field is fatal.\nconst required = [\n  ['lifecycle field', LIFECYCLE_FIELD],\n  ['pagination key', 'SystemModstamp'],\n  ['identity key', 'Id'],\n  ['conversion link', 'ConvertedContactId']\n];\nfor (const [label, value] of required) {\n  if (!value || value === UNRESOLVED) {\n    throw new Error('PREFLIGHT FAILED: required ' + label + ' is unresolved. '\n      + 'Confirm the API name before running. Never guess a field name.');\n  }\n}\n\n// The watermark floor for a FIRST run is the beginning of time: a first\n// baseline must cover the entire approved population, and a two-day\n// window cannot do that (Bite 4G1 measured 103,070 org-wide rows).\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  watermark_floor: '1970-01-01T00:00:00Z',\n  unresolved_optional_fields: ['became_lead_date', 'became_mql_date'],\n  intended_future_schedule_timezone: 'America/Denver'\n} }];"
      },
      "id": "node-preflight-resolve-configuration",
      "name": "Preflight: resolve configuration",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -40,
        300
      ],
      "executeOnce": true,
      "notes": "Fails loudly on placeholder configuration before any query runs."
    },
    {
      "parameters": {
        "jsCode": "// PRIVATE, n8n-ONLY. Nothing in this node may reach the repository or\n// the GUARD output. It exists so a human can state the approved scope\n// WITHOUT that statement becoming committed evidence.\n//\n// Bite 4G2B2A does NOT approve a campaign-based population. The default\n// safe hypothesis is identity-anchored: observe people Sourced already\n// tracks by exact Salesforce id, plus candidates the approved import\n// path would admit. Campaign filters, if ever approved, belong here and\n// nowhere else.\nconst APPROVED_CAMPAIGN_SCOPE = [];  // intentionally empty: none approved\n\n// Emitted downstream as a COUNT only. Never the names themselves.\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  approved_campaign_scope_count: APPROVED_CAMPAIGN_SCOPE.length,\n  scope_basis: 'identity_anchored_default'\n} }];"
      },
      "id": "node-private-approved-scope-decision",
      "name": "PRIVATE: approved scope decision",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -40,
        480
      ],
      "executeOnce": true,
      "notes": "PRIVATE n8n-only. Campaign names may live ONLY here and must never reach the repository or GUARD output. Currently empty: no campaign scope is approved."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "=SELECT Id, Hubspot_lead_lifecycle__c, SystemModstamp, LastModifiedDate, IsConverted, ConvertedContactId FROM Lead WHERE SystemModstamp >= {{ $json.watermark_floor }} ORDER BY SystemModstamp ASC, Id ASC LIMIT 200",
        "options": {}
      },
      "id": "node-extract-lead-lifecycle-(page-1)",
      "name": "Extract: Lead lifecycle (page 1)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        200,
        180
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ-ONLY search. executeOnce prevents query amplification. Ordered by (SystemModstamp, Id) so a shared timestamp at a page boundary cannot skip or repeat a record."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "=SELECT Id, Hubspot_lead_lifecycle__c, SystemModstamp, LastModifiedDate FROM Contact WHERE SystemModstamp >= {{ $json.watermark_floor }} ORDER BY SystemModstamp ASC, Id ASC LIMIT 200",
        "options": {}
      },
      "id": "node-extract-contact-lifecycle-(page-1)",
      "name": "Extract: Contact lifecycle (page 1)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        200,
        340
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ-ONLY search. Same deterministic ordering."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "=SELECT Id, ConvertedContactId, SystemModstamp FROM Lead WHERE IsConverted = true AND SystemModstamp >= {{ $json.watermark_floor }} ORDER BY SystemModstamp ASC, Id ASC LIMIT 200",
        "options": {}
      },
      "id": "node-extract-converted-identity-(page-1)",
      "name": "Extract: converted identity (page 1)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        200,
        500
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ-ONLY search. Independent completeness axis from lifecycle."
    },
    {
      "parameters": {
        "jsCode": "// GUARD: the ONLY successful terminal in this workflow. Every failure\n// mode below throws rather than returning a green run, because a dry run\n// that reports success while silently truncating is worse than no dry\n// run at all.\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n\nconst leadRows    = realRows($('Extract: Lead lifecycle (page 1)').all());\nconst contactRows = realRows($('Extract: Contact lifecycle (page 1)').all());\nconst identRows   = realRows($('Extract: converted identity (page 1)').all());\nconst pre         = realRows($('Preflight: resolve configuration').all())[0] || {};\nconst scope       = realRows($('PRIVATE: approved scope decision').all())[0] || {};\n\nconst PAGE_LIMIT = 200;\n\n// --- Completeness. Two INDEPENDENT axes: they fail independently, so a\n// complete lifecycle sweep with a truncated identity sweep is still an\n// incomplete run and must not advance a watermark.\nconst lifecycleTruncated = (leadRows.length >= PAGE_LIMIT) || (contactRows.length >= PAGE_LIMIT);\nconst identityTruncated  = identRows.length >= PAGE_LIMIT;\n\n// --- Duplicate pagination keys are a HARD failure: a repeated Id means\n// the ordering key is wrong, and deduplicating would hide that.\nconst dupCount = (rows) => {\n  const seen = new Set(); let dups = 0;\n  for (const r of rows) { const id = r.Id; if (!id) continue;\n    if (seen.has(id)) dups += 1; else seen.add(id); }\n  return dups;\n};\nconst dupLead = dupCount(leadRows), dupContact = dupCount(contactRows), dupIdent = dupCount(identRows);\nif (dupLead || dupContact || dupIdent) {\n  throw new Error('GUARD FAILED: duplicate Salesforce Ids within a page ('\n    + dupLead + '/' + dupContact + '/' + dupIdent + '). The pagination key is wrong.');\n}\n\n// --- Ordering must be strictly increasing on (SystemModstamp, Id).\nconst outOfOrder = (rows) => {\n  let bad = 0, prev = null;\n  for (const r of rows) {\n    const cur = String(r.SystemModstamp || '') + '|' + String(r.Id || '');\n    if (prev !== null && cur <= prev) bad += 1;\n    prev = cur;\n  }\n  return bad;\n};\nif (outOfOrder(leadRows) || outOfOrder(contactRows) || outOfOrder(identRows)) {\n  throw new Error('GUARD FAILED: rows are not strictly ordered by (SystemModstamp, Id).');\n}\n\n// --- Lifecycle value classification. AGGREGATE ONLY: labels and counts,\n// never a record. Unmapped values are surfaced for review, never guessed.\nconst APPROVED = {\n  'Lead': 'lead', 'Marketing Qualified Lead': 'mql',\n  'Customer': 'out_of_scope', 'Internal': 'out_of_scope',\n  'Opportunity': 'out_of_scope', 'Other': 'out_of_scope',\n  'Partner': 'out_of_scope', 'Prospect': 'out_of_scope',\n  'Sales Qualified Lead': 'out_of_scope', 'Subscriber': 'out_of_scope'\n};\nconst byState = { lead: 0, mql: 0, out_of_scope: 0, unknown: 0 };\nconst unknownLabels = {};\nlet missingLifecycle = 0;\nfor (const r of leadRows.concat(contactRows)) {\n  const raw = r['Hubspot_lead_lifecycle__c'];\n  if (raw === null || raw === undefined || String(raw).trim() === '') { missingLifecycle += 1; byState.unknown += 1; continue; }\n  const mapped = APPROVED[String(raw)];\n  if (!mapped) { byState.unknown += 1; unknownLabels[String(raw)] = (unknownLabels[String(raw)] || 0) + 1; }\n  else { byState[mapped] += 1; }\n}\n\n// --- Exact converted identity pairs. ConvertedContactId ONLY.\nlet exactPairs = 0, malformedPairs = 0;\nconst SFID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;\nfor (const r of identRows) {\n  if (SFID.test(String(r.Id || '')) && SFID.test(String(r.ConvertedContactId || ''))) exactPairs += 1;\n  else malformedPairs += 1;\n}\n\nconst complete = !lifecycleTruncated && !identityTruncated;\nconst incompleteReasons = [];\nif (lifecycleTruncated) incompleteReasons.push('lifecycle extraction truncated at the page limit');\nif (identityTruncated)  incompleteReasons.push('identity extraction truncated at the page limit');\n\n// A FIRST run is baseline-only by construction: current values are a\n// photograph, never a record of movement. These three MUST be zero.\nconst transitions = 0, returns = 0, requalifications = 0;\n\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  apply_payload_created: false,\n  scope_basis: scope.scope_basis || 'identity_anchored_default',\n  approved_campaign_scope_count: scope.approved_campaign_scope_count || 0,\n  lead_records_seen: leadRows.length,\n  contact_records_seen: contactRows.length,\n  exact_converted_identity_pairs: exactPairs,\n  malformed_identity_pairs: malformedPairs,\n  baseline_observations_by_state: byState,\n  unknown_lifecycle_labels: unknownLabels,\n  missing_lifecycle_values: missingLifecycle,\n  duplicate_source_ids: 0,\n  transitions: transitions,\n  returns: returns,\n  requalifications: requalifications,\n  lifecycle_pages_completed: 1,\n  lifecycle_possibly_truncated: lifecycleTruncated,\n  identity_pages_completed: 1,\n  identity_possibly_truncated: identityTruncated,\n  plan_complete: complete,\n  incomplete_reasons: incompleteReasons,\n  proposed_watermark: complete ? (leadRows.length ? leadRows[leadRows.length - 1].SystemModstamp : null) : null,\n  unresolved_optional_fields: pre.unresolved_optional_fields || [],\n  intended_future_schedule_timezone: 'America/Denver'\n} }];"
      },
      "id": "node-guard-dry-run-summary",
      "name": "GUARD: dry-run summary",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        460,
        340
      ],
      "executeOnce": true,
      "notes": "The ONLY successful terminal. Throws on truncation, duplicate ids, or broken ordering. Emits aggregate counts only: no Salesforce ids, names, emails, companies, campaign names, or source rows."
    }
  ],
  "connections": {
    "Manual Trigger (no schedule)": {
      "main": [
        [
          {
            "node": "Preflight: resolve configuration",
            "type": "main",
            "index": 0
          },
          {
            "node": "PRIVATE: approved scope decision",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Preflight: resolve configuration": {
      "main": [
        [
          {
            "node": "Extract: Lead lifecycle (page 1)",
            "type": "main",
            "index": 0
          },
          {
            "node": "Extract: Contact lifecycle (page 1)",
            "type": "main",
            "index": 0
          },
          {
            "node": "Extract: converted identity (page 1)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Extract: Lead lifecycle (page 1)": {
      "main": [
        [
          {
            "node": "GUARD: dry-run summary",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Extract: Contact lifecycle (page 1)": {
      "main": [
        [
          {
            "node": "GUARD: dry-run summary",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Extract: converted identity (page 1)": {
      "main": [
        [
          {
            "node": "GUARD: dry-run summary",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": false,
  "settings": {
    "executionOrder": "v1"
  },
  "tags": []
}
```
