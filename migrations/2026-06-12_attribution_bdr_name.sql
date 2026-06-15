-- 2026-06-12_attribution_bdr_name.sql
--
-- Adds `bdr_name` to attributions: which BDR (sales-development rep) a deal
-- is credited to, for the BDR Quota tracker. The app offers a fixed roster
-- ("Dave Cummins", "Garrett McNally") via a dropdown in the deal editor, but
-- the column is plain TEXT (no CHECK) so the roster can change in the UI
-- without a schema change.
--
-- Deal-level: like region, the editor propagates one bdr_name across every
-- row of a deal_id on save, so any stage row of a deal carries the same value.
--
-- Nullable, no backfill: existing deals are untagged (NULL) until set in the
-- editor. The BDR dashboard only counts deals whose first-touch top-level
-- channel is "Marketing SDR" AND whose bdr_name matches a roster member.
--
-- RUN ORDER: standalone, no dependencies. Apply manually in the Supabase SQL
-- Editor (no migration runner is wired into the app). Idempotent.

ALTER TABLE attributions
  ADD COLUMN IF NOT EXISTS bdr_name TEXT;

CREATE INDEX IF NOT EXISTS idx_attributions_bdr_name
  ON attributions(bdr_name);
