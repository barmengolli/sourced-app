-- 2026-08-12_campaign_member_v2_set_based_hardening.sql
--
-- Replaces only the v2 Account/provenance wrapper after the first controlled
-- 2,618-membership invocation exceeded Supabase's statement timeout. The
-- proven v1 CampaignMember apply remains the atomic authority. The v2
-- prestate capture and post-apply Account/provenance update are changed from
-- one query per membership to two set-based statements over a transaction-
-- local temporary table.
--
-- The timed-out PostgreSQL statement was canceled atomically; this migration
-- does not assume that any part of that invocation committed.
--
-- STATUS: Applied manually to production on 2026-08-12. This migration
-- changed function code only and did not import or alter business data.

BEGIN;

CREATE OR REPLACE FUNCTION public.sourced_apply_sfdc_campaign_members_v2(
  p_rows JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'p_rows must be a JSON array';
  END IF;
  IF pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'p_rows must not be empty';
  END IF;
  IF pg_catalog.jsonb_array_length(p_rows) > 10000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'p_rows exceeds the 10000-row safety limit';
  END IF;

  -- A caller may invoke the RPC twice inside one explicit transaction during
  -- verification. Remove only this session-local scratch relation so the
  -- second invocation remains an exact retry; no persistent table is dropped.
  DROP TABLE IF EXISTS pg_temp._sourced_cm_v2_people;
  CREATE TEMP TABLE _sourced_cm_v2_people ON COMMIT DROP AS
  WITH parsed AS (
    SELECT
      pg_catalog.lower(NULLIF(pg_catalog.btrim(row_value->>'email'), '')) AS email,
      NULLIF(pg_catalog.btrim(row_value->>'sfdc_account_id'), '') AS account_id,
      NULLIF(pg_catalog.btrim(row_value->>'current_stage'), '') AS current_stage,
      (row_value->>'observed_at')::TIMESTAMPTZ AS observed_at
    FROM pg_catalog.jsonb_array_elements(p_rows) AS source(row_value)
  ), grouped AS (
    SELECT
      p.email,
      pg_catalog.min(p.account_id) FILTER (WHERE p.account_id IS NOT NULL) AS account_id,
      pg_catalog.bool_or(p.current_stage = 'mql') AS mql_observed,
      pg_catalog.max(p.observed_at)::DATE AS source_observed_date,
      (
        pg_catalog.max(p.observed_at) AT TIME ZONE 'America/Denver'
      )::DATE AS local_observed_date
    FROM parsed AS p
    GROUP BY p.email
  )
  SELECT
    g.email,
    g.account_id,
    g.mql_observed,
    g.source_observed_date,
    g.local_observed_date,
    CASE
      WHEN l.id IS NULL THEN 'missing'
      WHEN EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(
          COALESCE(l.stage_history, '[]'::JSONB)
        ) AS h
        WHERE h->>'stage' = 'mql'
      ) THEN 'mql'
      ELSE 'lead'
    END AS prior_state
  FROM grouped AS g
  LEFT JOIN public.leads AS l
    ON l.email = g.email;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        pg_catalog.lower(NULLIF(pg_catalog.btrim(row_value->>'email'), '')) AS email,
        pg_catalog.left(NULLIF(pg_catalog.btrim(row_value->>'sfdc_account_id'), ''), 15)
          AS account_key
      FROM pg_catalog.jsonb_array_elements(p_rows) AS source(row_value)
    ) AS identities
    WHERE identities.account_key IS NOT NULL
    GROUP BY identities.email
    HAVING pg_catalog.count(DISTINCT identities.account_key) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'one email carries conflicting Salesforce Account identities';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp._sourced_cm_v2_people AS incoming
    WHERE incoming.account_id IS NOT NULL
      AND incoming.account_id !~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid Salesforce Account identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_temp._sourced_cm_v2_people AS incoming
    JOIN public.leads AS l ON l.email = incoming.email
    WHERE incoming.account_id IS NOT NULL
      AND l.sfdc_account_id IS NOT NULL
      AND pg_catalog.left(l.sfdc_account_id, 15)
        <> pg_catalog.left(incoming.account_id, 15)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505',
      MESSAGE = 'existing person carries a different Salesforce Account identity';
  END IF;

  -- The applied v1 function remains the atomic authority for people,
  -- memberships, channels, manual locks, retries, and identity conflicts.
  v_result := public.sourced_apply_sfdc_campaign_members(p_rows);

  UPDATE public.leads AS l
  SET
    sfdc_account_id = COALESCE(l.sfdc_account_id, incoming.account_id),
    stage_history = CASE
      WHEN incoming.mql_observed THEN COALESCE((
        SELECT pg_catalog.jsonb_agg(
          CASE
            WHEN entry.value->>'stage' = 'mql'
             AND entry.value->>'edited_by' = 'n8n Salesforce daily sync'
             AND NOT (entry.value ? 'event_kind')
             AND entry.value->>'entered_at' = incoming.source_observed_date::TEXT
            THEN entry.value || pg_catalog.jsonb_build_object(
              'entered_at', incoming.local_observed_date,
              'event_kind', CASE
                WHEN incoming.prior_state = 'lead' THEN 'transition'
                ELSE 'baseline'
              END
            )
            ELSE entry.value
          END
          ORDER BY entry.ordinality
        )
        FROM pg_catalog.jsonb_array_elements(
          COALESCE(l.stage_history, '[]'::JSONB)
        ) WITH ORDINALITY AS entry(value, ordinality)
      ), '[]'::JSONB)
      ELSE COALESCE(l.stage_history, '[]'::JSONB)
    END,
    source_sfdc = CASE
      WHEN incoming.account_id IS NULL THEN COALESCE(l.source_sfdc, '{}'::JSONB)
      ELSE COALESCE(l.source_sfdc, '{}'::JSONB)
        || pg_catalog.jsonb_build_object('account_id', incoming.account_id)
    END
  FROM pg_temp._sourced_cm_v2_people AS incoming
  WHERE l.email = incoming.email;

  RETURN v_result || pg_catalog.jsonb_build_object('contract_version', 2);
END;
$$;

REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) TO service_role;

COMMIT;
