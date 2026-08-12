-- 2026-08-12_funnel_account_identity_and_lifecycle_provenance.sql
--
-- Adds exact Salesforce Account identity to the three reporting layers and
-- versioned ingestion wrappers that preserve the already-proven apply
-- functions. Account names remain display-only and are never identity keys.
-- The CampaignMember wrapper also distinguishes an observed baseline from a
-- later witnessed Lead-to-MQL transition. No business data is imported by
-- applying this migration.
--
-- RUN ORDER: after the applied 2026-08-11 CampaignMember apply migration and
-- the applied 2026-08-12 Opportunity daily ingestion contract.
-- STATUS: PENDING / NOT YET APPLIED.

BEGIN;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS sfdc_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_sfdc_account_id
  ON public.leads (sfdc_account_id);

ALTER TABLE public.attributions
  ADD COLUMN IF NOT EXISTS sfdc_account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_attributions_sfdc_account_id
  ON public.attributions (sfdc_account_id);

ALTER TABLE public.sf_opportunities
  ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sf_opportunities_account_id
  ON public.sf_opportunities (account_id);

-- The controlled 2026-08-11 CampaignMember apply was the initial observation
-- baseline, not thousands of same-day transitions. Label only the exact
-- legacy rows that carry the known ingestion author and lack the new field.
UPDATE public.leads AS l
SET stage_history = COALESCE((
  SELECT pg_catalog.jsonb_agg(
    CASE
      WHEN entry.value->>'stage' = 'mql'
       AND entry.value->>'edited_by' = 'n8n Salesforce daily sync'
       AND NOT (entry.value ? 'event_kind')
       AND entry.value->>'entered_at' = '2026-08-11'
      THEN entry.value || pg_catalog.jsonb_build_object('event_kind', 'baseline')
      ELSE entry.value
    END
    ORDER BY entry.ordinality
  )
  FROM pg_catalog.jsonb_array_elements(COALESCE(l.stage_history, '[]'::JSONB))
    WITH ORDINALITY AS entry(value, ordinality)
), '[]'::JSONB)
WHERE EXISTS (
  SELECT 1
  FROM pg_catalog.jsonb_array_elements(COALESCE(l.stage_history, '[]'::JSONB)) AS entry
  WHERE entry->>'stage' = 'mql'
    AND entry->>'edited_by' = 'n8n Salesforce daily sync'
    AND NOT (entry ? 'event_kind')
    AND entry->>'entered_at' = '2026-08-11'
);

