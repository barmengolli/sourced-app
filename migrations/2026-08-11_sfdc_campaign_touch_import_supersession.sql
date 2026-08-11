-- 2026-08-11_sfdc_campaign_touch_import_supersession.sql
--
-- One-time repair plus permanent prevention for legacy manual-import campaign
-- touches that were left beside the authoritative Salesforce CampaignMember
-- rows inserted by sourced_apply_sfdc_campaign_members.
--
-- Production read-only audit on 2026-08-11 found 2,608 proven legacy shadows:
-- each row had source='import', no CampaignMember ID, and the same canonical
-- Sourced person + exact child channel as an n8n_sync row carrying a real
-- CampaignMember ID. The overlap inflated every affected funnel channel.
-- Content Syndication Q3, for example, displayed 150 Leads / 82 MQLs instead
-- of the authoritative 77 Leads / 43 MQLs.
--
-- STATUS: PENDING / NOT YET APPLIED TO PRODUCTION.
-- RUN ORDER: after 2026-08-11_sfdc_campaign_member_daily_apply.sql.
--
-- Safety boundary:
--   * deletes only source='import' rows with campaign_member_id IS NULL;
--   * requires an n8n_sync row with a real CampaignMember ID for the same
--     lead_id and exact child channel_id;
--   * never deletes n8n_sync, manual, backfill, unmatched import, lead, or
--     channel rows;
--   * the trigger applies the same predicate to future n8n inserts/updates;
--   * rerunning is idempotent (the second cleanup deletes zero rows).

BEGIN;

CREATE OR REPLACE FUNCTION public.sourced_supersede_legacy_import_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- The existing table still has legacy browser-write policies. Automatic
  -- deletion is allowed only while the postgres-owned SECURITY DEFINER apply
  -- function is executing. PostgreSQL preserves that definer identity inside
  -- this invoker trigger. A direct anon/authenticated browser write therefore
  -- cannot use the trigger to remove another row.
  IF current_user <> 'postgres' THEN
    RETURN NEW;
  END IF;

  IF NEW.source = 'n8n_sync'
     AND NEW.campaign_member_id IS NOT NULL
     AND NEW.channel_id IS NOT NULL THEN
    DELETE FROM public.lead_campaign_touches AS legacy
    WHERE legacy.id <> NEW.id
      AND legacy.source = 'import'
      AND legacy.campaign_member_id IS NULL
      AND legacy.lead_id = NEW.lead_id
      AND legacy.channel_id = NEW.channel_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sourced_supersede_legacy_import_touch() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sourced_supersede_legacy_import_touch() FROM anon;
REVOKE ALL ON FUNCTION public.sourced_supersede_legacy_import_touch() FROM authenticated;

DROP TRIGGER IF EXISTS trg_sourced_supersede_legacy_import_touch
  ON public.lead_campaign_touches;
CREATE TRIGGER trg_sourced_supersede_legacy_import_touch
AFTER INSERT OR UPDATE OF lead_id, channel_id, source, campaign_member_id
ON public.lead_campaign_touches
FOR EACH ROW
EXECUTE FUNCTION public.sourced_supersede_legacy_import_touch();

-- One-time repair. The RETURNING CTE makes the exact mutation count visible
-- in the SQL Editor without exposing any person, campaign, or membership ID.
WITH deleted AS (
  DELETE FROM public.lead_campaign_touches AS legacy
  WHERE legacy.source = 'import'
    AND legacy.campaign_member_id IS NULL
    AND legacy.channel_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.lead_campaign_touches AS authoritative
      WHERE authoritative.source = 'n8n_sync'
        AND authoritative.campaign_member_id IS NOT NULL
        AND authoritative.lead_id = legacy.lead_id
        AND authoritative.channel_id = legacy.channel_id
    )
  RETURNING legacy.id
)
SELECT pg_catalog.count(*)::INTEGER AS legacy_import_touches_superseded
FROM deleted;

-- Aggregate-only postconditions. Expected on the first production run:
-- legacy_import_touches_still_shadowed = 0. The other counts are evidence,
-- not hard-coded gates, so a legitimate daily sync between audit and apply
-- cannot make the migration fail spuriously.
SELECT
  (
    SELECT pg_catalog.count(*)
    FROM public.lead_campaign_touches AS legacy
    WHERE legacy.source = 'import'
      AND legacy.campaign_member_id IS NULL
      AND legacy.channel_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.lead_campaign_touches AS authoritative
        WHERE authoritative.source = 'n8n_sync'
          AND authoritative.campaign_member_id IS NOT NULL
          AND authoritative.lead_id = legacy.lead_id
          AND authoritative.channel_id = legacy.channel_id
      )
  ) AS legacy_import_touches_still_shadowed,
  (
    SELECT pg_catalog.count(*)
    FROM public.lead_campaign_touches
    WHERE source = 'n8n_sync'
  ) AS authoritative_n8n_touches,
  (
    SELECT pg_catalog.count(*)
    FROM public.lead_campaign_touches
    WHERE source = 'import'
  ) AS unmatched_legacy_import_touches,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS t
    JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'lead_campaign_touches'
      AND t.tgname = 'trg_sourced_supersede_legacy_import_touch'
      AND NOT t.tgisinternal
  ) AS prevention_trigger_exists;

COMMIT;
