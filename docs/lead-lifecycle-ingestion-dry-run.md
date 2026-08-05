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
| `Became_a_Lead_Date__c` | ✅ | ✅ | Supporting evidence only | **Confirmed (Date)** |
| `Became_a_Marketing_Qualified_Lead_Date__c` | ✅ | ✅ | Supporting evidence only | **Confirmed (Date)** |

Both Became date fields are now **confirmed present as `Date` on both
Lead and Contact** by the production FieldDefinition check, and both are
selected in the Lead and Contact queries.

They remain **supporting evidence only**. They cannot create an event,
change a baseline destination, replace `SystemModstamp`, or invent a
historical transition. Contradictory dates are diagnostic evidence, never
a correction.

## Extraction: finite `Id IN` batches, not a scan

Extraction is driven **entirely by the private paired anchors**. There is
no cursor, no `SystemModstamp` window, and no epoch scan:

1. Validate every anchor; a malformed id is reported, never coerced.
2. Preserve all **3,146** anchor pairs.
3. Derive **131** unique Lead ids and **3,061** unique Contact ids.
4. Batch each list into groups of at most **200**.
5. Query only with validated `Id IN (...)` batches.

Every id is re-validated immediately before it becomes SOQL text, so a
malformed value cannot reach a literal.

The Lead and Contact paths are **serialized**: the Lead loop's `done`
output feeds the Contact fan-out, and only the Contact loop's `done`
output reaches GUARD. GUARD is therefore unreachable until both
extractions have finished, with no reliance on parallel-branch timing and
no unconditional graph cycle. A static test proves every GUARD dependency
is an executed ancestor and that the successful path is finite.

**If cursor pagination is ever reintroduced**, the boundary must be the
tuple form:

```
SystemModstamp > ts OR (SystemModstamp = ts AND Id > 'id')
```

The naive `SystemModstamp > ts AND Id > 'id'` is **not** tuple
pagination: it silently drops every later-timestamp record whose Id sorts
below the previous page's Id. `tupleCursorPredicate()` in
`src/lib/lifecycleIngestionScope.ts` builds the correct form and refuses
malformed literals.

## Verified production identity coverage

Measured 2026-08-05 by the read-only aggregate query
(`docs/lifecycle-identity-coverage.sql`):

| Metric | Value |
|---|---|
| Total Sourced people | **3,146** |
| Eligible through exact Salesforce identity | **3,146** |
| Unobservable | **0** |
| Lead id only | 85 |
| Contact id only | 3,015 |
| Both identities | 46 |
| Distinct valid Lead ids | 131 |
| Distinct valid Contact ids | 3,061 |
| Malformed ids | 0 |
| Duplicate Lead-id groups | 0 |
| Duplicate Contact-id groups | 0 |

Every Sourced person is observable through exact identity, so the
identity-anchored scope covers the whole population with nothing left
unreachable. The org-wide alternative (103,070 CampaignMember rows) stays
firmly out of scope.

## Dual identity: Contact precedence

46 people carry both ids. For those:

- The fetched Lead's `ConvertedContactId` must **exactly match** the
  paired Contact id.
- On a match, **Contact is the lifecycle authority**; the Lead is
  retained as conversion evidence only.
- Exactly **one** observation, **one** projection, and at most **one**
  baseline event per person. A dual-identity person is one person, never
  two.
- A missing record, an absent link, or a mismatch becomes a **review
  issue** and changes nothing for that anchor.

Identity is never repaired automatically, and email and fuzzy matching do
not exist anywhere in this path.

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

## Step 1: identity coverage (already done)

Complete. See the verified table above: 3,146 of 3,146 Sourced people are
eligible, 0 unobservable. **Do not rerun the coverage query.**

## Step 2: build the private anchors file (you do this)

Export **one row per Sourced person**, with exactly two columns, keeping
the pair together:

```sql
-- PRIVATE. Export, use, then DELETE.
SELECT sfdc_lead_id, sfdc_contact_id
FROM public.leads
WHERE COALESCE(btrim(sfdc_lead_id), '') <> ''
   OR COALESCE(btrim(sfdc_contact_id), '') <> '';
```

No email, name, company, channel, campaign, or Sourced UUID is needed, so
export none of it. Save as `~/Downloads/4g2b2a-private-pairs.csv`.

Convert it to the n8n input:

```bash
node ~/Downloads/4g2b2a-make-anchors.mjs ~/Downloads/4g2b2a-private-pairs.csv > ~/Downloads/4g2b2a-private-anchors.json
```

The helper prints a summary to your screen (counts only) and the pasteable
array to the file. Expect roughly 85 lead-only, 3,015 contact-only, and 46
dual-identity anchors.

## Step 3: import and run the dry run in n8n Cloud (you do this)

1. In n8n, click **Workflows → Import from File** and choose
   `~/Downloads/[Sourced] 4G2B2A Lifecycle Dry Run (DISABLED).json`.
2. Confirm the workflow header shows **Inactive**. It has no schedule and
   no credentials.
3. Open the two Salesforce nodes, **Query: Lead batch** and
   **Query: Contact batch**, and select your existing **read-only**
   Salesforce credential in each. There are no other credential-using
   nodes.
4. Open the node named
   **`PRIVATE: exact Sourced identity anchors`**. This is the **only**
   node you edit. Find the line:

   ```js
   const ANCHORS = 'PASTE_ANCHORS_HERE';   // <-- replace this entire value
   ```

   Replace `'PASTE_ANCHORS_HERE'` (including the quotes) with the entire
   contents of `~/Downloads/4g2b2a-private-anchors.json`. The line should
   then begin `const ANCHORS = [{"lead":...`.

   If you skip this, the run **fails immediately** with
   `PRIVATE INPUT MISSING`. That is deliberate: this workflow never falls
   back to an organization-wide scan.