CREATE OR REPLACE FUNCTION public.sourced_apply_sfdc_campaign_members_v2(
  p_rows JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_rec JSONB;
  v_result JSONB;
  v_email TEXT;
  v_account_id TEXT;
  v_person_id UUID;
  v_source_observed_date DATE;
  v_local_observed_date DATE;
  v_prestate JSONB := '{}'::JSONB;
  v_prior_state TEXT;
BEGIN
  IF pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'p_rows must be a JSON array';
  END IF;

  -- Capture whether each person existed and had already reached MQL before the
  -- v1 atomic apply. This is the only evidence needed to distinguish a new
  -- baseline from a witnessed transition; no history is invented.
  FOR v_rec IN SELECT value FROM pg_catalog.jsonb_array_elements(p_rows)
  LOOP
    v_email := pg_catalog.lower(NULLIF(pg_catalog.btrim(v_rec->>'email'), ''));
    v_account_id := NULLIF(pg_catalog.btrim(v_rec->>'sfdc_account_id'), '');
    IF v_account_id IS NOT NULL
       AND v_account_id !~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Salesforce Account identity';
    END IF;

    IF v_email IS NOT NULL AND NOT (v_prestate ? v_email) THEN
      SELECT l.id INTO v_person_id
      FROM public.leads AS l
      WHERE l.email = v_email;

      v_prestate := v_prestate || pg_catalog.jsonb_build_object(
        v_email,
        CASE
          WHEN v_person_id IS NULL THEN 'missing'
          WHEN EXISTS (
            SELECT 1
            FROM public.leads AS l,
              pg_catalog.jsonb_array_elements(COALESCE(l.stage_history, '[]'::JSONB)) AS h
            WHERE l.id = v_person_id AND h->>'stage' = 'mql'
          ) THEN 'mql'
          ELSE 'lead'
        END
      );
    END IF;
  END LOOP;

  -- The applied v1 function remains the atomic authority for people,
  -- memberships, channels, manual locks, retries, and identity conflicts.
  v_result := public.sourced_apply_sfdc_campaign_members(p_rows);

  FOR v_rec IN SELECT value FROM pg_catalog.jsonb_array_elements(p_rows)
  LOOP
    v_email := pg_catalog.lower(NULLIF(pg_catalog.btrim(v_rec->>'email'), ''));
    v_account_id := NULLIF(pg_catalog.btrim(v_rec->>'sfdc_account_id'), '');
    v_prior_state := v_prestate->>v_email;
    v_source_observed_date := (v_rec->>'observed_at')::TIMESTAMPTZ::DATE;
    v_local_observed_date := (
      (v_rec->>'observed_at')::TIMESTAMPTZ AT TIME ZONE 'America/Denver'
    )::DATE;

    SELECT l.id INTO v_person_id
    FROM public.leads AS l
    WHERE l.email = v_email
    FOR UPDATE;

    IF v_account_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.leads AS l
      WHERE l.id = v_person_id
        AND l.sfdc_account_id IS NOT NULL
        AND pg_catalog.left(l.sfdc_account_id, 15)
          <> pg_catalog.left(v_account_id, 15)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23505',
        MESSAGE = 'existing person carries a different Salesforce Account identity';
    END IF;

    UPDATE public.leads AS l
    SET sfdc_account_id = COALESCE(l.sfdc_account_id, v_account_id),
        stage_history = COALESCE((
          SELECT pg_catalog.jsonb_agg(
            CASE
              WHEN entry.value->>'stage' = 'mql'
               AND entry.value->>'edited_by' = 'n8n Salesforce daily sync'
               AND NOT (entry.value ? 'event_kind')
               AND entry.value->>'entered_at' = v_source_observed_date::TEXT
              THEN entry.value || pg_catalog.jsonb_build_object(
                'entered_at', v_local_observed_date,
                'event_kind', CASE WHEN v_prior_state = 'lead'
                  THEN 'transition' ELSE 'baseline' END
              )
              ELSE entry.value
            END
            ORDER BY entry.ordinality
          )
          FROM pg_catalog.jsonb_array_elements(COALESCE(l.stage_history, '[]'::JSONB))
            WITH ORDINALITY AS entry(value, ordinality)
        ), '[]'::JSONB),
        source_sfdc = COALESCE(l.source_sfdc, '{}'::JSONB)
          || pg_catalog.jsonb_build_object('account_id', v_account_id)
    WHERE l.id = v_person_id;
  END LOOP;

  RETURN v_result || pg_catalog.jsonb_build_object('contract_version', 2);
END;
$$;

REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.sf_apply_opportunity_ingestion_v3(
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
  v_account_id TEXT;
BEGIN
  FOR v_item IN
    SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_snapshots, '[]'::JSONB))
  LOOP
    v_account_id := NULLIF(pg_catalog.btrim(v_item->>'account_id'), '');
    IF v_account_id IS NOT NULL
       AND v_account_id !~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Salesforce Account identity';
    END IF;
  END LOOP;

  -- v2 remains authoritative for its applied snapshot/review transaction.
  v_result := public.sf_apply_opportunity_ingestion_v2(
    p_snapshots, p_events, p_reviews, p_run
  );

  FOR v_item IN
    SELECT * FROM pg_catalog.jsonb_array_elements(COALESCE(p_snapshots, '[]'::JSONB))
  LOOP
    UPDATE public.sf_opportunities
    SET account_id = NULLIF(pg_catalog.btrim(v_item->>'account_id'), '')
    WHERE sf_opportunity_id = v_item->>'sf_opportunity_id'
      AND sf_last_modified_at = NULLIF(v_item->>'sf_last_modified_at', '')::TIMESTAMPTZ
      AND content_hash IS NOT DISTINCT FROM v_item->>'content_hash';
  END LOOP;

  RETURN v_result || pg_catalog.jsonb_build_object('contract_version', 3);
END;
$$;

REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion_v3(JSONB, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion_v3(JSONB, JSONB, JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sf_apply_opportunity_ingestion_v3(JSONB, JSONB, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sf_apply_opportunity_ingestion_v3(JSONB, JSONB, JSONB, JSONB) TO service_role;

COMMIT;
