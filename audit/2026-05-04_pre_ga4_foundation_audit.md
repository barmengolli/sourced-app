# Sourced foundation audit — 2026-05-04

Read-only inspection of the Sourced codebase before adding a Google
Analytics 4 integration. No code was changed during this audit. Findings
are numbered F-NNN so they can be referenced in follow-up prompts.

Branch checked: `feature/funnel-flow-sankey`. Repo root:
`/Users/barmengolli/Desktop/MarketingOps Cowork/sourced/sourced-app`. Out-of-tree
canonical schema: `/Users/barmengolli/Desktop/MarketingOps Cowork/sourced/SCHEMA.sql`.
Migrations: `/Users/barmengolli/Desktop/MarketingOps Cowork/sourced/migrations/`.

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 6 |
| MEDIUM | 9 |
| LOW | 7 |

**Top three to fix before GA4 integration:**

1. **F-002 — In-repo SCHEMA.sql is structurally divergent from the canonical schema.** The in-repo copy is at the M6 baseline (no `funnel_actuals`, no `outreach_snapshots`, no `region` column on leads, no hierarchical channels) while the canonical is M11. Any new contributor or test environment bootstrapping from the in-repo file will end up with a database that the app cannot run against. GA4 will add at least one new table; pick a single source of truth before that work lands.
2. **F-003 — `useChannels` does not paginate.** Every other read hook implements the PostgREST 1000-row workaround except this one, which silently truncates if the channel taxonomy ever grows past 1000 rows. The funnel grid, every chart, and the new Sankey all depend on a complete channels list. GA4 channels will be inserted directly via a new mapping flow; cap risk increases.
3. **F-008 — Realtime subscriptions have no error or disconnect handling.** Every hook calls `.subscribe()` with no callback, so a transient network drop or auth failure leaves the UI silently stale. Realtime is the only thing keeping the funnel in sync with multi-tab edits and the n8n cron writes; a silent drop produces wrong numbers without visible signal.

The audit also includes one Q1-MQL-bucket consistency query (F-018) that the user should run themselves to confirm the post-correction state is clean before introducing GA4 lead sources.

---

## Findings

### F-001 — HIGH — Anon-write RLS policies on every table

**Category**: Security

**Location**: `sourced/SCHEMA.sql:283-313` (canonical RLS section)

**Observation**: All nine tables (`channels`, `leads`, `attributions`, `attribution_touches`, `funnel_projections`, `funnel_actuals`, `cell_comments`, `cell_links`, `outreach_snapshots`) have identical permissive policies:

```sql
CREATE POLICY "Allow public read"  ON <t> FOR SELECT USING (true);
CREATE POLICY "Allow anon insert"  ON <t> FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow anon update"  ON <t> FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow anon delete"  ON <t> FOR DELETE USING (true);
```

Anyone holding the public anon key can perform any CRUD operation on any
table. The browser-side password gate is the only barrier. This is a
documented decision from the M6 build (the SCHEMA.sql header reads
"Pattern mirrors DataVis 1: public read, anon write (gated by client
password). Replace with proper auth in v2.") but it deserves a finding
because the GA4 integration will increase the attack surface — a webhook
or an extra browser context with the leaked anon key would be enough.

**Risk if not fixed**: A leaked anon key (visible in any browser bundle)
combined with a guessed/leaked password gives full read/write/delete to
the entire dataset. The policy text says "in v2"; we are at M11 with no
migration plan written down. GA4 will pull session-level data that may
include identifiers we don't currently collect; the blast radius grows.

**Suggested fix**: Plan the auth migration before GA4 ships. Minimum
viable: enable Supabase Auth with anonymous sign-in, lock down RLS to
`auth.role() = 'authenticated'`, replace the password gate with a
magic-link login. Keep the existing schema and hooks; only the policies
and the gate change. Budget this as its own milestone, not a sub-task of
GA4.

**Effort estimate**: Medium (3-8hr), or Large (1-2 days) if you want a
real role model with viewer vs editor splits.

---

### F-002 — HIGH — In-repo SCHEMA.sql is structurally divergent from canonical

**Category**: Schema

**Location**: `sourced-app/SCHEMA.sql` (in-repo, M6 era) vs `sourced/SCHEMA.sql`
(canonical, current, out-of-tree)

**Observation**: The two files do not describe the same database. Concrete
divergences (in-repo column ⇆ canonical):