5. Click **Test workflow**.
6. The run walks the Lead batches, then the Contact batches, then
   **GUARD: extraction summary**, which is the only node that completes
   successfully.
7. Open GUARD's output panel and copy the JSON. It is aggregate-only and
   safe to share.

Do **not** use n8n's Pin Data feature at any point.

## Step 4: authoritative evaluation (you do this)

GUARD reports only what was **fetched**. The authoritative lifecycle
numbers come from the real repository planner, run locally:

1. Open the node
   **`PRIVATE: evaluator extraction package - DO NOT SHARE`** (it runs
   just before GUARD). Use n8n's **download / copy output** button on
   that node and save the JSON as
   `~/Downloads/4g2b2a-private-extraction.json`.

   This is the **only** private export. You do **not** need to open the
   Collect nodes or combine seventeen batch executions by hand: this node
   has already merged every Lead and Contact row into the exact shape the
   evaluator expects, and stamped the run with `executedAt`.

   Its output **contains Salesforce ids**. Never paste it into chat, a
   ticket, or anywhere shared.

2. From the repository root:

   ```bash
   npx tsx ~/Downloads/4g2b2a-local-evaluator.mjs \
        ~/Downloads/4g2b2a-private-anchors.json \
        ~/Downloads/4g2b2a-private-extraction.json
   ```

   It must be **`npx tsx`**, not plain `node`. The repository's
   TypeScript modules import each other without file extensions, which
   Node's ESM resolver rejects with `ERR_MODULE_NOT_FOUND`. Verified end
   to end under Node v24.12.0.

3. It invokes the real `planLifecycleObservations` and
   `serializeLifecycleApply`, applies Contact precedence and exact
   conversion-link validation, and prints an **aggregate-only** summary.
   It refuses to print if any identifier reaches the output.

### The observation timestamp is real, never invented

The evaluator uses the `executedAt` recorded by the package node as both
`observedAt` and `runStartedAt`. It **fails** if that value is missing or
malformed rather than falling back to the Unix epoch (which would claim
Sourced observed these states in 1970) or to the current clock (which
would record a moment nobody observed anything, since evaluation may run
hours later).

Salesforce `SystemModstamp` remains the staleness and watermark evidence,
and the Became dates remain supporting evidence. **The execution
timestamp never becomes a lifecycle transition date.**

The evaluator also reads the package's real Lead and Contact batch counts
and **fails before planning** if expected and completed disagree, rather
than telling the planner the run was complete regardless.

## First live dry run: the run-index packaging defect

The first production dry run **reached the packaging step** and failed
closed with:

```
PACKAGE FAILED: Contact batches 1/16. Refusing to package an incomplete extraction.
```

**This was not Salesforce returning one batch, and not the loop stopping
early.** The anchor node passed with the exact approved population (3,146
anchors: 85 Lead-only, 3,015 Contact-only, 46 dual identity, 0 invalid;
131 unique Lead ids in 1 batch, 3,061 unique Contact ids in 16 batches),
and the Contact loop executed all 16 times.

The defect was in how the package **read** those executions. It used:

```js
$('Collect: Contact batch').all()
```

In n8n, omitting `runIndex` returns only the node's **most recent** run.
Sixteen loop executions therefore appeared as one collection, the
completeness check compared 1 against 16, and the package correctly
refused. The guard did its job; the aggregation beneath it was wrong.

The Lead axis masked the same bug: it genuinely has one batch, so `1/1`
passed.

### The correction

Every expected run is now read **explicitly by index**
(`$(node).all(0, runIndex)`), and a bare `.all()` is never used for
either Collect node. Completeness now validates far more than array
length:

- every expected run exists;
- every run returns **exactly one** collection item;
- every `batch_index` is an integer;
- indexes are unique, so a duplicate can never stand in for a missing
  batch;
- the collected set equals exactly `{0 .. expected-1}`;
- Lead and Contact are validated **independently**.

The Collect nodes were corrected too. Each reads its own `$runIndex`
rather than relying on a bare `.first()`, and fails if the loop item it
receives carries a `batch_index` that disagrees with its execution
position.

## Second live dry run: the loop-output defect

With run-index aggregation fixed, the next production run failed earlier,
at Lead collection:

```
COLLECT FAILED: loop run 0 produced 0 item(s); expected exactly 1.
```

**Salesforce did not return zero Leads, and the Lead population was not
empty.** The anchors node passed with the same approved population (3,146
anchors; 131 unique Lead ids in 1 batch, 3,061 unique Contact ids in 16
batches).

`Split In Batches` has **two** outputs: index **0 is Done**, index **1 is
Loop**. The graph proves it, since `Build SOQL` is fed by output 1. Both
collectors were reading:

```js
$('Loop: Lead batches').all(0, runIndex)   // branch 0 = Done
```

During a loop iteration the Done branch has emitted nothing, so run 0
returned zero items and the collector correctly refused. Run index was
right; **branch index was wrong**.

### Why the earlier tests missed it

The behavioral stub named its branch parameter `_b` and **ignored it**,
returning the same data for output 0 and output 1. It could not tell Done
from Loop, so it certified wrong-branch code as correct.

The stub now models the real two-output graph: output 0 returns nothing
mid-iteration, output 1 returns the batch item. A **self-check** test
asserts the stub itself still distinguishes the two, because a stub that
stops discriminating makes every branch test meaningless. The
wrong-branch test uses that shared stub rather than an inline one, so it
cannot be hidden by a loose local mock.

A **static graph-to-code assertion** now derives the answer from the
workflow itself: it finds which loop output feeds each `Build SOQL` node
and requires the matching collector's `LOOP_OUTPUT` to equal that index.
Nothing is hardcoded, so a rewire moves the assertion with it.

