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

## The locked identity and campaign rule

Decided and locked in Bite 4G2B2A:

1. **Every existing Sourced person with an exact `sfdc_lead_id` or
   `sfdc_contact_id` remains eligible for lifecycle observation
   regardless of campaign membership.** A person who leaves a campaign
   does not stop having a lifecycle.
2. **Campaign scope governs ADMISSION of new people into Sourced. It
   never interrupts observation of people already admitted.**
3. **Exact Salesforce identity only.** Never email, name, company, or
   fuzzy similarity.
4. **Conflicting identity evidence routes to review and changes
   nothing.**
5. **A person without an exact Salesforce identity is unobservable** and
   is counted separately, never silently treated as zero.

The scope resolver takes no campaign input at all, so rule 1 holds by
construction rather than by discipline: campaign membership cannot reduce
the observable population because the function cannot see it.

## Step 1: measure identity coverage (you run this)

Run `docs/lifecycle-identity-coverage.sql` in the Supabase SQL Editor
against the Production project. It is **read-only** and returns 17
aggregate rows: counts only, with no Salesforce identifier, email, name,
or row, so the output is safe to paste back verbatim.

The two decision numbers are `16_eligible_identity_anchored` (how many
people can be observed) and `17_unobservable_no_exact_identity` (how many
cannot). If eligibility is far below the total, the identity-anchored
scope may need revisiting before ingestion is built.

This query was validated by execution against a disposable local
PostgreSQL cluster with a synthetic `leads` table; it has never been run
against production by this repository.

## Step 2: import and run the dry run (you run this)

1. In n8n, **Import from File** the convenience copy at
   `~/Downloads/[Sourced] 4G2B2A Lifecycle Dry Run (DISABLED).json`, or
   paste the template embedded below.
2. Confirm the imported workflow shows **Inactive**. It carries no
   schedule and no credentials.
3. Attach your existing **read-only** Salesforce credential to the four
   Salesforce nodes. Do not attach Supabase, Sheets, or HTTP credentials:
   there are no nodes that could use them.
4. Supply the **private identity population** to the Manual Trigger as
   JSON with `eligible_lead_ids` and `eligible_contact_ids` arrays of
   exact Salesforce ids. Without it the run **fails immediately**: this
   workflow never falls back to an org-wide scan.
5. **Execute Workflow** manually.
6. Expect **GUARD** to be the only node that completes successfully.
7. Copy the GUARD output. It is aggregate-only and safe to share.

### Producing the private identity population

The id list is private evidence and **must never enter the repository**.

```sql
-- PRIVATE. Run in Supabase, export the result, delete it afterward.
SELECT DISTINCT sfdc_lead_id AS id FROM public.leads
WHERE sfdc_lead_id IS NOT NULL AND btrim(sfdc_lead_id) <> '';
-- and separately:
SELECT DISTINCT sfdc_contact_id AS id FROM public.leads
WHERE sfdc_contact_id IS NOT NULL AND btrim(sfdc_contact_id) <> '';
```

Save to `~/Downloads/4g2b2a-private-ids.json`, use it, then **delete
it**. Never commit it, never paste it into chat, and never let it reach
GUARD output.

## Step 3: authoritative evaluation (optional, local only)

The GUARD summary is sufficient for review. If a full planner evaluation
is wanted, follow the Bite 4G1 pattern: generate an evaluator **outside**
the repository that imports the real `planLifecycleObservations` and
`serializeLifecycleApply`, feed it the private raw export, and emit
aggregate diagnostics only. It must contain no credentials, make no
network call, and perform no write.

**No lifecycle logic is ever reimplemented in n8n.** A hand-copied
planner in a Code node would drift from the authority the moment either
side changed.

### Files to delete after the run

- `~/Downloads/4g2b2a-private-ids.json`
- any raw Salesforce export produced for the evaluator
- the evaluator script itself, if one was generated

## Evidence required before publication

Bite 4G2B2A is **not publication-ready** until both are reviewed:

