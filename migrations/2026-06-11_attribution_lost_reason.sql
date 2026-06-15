-- 2026-06-11_attribution_lost_reason.sql
--
-- Adds a free-form-but-constrained `lost_reason` to attributions, captured
-- when a deal is marked close-lost. The app offers a few values today
-- ("Closed-Lost to Competitor", "Closed-Lost In-House", "Closed-Disqualified")
-- via a required dropdown, but the column is plain TEXT (no CHECK) so the
-- option list can evolve in the UI without a schema change.
--
-- Nullable with no backfill: existing close-lost rows keep lost_reason = NULL
-- and render as "No reason set" until edited. The MOps lead fills these in
-- manually via the deal editor. New close-lost actions require a reason at
-- the UI layer.
--
-- RUN ORDER: standalone, no dependencies. Apply manually in the Supabase SQL
-- Editor (no migration runner is wired into the app). Idempotent.

ALTER TABLE attributions
  ADD COLUMN IF NOT EXISTS lost_reason TEXT;