| Aspect | In-repo | Canonical | Impact |
|---|---|---|---|
| `channels.parent_channel_id` | absent | present | in-repo is flat; app requires hierarchy |
| `channels` UNIQUE | `(name)` | `(name, parent_channel_id)` | M3.5 onward needs the composite |
| `channels` seed data | 10 rows hard-coded | none, expects SFDC import | drift causes confusion in fresh setups |
| `leads.region` | absent | present | M9 region work won't run against in-repo |
| `leads.current_stage` CHECK | 8 stages incl. `cold`, `disqualified` | 2 stages (`lead`, `mql`) | in-repo allows values the app doesn't honor |
| `campaigns`, `campaign_channels`, `campaign_spend`, `lead_campaigns` | present | absent | in-repo has dead-on-arrival domain |
| `attribution_touches.campaign_id` | present | absent | dangling FK in in-repo |
| `funnel_actuals` | absent | present | in-repo skips manual-actual fallback |
| `outreach_snapshots` | absent | present | in-repo has no Outreach support |
| Realtime publication | includes campaigns/spend | does not | publication drift |
| Closed Lost CHECK update | applied to in-repo's existing 2 stage_key columns | applied to canonical's 3 | partial sync from M-Closed-Lost commit |

**Risk if not fixed**: Anyone bootstrapping a new Supabase project from
`sourced-app/SCHEMA.sql` (likely the file someone reaches for first since
it lives next to package.json) will get a database the app cannot run
against. CI / staging environments will diverge from prod. GA4 will add
at least a `ga4_events` or `ga4_sessions` table; the question of which
schema file to update will have no obvious answer.

**Suggested fix**: Pick one schema file as canonical and delete the other.
Recommend: move `sourced/SCHEMA.sql` and `sourced/migrations/` *into*
`sourced-app/` so the source of truth lives inside the git repo. Delete
`sourced-app/SCHEMA.sql` since it's stale. This was deferred during the
Closed Lost commit explicitly because it was structural cleanup, but
it's blocking now.

**Effort estimate**: Small (1-3hr).

---

### F-003 — HIGH — `useChannels` skips PostgREST 1000-row pagination

**Category**: Performance

**Location**: `src/hooks/useChannels.ts:6-23`

**Observation**: Every other data-fetching hook (`useLeads`,
`useAttributions`, `useAttributionTouches`, `useFunnelActuals`,
`useFunnelProjections`, `useChannelLeadCounts`, `useOutreachSnapshots`)
implements a `while (true) { range(from, from + PAGE - 1) … }` loop to
work around PostgREST's default 1000-row cap. `useChannels` does a single
`.select('*')` with no `.range()`:

```ts
supabase
  .from('channels')
  .select('*')
  .order('display_order', { ascending: true })
  .order('name', { ascending: true })
  .then(({ data, error }) => { … if (data) setChannels(data as Channel[]); });
```

**Risk if not fixed**: At ~30-50 channels today this is fine. As the
team adds GA4-derived channels, sub-channels for paid acquisition splits,
and any future imports, the channel taxonomy is the kind of thing that
silently grows. The first 1001th channel just doesn't render. No error.
Funnel grid loses a row; charts lose a node; Sankey loses a column. The
totals row will still match because rollup happens server-side via
attributions, but the "where did these leads come from?" question has no
visible answer for that channel.

**Suggested fix**: Copy the pagination loop pattern from `useLeads.ts:71-87`
into `useChannels.ts`. ~10 lines.

**Effort estimate**: Quick (<1hr).

---

### F-004 — HIGH — Password gate has hard-coded fallback in source

**Category**: Security

**Location**: `src/components/PasswordGate.tsx:3-12`

**Observation**:

```ts
const FALLBACK_PASSWORD = 'HWWQa4yD5vkX';
const ENV_PASSWORD = import.meta.env.VITE_APP_PASSWORD as string | undefined;
if (!ENV_PASSWORD) console.warn('VITE_APP_PASSWORD is not set. Falling back to default.');
const CORRECT_PASSWORD = ENV_PASSWORD || FALLBACK_PASSWORD;
```

The fallback ships in the production JS bundle. `import.meta.env`
substitutions happen at build time, so `FALLBACK_PASSWORD` is a literal
in the compiled output. Comparison is plain string equality. Session
state lives in `sessionStorage[STORAGE_KEY]` (key: `sourced_unlocked`,
value: literal `'true'`); a user with devtools can set it directly and
skip the password.

**Risk if not fixed**: Anyone with the URL and devtools can unlock the
app. The password is also visible in the bundle. If the env var is set
in Vercel, only the env var is in the bundle (the fallback is still
there as a literal — Vite does NOT tree-shake unused branches of a
runtime `||`). For GA4 the threat model gets worse: GA4 measurement IDs
and any client secrets we add for the integration will land in the same
bundle.

**Suggested fix**: Two parts. First, drop the fallback constant and
require `VITE_APP_PASSWORD` at build time (throw at module init if
unset). Second, plan the real auth migration tracked in F-001. The
fallback removal is a one-line fix that closes the worst of it without
waiting for auth.

**Effort estimate**: Quick (<1hr) for the fallback removal. F-001 budgets
the full fix.

---

### F-005 — HIGH — Quarterly trend `useMemo` deps array omits `filter`

**Category**: Calculation correctness

**Location**: `src/pages/FunnelDashboardPage.tsx:83-105`

**Observation**: The quarterly-trend memo computes Q1/Q2/Q3/Q4 totals by
calling `computeGrid` four times with `filter: \`Q${q}\``. The deps array
omits `filter`:

