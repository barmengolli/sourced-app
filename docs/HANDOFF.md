# Sourced, Handoff Documentation

Last updated: 2026-05-12

This document is the single source of truth for picking up Sourced if the current owner leaves, takes extended leave, or hands off to a contractor. Read this entire document before making changes. It takes ~30 minutes.

If you are operating Sourced day-to-day (weekly imports, fixing data), skip ahead to the **Weekly operations** and **Common operations** sections.

---

## 1. What is Sourced?

Sourced is a custom B2B marketing attribution and funnel reporting tool built for EIS Group. It exists to fill the gap between Salesforce (the system of record) and what the Marketing Operations team actually needs to report on: a corrected, editable mirror of SFDC data with multi-touch deal attribution, channel hierarchy management, and velocity tracking across the funnel.

**Production URL:** https://sourced-app.vercel.app

**Why it exists:** Salesforce data quality is inconsistent. HubSpot data quality is also inconsistent. Commercial tools like Dreamdata and HockeyStack address parts of this problem but none of them fit EIS's specific funnel definitions, sales-team manual deal entry needs, and editable corrections workflow. Sourced was built to bridge those gaps.

**Demo workflow:** Imports SFDC campaign-member CSVs weekly, lets the MOps owner correct bad data in place (with field-level locks that survive re-imports), tracks deals via a multi-touch attribution chain (HPP → Opp → Pursuit → Closed Won or Closed Lost), and surfaces velocity, channel distribution, and week-over-week deltas in a unified dashboard.

**What it is NOT:** Sourced is not a CRM. It does not replace Salesforce or HubSpot. It does not have automated ad-platform integrations. It does not have multi-user authentication (currently). It is a personal-scale internal tool that may need to evolve into something more enterprise-grade over time (see Roadmap).

---

## 2. Tech stack at a glance

| Layer | Technology | Version (as of 2026-05-12) |
|---|---|---|
| Frontend | React | 19 |
| Language | TypeScript | 5.x |
| Build tool | Vite | latest |
| Styling | Tailwind CSS | v4 |
| Database | Supabase (Postgres) | hosted |
| Hosting | Vercel | hosted |
| Automation | n8n | self-hosted |
| Charts | Recharts | latest |
| CSV parsing | PapaParse | latest |
| Forms / state | React hooks, local state, localStorage | n/a |

There is no test suite. There is no CI beyond Vercel's build check. Both are noted in the audit document.

---

## 3. System access and vendors

The five external systems Sourced depends on. Each is the responsibility of a specific person or seat at EIS. **Before handoff is complete, the new owner must have admin or owner-level access to each.**

### 3.1 GitHub repository

- **URL:** https://github.com/barmengolli/sourced-app
- **Owner:** Currently Benjamin Armengolli (personal GitHub account)
- **Risk:** Repo is on a personal account. If the current owner leaves the company, the repo leaves with them. **Migrate to an EIS-owned GitHub organization before handoff is final.**
- **Action on handoff:**
  1. Transfer the repository to an EIS-controlled GitHub organization
  2. Grant the new owner admin access
  3. Update Vercel's GitHub integration to point at the new owner location

### 3.2 Vercel project

- **URL:** https://vercel.com/barmengolli-1411s-projects/sourced-app (or wherever it lives now)
- **Owner:** Personal Vercel account
- **Risk:** Same as GitHub. Personal account.
- **Action on handoff:**
  1. Transfer Vercel project to an EIS-controlled Vercel team
  2. Grant new owner admin access
  3. Re-verify environment variables are intact after transfer

### 3.3 Supabase project

- **URL:** https://supabase.com/dashboard (find the `sourced-app` project)
- **Owner:** Personal Supabase account
- **Risk:** Same risk. If the owner leaves, the database goes with them unless transferred.
- **Action on handoff:**
  1. Transfer Supabase project to an EIS-controlled Supabase organization
  2. Grant new owner admin access
  3. Document the project reference (the `<project-ref>.supabase.co` URL stays the same after transfer)
  4. Rotate the database password if the previous owner had it

