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

## Execution model: two passes

Discovery cannot be one pass. Pass B's history queries must filter on the
lifecycle field API name, and that name is exactly what Pass A discovers,
so a single pass would require knowing the answer before asking the
question. The workflow therefore has **two manual triggers**:

**Pass A: field and scope discovery.** Reads FieldDefinition for Lead,
Contact, and CampaignMember; surfaces lifecycle-field candidates with
their history-tracking flags; counts CampaignMember volumes; measures
converted-Lead linkage; and produces the PRIVATE campaign-scope decision
aid. Pass A is **never** a complete 4G1 result and says so in its own
output: no lifecycle field is confirmed yet, so no transition evidence
exists.

**Pass B: lifecycle history and reconciliation audit.** You enter the two
confirmed API names into `CONFIG B`, then run it. `B0` rejects
placeholders and blanks **before any query runs**; `B2` re-verifies both
names against FieldDefinition in the same run that uses them; `B3`/`B4`
measure lifecycle-filtered history coverage; `B5`/`B6`/`B7` export the
actual history rows and identity pairs for the local evaluator.

A run can never end "successfully" with a placeholder still configured:
`B0` fails first, and `GUARD B` re-checks at the end.

## Lead and Contact are independent

Nothing assumes the two objects share a lifecycle API name. They are
discovered separately (`A1`), configured separately
(`LEAD_LIFECYCLE_FIELD`, `CONTACT_LIFECYCLE_FIELD`), verified separately
(`B2`), and queried separately (`B3`/`B5` vs `B4`/`B6`). The pure module
validates each one on its own and reports a per-object rejection reason:
`placeholder_not_replaced`, `blank`, `not_returned_by_field_definition`,
or `not_history_queryable`. A name is never guessed and never falls back
to the other object's value. `apiNamesMatch` is reported for information
only; nothing downstream depends on them matching.

## Current values are not lifecycle events

A `GROUP BY` over the lifecycle field tells you what people look like
**today**. It cannot prove that anyone ever moved from Lead to MQL, and it
certainly cannot prove a demotion or a requalification, because the
current value overwrote whatever came before. Transition evidence
therefore comes from `LeadHistory` and `ContactHistory` rows carrying
history Id, parent Id, field, old value, new value, and the full
CreatedDate timestamp.

## Lifecycle-history coverage, not whole-object history

`B3` and `B4` filter on the confirmed lifecycle field
(`WHERE Field = <confirmed name>`). Whole-object history is a different,
much larger number, and reporting it as lifecycle coverage would overstate
what is actually available. For each object the summary reports the
earliest and latest lifecycle-history timestamps, the lifecycle row count,
and a three-way outcome that keeps these cases distinct:

- `succeeded_with_rows`: the query ran and found lifecycle history.
- `succeeded_zero_rows`: the query ran and the field has no history.
- `query_failed`: the object or field is inaccessible.

An inaccessible object is **not** the same as an object with no history,
and neither is silently treated as the other.

## Authoritative transition classification

n8n cannot execute the repository TypeScript, and the program forbids a
second competing lifecycle calculation. So Pass B **exports** raw history
rows privately, and a local, uncommitted, read-only evaluator runs the
REAL repository code over them: `summarizeDiscovery`, which delegates
classification to `adaptLifecycleHistory` (Bite 4B). The evaluator prints
aggregate-only results, refuses to print anything that trips
`assertNoIdentifierLeakage`, and tells you to delete the raw export.

**The evaluator's aggregate output is the final 4G1 transition evidence.**
`GUARD B` says so explicitly rather than claiming to be comprehensive: it
reports row counts and coverage, and names the evaluator as the source of
truth for transitions. The evidence it produces covers Lead to MQL
transitions, MQL to Lead returns, requalifications, unchanged
observations, blank and unknown values, out-of-scope values, malformed
timestamps, exact and conflicting duplicate history Ids, affected-person
counts, and review/incomplete counts.

## CampaignMember volume and scope

Three volumes are measured, and all three are **organization-wide**
because no campaign filter is applied to them:

- incremental, matching the current nightly two-day `CreatedDate` window;
- changed-or-created, sizing a future strategy that would also catch
  edits (the current workflow's `CreatedDate`-only filter never sees them);
- full reconciliation.

None of these may be described as "in scope" unless an approved campaign
scope is actually applied to the query. The pure module carries an
explicit `organization_wide` / `approved_campaign_scope` label per number
so the distinction cannot be lost in a later summary.

The PRIVATE campaign node deliberately includes Campaign Name and Parent
Campaign Name **inside n8n**, because you cannot decide which campaigns
belong in Sourced from opaque ids. Those names and ids must never reach a
guard summary, the repository, or a PR. No campaign is automatically
included or excluded, and campaign-based source attribution is unchanged.

## Row-limit risks are reported separately

One flag cannot express two different risks, so there are two:

- `incrementalCanExceedRowLimit`: the nightly query would silently
  truncate at the current 5,000-row limit. This is a correctness bug.
- `reconciliationRequiresPagination`: a full reconciliation needs paging.
  This is a design requirement, not a bug.

Estimated batch counts are reported for both, and a future
changed-or-created window that could not be sized is flagged rather than
assumed to be zero.

## Empty results are not rows

Salesforce nodes with `alwaysOutputData` emit a single empty `{}` sentinel
when a query returns nothing. Counting that as a record would turn "no
rows" into "one row". Every counting path filters to objects with at least
one own key, and the guards distinguish a successful zero-row query from a
failed one.

## Manual import and execution

1. In n8n choose **Import from File** and select the generated file (path
   in the bite report). It arrives **disabled**; leave it disabled.
2. Bind your existing Salesforce credential to the Salesforce nodes. The
   committed template binds none by design.
3. **Run Pass A**: open the workflow, click the `PASS A` trigger, then
   Execute. Read `GUARD A`'s output for the lifecycle-field candidates and
   volumes. Read the PRIVATE campaign node in the n8n UI only.
4. Decide the two API names from Pass A's candidates. Do not guess them.
5. **Edit `CONFIG B`**: replace `LEAD_LIFECYCLE_FIELD` and
   `CONTACT_LIFECYCLE_FIELD` with those exact names.
6. **Run Pass B**: click the `PASS B` trigger, then Execute. If a
   placeholder survived, `B0` fails the run on purpose.
7. If `possibly_truncated` is true in `GUARD B`, duplicate the `B5`/`B6`
   row nodes with `OFFSET` raised by the page size and re-run until a page
   returns fewer rows than the page size.
8. Copy the PRIVATE raw-export node's output to a local file, fill in the
   evaluator's `STAGE_VALUE_MAP` from the observed lifecycle values, run
   the evaluator, paste its **aggregate** output into the Results section
   below, then **delete the raw export file**.

## Results

_Not yet run. Paste GUARD A, GUARD B, and the local evaluator's aggregate
output here, then record the confirmed field names and value-to-stage map
for Bite 4G2._

## Evidence still unresolved before Bite 4G2

1. **Which API field backs "Member First Associated Date."** Still
   unconfirmed; the current workflow assumes CampaignMember CreatedDate.
2. **The confirmed lifecycle API names** on Lead and Contact, and whether
   they differ.
3. **The value-to-stage map**, from observed values only, restricted to
   `lead`, `mql`, and `out_of_scope`. Deal stages must never be written as
   lead lifecycle.
4. **Which campaigns are in scope**, decided from the PRIVATE node. Every
   volume measured so far is organization-wide.
5. **Alerting channel: Slack versus email**, and who receives it. The
   current workflow has no failure notification at all.
6. **Whether the RPC write path becomes a versioned migration** or is
   replaced. It exists only in the live environment today.
7. **Historical backfill depth**, bounded by the retention window Pass B
   reports.

## The workflow template

Disabled, read-only, manual. Import a copy; do not paste run output back
into this block.

```json
{
  "name": "[Sourced] - 4G1 Lead Sync Discovery - READ ONLY - DISABLED (two-pass)",
  "nodes": [
    {
      "parameters": {},
      "id": "manual-trigger-pass-a",
      "name": "PASS A: click Execute (manual only)",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [
        -720,
        300
      ]
    },
    {
      "parameters": {
        "jsCode": "// PASS A: field and scope discovery. Runs with NO lifecycle field\n// configured, because the whole point of Pass A is to find those names.\n// Pass A can never be a complete 4G1 result; only Pass B can.\n//\n// The timezone is recorded for the FUTURE scheduled workflow (4G2+) so\n// the rebuild does not inherit the n8n instance default the way the\n// current production workflow silently does. This workflow is manual.\nreturn [{ json: {\n  pass: 'A',\n  dry_run: true,\n  writes_attempted: 0,\n  future_schedule_timezone: 'America/Denver',\n  incremental_window_days: 2,\n  planned_batch_size: 2000,\n  current_workflow_row_limit: 5000\n} }];"
      },
      "id": "config-a-discovery-settings",
      "name": "CONFIG A: discovery settings",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -500,
        300
      ],
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Lead'"
      },
      "id": "a1-lead-fields-fielddefinition",
      "name": "A1: Lead fields (FieldDefinition)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        -280,
        300
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY metadata. Discovers Lead field API names, labels, types, and history-tracking flags. Lead and Contact are discovered INDEPENDENTLY: they may use different lifecycle API names."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Contact'"
      },
      "id": "a1-contact-fields-fielddefinition",
      "name": "A1: Contact fields (FieldDefinition)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        -60,
        300
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY metadata. Discovers Contact field API names, labels, types, and history-tracking flags. Lead and Contact are discovered INDEPENDENTLY: they may use different lifecycle API names."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'CampaignMember'"
      },
      "id": "a1-campaignmember-fields-fielddefinition",
      "name": "A1: CampaignMember fields (FieldDefinition)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        160,
        300
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY metadata. Discovers CampaignMember field API names, labels, types, and history-tracking flags. Lead and Contact are discovered INDEPENDENTLY: they may use different lifecycle API names."
    },
    {
      "parameters": {
        "jsCode": "// alwaysOutputData makes a zero-row query emit ONE empty {} sentinel.\n// Counting that as a record would turn 'no rows' into 'one row', so\n// every real row must have at least one own key.\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n// Empty required results FAIL. A silent zero here would make every\n// downstream 'field not found' finding meaningless: absence of\n// evidence would be read as evidence of absence.\nconst sources = [\n  ['Lead', realRows($('A1: Lead fields (FieldDefinition)').all())],\n  ['Contact', realRows($('A1: Contact fields (FieldDefinition)').all())],\n  ['CampaignMember', realRows($('A1: CampaignMember fields (FieldDefinition)').all())]\n];\nconst out = {};\nconst lifecycleCandidates = {};\nfor (const [obj, rows] of sources) {\n  const named = rows.filter((r) => r.QualifiedApiName);\n  if (named.length === 0) {\n    throw new Error('DISCOVERY FAILED: FieldDefinition returned no rows for ' + obj\n      + '. Check the integration user metadata read access. Do NOT treat this as \"field absent\".');\n  }\n  out[obj] = named.length;\n  // Candidate surfacing only. This NEVER maps a value to a stage and\n  // never picks a winner; a human confirms the API name for Pass B.\n  lifecycleCandidates[obj] = named\n    .filter((r) => /lifecycle/i.test(String(r.QualifiedApiName)) || /lifecycle/i.test(String(r.Label || '')))\n    .map((r) => ({ apiName: r.QualifiedApiName, label: r.Label, historyTracked: r.IsFieldHistoryTracked === true }));\n}\nreturn [{ json: { dry_run: true, writes_attempted: 0, field_rows_by_object: out, lifecycle_candidates: lifecycleCandidates } }];"
      },
      "id": "a2-validate-field-discovery-returned-rows",
      "name": "A2: VALIDATE field discovery returned rows",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        380,
        300
      ],
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT COUNT(Id) total FROM CampaignMember WHERE CreatedDate >= LAST_N_DAYS:2"
      },
      "id": "a3-campaignmember-incremental-volume-org-wid",
      "name": "A3: CampaignMember incremental volume (org-wide, 2-day CreatedDate)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        600,
        200
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY aggregate. ORGANIZATION-WIDE count for the CURRENT nightly window. No campaign scope filter is applied, so this must NOT be labeled 'in scope'."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT COUNT(Id) total FROM CampaignMember WHERE CreatedDate >= LAST_N_DAYS:2 OR LastModifiedDate >= LAST_N_DAYS:2"
      },
      "id": "a4-campaignmember-changed-or-created-volume-",
      "name": "A4: CampaignMember changed-or-created volume (org-wide, future strategy)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        600,
        380
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY aggregate. Sizes the FUTURE changed-or-created incremental strategy (the current workflow uses CreatedDate only and therefore never sees edits). ORGANIZATION-WIDE."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT COUNT(Id) total FROM CampaignMember"
      },
      "id": "a5-campaignmember-reconciliation-volume-org-",
      "name": "A5: CampaignMember reconciliation volume (org-wide)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        600,
        560
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY aggregate. ORGANIZATION-WIDE full-reconciliation size, used to decide pagination. Not an approved campaign scope."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT COUNT(Id) total FROM Lead WHERE IsConverted = true AND ConvertedContactId != null"
      },
      "id": "a6-converted-lead-linkage-coverage-org-wide",
      "name": "A6: converted-Lead linkage coverage (org-wide)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        820,
        300
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY aggregate. Coverage of ConvertedContactId on converted Leads; counts only, no ids returned."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT CampaignId, Campaign.Name, Campaign.Parent.Name, COUNT(Id) members FROM CampaignMember GROUP BY CampaignId, Campaign.Name, Campaign.Parent.Name ORDER BY COUNT(Id) DESC"
      },
      "id": "private-n8n-only-do-not-share---campaign-sco",
      "name": "PRIVATE (n8n only): DO NOT SHARE - campaign scope decision aid",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        1040,
        480
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "PRIVATE (n8n only): DO NOT SHARE. Campaign names and parent names are included ON PURPOSE so you can decide which campaigns belong in Sourced. No campaign is automatically included or excluded, and campaign-based source attribution is unchanged. These names and ids must NEVER reach the Guard summary, the repository, or a PR. Read in the n8n UI only."
    },
    {
      "parameters": {
        "jsCode": "// alwaysOutputData makes a zero-row query emit ONE empty {} sentinel.\n// Counting that as a record would turn 'no rows' into 'one row', so\n// every real row must have at least one own key.\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n// Pass A terminal. It reports what was discovered and states plainly\n// that Pass A is NOT a complete 4G1 result: no lifecycle field is\n// confirmed yet, so no transition evidence exists.\nconst cfg = $('CONFIG A: discovery settings').first().json;\nif (cfg.dry_run !== true || cfg.writes_attempted !== 0) {\n  throw new Error('GUARD A: discovery must be dry_run with zero writes.');\n}\nconst v = $('A2: VALIDATE field discovery returned rows').first().json;\nconst scalar = (node, key) => {\n  const rows = realRows($(node).all());\n  if (rows.length === 0) return { queried: true, rows_returned: 0, value: null };\n  const raw = rows[0][key] ?? rows[0].expr0 ?? rows[0].total ?? null;\n  return { queried: true, rows_returned: rows.length, value: raw === null ? null : Number(raw) };\n};\nconst summary = {\n  pass: 'A',\n  dry_run: true,\n  writes_attempted: 0,\n  complete: false,\n  incomplete_reasons: ['Pass A discovers field names and scope only. Run Pass B with the confirmed Lead and Contact lifecycle field API names to obtain transition evidence.'],\n  future_schedule_timezone: cfg.future_schedule_timezone,\n  field_rows_by_object: v.field_rows_by_object,\n  lifecycle_candidates: v.lifecycle_candidates,\n  campaign_member_volumes: {\n    incremental_2day_created: scalar('A3: CampaignMember incremental volume (org-wide, 2-day CreatedDate)', 'total'),\n    changed_or_created_2day: scalar('A4: CampaignMember changed-or-created volume (org-wide, future strategy)', 'total'),\n    full_reconciliation: scalar('A5: CampaignMember reconciliation volume (org-wide)', 'total'),\n    scope: 'organization_wide'\n  },\n  converted_lead_linkage: scalar('A6: converted-Lead linkage coverage (org-wide)', 'total'),\n  next_step: 'Enter the confirmed Lead and Contact lifecycle API names into CONFIG B, then run Pass B.'\n};\nconst s = JSON.stringify(summary);\nif (/\\b(001|003|00Q|00v|701|005|006)[A-Za-z0-9]{12}([A-Za-z0-9]{3})?\\b/.test(s)) {\n  throw new Error('GUARD A: summary contains a Salesforce-record-id-shaped value.');\n}\nif (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/.test(s)) {\n  throw new Error('GUARD A: summary contains an email-shaped value.');\n}\nreturn [{ json: summary }];"
      },
      "id": "guard-a-pass-a-summary-shared-aggregate-only",
      "name": "GUARD A: Pass A summary (shared, aggregate only)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1260,
        300
      ],
      "executeOnce": true
    },
    {
      "parameters": {},
      "id": "manual-trigger-pass-b",
      "name": "PASS B: click Execute (manual only)",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [
        -720,
        900
      ]
    },
    {
      "parameters": {
        "jsCode": "// PASS B. Replace BOTH placeholders with the exact API names Pass A\n// reported. Lead and Contact are INDEPENDENT: do not assume they match.\n// Leaving a placeholder in place FAILS the run (see B0) rather than\n// producing a summary that looks complete but proves nothing.\nconst LEAD_LIFECYCLE_FIELD = 'LEAD_LIFECYCLE_FIELD';\nconst CONTACT_LIFECYCLE_FIELD = 'CONTACT_LIFECYCLE_FIELD';\nreturn [{ json: {\n  pass: 'B',\n  dry_run: true,\n  writes_attempted: 0,\n  lead_lifecycle_field: LEAD_LIFECYCLE_FIELD,\n  contact_lifecycle_field: CONTACT_LIFECYCLE_FIELD,\n  history_page_size: 2000,\n  planned_batch_size: 2000,\n  current_workflow_row_limit: 5000\n} }];"
      },
      "id": "config-b-confirmed-lifecycle-fields-edit-bef",
      "name": "CONFIG B: confirmed lifecycle fields (EDIT BEFORE RUNNING)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -500,
        900
      ],
      "executeOnce": true
    },
    {
      "parameters": {
        "jsCode": "// Fail loudly BEFORE any query runs. A Pass B run must never reach the\n// Guard with an unresolved placeholder.\nconst cfg = $('CONFIG B: confirmed lifecycle fields (EDIT BEFORE RUNNING)').first().json;\nconst PLACEHOLDERS = ['FIELD_API_NAME','LEAD_LIFECYCLE_FIELD','CONTACT_LIFECYCLE_FIELD','REPLACE_ME','TODO'];\nconst check = (label, value) => {\n  const v = String(value ?? '').trim();\n  if (v === '') throw new Error('PASS B FAILED: ' + label + ' is blank. Enter the confirmed API name from Pass A.');\n  if (PLACEHOLDERS.includes(v.toUpperCase())) {\n    throw new Error('PASS B FAILED: ' + label + ' is still the placeholder \"' + v\n      + '\". Replace it with the confirmed API name from Pass A. Never guess it.');\n  }\n  return v;\n};\nconst lead = check('LEAD_LIFECYCLE_FIELD', cfg.lead_lifecycle_field);\nconst contact = check('CONTACT_LIFECYCLE_FIELD', cfg.contact_lifecycle_field);\nreturn [{ json: { ...cfg, lead_lifecycle_field: lead, contact_lifecycle_field: contact } }];"
      },
      "id": "b0-reject-placeholders-and-blanks",
      "name": "B0: REJECT placeholders and blanks",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -280,
        900
      ],
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Lead'"
      },
      "id": "b1-lead-fields-fielddefinition-re-verify",
      "name": "B1: Lead fields (FieldDefinition, re-verify)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        -60,
        900
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY. Re-verifies the configured Lead lifecycle API name in the same run that queries its history, so a stale or mistyped name cannot slip through."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT QualifiedApiName, Label, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Contact'"
      },
      "id": "b1-contact-fields-fielddefinition-re-verify",
      "name": "B1: Contact fields (FieldDefinition, re-verify)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        160,
        900
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY. Re-verifies the configured Contact lifecycle API name in the same run that queries its history, so a stale or mistyped name cannot slip through."
    },
    {
      "parameters": {
        "jsCode": "// alwaysOutputData makes a zero-row query emit ONE empty {} sentinel.\n// Counting that as a record would turn 'no rows' into 'one row', so\n// every real row must have at least one own key.\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n// The configured name must be a REAL field on that object. Not found is\n// a hard failure, never a silent fallback to the other object's name.\nconst cfg = $('B0: REJECT placeholders and blanks').first().json;\nconst verify = (obj, node, configured) => {\n  const rows = realRows($(node).all()).filter((r) => r.QualifiedApiName);\n  if (rows.length === 0) {\n    throw new Error('PASS B FAILED: FieldDefinition returned no rows for ' + obj + '.');\n  }\n  const match = rows.find((r) => String(r.QualifiedApiName) === configured);\n  if (!match) {\n    throw new Error('PASS B FAILED: ' + obj + ' has no field named \"' + configured\n      + '\". Use the exact API name Pass A reported.');\n  }\n  return { apiName: match.QualifiedApiName, historyTracked: match.IsFieldHistoryTracked === true };\n};\nconst lead = verify('Lead', 'B1: Lead fields (FieldDefinition, re-verify)', cfg.lead_lifecycle_field);\nconst contact = verify('Contact', 'B1: Contact fields (FieldDefinition, re-verify)', cfg.contact_lifecycle_field);\nreturn [{ json: { ...cfg, lead_field: lead, contact_field: contact } }];"
      },
      "id": "b2-verify-configured-fields-exist",
      "name": "B2: VERIFY configured fields exist",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        380,
        900
      ],
      "executeOnce": true
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT MIN(CreatedDate) earliest, MAX(CreatedDate) latest, COUNT(Id) rows FROM LeadHistory WHERE Field = '{{ $json.lead_lifecycle_field }}'"
      },
      "id": "b3-leadhistory-lifecycle-coverage-field-filt",
      "name": "B3: LeadHistory lifecycle coverage (field-filtered)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        600,
        800
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY aggregate, FILTERED TO THE CONFIRMED LIFECYCLE FIELD. Whole-object history is a different, larger number and must never be reported as lifecycle coverage."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT MIN(CreatedDate) earliest, MAX(CreatedDate) latest, COUNT(Id) rows FROM ContactHistory WHERE Field = '{{ $('B2: VERIFY configured fields exist').first().json.contact_lifecycle_field }}'"
      },
      "id": "b4-contacthistory-lifecycle-coverage-field-f",
      "name": "B4: ContactHistory lifecycle coverage (field-filtered)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        600,
        980
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY aggregate, FILTERED TO THE CONFIRMED CONTACT LIFECYCLE FIELD."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT Id, LeadId, Field, OldValue, NewValue, CreatedDate FROM LeadHistory WHERE Field = '{{ $('B2: VERIFY configured fields exist').first().json.lead_lifecycle_field }}' ORDER BY CreatedDate ASC LIMIT 2000 OFFSET 0"
      },
      "id": "b5-leadhistory-lifecycle-rows-page-1",
      "name": "B5: LeadHistory lifecycle rows (page 1)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        820,
        800
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY. Actual lifecycle history ROWS: history Id, parent Id, field, old and new value, and the full CreatedDate timestamp. Current values can never prove a transition; only these rows can. Page with OFFSET (duplicate this node and raise OFFSET by 2000) until a page returns fewer than 2000 rows. PRIVATE: these rows carry record ids and must be exported privately, never into the Guard summary."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT Id, ContactId, Field, OldValue, NewValue, CreatedDate FROM ContactHistory WHERE Field = '{{ $('B2: VERIFY configured fields exist').first().json.contact_lifecycle_field }}' ORDER BY CreatedDate ASC LIMIT 2000 OFFSET 0"
      },
      "id": "b6-contacthistory-lifecycle-rows-page-1",
      "name": "B6: ContactHistory lifecycle rows (page 1)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        820,
        980
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY. Actual Contact lifecycle history rows, paginated the same way as B5."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "SELECT Id, ConvertedContactId FROM Lead WHERE IsConverted = true AND ConvertedContactId != null ORDER BY Id ASC LIMIT 2000 OFFSET 0"
      },
      "id": "b7-converted-lead-identity-rows-for-person-m",
      "name": "B7: converted-Lead identity rows (for person mapping)",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        1040,
        980
      ],
      "executeOnce": true,
      "alwaysOutputData": true,
      "notes": "READ ONLY. Lead-to-Contact identity pairs so a person's history is not split across the conversion boundary. PRIVATE: ids only, exported privately, never into the Guard summary."
    },
    {
      "parameters": {
        "jsCode": "// alwaysOutputData makes a zero-row query emit ONE empty {} sentinel.\n// Counting that as a record would turn 'no rows' into 'one row', so\n// every real row must have at least one own key.\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n// PRIVATE (n8n only): DO NOT SHARE.\n// Raw history rows and identity pairs for the AUTHORITATIVE local\n// evaluator. n8n cannot run the repository TypeScript, and the program\n// forbids a second competing lifecycle calculation, so classification\n// happens locally against the real adapter instead.\n//\n// Copy this node's output to a local file, run the evaluator described\n// in docs/lead-sync-discovery.md, then DELETE the file. These rows\n// contain Salesforce record ids and must never be committed, pasted\n// into a PR, or folded into the Guard summary.\nconst cfg = $('B2: VERIFY configured fields exist').first().json;\nconst leadRows = realRows($('B5: LeadHistory lifecycle rows (page 1)').all());\nconst contactRows = realRows($('B6: ContactHistory lifecycle rows (page 1)').all());\nconst identityRows = realRows($('B7: converted-Lead identity rows (for person mapping)').all());\nconst PAGE = Number(cfg.history_page_size) || 2000;\n// A full page means there is very likely another page. Silent\n// truncation is the failure mode this warns about.\nconst truncated = leadRows.length >= PAGE || contactRows.length >= PAGE || identityRows.length >= PAGE;\nreturn [{ json: {\n  PRIVATE: 'DO NOT SHARE. Delete after running the local evaluator.',\n  lead_lifecycle_field: cfg.lead_lifecycle_field,\n  contact_lifecycle_field: cfg.contact_lifecycle_field,\n  page_size: PAGE,\n  possibly_truncated: truncated,\n  lead_history_rows: leadRows,\n  contact_history_rows: contactRows,\n  converted_identity_rows: identityRows\n} }];"
      },
      "id": "private-n8n-only-do-not-share---raw-export-f",
      "name": "PRIVATE (n8n only): DO NOT SHARE - raw export for local evaluator",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1260,
        980
      ],
      "executeOnce": true
    },
    {
      "parameters": {
        "jsCode": "// alwaysOutputData makes a zero-row query emit ONE empty {} sentinel.\n// Counting that as a record would turn 'no rows' into 'one row', so\n// every real row must have at least one own key.\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n// The ONLY successful terminal of the shared Pass B path.\n// It asserts dry-run/zero-writes, that no placeholder survived, and\n// that every required discovery section completed. It reports\n// lifecycle-FILTERED history coverage and row COUNTS only.\n//\n// It deliberately does NOT compute transitions: the authoritative\n// classification is the repository adapter, run by the local evaluator\n// over the PRIVATE export. This summary names that evaluator's output\n// as the final 4G1 result rather than pretending to be comprehensive.\nconst cfg = $('B2: VERIFY configured fields exist').first().json;\nif (cfg.dry_run !== true || cfg.writes_attempted !== 0) {\n  throw new Error('GUARD B: discovery must be dry_run with zero writes.');\n}\nconst PLACEHOLDERS = ['FIELD_API_NAME','LEAD_LIFECYCLE_FIELD','CONTACT_LIFECYCLE_FIELD','REPLACE_ME','TODO'];\nfor (const [label, value] of [['lead', cfg.lead_lifecycle_field], ['contact', cfg.contact_lifecycle_field]]) {\n  const v = String(value ?? '').trim();\n  if (v === '' || PLACEHOLDERS.includes(v.toUpperCase())) {\n    throw new Error('GUARD B: unresolved placeholder for ' + label + ' lifecycle field.');\n  }\n}\n// Lifecycle coverage: distinguish a successful zero-row result from a\n// failed query. An empty sentinel is not a row.\nconst coverage = (node, field) => {\n  const rows = realRows($(node).all());\n  if (rows.length === 0) {\n    return { outcome: 'succeeded_zero_rows', lifecycle_field: field, row_count: 0, earliest: null, latest: null };\n  }\n  const r = rows[0];\n  const count = Number(r.rows ?? r.expr2 ?? 0);\n  if (!count) {\n    return { outcome: 'succeeded_zero_rows', lifecycle_field: field, row_count: 0, earliest: null, latest: null };\n  }\n  return { outcome: 'succeeded_with_rows', lifecycle_field: field, row_count: count,\n    earliest: r.earliest ?? r.expr0 ?? null, latest: r.latest ?? r.expr1 ?? null };\n};\nconst priv = $('PRIVATE (n8n only): DO NOT SHARE - raw export for local evaluator').first().json;\nconst summary = {\n  pass: 'B',\n  dry_run: true,\n  writes_attempted: 0,\n  lifecycle_fields: { lead: cfg.lead_lifecycle_field, contact: cfg.contact_lifecycle_field,\n    api_names_match: cfg.lead_lifecycle_field === cfg.contact_lifecycle_field,\n    lead_history_tracked: cfg.lead_field.historyTracked,\n    contact_history_tracked: cfg.contact_field.historyTracked },\n  lifecycle_history_coverage: {\n    lead: coverage('B3: LeadHistory lifecycle coverage (field-filtered)', cfg.lead_lifecycle_field),\n    contact: coverage('B4: ContactHistory lifecycle coverage (field-filtered)', cfg.contact_lifecycle_field)\n  },\n  history_rows_exported: {\n    lead: priv.lead_history_rows.length,\n    contact: priv.contact_history_rows.length,\n    identity_pairs: priv.converted_identity_rows.length,\n    page_size: priv.page_size,\n    possibly_truncated: priv.possibly_truncated\n  },\n  transitions: 'NOT COMPUTED HERE. Run the local evaluator over the PRIVATE export; its aggregate output is the authoritative 4G1 transition evidence.',\n  complete: priv.possibly_truncated !== true,\n  incomplete_reasons: priv.possibly_truncated === true\n    ? ['A history page returned a full page, so rows may be truncated. Raise OFFSET and re-run until a page returns fewer rows than the page size.']\n    : [],\n  next_step: 'Run the local evaluator (docs/lead-sync-discovery.md), paste its AGGREGATE output into the doc, then delete the raw export.'\n};\nconst s = JSON.stringify(summary);\nif (/\\b(001|003|00Q|00v|701|005|006)[A-Za-z0-9]{12}([A-Za-z0-9]{3})?\\b/.test(s)) {\n  throw new Error('GUARD B: summary contains a Salesforce-record-id-shaped value.');\n}\nif (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/.test(s)) {\n  throw new Error('GUARD B: summary contains an email-shaped value.');\n}\nreturn [{ json: summary }];"
      },
      "id": "guard-b-pass-b-summary-shared-aggregate-only",
      "name": "GUARD B: Pass B summary (shared, aggregate only)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1480,
        900
      ],
      "executeOnce": true
    }
  ],
  "connections": {
    "PASS A: click Execute (manual only)": {
      "main": [
        [
          {
            "node": "CONFIG A: discovery settings",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "CONFIG A: discovery settings": {
      "main": [
        [
          {
            "node": "A1: Lead fields (FieldDefinition)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "A1: Lead fields (FieldDefinition)": {
      "main": [
        [
          {
            "node": "A1: Contact fields (FieldDefinition)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "A1: Contact fields (FieldDefinition)": {
      "main": [
        [
          {
            "node": "A1: CampaignMember fields (FieldDefinition)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "A1: CampaignMember fields (FieldDefinition)": {
      "main": [
        [
          {
            "node": "A2: VALIDATE field discovery returned rows",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "A2: VALIDATE field discovery returned rows": {
      "main": [
        [
          {
            "node": "A3: CampaignMember incremental volume (org-wide, 2-day CreatedDate)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "A3: CampaignMember incremental volume (org-wide, 2-day CreatedDate)": {
      "main": [
        [
          {
            "node": "A4: CampaignMember changed-or-created volume (org-wide, future strategy)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "A4: CampaignMember changed-or-created volume (org-wide, future strategy)": {
      "main": [
        [
          {
            "node": "A5: CampaignMember reconciliation volume (org-wide)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "A5: CampaignMember reconciliation volume (org-wide)": {
      "main": [
        [
          {
            "node": "A6: converted-Lead linkage coverage (org-wide)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "A6: converted-Lead linkage coverage (org-wide)": {
      "main": [
        [
          {
            "node": "PRIVATE (n8n only): DO NOT SHARE - campaign scope decision aid",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "PRIVATE (n8n only): DO NOT SHARE - campaign scope decision aid": {
      "main": [
        [
          {
            "node": "GUARD A: Pass A summary (shared, aggregate only)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "PASS B: click Execute (manual only)": {
      "main": [
        [
          {
            "node": "CONFIG B: confirmed lifecycle fields (EDIT BEFORE RUNNING)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "CONFIG B: confirmed lifecycle fields (EDIT BEFORE RUNNING)": {
      "main": [
        [
          {
            "node": "B0: REJECT placeholders and blanks",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "B0: REJECT placeholders and blanks": {
      "main": [
        [
          {
            "node": "B1: Lead fields (FieldDefinition, re-verify)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "B1: Lead fields (FieldDefinition, re-verify)": {
      "main": [
        [
          {
            "node": "B1: Contact fields (FieldDefinition, re-verify)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "B1: Contact fields (FieldDefinition, re-verify)": {
      "main": [
        [
          {
            "node": "B2: VERIFY configured fields exist",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "B2: VERIFY configured fields exist": {
      "main": [
        [
          {
            "node": "B3: LeadHistory lifecycle coverage (field-filtered)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "B3: LeadHistory lifecycle coverage (field-filtered)": {
      "main": [
        [
          {
            "node": "B4: ContactHistory lifecycle coverage (field-filtered)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "B4: ContactHistory lifecycle coverage (field-filtered)": {
      "main": [
        [
          {
            "node": "B5: LeadHistory lifecycle rows (page 1)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "B5: LeadHistory lifecycle rows (page 1)": {
      "main": [
        [
          {
            "node": "B6: ContactHistory lifecycle rows (page 1)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "B6: ContactHistory lifecycle rows (page 1)": {
      "main": [
        [
          {
            "node": "B7: converted-Lead identity rows (for person mapping)",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "B7: converted-Lead identity rows (for person mapping)": {
      "main": [
        [
          {
            "node": "PRIVATE (n8n only): DO NOT SHARE - raw export for local evaluator",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "PRIVATE (n8n only): DO NOT SHARE - raw export for local evaluator": {
      "main": [
        [
          {
            "node": "GUARD B: Pass B summary (shared, aggregate only)",
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