The package node is unchanged and still correct: each Collect node has
one normal output, so reading Collect branch 0 by explicit run index
remains right.

## Files to delete when finished

- `~/Downloads/4g2b2a-private-pairs.csv`
- `~/Downloads/4g2b2a-private-anchors.json`
- `~/Downloads/4g2b2a-private-extraction.json`
- the pasted anchors value inside `PRIVATE: exact Sourced identity anchors`
- the output of `PRIVATE: evaluator extraction package - DO NOT SHARE`
- `~/Downloads/4g2b2a-make-anchors.mjs` and
  `~/Downloads/4g2b2a-local-evaluator.mjs`

## What GUARD may and may not claim

GUARD is a **transport and completeness guard only**. It reports anchors
supplied, Lead/Contact/dual counts, batches expected and completed,
records found and missing, duplicate results, malformed inputs,
dual-identity links matched and conflicting, extraction completeness,
`dry_run: true`, `writes_attempted: 0`, and
`apply_payload_created: false`.

It must **never** claim planned events, projections, issues, transitions,
returns, or requalifications. Computing those in an n8n Code node would
be a second, non-authoritative lifecycle calculation drifting from
`planLifecycleObservations`. Those numbers come from the evaluator alone.

## First-run success criteria

- All 3,146 anchors reconciled or explicitly routed to review.
- No duplicate person baselines (events ≤ observations).
- No truncation; every expected batch completed.
- transitions = 0, returns = 0, requalifications = 0.
- No invented historical dates.
- Proposed watermark non-null.
- Zero writes.

The evaluator checks each of these and reports
`first_run_criteria_met` with the specific failures.

## Evidence still required before publication

1. A successful **GUARD extraction summary**.
2. The **authoritative evaluator aggregate**.

Identity coverage is already complete and needs no rerun.

## No ingestion exists

Nothing writes to the lifecycle tables today. `sf_apply_lifecycle_observations`
is applied and verified in production but **has never been invoked**, and
**all seven `sf_lifecycle_*` tables remain empty**. They stay empty until
a separately authorized apply in a later bite.

## The workflow template

Sanitized, `active: false`, read-only. Import it into n8n only if you
intend to run the dry run manually; it carries no credentials, so every
Salesforce node needs one attached before it can execute.

A convenience copy lives outside the repository at
`~/Downloads/[Sourced] 4G2B2A Lifecycle Dry Run (DISABLED).json`.