### 3.4 n8n instance

- **URL:** Wherever it's self-hosted (Cloud, Docker, Hetzner, etc.)
- **Owner:** Personal account / personal infrastructure
- **Risk:** If the n8n instance lives on the current owner's personal infrastructure, it dies with them.
- **Action on handoff:**
  1. Move n8n to an EIS-controlled host (or migrate to n8n Cloud on an EIS workspace)
  2. Document the workflow JSON in the repo (export and commit to `sourced-app/docs/n8n-outreach-sync.json`)
  3. Grant new owner the n8n admin login

### 3.5 Salesforce and HubSpot

These are EIS-owned and not at handoff risk. The new Sourced owner needs:
- Salesforce: export permissions on the `Campaigns with Members and Contact Details` report (and any related reports)
- HubSpot: read access to the Marketing contact lists and lifecycle stages used by the inclusion list (see `/CLAUDE.md` for the inclusion-list definitions)

---

## 4. Environment variables

Sourced reads four environment variables, all prefixed with `VITE_` so Vite ships them to the client bundle. **These values are visible to anyone who inspects the JavaScript bundle in their browser.** That is acceptable for the current threat model (the password gate is a soft barrier, not real auth) but should be revisited as part of the F-001 auth migration.

| Variable | Value | Notes |
|---|---|---|
| `VITE_APP_PASSWORD` | The shared password for the gate | Marked sensitive in Vercel but still ships to the client. Rotate periodically. |
| `VITE_REVEAL_PII_PASSWORD` | Section-level password gate for the Leads view | Different from `VITE_APP_PASSWORD`. Page contents are hidden behind this gate; unlocking exposes raw lead data inside the Leads section only. Defeats shoulder-surfing, not devtools (rows still ship from Supabase). Share only with users who need raw PII access. |
| `VITE_SUPABASE_URL` | The Supabase project URL (`https://<ref>.supabase.co`) | Stable across deployments |
| `VITE_SUPABASE_ANON_KEY` | The Supabase anonymous key | Public by design (combined with RLS for security), but RLS is currently permissive (audit F-001) so treat as semi-sensitive |

**Where to find / set:**
- **Local dev:** `sourced-app/.env.local` (gitignored, never commit). Create from the example below.
- **Production:** Vercel Project Settings → Environment Variables.

**Example `.env.local`:**

```
VITE_APP_PASSWORD=<your-password>
VITE_REVEAL_PII_PASSWORD=<your-pii-password>
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

**How to rotate the password:**
1. Pick a new value. Save in Vercel under `VITE_APP_PASSWORD` (edit the existing variable, save).
2. Trigger a redeploy in Vercel (Deployments → three-dot menu → Redeploy on the latest deployment).
3. Update your local `.env.local` to match.
4. Tell anyone who has the password.

**How to rotate the Supabase anon key:**
Don't rotate routinely. Anon keys are designed to be public. If you have a real security incident, rotate via Supabase Project Settings → API → Reset anon key, then update Vercel and local. This will force-disconnect every active session.

---

## 5. Local development setup

Prerequisites:
- Node.js v20 or later (use `nvm use 20` if you have nvm)
- npm v10 or later (ships with Node 20)
- Git
- A modern terminal (zsh or bash)
- VS Code recommended, with these extensions: ESLint, Prettier, Tailwind CSS IntelliSense

Steps:

```bash
# Clone the repo
git clone https://github.com/barmengolli/sourced-app.git
cd sourced-app

# Install dependencies
npm install

# Create your local env file
cp .env.local.example .env.local
# Edit .env.local and fill in the three values above

# Run the local dev server
npm run dev
# Opens at http://localhost:5173

