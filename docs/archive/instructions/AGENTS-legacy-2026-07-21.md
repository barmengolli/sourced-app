# Archived Codex instructions

> Archived on 2026-07-21. Historical reference only. The active project
> instructions are in `../../../CLAUDE.md`. Do not use this file as current
> guidance.

# sourced: project instructions for Codex

This file is loaded for Codex work in this repository. Follow it strictly.

## Required context

Before any task, read `docs/PROJECT_CONTEXT.md` completely. It is the canonical
description of the application that exists now.

For any reporting source, timeframe filter, comparison, delta, KPI, chart,
aggregation, or reporting-control task, also read
`docs/REPORTING_TIMEFRAME_DELTA_STANDARD.md` completely before acting.

For database work, inspect `SCHEMA.sql`, the relevant migrations, and the live
catalog when authorized. Migration status documentation alone is not proof of
production state.

## Non-negotiable rules

- Treat customer and prospect data as sensitive PII. Never commit source
  exports, contact lists, real records, credentials, or `.env` files.
- Never print full lead records or secrets to logs, tests, documentation, or
  tool output.
- Password gates are convenience barriers, not real authorization. Current RLS
  is permissive. Do not claim otherwise.
- Local development normally uses production Supabase. Do not create, edit,
  import, delete, migrate, deploy, or otherwise change production state without
  explicit user authorization.
- Preserve the lead edit-lock contract. Locked Marketing values survive imports
  while incoming Salesforce values update `source_sfdc`.
- Funnel actuals are computed from source records. Projections and historical
  fallbacks remain stored at their documented grain.
- An HPP may have no linked lead. Source channel is required. Never fabricate a
  lead, and never infer Sales origin from a null `lead_id`.
- Lead email is the canonical identity key and is stored lowercase.
- Update `SCHEMA.sql` in the same approved change as a structural migration.
- Follow the reporting standard. Preserve fine source grain, never invent
  monthly data, and never sum cumulative or point-in-time snapshots.
- Reporting controls with the same purpose must use shared visual primitives.
  Do not duplicate page-local Tailwind control styles.
- Use the existing theme, lowercase `sourced` wordmark, and sentence case.
- Do not use em dashes in user-facing or generated copy.
- Do not add unrelated features or broaden a focused task without approval.

## Working rules

- Inspect before changing. Prefer the current code over old milestone or
  handoff descriptions, and report any conflict.
- Preserve unrelated user changes and untracked files.
- Use `rg` for search and `apply_patch` for manual file edits.
- Keep calculations and data transformations pure where practical.
- Add regression tests for calculation, import, lock, and data-contract changes.
- Tests must be deterministic, use fixed dates, and make no network calls.
- Run verification proportional to the change. For code changes, the standard
  gate is `npm run verify`.
- Lint has an existing backlog. Do not suppress or increase findings.
- When work changes architecture, data contracts, integrations, or operational
  assumptions, update `docs/PROJECT_CONTEXT.md` in the same change.

## Canonical references

- Current project context: `docs/PROJECT_CONTEXT.md`
- Reporting standard: `docs/REPORTING_TIMEFRAME_DELTA_STANDARD.md`
- Database schema: `SCHEMA.sql`
- Migration ledger: `migrations/README.md`
- Deferred lint plan: `docs/LINT_BACKLOG.md`
- LinkedIn n8n mapping: `docs/linkedin-n8n-mapping.md`

When in doubt, stop and ask Benjamin before changing scope or production state.