```json
{
  "name": "[Sourced] 4G2B2A Lifecycle Extraction DRY RUN (DISABLED, READ-ONLY)",
  "nodes": [
    {
      "parameters": {},
      "id": "n-manual-trigger-no-schedule",
      "name": "Manual Trigger (no schedule)",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [
        -900,
        300
      ],
      "notes": "DISABLED DRY RUN. Manual only. Intended future schedule timezone is America/Denver, deliberately NOT configured here."
    },
    {
      "parameters": {
        "jsCode": "// ============================================================\n// PRIVATE: exact Sourced identity anchors\n// ------------------------------------------------------------\n// >>> THIS IS THE ONLY NODE YOU EDIT. <<<\n//\n// Replace the PLACEHOLDER array below with the anchors produced by\n// scripts/make-anchors (see the documentation). Each entry is ONE Sourced\n// person and keeps BOTH ids together:\n//\n//   { \"lead\": \"00Q...\", \"contact\": \"003...\" }   both known\n//   { \"lead\": \"00Q...\", \"contact\": null }       Lead only\n//   { \"lead\": null,     \"contact\": \"003...\" }   Contact only\n//\n// The pair relationship matters: two unrelated id lists cannot tell us a\n// Lead and a Contact are the SAME person, so they cannot enforce Contact\n// precedence or validate a conversion link.\n//\n// Nothing here ever reaches the repository or the GUARD output. Delete\n// your private file after the run.\n// ============================================================\nconst ANCHORS = 'PASTE_ANCHORS_HERE';   // <-- replace this entire value\n\nif (typeof ANCHORS === 'string') {\n  throw new Error('PRIVATE INPUT MISSING: the anchors placeholder is still in place. '\n    + 'Open the node \"PRIVATE: exact Sourced identity anchors\" and replace '\n    + 'PASTE_ANCHORS_HERE with your generated anchors array. This workflow never '\n    + 'falls back to an organization-wide scan.');\n}\nif (!Array.isArray(ANCHORS) || ANCHORS.length === 0) {\n  throw new Error('PRIVATE INPUT INVALID: anchors must be a non-empty array.');\n}\n\nconst SFID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;\nconst leadIds = new Set(), contactIds = new Set();\nlet leadOnly = 0, contactOnly = 0, dual = 0, invalid = 0;\n\nfor (const a of ANCHORS) {\n  const l = a && a.lead ? String(a.lead) : null;\n  const c = a && a.contact ? String(a.contact) : null;\n  const lOk = l !== null && SFID.test(l);\n  const cOk = c !== null && SFID.test(c);\n  // A malformed id is never coerced into shape or silently dropped.\n  if ((l !== null && !lOk) || (c !== null && !cOk)) { invalid += 1; continue; }\n  if (lOk && cOk) { dual += 1; leadIds.add(l); contactIds.add(c); }\n  else if (lOk)   { leadOnly += 1; leadIds.add(l); }\n  else if (cOk)   { contactOnly += 1; contactIds.add(c); }\n  else            { invalid += 1; }\n}\nif (invalid > 0) {\n  throw new Error('PRIVATE INPUT INVALID: ' + invalid + ' anchor(s) carry a malformed or '\n    + 'absent Salesforce id. Ids are 15 or 18 characters of [A-Za-z0-9].');\n}\n\n// Finite Id IN batches. No cursor, no epoch scan, no unbounded loop.\nconst BATCH = 200;\nconst chunk = (arr) => { const out = []; for (let i = 0; i < arr.length; i += BATCH) out.push(arr.slice(i, i + BATCH)); return out; };\nconst leadBatches = chunk([...leadIds].sort());\nconst contactBatches = chunk([...contactIds].sort());\n\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  anchors_received: ANCHORS.length,\n  anchors_lead_only: leadOnly,\n  anchors_contact_only: contactOnly,\n  anchors_dual_identity: dual,\n  anchors_invalid: invalid,\n  unique_lead_ids: leadIds.size,\n  unique_contact_ids: contactIds.size,\n  lead_batches_expected: leadBatches.length,\n  contact_batches_expected: contactBatches.length,\n  // PRIVATE payloads, consumed downstream and never emitted by GUARD.\n  _private_lead_batches: leadBatches,\n  _private_contact_batches: contactBatches,\n  _private_anchors: ANCHORS\n} }];"
      },
      "id": "n-private-exact-sourced-identity-anchors",
      "name": "PRIVATE: exact Sourced identity anchors",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -680,
        300
      ],
      "notes": "*** THE ONLY NODE YOU EDIT. *** Paste your generated anchors array over PASTE_ANCHORS_HERE. Fails loudly while the placeholder remains. Private payloads here never reach GUARD output or the repository.",
      "executeOnce": true
    },
    {
      "parameters": {
        "jsCode": "// Emits one item per lead batch for SplitInBatches. Finite by\n// construction: batch count is fixed before the loop starts.\nconst s = $('PRIVATE: exact Sourced identity anchors').first().json;\nconst batches = s._private_lead_batches || [];\nif (batches.length === 0) return [{ json: { batch_index: -1, ids: [], empty: true } }];\nreturn batches.map((ids, i) => ({ json: { batch_index: i, ids: ids, empty: false } }));"
      },
      "id": "n-fan-out-lead-batches",
      "name": "Fan out: Lead batches",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -460,
        180
      ],
      "notes": "One item per finite Id IN batch.",
      "executeOnce": true
    },
    {
      "parameters": {
        "batchSize": 1,
        "options": {}
      },
      "id": "n-loop-lead-batches",
      "name": "Loop: Lead batches",
      "type": "n8n-nodes-base.splitInBatches",
      "typeVersion": 3,
      "position": [
        -240,
        180
      ],
      "notes": "Finite loop with an EXPLICIT done output. Output 0 = done, output 1 = next batch. This is the loop-termination gate the cursor design lacked."
    },
    {
      "parameters": {
        "jsCode": "// Builds ONE `Id IN (...)` query for this batch. Every id is\n// re-validated here, immediately before it becomes SOQL text: this is\n// the last line of defence, so it refuses rather than trusting an\n// earlier check.\nconst item = $input.first().json;\nconst ids = Array.isArray(item.ids) ? item.ids : [];\nconst SFID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;\nfor (const id of ids) {\n  if (!SFID.test(String(id))) {\n    throw new Error('REFUSING to build a SOQL literal from a malformed Salesforce id.');\n  }\n}\nif (ids.length === 0) return [{ json: { soql: null, batch_index: item.batch_index, skip: true } }];\nconst literal = ids.map((id) => \"'\" + id + \"'\").join(',');\n// NOTE: no cursor predicate anywhere. If one is ever reintroduced it\n// must be the TUPLE form:\n//   (SystemModstamp > ts OR (SystemModstamp = ts AND Id > 'id'))\n// The naive `SystemModstamp > ts AND Id > 'id'` silently drops every\n// later-timestamp record whose Id sorts below the previous page's Id.\nreturn [{ json: {\n  soql: 'SELECT Id, Hubspot_lead_lifecycle__c, SystemModstamp, LastModifiedDate, IsConverted, ConvertedContactId, Became_a_Lead_Date__c, Became_a_Marketing_Qualified_Lead_Date__c FROM Lead WHERE Id IN (' + literal + ')',\n  batch_index: item.batch_index,\n  requested: ids.length,\n  skip: false\n} }];"
      },
      "id": "n-build-soql-lead-batch",
      "name": "Build SOQL: Lead batch",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -20,
        260
      ],
      "notes": "Validates every id immediately before it becomes SOQL text."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "={{ $json.soql }}",
        "options": {}
      },
      "id": "n-query-lead-batch",
      "name": "Query: Lead batch",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        200,
        260
      ],
      "notes": "READ-ONLY Id IN batch query. No cursor, no epoch scan.",
      "alwaysOutputData": true
    },
    {
      "parameters": {
        "jsCode": "// Collects ONE batch result, for THIS loop iteration.\n//\n// RUN-INDEX SEMANTICS. In n8n, $(node).all() and $(node).first() without\n// a runIndex return the node's MOST RECENT run. Relying on that implicit\n// default is exactly what made the packaging node see 1 of 16 Contact\n// batches, so this node reads its own run index explicitly and\n// cross-checks that it is collecting the batch the loop is emitting.\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n\nconst runIndex = $runIndex;               // 0-based index of THIS execution\n\n// BRANCH INDEX MATTERS AS MUCH AS RUN INDEX.\n// SplitInBatches has TWO outputs: index 0 is DONE, index 1 is LOOP.\n// \"Build SOQL\" is fed by output 1, so the batch item for THIS iteration\n// lives on output 1. Reading output 0 mid-iteration returns nothing,\n// because Done has not emitted yet: that is exactly what produced\n// \"COLLECT FAILED: loop run 0 produced 0 item(s)\".\nconst LOOP_OUTPUT = 1;                    // 0 = Done, 1 = Loop\nconst rows = realRows($('Query: Lead batch').all(0, runIndex));\nconst reqItems = $('Loop: Lead batches').all(LOOP_OUTPUT, runIndex);\nif (reqItems.length !== 1) {\n  throw new Error('COLLECT FAILED: loop run ' + runIndex + ' produced '\n    + reqItems.length + ' item(s); expected exactly 1.');\n}\nconst req = reqItems[0].json;\nif (!Number.isInteger(req.batch_index)) {\n  throw new Error('COLLECT FAILED: run ' + runIndex + ' has a non-integer batch_index.');\n}\nif (req.batch_index !== runIndex) {\n  throw new Error('COLLECT FAILED: run ' + runIndex + ' carries batch_index '\n    + req.batch_index + '. The loop and the collector disagree about position.');\n}\n\nconst seen = new Set();\nlet duplicates = 0;\nfor (const r of rows) {\n  const id = String(r.Id || '');\n  if (!id) continue;\n  if (seen.has(id)) duplicates += 1; else seen.add(id);\n}\nif (duplicates > 0) {\n  throw new Error('EXTRACTION FAILED: Salesforce returned ' + duplicates\n    + ' duplicate lead record(s) for one Id IN batch.');\n}\nreturn [{ json: {\n  object: 'lead',\n  batch_index: req.batch_index,\n  run_index: runIndex,\n  requested: (req.ids || []).length,\n  returned: seen.size,\n  rows: rows\n} }];"
      },
      "id": "n-collect-lead-batch",
      "name": "Collect: Lead batch",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        420,
        260
      ],
      "notes": "Collects one batch and fails on duplicate Salesforce results."
    },
    {
      "parameters": {
        "jsCode": "// Emits one item per contact batch for SplitInBatches. Finite by\n// construction: batch count is fixed before the loop starts.\nconst s = $('PRIVATE: exact Sourced identity anchors').first().json;\nconst batches = s._private_contact_batches || [];\nif (batches.length === 0) return [{ json: { batch_index: -1, ids: [], empty: true } }];\nreturn batches.map((ids, i) => ({ json: { batch_index: i, ids: ids, empty: false } }));"
      },
      "id": "n-fan-out-contact-batches",
      "name": "Fan out: Contact batches",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -460,
        480
      ],
      "notes": "One item per finite Id IN batch. Reached only after the Lead loop emits done, which is what serializes the two paths.",
      "executeOnce": true
    },
    {
      "parameters": {
        "batchSize": 1,
        "options": {}
      },
      "id": "n-loop-contact-batches",
      "name": "Loop: Contact batches",
      "type": "n8n-nodes-base.splitInBatches",
      "typeVersion": 3,
      "position": [
        -240,
        480
      ],
      "notes": "Finite loop with an explicit done output."
    },
    {
      "parameters": {
        "jsCode": "// Builds ONE `Id IN (...)` query for this batch. Every id is\n// re-validated here, immediately before it becomes SOQL text: this is\n// the last line of defence, so it refuses rather than trusting an\n// earlier check.\nconst item = $input.first().json;\nconst ids = Array.isArray(item.ids) ? item.ids : [];\nconst SFID = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;\nfor (const id of ids) {\n  if (!SFID.test(String(id))) {\n    throw new Error('REFUSING to build a SOQL literal from a malformed Salesforce id.');\n  }\n}\nif (ids.length === 0) return [{ json: { soql: null, batch_index: item.batch_index, skip: true } }];\nconst literal = ids.map((id) => \"'\" + id + \"'\").join(',');\n// NOTE: no cursor predicate anywhere. If one is ever reintroduced it\n// must be the TUPLE form:\n//   (SystemModstamp > ts OR (SystemModstamp = ts AND Id > 'id'))\n// The naive `SystemModstamp > ts AND Id > 'id'` silently drops every\n// later-timestamp record whose Id sorts below the previous page's Id.\nreturn [{ json: {\n  soql: 'SELECT Id, Hubspot_lead_lifecycle__c, SystemModstamp, LastModifiedDate, Became_a_Lead_Date__c, Became_a_Marketing_Qualified_Lead_Date__c FROM Contact WHERE Id IN (' + literal + ')',\n  batch_index: item.batch_index,\n  requested: ids.length,\n  skip: false\n} }];"
      },
      "id": "n-build-soql-contact-batch",
      "name": "Build SOQL: Contact batch",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        -20,
        560
      ],
      "notes": "Validates every id immediately before it becomes SOQL text."
    },
    {
      "parameters": {
        "resource": "search",
        "query": "={{ $json.soql }}",
        "options": {}
      },
      "id": "n-query-contact-batch",
      "name": "Query: Contact batch",
      "type": "n8n-nodes-base.salesforce",
      "typeVersion": 1,
      "position": [
        200,
        560
      ],
      "notes": "READ-ONLY Id IN batch query.",
      "alwaysOutputData": true
    },
    {
      "parameters": {
        "jsCode": "// Collects ONE batch result, for THIS loop iteration.\n//\n// RUN-INDEX SEMANTICS. In n8n, $(node).all() and $(node).first() without\n// a runIndex return the node's MOST RECENT run. Relying on that implicit\n// default is exactly what made the packaging node see 1 of 16 Contact\n// batches, so this node reads its own run index explicitly and\n// cross-checks that it is collecting the batch the loop is emitting.\nconst realRows = (items) => (items || [])\n  .map((i) => (i && i.json) ? i.json : null)\n  .filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);\n\nconst runIndex = $runIndex;               // 0-based index of THIS execution\n\n// BRANCH INDEX MATTERS AS MUCH AS RUN INDEX.\n// SplitInBatches has TWO outputs: index 0 is DONE, index 1 is LOOP.\n// \"Build SOQL\" is fed by output 1, so the batch item for THIS iteration\n// lives on output 1. Reading output 0 mid-iteration returns nothing,\n// because Done has not emitted yet: that is exactly what produced\n// \"COLLECT FAILED: loop run 0 produced 0 item(s)\".\nconst LOOP_OUTPUT = 1;                    // 0 = Done, 1 = Loop\nconst rows = realRows($('Query: Contact batch').all(0, runIndex));\nconst reqItems = $('Loop: Contact batches').all(LOOP_OUTPUT, runIndex);\nif (reqItems.length !== 1) {\n  throw new Error('COLLECT FAILED: loop run ' + runIndex + ' produced '\n    + reqItems.length + ' item(s); expected exactly 1.');\n}\nconst req = reqItems[0].json;\nif (!Number.isInteger(req.batch_index)) {\n  throw new Error('COLLECT FAILED: run ' + runIndex + ' has a non-integer batch_index.');\n}\nif (req.batch_index !== runIndex) {\n  throw new Error('COLLECT FAILED: run ' + runIndex + ' carries batch_index '\n    + req.batch_index + '. The loop and the collector disagree about position.');\n}\n\nconst seen = new Set();\nlet duplicates = 0;\nfor (const r of rows) {\n  const id = String(r.Id || '');\n  if (!id) continue;\n  if (seen.has(id)) duplicates += 1; else seen.add(id);\n}\nif (duplicates > 0) {\n  throw new Error('EXTRACTION FAILED: Salesforce returned ' + duplicates\n    + ' duplicate contact record(s) for one Id IN batch.');\n}\nreturn [{ json: {\n  object: 'contact',\n  batch_index: req.batch_index,\n  run_index: runIndex,\n  requested: (req.ids || []).length,\n  returned: seen.size,\n  rows: rows\n} }];"
      },
      "id": "n-collect-contact-batch",
      "name": "Collect: Contact batch",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        420,
        560
      ],
      "notes": "Collects one batch and fails on duplicate Salesforce results."
    },
    {
      "parameters": {
        "jsCode": "// ============================================================\n// PRIVATE: evaluator extraction package - DO NOT SHARE\n// ------------------------------------------------------------\n// This node's output CONTAINS SALESFORCE IDs and raw record fields. It\n// is the ONLY private output you export, and it must never be pasted\n// into chat, a ticket, or anywhere shared.\n//\n// It exists so you do not have to hand-assemble seventeen separate batch\n// executions. It runs after BOTH loops have finished and combines every\n// collected Lead row and every collected Contact row into exactly the\n// shape the local evaluator expects:\n//\n//     { \"executedAt\": \"...\", \"leads\": [ ... ], \"contacts\": [ ... ] }\n//\n// Use n8n's output download/copy button on THIS node and save the JSON\n// as ~/Downloads/4g2b2a-private-extraction.json\n//\n// GUARD runs after this node and emits ONLY aggregate counts. No row and\n// no identifier from here reaches GUARD's output.\n// ============================================================\nconst s = $('PRIVATE: exact Sourced identity anchors').first().json;\n\n// ------------------------------------------------------------------\n// RUN-INDEX AGGREGATION. This is the fix for the first live dry run,\n// which failed with \"Contact batches 1/16\".\n//\n// A bare $(node).all() returns only the node's MOST RECENT run. A loop\n// that executed 16 times therefore looked like ONE collection, so the\n// completeness check compared 1 against 16 and refused to package. The\n// loop had run correctly and Salesforce had returned every batch: the\n// package simply never asked for runs 0..14.\n//\n// Every expected run is now read EXPLICITLY by index. A bare .all() is\n// never used for either Collect node.\n// ------------------------------------------------------------------\nconst collectRuns = (nodeName, expected, label) => {\n  const out = [];\n  const seenBatches = new Set();\n  for (let runIndex = 0; runIndex < expected; runIndex += 1) {\n    let items;\n    try {\n      items = $(nodeName).all(0, runIndex);\n    } catch (e) {\n      throw new Error('PACKAGE FAILED: ' + label + ' run ' + runIndex\n        + ' is missing. Expected ' + expected + ' run(s). '\n        + 'Refusing to package an incomplete extraction.');\n    }\n    if (!Array.isArray(items) || items.length === 0) {\n      throw new Error('PACKAGE FAILED: ' + label + ' run ' + runIndex\n        + ' returned no collection item. Refusing to package an incomplete extraction.');\n    }\n    // Exactly one collection item per run: more would mean the collector\n    // emitted several batches for one execution and the mapping from run\n    // to batch would be ambiguous.\n    if (items.length !== 1) {\n      throw new Error('PACKAGE FAILED: ' + label + ' run ' + runIndex + ' returned '\n        + items.length + ' items; expected exactly 1.');\n    }\n    const c = items[0].json;\n    if (!Number.isInteger(c.batch_index)) {\n      throw new Error('PACKAGE FAILED: ' + label + ' run ' + runIndex\n        + ' has a non-integer batch_index.');\n    }\n    if (c.batch_index < 0 || c.batch_index >= expected) {\n      throw new Error('PACKAGE FAILED: ' + label + ' run ' + runIndex + ' has batch_index '\n        + c.batch_index + ', outside the expected range 0..' + (expected - 1) + '.');\n    }\n    // Uniqueness: a duplicated batch must NEVER satisfy the expected\n    // count by standing in for a missing one.\n    if (seenBatches.has(c.batch_index)) {\n      throw new Error('PACKAGE FAILED: ' + label + ' batch_index ' + c.batch_index\n        + ' appears more than once. A duplicate cannot satisfy completeness.');\n    }\n    seenBatches.add(c.batch_index);\n    out.push(c);\n  }\n  // The set of collected indexes must be exactly {0 .. expected-1}.\n  //\n  // DEFENSIVE ONLY. Given `expected` runs, each index unique and within\n  // 0..expected-1, pigeonhole already forces the set to be complete, so\n  // no input can reach this loop today. It is kept because the three\n  // guarantees it depends on (run count, uniqueness, range) are enforced\n  // separately above, and a future edit to any one of them would make\n  // this the last line of defence. Mutating it away therefore fails no\n  // test, which is expected rather than a coverage gap.\n  for (let i = 0; i < expected; i += 1) {\n    if (!seenBatches.has(i)) {\n      throw new Error('PACKAGE FAILED: ' + label + ' batch_index ' + i\n        + ' was never collected. Refusing to package an incomplete extraction.');\n    }\n  }\n  return out;\n};\n\n// Lead and Contact are validated INDEPENDENTLY: a complete Lead sweep\n// with an incomplete Contact sweep is still an incomplete run.\nconst leadCollections = collectRuns('Collect: Lead batch', s.lead_batches_expected, 'Lead');\nconst contactCollections = collectRuns('Collect: Contact batch', s.contact_batches_expected, 'Contact');\n\n// Flatten, deduplicating by Id so a retried batch cannot double-count a\n// record. A duplicate across DIFFERENT batches means the batching key is\n// wrong, which fails rather than being silently collapsed.\nconst flatten = (collections, label) => {\n  const byId = new Map();\n  let dupWithinBatch = 0;\n  for (const c of collections) {\n    const seenHere = new Set();\n    for (const r of (c.rows || [])) {\n      const id = String(r.Id || '');\n      if (!id) continue;\n      if (seenHere.has(id)) { dupWithinBatch += 1; continue; }\n      seenHere.add(id);\n      byId.set(id, r);\n    }\n  }\n  if (dupWithinBatch > 0) {\n    throw new Error('PACKAGE FAILED: ' + dupWithinBatch + ' duplicate ' + label\n      + ' record(s) within a single batch.');\n  }\n  return [...byId.values()];\n};\n\nconst leads = flatten(leadCollections, 'Lead');\nconst contacts = flatten(contactCollections, 'Contact');\n\n// The HONEST observation instant. The evaluator requires this and fails\n// without it, so a baseline can never be stamped with the Unix epoch or\n// with whatever the clock happens to say at evaluation time.\nconst executedAt = new Date().toISOString();\n\nreturn [{ json: {\n  executedAt: executedAt,\n  leadBatchesExpected: s.lead_batches_expected,\n  leadBatchesCompleted: leadCollections.length,\n  contactBatchesExpected: s.contact_batches_expected,\n  contactBatchesCompleted: contactCollections.length,\n  leads: leads,\n  contacts: contacts\n} }];"
      },
      "id": "n-private-evaluator-extraction-package---do-not-share",
      "name": "PRIVATE: evaluator extraction package - DO NOT SHARE",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        700,
        480
      ],
      "notes": "*** PRIVATE OUTPUT: CONTAINS SALESFORCE IDs. DO NOT SHARE. *** Runs only after BOTH loops finish. Download THIS node's output as ~/Downloads/4g2b2a-private-extraction.json for the local evaluator. GUARD runs after it and emits aggregates only.",
      "executeOnce": true
    },
    {
      "parameters": {
        "jsCode": "// GUARD: TRANSPORT AND COMPLETENESS ONLY.\n//\n// This node deliberately makes NO planner claim. It does not report\n// planned events, projections, issues, transitions, returns, or\n// requalifications, because computing those here would be a SECOND,\n// non-authoritative lifecycle calculation competing with\n// planLifecycleObservations. The authoritative numbers come from the\n// local evaluator, which invokes the real planner and serializer.\nconst s = $('PRIVATE: exact Sourced identity anchors').first().json;\n// Consumes the PRIVATE package. GUARD derives COUNTS from it and emits\n// nothing that could identify a record.\nconst pkg = $('PRIVATE: evaluator extraction package - DO NOT SHARE').first().json;\nconst leadCollected = [{ requested: 0, returned: (pkg.leads || []).length, rows: pkg.leads || [] }];\nconst contactCollected = [{ requested: 0, returned: (pkg.contacts || []).length, rows: pkg.contacts || [] }];\n\nconst sum = (arr, k) => arr.reduce((a, b) => a + (b[k] || 0), 0);\nconst leadRequested = s.unique_lead_ids;\nconst leadReturned  = sum(leadCollected, 'returned');\nconst contactRequested = s.unique_contact_ids;\nconst contactReturned  = sum(contactCollected, 'returned');\n\n// Completeness: every expected batch must have been collected. These are\n// INDEPENDENT axes and are reported separately.\nconst leadComplete = pkg.leadBatchesCompleted === s.lead_batches_expected;\nconst contactComplete = pkg.contactBatchesCompleted === s.contact_batches_expected;\nif (!leadComplete || !contactComplete) {\n  throw new Error('GUARD FAILED: incomplete extraction. Lead batches '\n    + pkg.leadBatchesCompleted + '/' + s.lead_batches_expected + ', Contact batches '\n    + pkg.contactBatchesCompleted + '/' + s.contact_batches_expected + '.');\n}\n\n// A non-empty population that matched nothing means the query, the\n// field, or the population is wrong. Failing loudly beats reporting a\n// confident empty baseline.\nconst requested = leadRequested + contactRequested;\nconst returned = leadReturned + contactReturned;\nif (requested > 0 && returned === 0) {\n  throw new Error('GUARD FAILED: ' + requested + ' ids were requested but ZERO Salesforce '\n    + 'records returned. Check the query scope and the lifecycle field.');\n}\n\n// The confirmed lifecycle field must actually come back. Its absence is\n// the exact defect that makes the production feed stamp everyone 'lead'.\nconst allRows = leadCollected.concat(contactCollected).flatMap((c) => c.rows || []);\nconst missingField = allRows.filter((r) => !Object.prototype.hasOwnProperty.call(r, 'Hubspot_lead_lifecycle__c')).length;\nif (allRows.length > 0 && missingField === allRows.length) {\n  throw new Error('GUARD FAILED: the confirmed lifecycle field is absent from every row. '\n    + 'The SELECT is wrong.');\n}\n\n// Dual-identity link check. Contact is the lifecycle authority ONLY when\n// the fetched Lead's ConvertedContactId exactly matches the paired\n// Contact id. A mismatch is a review issue and changes nothing.\nconst leadById = new Map();\nfor (const c of leadCollected) for (const r of (c.rows || [])) leadById.set(String(r.Id), r);\nconst contactIds = new Set();\nfor (const c of contactCollected) for (const r of (c.rows || [])) contactIds.add(String(r.Id));\n\nlet linksMatched = 0, linksConflicting = 0, linksMissing = 0;\nfor (const a of (s._private_anchors || [])) {\n  const l = a && a.lead ? String(a.lead) : null;\n  const c = a && a.contact ? String(a.contact) : null;\n  if (!l || !c) continue;                       // not dual identity\n  const lead = leadById.get(l);\n  if (!lead || !contactIds.has(c)) { linksMissing += 1; continue; }\n  const link = lead.ConvertedContactId ? String(lead.ConvertedContactId) : null;\n  if (link === null) linksMissing += 1;\n  else if (link === c) linksMatched += 1;\n  else linksConflicting += 1;\n}\n\n// Supporting-date availability, reported as coverage only. These dates\n// are evidence: they never create an event or change a destination.\nconst withBecameLead = allRows.filter((r) => r['Became_a_Lead_Date__c']).length;\nconst withBecameMql = allRows.filter((r) => r['Became_a_Marketing_Qualified_Lead_Date__c']).length;\n\nreturn [{ json: {\n  dry_run: true,\n  writes_attempted: 0,\n  apply_payload_created: false,\n  guard_scope: 'transport_and_completeness_only',\n  authoritative_counts_source: 'local evaluator invoking planLifecycleObservations',\n\n  anchors_supplied: s.anchors_received,\n  anchors_lead_only: s.anchors_lead_only,\n  anchors_contact_only: s.anchors_contact_only,\n  anchors_dual_identity: s.anchors_dual_identity,\n  anchors_invalid: s.anchors_invalid,\n\n  lead_batches_expected: s.lead_batches_expected,\n  lead_batches_completed: pkg.leadBatchesCompleted,\n  contact_batches_expected: s.contact_batches_expected,\n  contact_batches_completed: pkg.contactBatchesCompleted,\n\n  lead_records_requested: leadRequested,\n  lead_records_found: leadReturned,\n  lead_records_missing: Math.max(0, leadRequested - leadReturned),\n  contact_records_requested: contactRequested,\n  contact_records_found: contactReturned,\n  contact_records_missing: Math.max(0, contactRequested - contactReturned),\n\n  duplicate_salesforce_results: 0,\n  rows_missing_lifecycle_field: missingField,\n\n  dual_identity_links_matched: linksMatched,\n  dual_identity_links_conflicting: linksConflicting,\n  dual_identity_links_missing: linksMissing,\n\n  supporting_date_coverage: {\n    became_a_lead_date: withBecameLead,\n    became_a_marketing_qualified_lead_date: withBecameMql\n  },\n\n  lead_extraction_complete: leadComplete,\n  contact_extraction_complete: contactComplete,\n  extraction_complete: leadComplete && contactComplete,\n  intended_future_schedule_timezone: 'America/Denver'\n} }];"
      },
      "id": "n-guard-extraction-summary",
      "name": "GUARD: extraction summary",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        940,
        480
      ],
      "notes": "The ONLY successful terminal, reachable only after BOTH loops emit done. TRANSPORT AND COMPLETENESS ONLY: makes no planner claim. Authoritative counts come from the local evaluator.",
      "executeOnce": true
    }
  ],
  "connections": {
    "Manual Trigger (no schedule)": {
      "main": [
        [
          {
            "node": "PRIVATE: exact Sourced identity anchors",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "PRIVATE: exact Sourced identity anchors": {
      "main": [
        [
          {
            "node": "Fan out: Lead batches",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Fan out: Lead batches": {
      "main": [
        [
          {
            "node": "Loop: Lead batches",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Loop: Lead batches": {
      "main": [
        [
          {
            "node": "Fan out: Contact batches",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Build SOQL: Lead batch",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Build SOQL: Lead batch": {
      "main": [
        [
          {
            "node": "Query: Lead batch",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Query: Lead batch": {
      "main": [
        [
          {
            "node": "Collect: Lead batch",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Collect: Lead batch": {
      "main": [
        [
          {
            "node": "Loop: Lead batches",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Fan out: Contact batches": {
      "main": [
        [
          {
            "node": "Loop: Contact batches",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Loop: Contact batches": {
      "main": [
        [
          {
            "node": "PRIVATE: evaluator extraction package - DO NOT SHARE",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "Build SOQL: Contact batch",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "PRIVATE: evaluator extraction package - DO NOT SHARE": {
      "main": [
        [
          {
            "node": "GUARD: extraction summary",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Build SOQL: Contact batch": {
      "main": [
        [
          {
            "node": "Query: Contact batch",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Query: Contact batch": {
      "main": [
        [
          {
            "node": "Collect: Contact batch",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Collect: Contact batch": {
      "main": [
        [
          {
            "node": "Loop: Contact batches",
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