# Other useful commands:
npm run build         # Production build (also runs typecheck)
npx tsc --noEmit      # Typecheck only, no build
npm run lint          # ESLint (if configured)
```

**Caveats:**
- Local dev hits the SAME Supabase as production. There is no separate dev database. Changes you make locally affect production data. Be careful with imports and SQL.
- If you want a true dev environment, create a separate Supabase project and point your `.env.local` at it. You'd also need to copy the schema and a snapshot of data. Not done today.

---

## 6. Deployment

Vercel auto-deploys from the `main` branch on GitHub. Every push to `main` triggers a build. If the build passes, the new version goes live within ~60 seconds.

### 6.1 The standard PR flow

This is what every code change today goes through:

```bash
# Make changes on a feature branch
git checkout -b feat/my-change
# Edit files, commit
git push -u origin feat/my-change
```

Open a Pull Request on GitHub from `feat/my-change` → `main`. Review the diff. Use **Squash and merge** to keep `main` history clean.

After merging:
- Vercel detects the new commit on `main`, builds, deploys
- The merged branch can be deleted (GitHub prompts)
- Locally: `git checkout main && git pull origin main`

### 6.2 How to roll back a bad deploy

1. Open Vercel → Deployments
2. Find the last known-good deployment
3. Click its three-dot menu → "Promote to Production"
4. Vercel reverts production to that deployment within seconds

Note: this is a roll-back of the DEPLOYED artifact. The bad code is still on `main`. You'll want to either revert the commit on main (`git revert <hash>`) and push, or follow up with a fix commit, depending on the situation.

### 6.3 Preview deployments

Every PR gets a preview URL automatically from Vercel. Check the PR conversation for the Vercel bot comment. Use the preview URL to test changes before merging.

---

## 7. Data model

The Supabase schema lives in `sourced-app/SCHEMA.sql`. Migrations applied to production are tracked in `sourced-app/migrations/`. The README in that folder has the status of each migration.

### 7.1 Tables overview

| Table | Purpose |
|---|---|
| `channels` | Hierarchy of marketing channels (Parent Campaign → Sub-Campaign). Imported from SFDC's `Parent Campaign: Campaign Name` and `Campaign Name` columns. Self-referencing via `parent_channel_id`. Can also be added manually (e.g., the `Sales` channel for sales-team deals). |
| `leads` | Contact-level records, one row per email. Mirror of SFDC's campaign members. Includes `current_stage` (lead or mql), `marketing_sourced_date`, `region`, `source_channel_id`, plus a `stage_history` JSONB array and a `field_locks` JSONB for per-field edit protection. |
| `attributions` | Deal-stage records. One row per deal at each stage it has been in (HPP → Opp → Pursuit → Won/Lost). All rows for the same deal share a `deal_id`. Has `stage_entered_at` (when the deal entered THAT stage) for velocity tracking. |
| `attribution_touches` | Ordered list of marketing touches per attribution. Each touch has channel_id, touched_at, optional notes. |
| `funnel_projections` | Manually-entered projections per (channel, year, quarter, stage). What you HOPE to achieve. |
| `funnel_actuals` | Manually-entered actuals per (channel, year, quarter, stage) for stages where lead-level signal isn't sufficient (HPP onward). Fallback to attribution row counts when present. |
| `cell_comments`, `cell_links` | Per-cell notes and SFDC links on the funnel grid. Optional. |
| `outreach_snapshots` | Weekly snapshots of Outreach.io sequence performance (sent, delivered, opened, replied, etc.). Populated by the n8n workflow. |

### 7.2 Key relationships and concepts

**The channel hierarchy.** Channels are a self-referencing tree. Parent channels (e.g., `2026 - Content Syndication`) have NULL `parent_channel_id`. Sub-channels (e.g., `2026 - Content Syndication - Group Benefits`) point to their parent. The funnel grid renders the tree with collapse/expand on parents.

**Field locks.** Every editable field on a lead can be individually locked. Locked fields are preserved on re-import. The `field_locks` JSONB stores `{fieldName: true}` for each locked field. The importer's `buildSyncPatch` checks this before writing.

**Stage history.** A lead's `stage_history` is a JSONB array of `{stage, entered_at, edited_by, edit_locked}` entries. The funnel grid counts MQLs by the date of the lead's MQL entry (NOT by `marketing_sourced_date`). Importer auto-appends new entries when a re-import shows the lead at a new stage (this behavior was added 2026-05-12 to fix a known under-counting bug, migration `2026-05-12_backfill_missing_mql_stage_history.sql`).

**The attribution chain.** A deal moves through stages by creating NEW attribution rows that share the same `deal_id`. The original HPP row stays in the database after promotion to Opp; that's how the velocity report computes time-in-stage.

**Manual deals.** The Sales channel and any other manually-created HPPs do not have a `lead_id` on their attributions. The funnel grid handles this gracefully.

### 7.3 Date semantics, critical to understand

- **Lead counts** are bucketed by `leads.marketing_sourced_date` (the SFDC Member First Associated Date).
- **MQL counts** are bucketed by the lead's earliest `stage_history` entry where `stage = 'mql'`, specifically that entry's `entered_at`.
- **HPP/Opp/Pursuit/Won/Lost counts** are bucketed by the attribution row's `period_index` AND `year`. The `stage_entered_at` date on each row is used for velocity calculations but not for funnel bucketing.

The Compare tab (week-over-week) uses ISO weeks (Monday to Sunday) based on the same `marketing_sourced_date` for Leads and the same `stage_entered_at` for HPP+ stages.

### 7.4 Key constraints worth knowing

- `attributions(deal_id, stage_key)` has a partial UNIQUE index (where deal_id is not null). Prevents accidental duplicate downstream attributions.
- `attributions.stage_key`, `funnel_projections.stage_key`, `funnel_actuals.stage_key` all have CHECK constraints listing allowed stages. To add a new stage, the constraints must be updated.
- `channels(name, parent_channel_id)` is UNIQUE. Same channel name can't appear under the same parent twice.

---

## 8. Weekly operations

This is the rhythm the current owner runs. New owner should adopt the same cadence.

### 8.1 Monday morning: SFDC import

1. Open Salesforce. Navigate to the custom report **"Campaigns with Members and Contact Details"** (in the `Campaigns` folder, owned by Benjamin Armengolli).
2. Export as CSV (UTF-8). If Salesforce exports as Windows-1252, re-save as UTF-8 in Excel or run `iconv -f WINDOWS-1252 -t UTF-8 input.csv > output.csv`.
3. Open https://sourced-app.vercel.app, enter password, navigate to **Funnel Import** in the sidebar.
4. Drop the CSV. The column mapping should auto-recognize from previous imports.
5. Review the diff screen: new vs updated vs unchanged counts.
6. Click **Apply**. Watch the progress modal complete.
7. Verify by going to **Marketing Funnel: Leads & MQLs** tab and checking the Q1+Q2 totals against what you exported from SFDC.

### 8.2 Tuesday or as-needed: Outreach data refresh

Currently broken since week 19 of 2026. The n8n workflow needs to be debugged or replaced. See section 10.

### 8.3 Ongoing: Manual data corrections

When you spot bad data:
- Click the cell in the funnel grid to edit (for projections / actuals)
- Click into a row on the Leads page to edit individual lead fields
- Click into a deal's attribution badge to edit deal-level data (date, amount, channel, etc.)

For bulk corrections, use the Supabase SQL Editor. See the `migrations/` folder for examples of past corrections (the Q1 Book a Call date correction, the MQL backfill, etc.).

---

## 9. Manual data corrections, patterns to follow

Past corrections have followed a consistent pattern. Reuse this when you need to do bulk SQL fixes.

### 9.1 The pattern

1. **Write a diagnostic query first** to identify the affected rows.
2. **Make a copy of the query as the migration's pre-flight.**
3. **Wrap the UPDATE in `BEGIN; ... COMMIT;`** in a single SQL block so you can review the diff before committing.
4. **Set `field_locks` on the modified fields** so re-imports don't overwrite your corrections.
5. **Save the SQL file** at `sourced-app/migrations/YYYY-MM-DD_description.sql` and commit to git.
6. **Update `migrations/README.md`** with the status (PENDING, APPLIED, UNKNOWN).
7. **Run the SQL in Supabase SQL Editor** (paste the full block, run, verify the verification SELECT, then COMMIT or ROLLBACK).

### 9.2 Examples in the repo

- `2026-05-04_q1_date_correction_book_a_call.sql` (moved 34 leads from Q2 to Q1, locked the date field)
- `2026-05-04_q1_mql_history_correction_book_a_call.sql` (companion fix for the stage_history entries)
- `2026-05-12_backfill_missing_mql_stage_history.sql` (system-wide backfill of missing MQL entries)
- `2026-05-04_add_close_lost_stage.sql` (schema migration: relaxed CHECK constraints)
- `2026-05-07_attributions_unique_deal_stage.sql` (added partial UNIQUE index)

---

## 10. The Outreach n8n workflow

### 10.1 What it does

A weekly cron in n8n (Monday morning) pulls Outreach.io sequence performance data via Outreach's API, transforms it into per-sequence weekly snapshots, and upserts into the `outreach_snapshots` table in Supabase. The Outreach Data, Outreach Dashboard, and Outreach Compare tabs in Sourced visualize this data.

### 10.2 Current status

**The workflow has been broken since W19 of 2026.** The user has been visually flagged that W19 onward is missing from the Outreach tabs. Debug pending. Tracked as deferred task in the project backlog.

### 10.3 How to debug

1. Open the n8n instance.
2. Find the workflow named (something like) "Outreach Automated Reporting".
3. Open the most recent execution. Look for errors (red icons on nodes).
4. Most likely culprits in order:
   - Outreach API auth token expired (rotate via Outreach.io settings)
   - Supabase upsert failed due to schema change (the `outreach_snapshots` rate columns are TEXT in production but the workflow may be sending NUMERIC, or vice-versa)
   - Spreadsheet schema drift (if the workflow reads from a Google Sheet first)

### 10.4 Manual fallback

If you need to push outreach data manually:
1. Pull the data from Outreach.io directly (UI export or API)
2. Write an INSERT SQL with the right columns
3. Run in Supabase SQL Editor

---

## 11. Common operations

### 11.1 Add a new channel

Channels are auto-created on import when a new (Parent Campaign, Campaign Name) pair appears in SFDC. For channels not in SFDC (e.g., manual Sales channel), insert directly:

```sql
INSERT INTO channels (name, parent_channel_id, display_order, hidden)
VALUES ('My New Channel', NULL, 0, false)
RETURNING id, name;
```

### 11.2 Fix a wrong date on a deal

Open the deal via Marketing Funnel → click the attribution badge in the relevant cell → click **Edit** on the row → change the date → save. The year and quarter are derived from the date.

### 11.3 Create a deal manually (Sales team deals)

Marketing Funnel → Data Entry tab → click **+ Create HPP** at the top → fill in the form (deal name, account, amount, region, SF link, channel, period, entered-on date) → save. Add touches inside the form if you have them.

### 11.4 Promote a deal to the next stage

Open the modal for the deal's current stage (via the cell badge) → click **Promote** → set the date the deal entered the next stage → confirm. A new attribution row is created at the next stage with the same `deal_id`.

### 11.5 Mark a deal as Closed Lost

Same modal → click **Close Lost** → set the date → confirm.

### 11.6 Reset all my localStorage preferences

Open browser DevTools → Application tab → Local Storage → find `sourced.*` keys → delete. Or in the console: `Object.keys(localStorage).filter(k => k.startsWith('sourced.')).forEach(k => localStorage.removeItem(k))`.

---

## 12. Known limitations and tech debt

The complete audit is at `sourced-app/audit/2026-05-04_pre_ga4_foundation_audit.md`. Read it. The high-level summary:

| Severity | Count | Status |
|---|---|---|
| CRITICAL | 0 | n/a |
| HIGH | 6 | Bundles A, B, C closed F-002, F-003, F-004, F-006. F-001 and F-008 remain open. |
| MEDIUM | 9 | Most open. |
| LOW | 7 | Most open. |

### 12.1 The most important open items

- **F-001: Auth migration.** The password gate is a soft barrier, not real auth. Supabase RLS is set to anon-grant on every table. Migrate to Supabase Auth or SSO before more users or sensitive data enter the system.
- **F-008: Realtime error handling.** Supabase realtime subscriptions silently fail on disconnect. The UI shows stale data without warning. Needs an error boundary plus reconnect logic.
- **Outreach n8n workflow broken since W19.** See section 10.
- **Schema rate-column drift.** `outreach_snapshots` rate columns are declared `NUMERIC(5,2)` in `SCHEMA.sql` but were `ALTER`-ed to TEXT in production early in the project. Reconcile by updating SCHEMA.sql or migrating production back to NUMERIC.

### 12.2 Other things to know

- **No test coverage.** Manual QA only. The Vercel build catches TypeScript and bundle errors; nothing else.
- **No CI beyond Vercel.** No automated checks before merge.
- **The codebase has comments referring to "DataVis" frequently.** That's the predecessor app this was forked-in-spirit from. Some patterns are ported from it.

---

## 13. Roadmap

In rough priority order, based on conversations with the CMO and the marketing-ops owner.

### 13.1 Short-term (next 4-6 weeks)

1. **Push the stage-history fix follow-on work** if any imports surface new bugs.
2. **UX polish pass.** A two-week deliberate walkthrough to identify rough edges and ship small fixes.
3. **W19 outreach push and n8n debug.** Get the Outreach tabs current.
4. **Schema rate-column drift fix.**
5. **F-008 realtime error handling.**

### 13.2 Medium-term (1-3 months)

1. **F-001 auth migration.** Replace the password gate with Supabase Auth or EIS SSO.
2. **Cohort report.** Originally on the M8 roadmap. Show how cohorts from each quarter are progressing through the funnel.
3. **n8n SFDC daily sync.** Replace the weekly manual CSV import with an automated daily pull from Salesforce via n8n. This also gives us actual MQL transition dates instead of "today's date" approximations.
4. **GA4 integration.** Originally the goal that triggered the foundation audit.

### 13.3 Strategic (3+ months, requires CMO buy-in)

1. **Evaluate commercial alternatives.** Dreamdata and HockeyStack are the closest B2B fits. ~$10k/year. Trade-off: vendor reliability and SOC 2 vs custom-fit and free.
2. **If continuing with Sourced, harden the operational model.** Move from solo-MOps ownership to a documented team responsibility. Multi-user, role-based access, audit log.

---

## 14. Where to find more

- **The original spec:** `sourced/INITIAL_PROMPT.md`. Was the prompt that scaffolded Sourced. Useful historical context.
- **The audit:** `sourced-app/audit/2026-05-04_pre_ga4_foundation_audit.md`. Most important read for a new technical owner.
- **Project conventions:** `sourced-app/CLAUDE.md` and `/CLAUDE.md`. AI-targeted but human-readable. Documents naming conventions, the MOps tech stack at EIS, do-not-do list.
- **Migrations:** `sourced-app/migrations/`. Every SQL migration applied to production lives here. README at top.
- **Past prompts:** `sourced/prompts/`. Claude Code prompts for past features. Useful reference for what was built and why.

---

## 15. Quick handoff checklist

If you are doing the actual handoff, use this checklist.

- [ ] Transfer GitHub repo from personal account to EIS org
- [ ] Transfer Vercel project from personal account to EIS team
- [ ] Transfer Supabase project from personal account to EIS organization
- [ ] Move n8n workflow to EIS-controlled host or n8n Cloud workspace
- [ ] Rotate Supabase database password
- [ ] Rotate `VITE_APP_PASSWORD` to a new value
- [ ] Document n8n credentials in EIS's password manager
- [ ] Document Salesforce / HubSpot user accounts that have report-export permissions
- [ ] Walk new owner through one weekly import end-to-end
- [ ] Walk new owner through one manual data correction (SQL migration pattern)
- [ ] Confirm new owner can deploy via PR to main
- [ ] Confirm new owner can roll back via Vercel UI
- [ ] Update this document with the new owner's name and contact, and the date of handoff
