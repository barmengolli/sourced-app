-- 2026-08-12_opportunity_reporting_projection.sql
--
-- Adds provenance required to keep reviewer-created attribution rows separate
-- from the future reversible Salesforce Opportunity reporting projection.
-- Applying this migration creates structure only. It does not approve a
-- review, create/link a deal, populate an attribution, or delete business
-- data. The authenticated review API remains responsible for the eventual
-- atomic approval/promotion transaction.
--
-- STATUS: Applied manually to production on 2026-08-12. Direct catalog
-- verification confirmed both provenance columns, both check constraints,
-- and the exact Salesforce Opportunity/stage partial unique index. Existing
-- rows remain manual; no review was approved and no attribution was created.

BEGIN;

ALTER TABLE public.attributions
  ADD COLUMN IF NOT EXISTS source_system TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE public.attributions
  ADD COLUMN IF NOT EXISTS sf_opportunity_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'attributions_source_system_valid'
      AND conrelid = 'public.attributions'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.attributions
      ADD CONSTRAINT attributions_source_system_valid
      CHECK (source_system IN ('manual', 'salesforce'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'attributions_salesforce_identity_required'
      AND conrelid = 'public.attributions'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.attributions
      ADD CONSTRAINT attributions_salesforce_identity_required
      CHECK (
        source_system = 'manual'
        OR NULLIF(pg_catalog.btrim(sf_opportunity_id), '') IS NOT NULL
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_attributions_sf_opportunity_id
  ON public.attributions (sf_opportunity_id);

-- One generated row per Salesforce Opportunity and stage. Manual rows are
-- excluded so no automation can collide with or remove reviewer-created data.
CREATE UNIQUE INDEX IF NOT EXISTS attributions_salesforce_opportunity_stage_uniq
  ON public.attributions (sf_opportunity_id, stage_key)
  WHERE source_system = 'salesforce';

COMMIT;
