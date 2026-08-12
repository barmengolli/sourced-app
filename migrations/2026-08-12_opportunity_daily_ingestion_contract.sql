-- 2026-08-12_opportunity_daily_ingestion_contract.sql
--
-- Forward-only support for the approved Salesforce Opportunity daily sync.
-- Adds the confirmed editable Market source value, a narrow BDR suggestion,
-- plus four reviewer-owned
-- overrides. Source values refresh nightly; ingestion never writes an
-- override, so Marketing corrections always win at presentation time via
-- COALESCE(override, source). Adds a v2 apply boundary that preserves the
-- already-applied atomic ingestion function and persists Market only for the
-- exact accepted snapshot timestamp/hash. Adds one restricted state-reader
-- RPC for the server-side n8n planner. No data is imported or backfilled.
--
-- RUN ORDER: requires the applied 2026-07-24 and 2026-07-27 Opportunity
-- migrations. Apply manually in Supabase SQL Editor. PENDING / NOT APPLIED.

BEGIN;

ALTER TABLE public.sf_opportunities
  ADD COLUMN IF NOT EXISTS market TEXT,
  ADD COLUMN IF NOT EXISTS suggested_bdr_name TEXT
    CHECK (suggested_bdr_name IN ('Dave Cummins', 'Garrett McNally'));

ALTER TABLE public.sf_opportunity_reviews
  ADD COLUMN IF NOT EXISTS market_override TEXT,
  ADD COLUMN IF NOT EXISTS commercial_region_override TEXT,
  ADD COLUMN IF NOT EXISTS gtm_cube_override TEXT;

-- suggested_bdr_name is evidence only. It never writes reviewer-owned source
-- attribution or channel selection. Source-channel override already exists as
-- reviewer-owned channel_id.
-- The ingestion function touches only issue_codes on existing reviews.

CREATE OR REPLACE FUNCTION public.sf_apply_opportunity_ingestion_v2(
  p_snapshots JSONB DEFAULT '[]'::JSONB,
  p_events JSONB DEFAULT '[]'::JSONB,
  p_reviews JSONB DEFAULT '[]'::JSONB,
  p_run JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_result JSONB;
  v_item JSONB;
BEGIN
  -- The applied v1 function remains the atomic authority for snapshots,
  -- events, reviews, audit events, run rows, idempotency, and watermarks.
  v_result := public.sf_apply_opportunity_ingestion(
    p_snapshots, p_events, p_reviews, p_run
  );

  IF COALESCE((v_result->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  -- Persist Market and the normalized BDR suggestion only when this exact
  -- snapshot is the current accepted row. A stale payload or same-timestamp
  -- conflict can never overwrite either value.
  FOR v_item IN
    SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_snapshots, '[]'::JSONB))
  LOOP
    UPDATE public.sf_opportunities
    SET market = v_item->>'market',
        suggested_bdr_name = v_item->>'suggested_bdr_name'
    WHERE sf_opportunity_id = v_item->>'sf_opportunity_id'
      AND sf_last_modified_at = NULLIF(v_item->>'sf_last_modified_at', '')::TIMESTAMPTZ
      AND content_hash IS NOT DISTINCT FROM v_item->>'content_hash';
  END LOOP;

  RETURN v_result || pg_catalog.jsonb_build_object('contract_version', 2);
END;
$$;

REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion_v2(JSONB, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion_v2(JSONB, JSONB, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion_v2(JSONB, JSONB, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sf_apply_opportunity_ingestion_v2(JSONB, JSONB, JSONB, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.sf_read_opportunity_ingestion_state()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'snapshots', COALESCE((
      SELECT pg_catalog.jsonb_object_agg(
        o.sf_opportunity_id,
        pg_catalog.jsonb_build_object(
          'contentHash', o.content_hash,
          'recordTypeDeveloperName', o.record_type_developer_name,
          'sfLastModifiedAt', o.sf_last_modified_at
        )
      )
      FROM public.sf_opportunities o
    ), '{}'::JSONB),
    'eventContentByHistoryId', COALESCE((
      SELECT pg_catalog.jsonb_object_agg(
        e.sf_history_id,
        pg_catalog.jsonb_build_object(
          'sfOpportunityId', e.sf_opportunity_id,
          'sourceField', e.source_field,
          'oldValue', e.old_value,
          'newValue', e.new_value,
          'changedAt', e.changed_at
        )
      )
      FROM public.sf_opportunity_events e
    ), '{}'::JSONB),
    'reviews', COALESCE((
      SELECT pg_catalog.jsonb_object_agg(
        o.sf_opportunity_id,
        pg_catalog.jsonb_build_object(
          'reviewState', r.review_state,
          'issueCodes', pg_catalog.to_jsonb(r.issue_codes),
          'channelId', r.channel_id,
          'leadId', r.lead_id
        )
      )
      FROM public.sf_opportunity_reviews r
      JOIN public.sf_opportunities o ON o.id = r.sf_opportunity_uuid
    ), '{}'::JSONB),
    'links', COALESCE((
      SELECT pg_catalog.jsonb_object_agg(
        chosen.sf_opportunity_id,
        pg_catalog.jsonb_build_object(
          'dealId', chosen.deal_id,
          'linkState', chosen.link_state
        )
      )
      FROM (
        SELECT DISTINCT ON (o.sf_opportunity_id)
          o.sf_opportunity_id, l.deal_id, l.link_state
        FROM public.sf_opportunity_deal_links l
        JOIN public.sf_opportunities o ON o.id = l.sf_opportunity_uuid
        ORDER BY o.sf_opportunity_id,
          CASE WHEN l.link_state = 'active' THEN 0 ELSE 1 END,
          l.updated_at DESC,
          l.id DESC
      ) chosen
    ), '{}'::JSONB)
  );
$$;

REVOKE ALL ON FUNCTION public.sf_read_opportunity_ingestion_state() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sf_read_opportunity_ingestion_state() FROM anon;
REVOKE ALL ON FUNCTION public.sf_read_opportunity_ingestion_state() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sf_read_opportunity_ingestion_state() TO service_role;

COMMIT;