```ts
const quarterly = useMemo(() => {
  return ([1,2,3,4] as const).map(q => ({
    quarter: q,
    totals: computeGrid({ leads, channels, …, year, filter: `Q${q}` as PeriodFilter, regions }).totals,
  }));
}, [leads, channels, …, year, regions]);
//   ^^^ filter not in deps — but the function body does not read the outer `filter`,
//   so this is technically correct. Flagging anyway because it reads as a bug.
```

Reading the body: the outer `filter` IS shadowed locally per iteration,
so the omission is intentional. The trend chart shows all four quarters
regardless of the period selector. But the eslint-react-hooks rule will
disagree, and a future contributor reading "deps look incomplete" will
either add `filter` (forcing a useless recompute) or doubt other deps
arrays in the file.

**Risk if not fixed**: Not a bug today. But a contributor "fixes" it by
adding `filter` to the deps and the trend chart starts re-running on
every period switch (~33% slower on Q-flip), or worse, someone refactors
the trend body to use the outer `filter` and forgets the deps update.

**Suggested fix**: Add a one-line comment immediately above the deps
array: `// filter intentionally omitted: trend always shows all four
quarters regardless of period selection.` Or refactor to take the
quarterly-totals callback as an explicit prop, which makes the contract
visible at the call site.

**Effort estimate**: Quick (<1hr).

---

### F-006 — HIGH — `attributions(deal_id, stage_key)` has no UNIQUE constraint

**Category**: Schema / data integrity

**Location**: `sourced/SCHEMA.sql:103-128` (attributions table)

**Observation**: The Closed Lost work (`feat: add Closed Lost as 7th
terminal stage`) and the duplicate-guard fix
(`fix/promote-duplicate-guard`) both deliberately did NOT add a UNIQUE
constraint on `(deal_id, stage_key)`. The reasoning, per the duplicate-
guard commit message: "the chain pattern intentionally allows multiple
rows per stage in edge cases (a deal can legitimately re-enter a stage
after a closeLost)." The guard is purely UI: the modal disables Promote
and Close Lost buttons when a downstream row already exists. Bulk
imports, n8n writes, manual SQL, or anyone with the anon key can still
insert duplicates.

**Risk if not fixed**: Today the only writers are the modal and the
hooks, both of which respect the guard. A pre-existing duplicate (Pets
Best — CoreSuite SaaS at Q2 Sales Opp, mentioned in the duplicate-guard
PR description) demonstrates that duplicates have already entered the
data, even with the guard in place. GA4 will likely add a webhook or
batch path that creates attributions, and that path will not have the
modal's UI guard.