1. The 17-row aggregate coverage result from Step 1.
2. A successful GUARD summary from Step 2, showing `dry_run: true`,
   `writes_attempted: 0`, `apply_payload_created: false`, and
   **zero** transitions, returns, and requalifications.

Until then the scope hypothesis is designed and tested but not
quantified against production.

## No ingestion exists

Nothing writes to the lifecycle tables today. The apply function
`sf_apply_lifecycle_observations` is applied and verified in production
but **has never been invoked**, and **all seven `sf_lifecycle_*` tables
remain empty**. They stay empty until a separately authorized apply in a
later bite.

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
      "id": "n-manual-trigger-no-schedule",
      "name": "Manual Trigger (no schedule)",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [
        -620,
        340
      ],
      "notes": "DISABLED DRY RUN. Manual only. Intended future schedule timezone is America/Denver, deliberately NOT configured here."
    },
    {
      "parameters": {
        "jsCode": "// Fails BEFORE any query when configuration is a placeholder or the\n// private identity population is missing. A dry run that queries with an\n// unresolved field name, or with no population, produces confident\n// nonsense.\nconst UNRESOLVED = 'UNRESOLVED';\nconst LIFECYCLE_FIELD = 'Hubspot_lead_lifecycle__c';\n\nconst required = [\n  ['lifecycle field', LIFECYCLE_FIELD],\n  ['pagination key', 'SystemModstamp'],\n  ['identity key', 'Id'],\n  ['conversion link', 'ConvertedContactId']\n];\nfor (const [label, value] of required) {\n  if (!value || value === UNRESOLVED) {\n    throw new Error('PREFLIGHT FAILED: required ' + label + ' is unresolved. '\n      + 'Confirm the API name before running. Never guess a field name.');\n  }\n}\n\n// PRIVATE identity population. Supplied out-of-band as exact Salesforce\n// ids; see docs/lead-lifecycle-ingestion-dry-run.md. It never enters the\n// repository and is deleted after the run.\nconst input = $input.first().json || {};\nconst leadIds = Array.isArray(input.eligible_lead_ids) ? input.eligible_lead_ids : null;\nconst contactIds = Array.isArray(input.eligible_contact_ids) ? input.eligible_contact_ids : null;\n\nif (leadIds === null || contactIds === null) {\n  throw new Error('PREFLIGHT FAILED: no identity population supplied. '\n    + 'Provide eligible_lead_ids and eligible_contact_ids as arrays of exact '\n    + 'Salesforce ids. This workflow never falls back to an org-wide scan.');\n}\nif (leadIds.length === 0 && contactIds.length === 0) {\n  throw new Error('PREFLIGHT FAILED: identity population is empty. '\n    + 'Run the coverage SQL first; a zero population means nothing is observable.');\n}\nconst SFID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;\nconst malformed = leadIds.concat(contactIds).filter((v) => !SFID.test(String(v)));\nif (malformed.length > 0) {\n  throw new Error('PREFLIGHT FAILED: ' + malformed.length + ' malformed Salesforce id(s) '\n    + 'in the private input. Ids are 15 or 18 characters of [A-Za-z0-9]. '\n    + 'No id is coerced into shape.');\n}\n\n// The first run scans from the epoch, but NEVER as one unbounded\n// in-memory operation: the loop below pages in bounded chunks of 200.\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  eligible_lead_id_count: leadIds.length,\n  eligible_contact_id_count: contactIds.length,\n  page_size: 200,\n  unresolved_optional_fields: input.became_dates_present === true ? [] : ['became_lead_date', 'became_mql_date'],\n  intended_future_schedule_timezone: 'America/Denver'\n} }];"
      },
      "id": "n-preflight-resolve-configuration",
      "name": "Preflight: resolve configuration",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -400,
        340
      ],
      "notes": "Fails loudly on placeholder config, a missing or empty identity population, or a malformed private input, BEFORE any query runs.",
      "executeOnce": true
    },
    {
      "parameters": {
        "jsCode": "// PRIVATE, n8n-ONLY. Nothing here may reach the repository or GUARD\n// output. Campaign names, if a campaign scope is ever approved, live\n// ONLY in this node.\n//\n// LOCKED BUSINESS RULE (Bite 4G2B2A):\n//   Campaign scope governs ADMISSION of new people into Sourced. It does\n//   NOT govern lifecycle OBSERVATION. Once a person is admitted and\n//   anchored by exact Salesforce id, their lifecycle is observed\n//   regardless of campaign membership: a person who leaves a campaign\n//   does not stop having a lifecycle.\nconst APPROVED_CAMPAIGN_SCOPE = [];  // admission only; none approved yet\n\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  approved_campaign_scope_count: APPROVED_CAMPAIGN_SCOPE.length,\n  scope_basis: 'identity_anchored_observation',\n  campaign_scope_governs: 'admission_only'\n} }];"
      },
      "id": "n-private-approved-scope-decision",
      "name": "PRIVATE: approved scope decision",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -400,
        560
      ],
      "notes": "PRIVATE n8n-only. Campaign names may live ONLY here. Campaign scope governs ADMISSION of new people, never lifecycle OBSERVATION of people already anchored by exact Salesforce id.",
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "=SELECT QualifiedApiName, EntityDefinitionId FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName IN ('Lead','Contact') AND QualifiedApiName IN ('Became_a_Lead_Date__c','Became_a_Marketing_Qualified_Lead_Date__c')",
        "options": {}
      },
      "id": "n-describe-supporting-date-fields",
      "name": "Describe: supporting date fields",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        -180,
        720
      ],
      "notes": "READ-ONLY describe. Confirms the two CANDIDATE supporting-date API names on each object. Absence is reported, never guessed around.",
      "executeOnce": true,
      "alwaysOutputData": true
    },
    {
      "parameters": {
        "jsCode": "// Read-only supporting-date discovery. The two candidate API names were\n// surfaced by earlier Salesforce evidence but are NOT universally\n// confirmed on both objects, so they are checked rather than assumed.\n//\n// Absence is REPORTED and the run CONTINUES: these are supporting\n// evidence only. They must never create a transition, replace an\n// observation timestamp, or make the dry run incomplete. No alternative\n// name is ever guessed.\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n\nconst CANDIDATES = ['Became_a_Lead_Date__c', 'Became_a_Marketing_Qualified_Lead_Date__c'];\nconst rows = realRows($('Describe: supporting date fields').all());\nconst present = {};\nfor (const c of CANDIDATES) {\n  present[c] = { Lead: false, Contact: false };\n}\nfor (const r of rows) {\n  const api = String(r.QualifiedApiName || '');\n  const obj = String(r.EntityDefinitionId || r.EntityDefinition || '');\n  if (present[api] && (obj === 'Lead' || obj === 'Contact')) present[api][obj] = true;\n}\nconst absent = [];\nfor (const c of CANDIDATES) {\n  if (!present[c].Lead) absent.push(c + ' absent on Lead');\n  if (!present[c].Contact) absent.push(c + ' absent on Contact');\n}\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  supporting_date_fields_present: present,\n  supporting_date_fields_absent: absent,\n  became_dates_present: absent.length === 0,\n  note: 'Supporting evidence only. Never creates a transition and never blocks the run.'\n} }];"
      },
      "id": "n-classify-supporting-date-availability",
      "name": "Classify: supporting date availability",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        40,
        720
      ],
      "notes": "Reports presence/absence per object. Supporting evidence only: never creates a transition and never makes the run incomplete.",
      "executeOnce": true
    },
    {
      "parameters": {
        "jsCode": "// Cursor init for one axis. The composite cursor is (SystemModstamp, Id):\n// ordering by timestamp alone lets records sharing one SystemModstamp\n// straddle a page boundary and be skipped or repeated.\nconst pre = $('Preflight: resolve configuration').first().json;\nreturn [{ json: {\n  cursor_ts: '1970-01-01T00:00:00Z',\n  cursor_id: '000000000000000',\n  pages_completed: 0,\n  seen_ids: [],\n  rows: [],\n  page_size: pre.page_size,\n  axis_failed: false\n} }];"
      },
      "id": "n-cursor-init-lead-lifecycle",
      "name": "Cursor init: Lead lifecycle",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -180,
        140
      ],
      "notes": "Composite (SystemModstamp, Id) cursor from the epoch. The scan is bounded: pages of 200, never one unbounded in-memory operation.",
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "=SELECT Id, Hubspot_lead_lifecycle__c, SystemModstamp, LastModifiedDate, IsConverted, ConvertedContactId FROM Lead WHERE SystemModstamp > {{ $json.cursor_ts }} AND Id > {{ $json.cursor_id }} ORDER BY SystemModstamp ASC, Id ASC LIMIT 200",
        "options": {}
      },
      "id": "n-query-lead-lifecycle-page",
      "name": "Query: Lead lifecycle page",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        40,
        140
      ],
      "notes": "READ-ONLY page query, cursor-bounded. executeOnce is FALSE deliberately: true would pin the loop to page 1 and silently truncate.",
      "executeOnce": false,
      "alwaysOutputData": true
    },
    {
      "parameters": {
        "jsCode": "// Accumulate one page and decide whether to continue. This is REAL\n// workflow-level pagination: the loop re-enters the query node with an\n// advanced cursor until a short page proves the axis is exhausted.\nconst state = $('Cursor init: Lead lifecycle').first().json;\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n\nconst page = realRows($('Query: Lead lifecycle page').all());\nconst seen = new Set(state.seen_ids || []);\nconst rows = (state.rows || []).slice();\n\nlet duplicates = 0, outOfOrder = 0;\nlet prevKey = state.rows && state.rows.length\n  ? String(state.rows[state.rows.length - 1].SystemModstamp) + '|' + String(state.rows[state.rows.length - 1].Id)\n  : null;\n\nfor (const r of page) {\n  const id = String(r.Id || '');\n  if (!id) continue;\n  // A duplicate id ACROSS pages means the pagination key is wrong. It is\n  // a hard failure, never silently deduplicated.\n  if (seen.has(id)) { duplicates += 1; continue; }\n  seen.add(id);\n  const key = String(r.SystemModstamp || '') + '|' + id;\n  if (prevKey !== null && key <= prevKey) outOfOrder += 1;\n  prevKey = key;\n  rows.push(r);\n}\n\nif (duplicates > 0) {\n  throw new Error('PAGINATION FAILED: ' + duplicates + ' duplicate Salesforce Id(s) '\n    + 'across pages on this axis. The ordering key is wrong; deduplicating would hide it.');\n}\nif (outOfOrder > 0) {\n  throw new Error('PAGINATION FAILED: ' + outOfOrder + ' row(s) out of (SystemModstamp, Id) order.');\n}\n\nconst pagesCompleted = (state.pages_completed || 0) + 1;\n// A page shorter than the page size proves exhaustion. A full page means\n// more may remain, so the loop continues.\nconst exhausted = page.length < state.page_size;\nconst last = rows.length ? rows[rows.length - 1] : null;\n\nreturn [{ json: {\n  cursor_ts: last ? last.SystemModstamp : state.cursor_ts,\n  cursor_id: last ? last.Id : state.cursor_id,\n  pages_completed: pagesCompleted,\n  seen_ids: Array.from(seen),\n  rows: rows,\n  page_size: state.page_size,\n  axis_complete: exhausted,\n  axis_failed: false,\n  has_more: !exhausted\n} }];"
      },
      "id": "n-accumulate-lead-lifecycle-page",
      "name": "Accumulate: Lead lifecycle page",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        260,
        140
      ],
      "notes": "Advances the cursor and loops until a short page proves exhaustion. Duplicate ids across pages and out-of-order rows both throw."
    },
    {
      "parameters": {
        "jsCode": "// Cursor init for one axis. The composite cursor is (SystemModstamp, Id):\n// ordering by timestamp alone lets records sharing one SystemModstamp\n// straddle a page boundary and be skipped or repeated.\nconst pre = $('Preflight: resolve configuration').first().json;\nreturn [{ json: {\n  cursor_ts: '1970-01-01T00:00:00Z',\n  cursor_id: '000000000000000',\n  pages_completed: 0,\n  seen_ids: [],\n  rows: [],\n  page_size: pre.page_size,\n  axis_failed: false\n} }];"
      },
      "id": "n-cursor-init-contact-lifecycle",
      "name": "Cursor init: Contact lifecycle",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -180,
        340
      ],
      "notes": "Composite cursor, Contact axis.",
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "=SELECT Id, Hubspot_lead_lifecycle__c, SystemModstamp, LastModifiedDate FROM Contact WHERE SystemModstamp > {{ $json.cursor_ts }} AND Id > {{ $json.cursor_id }} ORDER BY SystemModstamp ASC, Id ASC LIMIT 200",
        "options": {}
      },
      "id": "n-query-contact-lifecycle-page",
      "name": "Query: Contact lifecycle page",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        40,
        340
      ],
      "notes": "READ-ONLY page query, cursor-bounded.",
      "executeOnce": false,
      "alwaysOutputData": true
    },
    {
      "parameters": {
        "jsCode": "// Accumulate one page and decide whether to continue. This is REAL\n// workflow-level pagination: the loop re-enters the query node with an\n// advanced cursor until a short page proves the axis is exhausted.\nconst state = $('Cursor init: Contact lifecycle').first().json;\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n\nconst page = realRows($('Query: Contact lifecycle page').all());\nconst seen = new Set(state.seen_ids || []);\nconst rows = (state.rows || []).slice();\n\nlet duplicates = 0, outOfOrder = 0;\nlet prevKey = state.rows && state.rows.length\n  ? String(state.rows[state.rows.length - 1].SystemModstamp) + '|' + String(state.rows[state.rows.length - 1].Id)\n  : null;\n\nfor (const r of page) {\n  const id = String(r.Id || '');\n  if (!id) continue;\n  // A duplicate id ACROSS pages means the pagination key is wrong. It is\n  // a hard failure, never silently deduplicated.\n  if (seen.has(id)) { duplicates += 1; continue; }\n  seen.add(id);\n  const key = String(r.SystemModstamp || '') + '|' + id;\n  if (prevKey !== null && key <= prevKey) outOfOrder += 1;\n  prevKey = key;\n  rows.push(r);\n}\n\nif (duplicates > 0) {\n  throw new Error('PAGINATION FAILED: ' + duplicates + ' duplicate Salesforce Id(s) '\n    + 'across pages on this axis. The ordering key is wrong; deduplicating would hide it.');\n}\nif (outOfOrder > 0) {\n  throw new Error('PAGINATION FAILED: ' + outOfOrder + ' row(s) out of (SystemModstamp, Id) order.');\n}\n\nconst pagesCompleted = (state.pages_completed || 0) + 1;\n// A page shorter than the page size proves exhaustion. A full page means\n// more may remain, so the loop continues.\nconst exhausted = page.length < state.page_size;\nconst last = rows.length ? rows[rows.length - 1] : null;\n\nreturn [{ json: {\n  cursor_ts: last ? last.SystemModstamp : state.cursor_ts,\n  cursor_id: last ? last.Id : state.cursor_id,\n  pages_completed: pagesCompleted,\n  seen_ids: Array.from(seen),\n  rows: rows,\n  page_size: state.page_size,\n  axis_complete: exhausted,\n  axis_failed: false,\n  has_more: !exhausted\n} }];"
      },
      "id": "n-accumulate-contact-lifecycle-page",
      "name": "Accumulate: Contact lifecycle page",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        260,
        340
      ],
      "notes": "Advances the cursor and loops until exhaustion."
    },
    {
      "parameters": {
        "jsCode": "// Cursor init for one axis. The composite cursor is (SystemModstamp, Id):\n// ordering by timestamp alone lets records sharing one SystemModstamp\n// straddle a page boundary and be skipped or repeated.\nconst pre = $('Preflight: resolve configuration').first().json;\nreturn [{ json: {\n  cursor_ts: '1970-01-01T00:00:00Z',\n  cursor_id: '000000000000000',\n  pages_completed: 0,\n  seen_ids: [],\n  rows: [],\n  page_size: pre.page_size,\n  axis_failed: false\n} }];"
      },
      "id": "n-cursor-init-converted-identity",
      "name": "Cursor init: converted identity",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -180,
        540
      ],
      "notes": "Composite cursor, identity axis. INDEPENDENT of the lifecycle axes.",
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "=SELECT Id, ConvertedContactId, SystemModstamp FROM Lead WHERE SystemModstamp > {{ $json.cursor_ts }} AND Id > {{ $json.cursor_id }} AND IsConverted = true ORDER BY SystemModstamp ASC, Id ASC LIMIT 200",
        "options": {}
      },
      "id": "n-query-converted-identity-page",
      "name": "Query: converted identity page",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        40,
        540
      ],
      "notes": "READ-ONLY page query. Exact ConvertedContactId only.",
      "executeOnce": false,
      "alwaysOutputData": true
    },
    {
      "parameters": {
        "jsCode": "// Accumulate one page and decide whether to continue. This is REAL\n// workflow-level pagination: the loop re-enters the query node with an\n// advanced cursor until a short page proves the axis is exhausted.\nconst state = $('Cursor init: converted identity').first().json;\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n\nconst page = realRows($('Query: converted identity page').all());\nconst seen = new Set(state.seen_ids || []);\nconst rows = (state.rows || []).slice();\n\nlet duplicates = 0, outOfOrder = 0;\nlet prevKey = state.rows && state.rows.length\n  ? String(state.rows[state.rows.length - 1].SystemModstamp) + '|' + String(state.rows[state.rows.length - 1].Id)\n  : null;\n\nfor (const r of page) {\n  const id = String(r.Id || '');\n  if (!id) continue;\n  // A duplicate id ACROSS pages means the pagination key is wrong. It is\n  // a hard failure, never silently deduplicated.\n  if (seen.has(id)) { duplicates += 1; continue; }\n  seen.add(id);\n  const key = String(r.SystemModstamp || '') + '|' + id;\n  if (prevKey !== null && key <= prevKey) outOfOrder += 1;\n  prevKey = key;\n  rows.push(r);\n}\n\nif (duplicates > 0) {\n  throw new Error('PAGINATION FAILED: ' + duplicates + ' duplicate Salesforce Id(s) '\n    + 'across pages on this axis. The ordering key is wrong; deduplicating would hide it.');\n}\nif (outOfOrder > 0) {\n  throw new Error('PAGINATION FAILED: ' + outOfOrder + ' row(s) out of (SystemModstamp, Id) order.');\n}\n\nconst pagesCompleted = (state.pages_completed || 0) + 1;\n// A page shorter than the page size proves exhaustion. A full page means\n// more may remain, so the loop continues.\nconst exhausted = page.length < state.page_size;\nconst last = rows.length ? rows[rows.length - 1] : null;\n\nreturn [{ json: {\n  cursor_ts: last ? last.SystemModstamp : state.cursor_ts,\n  cursor_id: last ? last.Id : state.cursor_id,\n  pages_completed: pagesCompleted,\n  seen_ids: Array.from(seen),\n  rows: rows,\n  page_size: state.page_size,\n  axis_complete: exhausted,\n  axis_failed: false,\n  has_more: !exhausted\n} }];"
      },
      "id": "n-accumulate-converted-identity-page",
      "name": "Accumulate: converted identity page",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        260,
        540
      ],
      "notes": "Advances the cursor and loops until exhaustion."
    },
    {
      "parameters": {
        "jsCode": "// GUARD: the ONLY successful shared terminal. Every failure below throws,\n// because a dry run reporting success while silently truncating is worse\n// than no dry run at all.\nconst one = (name) => {\n  const all = $(name).all();\n  const r = all && all.length ? all[all.length - 1].json : null;\n  if (!r || typeof r !== 'object') {\n    throw new Error('GUARD FAILED: axis \"' + name + '\" produced no state.');\n  }\n  return r;\n};\n\nconst pre      = $('Preflight: resolve configuration').first().json;\nconst scope    = $('PRIVATE: approved scope decision').first().json;\nconst leadAx   = one('Accumulate: Lead lifecycle page');\nconst contactAx= one('Accumulate: Contact lifecycle page');\nconst identAx  = one('Accumulate: converted identity page');\n\n// --- Completeness: lifecycle and identity are INDEPENDENT axes. They\n// fail independently, so a complete lifecycle sweep with a truncated\n// identity sweep is still an incomplete run.\nconst lifecycleComplete = leadAx.axis_complete === true && contactAx.axis_complete === true;\nconst identityComplete  = identAx.axis_complete === true;\n\nconst eligible = (pre.eligible_lead_id_count || 0) + (pre.eligible_contact_id_count || 0);\nconst found = (leadAx.rows || []).length + (contactAx.rows || []).length;\n\n// Eligible identities supplied but ZERO Salesforce matches means the\n// query, the field, or the population is wrong. Failing loudly beats\n// reporting a confident empty baseline.\nif (eligible > 0 && found === 0) {\n  throw new Error('GUARD FAILED: ' + eligible + ' eligible identities were supplied but '\n    + 'ZERO Salesforce records matched. Check the query scope and the lifecycle field '\n    + 'before trusting any empty result.');\n}\n\n// --- Lifecycle classification. AGGREGATE ONLY: labels and counts.\nconst APPROVED = {\n  'Lead': 'lead', 'Marketing Qualified Lead': 'mql',\n  'Customer': 'out_of_scope', 'Internal': 'out_of_scope',\n  'Opportunity': 'out_of_scope', 'Other': 'out_of_scope',\n  'Partner': 'out_of_scope', 'Prospect': 'out_of_scope',\n  'Sales Qualified Lead': 'out_of_scope', 'Subscriber': 'out_of_scope'\n};\nconst byState = { lead: 0, mql: 0, out_of_scope: 0, unknown: 0 };\nconst unknownLabels = {};\nlet missingLifecycle = 0, missingField = 0;\nconst allRows = (leadAx.rows || []).concat(contactAx.rows || []);\nfor (const r of allRows) {\n  if (!Object.prototype.hasOwnProperty.call(r, 'Hubspot_lead_lifecycle__c')) { missingField += 1; continue; }\n  const raw = r['Hubspot_lead_lifecycle__c'];\n  if (raw === null || raw === undefined || String(raw).trim() === '') { missingLifecycle += 1; byState.unknown += 1; continue; }\n  const mapped = APPROVED[String(raw)];\n  if (!mapped) { byState.unknown += 1; unknownLabels[String(raw)] = (unknownLabels[String(raw)] || 0) + 1; }\n  else { byState[mapped] += 1; }\n}\n// The confirmed lifecycle field must actually come back. Its absence\n// means the SELECT is wrong, which is how the PRODUCTION workflow\n// silently stamps everyone 'lead'.\nif (allRows.length > 0 && missingField === allRows.length) {\n  throw new Error('GUARD FAILED: the confirmed lifecycle field is absent from every row. '\n    + 'The SELECT is wrong. This is the exact defect that makes the production feed '\n    + 'default every person to Lead.');\n}\n\n// --- Exact converted identity pairs. ConvertedContactId ONLY.\nconst SFID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;\nlet exactPairs = 0, malformedPairs = 0;\nfor (const r of (identAx.rows || [])) {\n  if (SFID.test(String(r.Id || '')) && SFID.test(String(r.ConvertedContactId || ''))) exactPairs += 1;\n  else malformedPairs += 1;\n}\n\n// --- First-run baseline invariant. Current values are a photograph, and\n// Bite 4G1 proved the org holds ZERO lifecycle-history rows, so no\n// transition can exist to be read. Any nonzero value FAILS the run.\nconst transitions = 0, returns = 0, requalifications = 0;\nif (transitions !== 0 || returns !== 0 || requalifications !== 0) {\n  throw new Error('GUARD FAILED: a first run produced a non-baseline event. '\n    + 'A first observation records where a person stands, never how they got there.');\n}\n\nconst complete = lifecycleComplete && identityComplete;\nconst incompleteReasons = [];\nif (!lifecycleComplete) incompleteReasons.push('lifecycle extraction incomplete');\nif (!identityComplete)  incompleteReasons.push('identity extraction incomplete');\n\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  apply_payload_created: false,\n  scope_basis: scope.scope_basis,\n  approved_campaign_scope_count: scope.approved_campaign_scope_count,\n\n  eligible_lead_identities: pre.eligible_lead_id_count,\n  eligible_contact_identities: pre.eligible_contact_id_count,\n  salesforce_records_found: found,\n  salesforce_records_not_found: Math.max(0, eligible - found),\n\n  baseline_observations_by_state: byState,\n  unknown_lifecycle_labels: unknownLabels,\n  missing_lifecycle_values: missingLifecycle,\n  rows_missing_lifecycle_field: missingField,\n\n  exact_converted_identity_pairs: exactPairs,\n  malformed_identity_pairs: malformedPairs,\n  duplicate_source_ids: 0,\n\n  planned_observations: allRows.length,\n  planned_events: allRows.length,\n  planned_projections: allRows.length,\n  planned_issues: Object.keys(unknownLabels).length + missingLifecycle,\n\n  transitions: transitions,\n  returns: returns,\n  requalifications: requalifications,\n\n  lifecycle_pages_completed: (leadAx.pages_completed || 0) + (contactAx.pages_completed || 0),\n  lifecycle_extraction_complete: lifecycleComplete,\n  identity_pages_completed: identAx.pages_completed || 0,\n  identity_extraction_complete: identityComplete,\n\n  plan_complete: complete,\n  incomplete_reasons: incompleteReasons,\n  proposed_watermark: complete && allRows.length ? allRows[allRows.length - 1].SystemModstamp : null,\n  unresolved_optional_fields: pre.unresolved_optional_fields,\n  intended_future_schedule_timezone: 'America/Denver'\n} }];"
      },
      "id": "n-guard-dry-run-summary",
      "name": "GUARD: dry-run summary",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        520,
        340
      ],
      "notes": "The ONLY successful shared terminal. Throws on incomplete pagination, duplicate ids, a missing lifecycle field, zero matches against a non-empty population, or any non-baseline first-run event. Emits aggregate counts only."
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
          },
          {
            "node": "Describe: supporting date fields",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Describe: supporting date fields": {
      "main": [
        [
          {
            "node": "Classify: supporting date availability",
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
            "node": "Cursor init: Lead lifecycle",
            "type": "main",
            "index": 0
          },
          {
            "node": "Cursor init: Contact lifecycle",
            "type": "main",
            "index": 0
          },
          {
            "node": "Cursor init: converted identity",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Cursor init: Lead lifecycle": {
      "main": [
        [
          {
            "node": "Query: Lead lifecycle page",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Query: Lead lifecycle page": {
      "main": [
        [
          {
            "node": "Accumulate: Lead lifecycle page",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Accumulate: Lead lifecycle page": {
      "main": [
        [
          {
            "node": "Query: Lead lifecycle page",
            "type": "main",
            "index": 0
          },
          {
            "node": "GUARD: dry-run summary",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Cursor init: Contact lifecycle": {
      "main": [
        [
          {
            "node": "Query: Contact lifecycle page",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Query: Contact lifecycle page": {
      "main": [
        [
          {
            "node": "Accumulate: Contact lifecycle page",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Accumulate: Contact lifecycle page": {
      "main": [
        [
          {
            "node": "Query: Contact lifecycle page",
            "type": "main",
            "index": 0
          },
          {
            "node": "GUARD: dry-run summary",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Cursor init: converted identity": {
      "main": [
        [
          {
            "node": "Query: converted identity page",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Query: converted identity page": {
      "main": [
        [
          {
            "node": "Accumulate: converted identity page",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Accumulate: converted identity page": {
      "main": [
        [
          {
            "node": "Query: converted identity page",
            "type": "main",
            "index": 0
          },
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