**Suggested fix**: Document the contract. Either:
(a) Add a partial UNIQUE that exempts re-entry: `UNIQUE (deal_id,
stage_key) WHERE NOT EXISTS (other row with same deal_id at closeLost)`
— complex, hard to maintain.
(b) Add the UNIQUE without the exception, and force re-entry to flow
through Delete-then-Promote (which is already the documented escape
hatch in the guard's tooltip text).
(c) Keep no DB constraint, but write a nightly check (cron + Slack
notification or a Supabase database function) that flags duplicates.

Recommend (b): the re-entry case is rare enough that requiring a manual
delete is acceptable, and the constraint catches bulk-import bugs.

**Effort estimate**: Small (1-3hr) for the migration + acceptance test
on the existing dups.

---

### F-007 — MEDIUM — `attributions.deal_id` is `TEXT`, not `UUID`

**Category**: Schema

**Location**: `sourced/SCHEMA.sql:104` and `sourced/sourced-app/SCHEMA.sql:164`

**Observation**: `deal_id TEXT` in both schema files. Application code
(`CreateHPPModal.tsx:159`) generates `crypto.randomUUID()` and inserts
the string into this column. Compares to `attributions.id UUID PRIMARY
KEY DEFAULT gen_random_uuid()` which uses the proper UUID type.

**Risk if not fixed**: No runtime bug today. Wider-than-needed type
allows non-UUID strings to be inserted (a typo in a custom import script
would silently store `"deal-123"`). Equality comparisons work fine.
Storage is slightly larger (TEXT vs UUID is 16 bytes vs 36 bytes). The
real cost is documentation: `TEXT` reads as "freeform identifier" when
it's actually a UUID.

**Suggested fix**: One-line schema change to `deal_id UUID`. Validate
existing rows are all parseable UUIDs first: `SELECT deal_id FROM
attributions WHERE deal_id IS NOT NULL AND deal_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LIMIT 5;`.

**Effort estimate**: Quick (<1hr) if no rogue values exist.

---

### F-008 — HIGH — Realtime subscriptions have no error or status callback

**Category**: Error handling / state management

**Location**: All realtime hooks. `useLeads.ts:334`, `useChannels.ts:52`,
`useAttributions.ts:141`, `useAttributionTouches.ts:107`,
`useFunnelActuals.ts:83`, `useFunnelProjections.ts:80`,
`useChannelLeadCounts.ts:58`, `useOutreachSnapshots.ts:108`.

**Observation**: Every `.subscribe()` call is bare. Supabase's realtime
client supports a status callback — `.subscribe((status, err) => {…})` —
that fires with `'SUBSCRIBED'`, `'CHANNEL_ERROR'`, `'TIMED_OUT'`, or
`'CLOSED'`. We use none of them. If the connection drops (network
hiccup, Supabase realtime outage, expired anon key, paused project), the
hook silently stops receiving updates and the UI quietly goes stale.
There is no toast, no banner, no console.error, no retry.

**Risk if not fixed**: This is a real failure mode in production. The
funnel grid's whole value prop is "edit a lead and watch the grid
recompute live." If the realtime channel drops while a user is editing,
their next edit appears to apply (optimistic update writes to local
state) but their colleague's view doesn't see it, and neither does the
chart on the next browser tab. We've lost the "single source of truth"
guarantee. The bigger problem: the user has no way to know it happened.
GA4 realtime updates (n8n cron writes to a new table) inherit the same
silent-failure mode.

**Suggested fix**: Standardize a `subscribeWithRetry` helper in
`src/lib/realtime.ts` that wraps the existing `.subscribe()` calls:
- Logs the status to console.
- On `CHANNEL_ERROR` / `TIMED_OUT`: retry with exponential backoff (1s,
  2s, 5s, 30s, give up).
- On final failure: set a global "stale" flag in a tiny Zustand or
  context store. Render a banner across the top: "Live updates
  disconnected. Refresh to resync."

Apply the helper to the eight hooks.

**Effort estimate**: Medium (3-8hr) to do it cleanly with the retry +
banner. Quick if you just add the status callback and a console.error
without the banner — but the banner is the part that prevents the silent
failure.

---

### F-009 — MEDIUM — CSV import per-row writes are not chunked for channel re-parenting

**Category**: Performance

**Location**: `src/hooks/useLeads.ts:197-215` (within `resolveChannelHierarchy`)

**Observation**: The lead update path correctly chunks via
`BULK_CHUNK = 100` (line 14, used at line 735+). The channel re-parenting
inside `resolveChannelHierarchy` does not:

```ts
const settled = await Promise.allSettled(
  updates.map((u) =>
    supabase.from('channels').update({ parent_channel_id: u.parentId }).eq('id', u.id),
  ),
);
```

Unbounded. With a large CSV that introduces many new sub-channels, this
fires N parallel UPDATEs. Today the channel taxonomy is small enough that
N is small, so this hasn't bitten.

**Risk if not fixed**: A pathological CSV (or a future GA4 channel-mapping
import that introduces hundreds of new channels) would trigger hundreds
of parallel UPDATEs. Supabase's pooler can handle bursts but not unbounded
ones; we'd see 503s and a partial sync state.

**Suggested fix**: Same chunked pattern (`BULK_CHUNK = 100`) applied
here.

**Effort estimate**: Quick (<1hr).

---

### F-010 — MEDIUM — CSV-imported text fields have no length validation

**Category**: Security / data integrity

**Location**: `src/lib/csv.ts:104-208` (`coalesceRows`),
`src/hooks/useLeads.ts:584-643` (`buildSyncPatch`, `buildInsertRow`)

**Observation**: User-supplied CSV columns (`first_name`, `last_name`,
`account`, `title`, `owner`, `lead_source`, `notes`) are trimmed and
inserted as-is. No `maxLength` enforcement at the importer. Postgres
TEXT columns will accept up to ~1GB before erroring; before that, a
3MB account name will quietly land in the database and break every
table render that displays it.

The CreateHPPModal and AttributionEditorModal also have unbounded
`<input type="text">` fields for `label`, `account`, `sf_link`. Same
issue.

There are no XSS vectors detected (no `dangerouslySetInnerHTML`, no
`innerHTML`, all renders via React text children). The risk is data
integrity, not script execution.

**Risk if not fixed**: A copy-paste accident or a malformed CSV column
(common when SFDC reports get column-shifted) writes garbage into the
account field. UI breaks visually (truncated everywhere), grid sort
becomes meaningless, and the row can't be cleaned up without a manual
SQL UPDATE.

**Suggested fix**: Two-layer defense.
- App-layer: clamp every text input to a sensible max in `coalesceRows`
  and the modals (e.g. `name 200, account 500, label 500, sf_link 1000,
  notes 4000`). Reject (or trim with a warning) anything longer.
- DB-layer: `ALTER TABLE leads ALTER COLUMN account TYPE varchar(500);`
  (etc.) for the most-rendered fields.

**Effort estimate**: Small (1-3hr). Ship the app-layer first as a hot
fix; DB-layer in the next migration window.

---

### F-011 — MEDIUM — `outreach_snapshots` has the same anon-write policy as user-edited tables

**Category**: Security

**Location**: `sourced/SCHEMA.sql:289-312`

**Observation**: The n8n cron writes to `outreach_snapshots` once a week
via the Sourced anon key. The same anon key sits in every user's browser
bundle. There's no separation between "machine writer" and "human
writer." A user with the anon key (everyone) can insert/update/delete
any row in `outreach_snapshots`, including rewriting historical
sequences.

**Risk if not fixed**: Lower than F-001 because the data is read-only in
the app (the dashboard never writes here). But a malicious or bored user
can easily corrupt the historical Outreach data. Detection is possible
(n8n's `UNIQUE (export_date, sequence_id)` upsert would replace any
manual writes the next week), but not guaranteed.

**Suggested fix**: Once F-001's auth model lands, scope
`outreach_snapshots` to a service-role-only write policy with a separate
key used by the n8n cron. Until then, document the trust assumption in
the table's SCHEMA comment.

**Effort estimate**: Small (1-3hr) once auth lands.

---

### F-012 — MEDIUM — CSV column-mapping localStorage entries are unbounded

**Category**: State management

**Location**: `src/components/import/ColumnMapper.tsx:54-67`

**Observation**: `sourced.csvMapping.<headerSetKey>` is keyed by a hash
of the CSV's header row. Every distinct CSV format the user has ever
imported writes a separate entry. There is no eviction, no TTL, no
cleanup. localStorage caps at ~5MB; one mapping is ~1KB so we have
~5000 mappings of headroom. Today the user has imported maybe 10
distinct formats. Risk is theoretical.

**Risk if not fixed**: Theoretical for a single user. Multiple users
sharing a browser would see each other's mapping suggestions, and the
cumulative growth could eventually hit the localStorage cap, after which
new mappings silently fail to persist (the catch in `lib/storage.ts:16`
just console.warns).

**Suggested fix**: When writing a new mapping, prune any entries older
than 90 days (track with a timestamp). Or cap to the most recent 50
header sets.

**Effort estimate**: Quick (<1hr).

---

### F-013 — MEDIUM — Inline edits roll back on server error but don't notify the user

**Category**: Error handling

**Location**: `src/hooks/useAttributions.ts:170-191` (update),
`src/hooks/useAttributions.ts:193-208` (delete),
`src/hooks/useLeads.ts:411-432` (applyPatch); etc.

**Observation**: Optimistic updates work correctly: state is captured
before the server call, applied immediately to local state, rolled back
on error. The error then `console.error`s and re-throws. Whether the
error reaches the user depends entirely on whether the call site has a
try/catch that surfaces it.

`LeadDetailDrawer` does this correctly (`wrapEdit`, `wrapToggle`,
`wrapRevert` all set a `topError` banner). Inline edits in `FunnelTable`
log to console only — the cell flickers (apply, then revert) and
nothing else surfaces.

**Risk if not fixed**: A user edits a projection, the server rejects
(RLS revoked, PostgREST timeout, schema CHECK violation), the value
visibly snaps back, the user thinks they fat-fingered it and tries
again. With no error message they can't tell whether the server is the
problem or their edit is invalid.

**Suggested fix**: Standardize a thin error-toast layer. Every hook
re-throws (good); every page-level view should mount an error boundary
or a toast component that catches the throw. `react-hot-toast` is small
and works with the existing palette.

**Effort estimate**: Small (1-3hr).

---

### F-014 — MEDIUM — No FE% definition is right for `closeLost`, current handling is correct but fragile

**Category**: Calculation correctness

**Location**: `src/components/funnel/FunnelTable.tsx:328-336`

**Observation**: FE% for closeLost is suppressed at the cell render
level: `const fe = prevStage === null || isLost ? null : funnelEfficiencyPercent(...)`.
This is correct (a `lost / won` ratio is meaningless). But the
suppression lives in the rendering component, not in the helper. Any
new chart that calls `funnelEfficiencyPercent(closeLostActual, prev)`
will get a misleading number.

**Risk if not fixed**: GA4 work plus future analytics widgets are likely
to build new ratio panels. If someone forgets to suppress closeLost,
they'll show a ratio that reads sensibly ("lost rate vs pursuit") but
isn't what the rest of the app means by FE%.

**Suggested fix**: Move the suppression into `funnelEfficiencyPercent`
itself with an additional parameter `stageKey?: FunnelStageKey`, and
return null when stageKey is `'closeLost'`. Or better, add a new helper
`funnelEfficiencyForStage(stage, actual, prevActual)` that wraps the
suppression rule. Keep the existing helper for legacy call sites.

**Effort estimate**: Quick (<1hr).

---

### F-015 — MEDIUM — Channel cycle detection is application-only

**Category**: Schema / data integrity

**Location**: `src/hooks/useLeads.ts:166-194`

**Observation**: `wouldCycle` walks the parent chain on the client to
prevent the importer from creating a cycle. It works correctly (covers
self-loop, simple cycle, deep cycle, malformed-input bailout). But the
canonical schema has no CHECK or trigger preventing cycles at the DB
layer. Anyone with the anon key can insert a cycle directly.

**Risk if not fixed**: Manual SQL (or a buggy future writer) creates
A→B→A. `resolveTopLevelChannelId` in `compute.ts` has its own cycle
guard that returns the input ID on cycle detection, so the funnel
grid wouldn't crash, but the rollup would be wrong. The Sankey would
mis-attribute leads.

**Suggested fix**: Add a Postgres trigger on `channels` that checks for
cycles before INSERT/UPDATE. Cheap query: walk
`parent_channel_id` for the new row and reject if you reach the row's
own id. Single migration.

**Effort estimate**: Small (1-3hr).

---

### F-016 — MEDIUM — `LOW`-numbered keys + the `sourced_unlocked` exception

**Category**: State management

**Location**: All localStorage usage (`src/lib/storage.ts`),
`src/components/PasswordGate.tsx:3`

**Observation**: All actively-used keys ARE prefixed with `sourced.`:

| Key | Writer | Reader | Default | Type |
|---|---|---|---|---|
| `sourced.funnel.lastTab` | App.tsx:216 | App.tsx:40 | null → defaultChild | PageKey \| null |
| `sourced.outreach.lastTab` | App.tsx:216 | App.tsx:40 | null → defaultChild | PageKey \| null |
| `sourced.sidebar.expanded.funnel` | Sidebar.tsx:70 | Sidebar.tsx:66 | true | boolean |
| `sourced.sidebar.expanded.outreach` | Sidebar.tsx:70 | Sidebar.tsx:66 | true | boolean |
| `sourced.charts.funnel.channel` | FunnelChartView.tsx:49 | FunnelChartView.tsx:46 | 'all' | string |
| `sourced.charts.trendline.stage` | TrendLineChartView.tsx:50 | TrendLineChartView.tsx:47 | 'all' | StageFilter |
| `sourced.charts.donut.stage` | DonutChartView.tsx:40 | DonutChartView.tsx:37 | 'lead' | FunnelStageKey |
| `sourced.charts.barchart.stage` | BarChartView.tsx:56 | BarChartView.tsx:53 | 'all' | StageFilter |
| `sourced.csvMapping.<hash>` | ColumnMapper.tsx:67 | ColumnMapper.tsx:60 | null → suggestMapping | ColumnMapping \| null |
| `sourced.funnel.selectedRows` | FunnelTable.tsx:481 | FunnelTable.tsx:477 | [] | string[] |
| `sourced.funnel.editsLocked` | FunnelDataEntryPage.tsx:118 | FunnelDataEntryPage.tsx:115 | true | boolean |

The one exception is the password gate: `sourced_unlocked` (underscore,
sessionStorage rather than localStorage). The hierarchy under `sourced.`
mostly works (`sourced.charts.X.Y`, `sourced.sidebar.expanded.X`) but
`sourced.funnel.lastTab` and `sourced.outreach.lastTab` drop the
`.sidebar.` mid-segment for no obvious reason — they're the same kind of
sidebar state as `sourced.sidebar.expanded.funnel`.

Orphan key: `sourced.funnelCollapsed.<channelId>` was written by an
earlier patch and is now actively cleaned up at app startup
(`src/main.tsx:11-14`). Graceful deprecation, no functionality lost.

**Risk if not fixed**: Cosmetic. Confusing for someone reading the
codebase.

**Suggested fix**: Rename `sourced.funnel.lastTab` →
`sourced.sidebar.lastTab.funnel` and ditto for outreach, with a one-time
migration in `main.tsx` to copy the old key into the new and delete the
old. Rename `sourced_unlocked` → `sourced.unlocked` for consistency, but
the storage type (`sessionStorage` vs `localStorage`) should stay
different and that distinction is worth preserving in the name —
e.g. `sourced.session.unlocked`.

**Effort estimate**: Quick (<1hr).

---

### F-017 — LOW — Modal `amount` field accepts negatives and unbounded large values

**Category**: Data integrity

**Location**: `src/components/attribution/CreateHPPModal.tsx:153-156`,
`src/components/attribution/AttributionEditorModal.tsx:132-135`

**Observation**: Numeric validation rejects NaN but no min/max:

```ts
const parsedAmount = amount.trim() === '' ? null : Number(amount);
if (parsedAmount !== null && Number.isNaN(parsedAmount)) {
  throw new Error('Amount must be a number');
}
```

A user can enter `-100`, `1e308`, etc. The Postgres column is
`NUMERIC(12,2)` so it rejects values exceeding 9,999,999,999.99 — but
not negatives.

**Risk if not fixed**: Won-deal totals could be skewed by a typo
("$5000" → "-5000" by accident). No detection.

**Suggested fix**: Reject `< 0` at the modal layer with a "Amount must
be ≥ 0" inline error. Optional max of $100M to catch typos.

**Effort estimate**: Quick (<1hr).

---

### F-018 — LOW (run as diagnostic) — Confirm Q1 MQL bucket alignment is clean post-correction

**Category**: Calculation correctness / data integrity

**Location**: Supabase SQL Editor (do not run in this audit)

**Observation**: The two May 4 migrations corrected 34 leads where
`marketing_sourced_date` and the MQL `entered_at` were both moved from
2026-04-02 to 2026-03-31. Per spec, this audit should suggest a query
that finds any OTHER leads where the MQL `entered_at` falls in a
different quarter than the lead's `marketing_sourced_date`.

**Suggested SQL** (run in Supabase SQL Editor, do not execute from this
audit):

```sql
SELECT
  l.id,
  l.email,
  l.marketing_sourced_date,
  (sh.value->>'entered_at')::date AS mql_entered_at,
  CEIL(EXTRACT(MONTH FROM l.marketing_sourced_date) / 3.0)::int AS lead_q,
  CEIL(EXTRACT(MONTH FROM (sh.value->>'entered_at')::date) / 3.0)::int AS mql_q
FROM leads l,
     LATERAL jsonb_array_elements(l.stage_history) AS sh
WHERE sh.value->>'stage' = 'mql'
  AND sh.value->>'entered_at' IS NOT NULL
  AND l.marketing_sourced_date IS NOT NULL
  AND EXTRACT(YEAR FROM l.marketing_sourced_date)
      = EXTRACT(YEAR FROM (sh.value->>'entered_at')::date)
  AND CEIL(EXTRACT(MONTH FROM l.marketing_sourced_date) / 3.0)::int
      <> CEIL(EXTRACT(MONTH FROM (sh.value->>'entered_at')::date) / 3.0)::int
ORDER BY l.email;
```

Expected result post-corrections: zero rows. Any rows returned indicate
a lead whose Lead-stage cell and MQL-stage cell will land in different
quarters in the funnel grid, causing the "MQL count exceeds Lead count
in Q+1" anomaly the May 4 corrections were meant to fix.

**Risk if not fixed**: Funnel math reads weirdly for any lead that
straddles a quarter boundary. The grid may show MQL > Lead in Q2 (which
should be impossible for a single cohort) because the lead's MQL
transition was logged in Q2 but it was sourced in Q1.

**Suggested fix**: Run the query. If it returns rows, write a fixup
migration similar to the May 4 ones. If zero, this finding closes.

**Effort estimate**: Quick (<1hr) to run the query. Small (1-3hr) if
fixups are needed.

---

### F-019 — LOW — `sf_link` URL field has no format validation

**Category**: Data integrity

**Location**: `src/components/attribution/CreateHPPModal.tsx:244-252`,
`src/components/attribution/AttributionEditorModal.tsx:220-227`

**Observation**: `<input type="url">` in the modal gives HTML5 form
validation only when the form is submitted via a `submit` event that
triggers it. The current submit handler calls `submit()` directly via
the click handler and bypasses the validation. Anyone can paste any
string. The link renders as `<a href={sf_link}>` in the
`OpportunitiesListModal` — which means a `javascript:` URL would execute
on click.

**Risk if not fixed**: With anon-write access, any attacker could
update an `sf_link` to `javascript:alert(document.cookie)` and wait for
a marketing user to click "SF" in the deal list. Today the password is
needed but the URL of attack is small.

**Suggested fix**: Validate at the modal layer that `sf_link` starts
with `https://` (or `http://` if you support it). Also pass `rel="noopener
noreferrer"` and `target="_blank"` on the rendered link (the current
code does this — verify in `OpportunitiesListModal`).

**Effort estimate**: Quick (<1hr).

---

### F-020 — LOW — `attribution_touches.touch_order` has no positive-integer CHECK

**Category**: Schema

**Location**: `sourced/SCHEMA.sql:131-140`

**Observation**: `touch_order INTEGER NOT NULL` with `UNIQUE(attribution_id,
touch_order)`. No CHECK on the integer being positive. Application code
inserts 1-indexed values, but a manual SQL or bug could insert 0 or
negative.

**Risk if not fixed**: Negligible. The Sankey ordering would be
slightly off if it happened, but nothing breaks.

**Suggested fix**: `CHECK (touch_order > 0)` next migration window.

**Effort estimate**: Quick (<1hr).

---

### F-021 — LOW — `marketing_sourced_date` accepts future dates

**Category**: Data integrity

**Location**: `sourced/SCHEMA.sql:51` (canonical)

**Observation**: `marketing_sourced_date DATE` with no constraint. A
user editing the date inline could type 2030. The lead lands in a
quarter with no other data and silently disappears from the visible
view (year selector doesn't auto-include 2030 unless any lead has data
there — which the bad data created).

**Risk if not fixed**: Low. A typo'd 2030 vs 2026 lead is a single
off-screen row. Detection would require querying for
`marketing_sourced_date > now() + interval '1 year'`.

**Suggested fix**: Either a CHECK at the DB
(`CHECK (marketing_sourced_date <= CURRENT_DATE + INTERVAL '7 days')`)
or a clamp at the inline-edit handler in `LeadFieldRow`. Or both.

**Effort estimate**: Quick (<1hr).

---

### F-022 — LOW — Working tree has 21 modified + 16 untracked files unrelated to current branch

**Category**: Git

**Location**: `git status` from `sourced-app/`

**Observation**: Pre-existing dirty tree carried across milestones.
`feature/funnel-flow-sankey` is the current branch. Local-only commits:

```
232b531 feat: replace channel influence sankey with multi-column funnel-flow sankey
4a61f9d feat: add Closed Lost as 7th terminal stage
```

Working tree:
- 21 modified-tracked (`src/App.tsx`, charts, hooks, etc. — M7 → M11
  work that landed in the two feature commits but was never broken
  out into its own milestone commits).
- 16 new-untracked (Sidebar, outreach pages, region constants, etc. —
  also M7 → M11 work).
- 2 deleted-tracked (`DashboardPage.tsx`, `ImportPage.tsx` — replaced
  during the IA refactor in M6.5).

This was acknowledged explicitly in both feature commit bodies as
"M7-M11 history will be reconstructed in a follow-up after the May 12
demo." This audit did not change anything in the tree.

**Risk if not fixed**: GA4 work will inherit this debt. New commits will
either continue the bundling pattern or sit on top of an unrebased mess.
At some point the history reconstruction has to happen; the longer it
waits, the more it blocks clean PRs.

**Suggested fix**: Tracked elsewhere (post-May-12 follow-up). Not part
of this audit's remediation plan.

**Effort estimate**: Large (1-2 days) when it happens.

---

### F-023 — LOW — Channel re-parenting bulk update is unbounded

**Category**: Performance

**Location**: `src/hooks/useLeads.ts:197-215`

**Observation**: Same as F-009 (channel re-parenting). Listed separately
because the lead-update path IS chunked correctly via `BULK_CHUNK = 100`
(line 14, used at line 735+) — only the channel-re-parenting bulk write
is unbounded. Just confirming this is a single specific issue, not a
broader pattern.

**Risk / fix / effort**: See F-009.

---

## Reverified items (no findings)

These were checked and found correct; logging here so future audits
don't re-investigate.

- **Lead count derivation** at `compute.ts:139-153`: filter on
  `marketing_sourced_date` quarter + region match. Correct.
- **MQL count derivation** at `compute.ts:154-167`: uses earliest
  `stage_history.entered_at` where `stage='mql'`, region from the lead.
  Correct.
- **Attribution stage counts** at `compute.ts:170-219`: counts attributions
  per `(channel, year, period, stage)` with manual fallback when no
  attribution covers the cell. Region check applied. Correct.
- **Region filter** at `compute.ts:97-105`: identical helper used by
  both lead pass and attribution pass. Correct.
- **Closed Lost FE% suppression** at `FunnelTable.tsx:328-336`: see
  F-014 for the architectural concern, but the current behavior is
  correct.
- **Division-by-zero guards** in `conversionPercent`, `onTargetPercent`,
  `funnelEfficiencyPercent` at `compute.ts:342-369`: all three guard.
  Correct.
- **`PctCell` decimal conversion** at `FunnelTable.tsx:259-284`: divides
  the 0-100 input by 100 before passing to `getOTColor`/`getFEColor`,
  which expect decimals. Correct.
- **Win/Loss block** at `ConversionsPanel.tsx:86-126`: denominator is
  `won + lost`, renders `—` when both zero. Correct.
- **Channel rollup** at `compute.ts:235-267`: post-order recursion,
  iterates `FUNNEL_STAGES` (which includes `closeLost`). Correct.
- **`computeFunnelSankey` cohort filter** at `compute.ts:755-771`:
  matches the grid's lead filter. Correct.
- **Manual-entry deal double-count guard** at `compute.ts:806-828`:
  `dealsCountedViaLead` set tracks lead-sourced deals so they're not
  counted again. Correct.
- **`pursuit → terminal:closeWon` rewrite** at `compute.ts:850-859`:
  retargets and merges values; no edge dropped or duplicated. Correct.
- **GIN index on `leads.stage_history`** at `SCHEMA.sql:96`: present.
- **Pagination** in 7 of 8 read hooks: correct (see F-003 for the eighth).
- **Bulk lead-update chunking** at `useLeads.ts:735+`: chunked at 100.
- **`field_locks` contract** in `buildSyncPatch` at `useLeads.ts:584-607`:
  CSV import respects locks; bulk and per-row paths both call this.
- **Optimistic-update rollbacks** in `useAttributions.update`,
  `delete`, `promote`, `markLost`: all roll back on server error and
  re-throw.
- **No `dangerouslySetInnerHTML` or `innerHTML`** anywhere in `src/`.
- **Cycle detection** in `resolveChannelHierarchy` at `useLeads.ts:166-194`:
  application-layer logic correct (DB-layer concern logged as F-015).
- **localStorage orphan cleanup** at `main.tsx:11-14`: removes
  `sourced.funnelCollapsed.*` keys on app boot.
