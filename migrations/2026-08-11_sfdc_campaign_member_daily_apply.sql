-- 2026-08-11_sfdc_campaign_member_daily_apply.sql
--
-- Daily Salesforce CampaignMember ingestion for Sourced. The function accepts
-- one fully reconciled batch from the disabled n8n workflow and applies it
-- atomically to leads, channels, and lead_campaign_touches.
--
-- Cohort rule: every eligible CampaignMember creates one Lead membership.
-- An incoming MQL observation also preserves/adds MQL evidence on the person,
-- so the SAME membership counts in both Lead and MQL. A person first seen as
-- MQL therefore never disappears from Lead counts.
--
-- PENDING / NOT YET APPLIED. This migration creates no business rows by
-- itself. Applying it only installs the function and permissions.

BEGIN;

CREATE OR REPLACE FUNCTION public.sourced_apply_sfdc_campaign_members(
  p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_rec JSONB;
  v_member_id TEXT;
  v_campaign_id TEXT;
  v_parent_campaign TEXT;
  v_sub_campaign TEXT;
  v_email TEXT;
  v_contact_id TEXT;
  v_lead_sfdc_id TEXT;
  v_touch_date DATE;
  v_observed_at TIMESTAMPTZ;
  v_source_modified_at TIMESTAMPTZ;
  v_current_stage TEXT;
  v_lifecycle_label TEXT;
  v_parent_channel_id UUID;
  v_channel_id UUID;
  v_lead_id UUID;
  v_email_lead_id UUID;
  v_external_lead_ids UUID[];
  v_existing_touch_lead UUID;
  v_touch_exists BOOLEAN;
  v_stage_history JSONB;
  v_processed INTEGER := 0;
  v_inserted_leads INTEGER := 0;
  v_updated_leads INTEGER := 0;
  v_inserted_touches INTEGER := 0;
  v_updated_touches INTEGER := 0;
  v_mql_memberships INTEGER := 0;
  v_seeds_superseded INTEGER := 0;
  v_deleted INTEGER := 0;
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

  FOR v_rec IN SELECT value FROM pg_catalog.jsonb_array_elements(p_rows)
  LOOP
    v_member_id := NULLIF(pg_catalog.btrim(v_rec->>'campaign_member_id'), '');
    v_campaign_id := NULLIF(pg_catalog.btrim(v_rec->>'campaign_id'), '');
    v_parent_campaign := NULLIF(pg_catalog.btrim(v_rec->>'parent_campaign'), '');
    v_sub_campaign := NULLIF(pg_catalog.btrim(v_rec->>'sub_campaign'), '');
    v_email := pg_catalog.lower(NULLIF(pg_catalog.btrim(v_rec->>'email'), ''));
    v_contact_id := NULLIF(pg_catalog.btrim(v_rec->>'sfdc_contact_id'), '');
    v_lead_sfdc_id := NULLIF(pg_catalog.btrim(v_rec->>'sfdc_lead_id'), '');
    v_current_stage := NULLIF(pg_catalog.btrim(v_rec->>'current_stage'), '');
    v_lifecycle_label := COALESCE(v_rec->>'lifecycle_label', '');

    BEGIN
      v_touch_date := (v_rec->>'touch_date')::DATE;
      v_observed_at := (v_rec->>'observed_at')::TIMESTAMPTZ;
      v_source_modified_at := NULLIF(v_rec->>'source_modified_at', '')::TIMESTAMPTZ;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION USING ERRCODE = '22007', MESSAGE = 'invalid source date or timestamp';
    END;

    IF v_member_id IS NULL OR v_member_id !~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid CampaignMember identity';
    END IF;
    IF v_campaign_id IS NULL OR v_campaign_id !~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Campaign identity';
    END IF;
    IF v_contact_id IS NULL AND v_lead_sfdc_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'missing Salesforce person identity';
    END IF;
    IF (v_contact_id IS NOT NULL AND v_contact_id !~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$')
       OR (v_lead_sfdc_id IS NOT NULL AND v_lead_sfdc_id !~ '^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Salesforce person identity';
    END IF;
    IF v_email IS NULL OR pg_catalog.strpos(v_email, '@') < 2 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid email identity';
    END IF;
    IF v_parent_campaign IS NULL OR v_sub_campaign IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'missing campaign name';
    END IF;
    IF v_current_stage NOT IN ('lead', 'mql') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid lead lifecycle stage';
    END IF;

    -- Serialize writes for one email so an exact concurrent retry cannot create
    -- two leads before the unique email constraint resolves the race.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('sourced:lead:' || v_email, 0)
    );

    -- Root channels need an explicit lock because the existing
    -- (name,parent_channel_id) UNIQUE constraint treats NULL parents as
    -- distinct. The child constraint is a conventional non-NULL unique key.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('sourced:channel:' || v_parent_campaign, 0)
    );
    SELECT c.id INTO v_parent_channel_id
    FROM public.channels AS c
    WHERE c.name = v_parent_campaign AND c.parent_channel_id IS NULL
    ORDER BY c.created_at ASC, c.id ASC
    LIMIT 1;
    IF v_parent_channel_id IS NULL THEN
      INSERT INTO public.channels (name, parent_channel_id)
      VALUES (v_parent_campaign, NULL)
      RETURNING id INTO v_parent_channel_id;
    END IF;

    SELECT c.id
      INTO v_channel_id
    FROM public.channels AS c
    WHERE c.name = v_sub_campaign
      AND c.parent_channel_id = v_parent_channel_id
    ORDER BY c.created_at ASC, c.id ASC
    LIMIT 1;
    IF v_channel_id IS NULL THEN
      -- The manual importer historically created missing channel names at the
      -- root and then attached children. Reuse that row rather than creating a
      -- duplicate child with the same name.
      SELECT c.id
        INTO v_channel_id
      FROM public.channels AS c
      WHERE c.name = v_sub_campaign
        AND c.parent_channel_id IS NULL
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT 1;
      IF v_channel_id IS NOT NULL THEN
        UPDATE public.channels
        SET parent_channel_id = v_parent_channel_id
        WHERE id = v_channel_id;
      ELSE
        INSERT INTO public.channels (name, parent_channel_id)
        VALUES (v_sub_campaign, v_parent_channel_id)
        RETURNING id INTO v_channel_id;
      END IF;
    END IF;

    -- Salesforce returns 18-character IDs while older imports may store the
    -- exact case-sensitive 15-character prefix. Match either representation
    -- without lowercasing or computing a checksum.
    SELECT pg_catalog.array_agg(DISTINCT l.id ORDER BY l.id)
      INTO v_external_lead_ids
    FROM public.leads AS l
    WHERE (v_contact_id IS NOT NULL AND l.sfdc_contact_id IS NOT NULL
           AND pg_catalog.left(l.sfdc_contact_id, 15) = pg_catalog.left(v_contact_id, 15))
       OR (v_lead_sfdc_id IS NOT NULL AND l.sfdc_lead_id IS NOT NULL
           AND pg_catalog.left(l.sfdc_lead_id, 15) = pg_catalog.left(v_lead_sfdc_id, 15));

    IF COALESCE(pg_catalog.array_length(v_external_lead_ids, 1), 0) > 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'conflicting Salesforce person identities';
    END IF;
    v_lead_id := v_external_lead_ids[1];

    SELECT l.id INTO v_email_lead_id
    FROM public.leads AS l
    WHERE l.email = v_email;

    IF v_lead_id IS NOT NULL AND v_email_lead_id IS NOT NULL AND v_lead_id <> v_email_lead_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'email and Salesforce identity resolve to different people';
    END IF;
    v_lead_id := COALESCE(v_lead_id, v_email_lead_id);

    IF v_lead_id IS NULL THEN
      v_stage_history := CASE WHEN v_current_stage = 'mql' THEN
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'stage', 'mql',
          'entered_at', v_observed_at::DATE,
          'edited_by', 'n8n Salesforce daily sync',
          'edit_locked', false
        ))
      ELSE '[]'::JSONB END;

      INSERT INTO public.leads (
        email, first_name, last_name, sfdc_lead_id, sfdc_contact_id,
        account, title, country, region, lead_source, current_stage,
        marketing_sourced_date, source_channel_id, stage_history,
        field_locks, source_sfdc, last_synced_at
      ) VALUES (
        v_email,
        NULLIF(pg_catalog.btrim(v_rec->>'first_name'), ''),
        NULLIF(pg_catalog.btrim(v_rec->>'last_name'), ''),
        v_lead_sfdc_id,
        v_contact_id,
        NULLIF(pg_catalog.btrim(v_rec->>'account'), ''),
        NULLIF(pg_catalog.btrim(v_rec->>'title'), ''),
        NULLIF(pg_catalog.btrim(v_rec->>'country'), ''),
        NULLIF(pg_catalog.btrim(v_rec->>'region'), ''),
        NULLIF(pg_catalog.btrim(v_rec->>'lead_source'), ''),
        v_current_stage,
        v_touch_date,
        v_channel_id,
        v_stage_history,
        '{}'::JSONB,
        pg_catalog.jsonb_build_object(
          'lifecycle_label', v_lifecycle_label,
          'source_modified_at', v_source_modified_at,
          'campaign_member_id', v_member_id
        ),
        v_observed_at
      ) RETURNING id INTO v_lead_id;
      v_inserted_leads := v_inserted_leads + 1;
    ELSE
      -- Refuse to attach a new Salesforce identity to an email that already
      -- carries a different identity of the same object type.
      IF EXISTS (
        SELECT 1 FROM public.leads AS l
        WHERE l.id = v_lead_id
          AND v_contact_id IS NOT NULL
          AND l.sfdc_contact_id IS NOT NULL
          AND pg_catalog.left(l.sfdc_contact_id, 15) <> pg_catalog.left(v_contact_id, 15)
      ) OR EXISTS (
        SELECT 1 FROM public.leads AS l
        WHERE l.id = v_lead_id
          AND v_lead_sfdc_id IS NOT NULL
          AND l.sfdc_lead_id IS NOT NULL
          AND pg_catalog.left(l.sfdc_lead_id, 15) <> pg_catalog.left(v_lead_sfdc_id, 15)
      ) THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'existing person carries a different Salesforce identity';
      END IF;

      UPDATE public.leads AS l SET
        first_name = CASE WHEN COALESCE((l.field_locks->>'first_name')::BOOLEAN, false)
          THEN l.first_name ELSE COALESCE(NULLIF(pg_catalog.btrim(v_rec->>'first_name'), ''), l.first_name) END,
        last_name = CASE WHEN COALESCE((l.field_locks->>'last_name')::BOOLEAN, false)
          THEN l.last_name ELSE COALESCE(NULLIF(pg_catalog.btrim(v_rec->>'last_name'), ''), l.last_name) END,
        account = CASE WHEN COALESCE((l.field_locks->>'account')::BOOLEAN, false)
          THEN l.account ELSE COALESCE(NULLIF(pg_catalog.btrim(v_rec->>'account'), ''), l.account) END,
        title = CASE WHEN COALESCE((l.field_locks->>'title')::BOOLEAN, false)
          THEN l.title ELSE COALESCE(NULLIF(pg_catalog.btrim(v_rec->>'title'), ''), l.title) END,
        country = CASE WHEN COALESCE((l.field_locks->>'country')::BOOLEAN, false)
          THEN l.country ELSE COALESCE(NULLIF(pg_catalog.btrim(v_rec->>'country'), ''), l.country) END,
        region = CASE WHEN COALESCE((l.field_locks->>'region')::BOOLEAN, false)
          THEN l.region ELSE COALESCE(NULLIF(pg_catalog.btrim(v_rec->>'region'), ''), l.region) END,
        lead_source = CASE WHEN COALESCE((l.field_locks->>'lead_source')::BOOLEAN, false)
          THEN l.lead_source ELSE COALESCE(NULLIF(pg_catalog.btrim(v_rec->>'lead_source'), ''), l.lead_source) END,
        current_stage = CASE WHEN COALESCE((l.field_locks->>'current_stage')::BOOLEAN, false)
          THEN l.current_stage ELSE v_current_stage END,
        marketing_sourced_date = CASE
          WHEN COALESCE((l.field_locks->>'marketing_sourced_date')::BOOLEAN, false) THEN l.marketing_sourced_date
          WHEN l.marketing_sourced_date IS NULL OR v_touch_date < l.marketing_sourced_date THEN v_touch_date
          ELSE l.marketing_sourced_date END,
        source_channel_id = CASE
          WHEN COALESCE((l.field_locks->>'source_channel_id')::BOOLEAN, false) THEN l.source_channel_id
          WHEN l.marketing_sourced_date IS NULL OR v_touch_date < l.marketing_sourced_date THEN v_channel_id
          ELSE l.source_channel_id END,
        sfdc_contact_id = COALESCE(l.sfdc_contact_id, v_contact_id),
        sfdc_lead_id = COALESCE(l.sfdc_lead_id, v_lead_sfdc_id),
        stage_history = CASE
          WHEN v_current_stage = 'mql'
           AND NOT EXISTS (
             SELECT 1 FROM pg_catalog.jsonb_array_elements(COALESCE(l.stage_history, '[]'::JSONB)) AS h
             WHERE h->>'stage' = 'mql'
           )
          THEN COALESCE(l.stage_history, '[]'::JSONB) || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'stage', 'mql',
              'entered_at', v_observed_at::DATE,
              'edited_by', 'n8n Salesforce daily sync',
              'edit_locked', false
            )
          )
          ELSE COALESCE(l.stage_history, '[]'::JSONB)
        END,
        source_sfdc = COALESCE(l.source_sfdc, '{}'::JSONB) || pg_catalog.jsonb_build_object(
          'lifecycle_label', v_lifecycle_label,
          'source_modified_at', v_source_modified_at,
          'campaign_member_id', v_member_id
        ),
        last_synced_at = v_observed_at,
        updated_at = pg_catalog.now()
      WHERE l.id = v_lead_id;
      v_updated_leads := v_updated_leads + 1;
    END IF;

    SELECT t.lead_id INTO v_existing_touch_lead
    FROM public.lead_campaign_touches AS t
    WHERE t.campaign_member_id = v_member_id
    FOR UPDATE;
    IF v_existing_touch_lead IS NOT NULL AND v_existing_touch_lead <> v_lead_id THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'CampaignMember identity resolves to a different person';
    END IF;
    v_touch_exists := v_existing_touch_lead IS NOT NULL;

    INSERT INTO public.lead_campaign_touches (
      lead_id, campaign_member_id, campaign_id, channel_id, touch_date,
      parent_campaign, sub_campaign, observed_at, source, raw
    ) VALUES (
      v_lead_id, v_member_id, v_campaign_id, v_channel_id, v_touch_date,
      v_parent_campaign, v_sub_campaign, v_observed_at, 'n8n_sync',
      pg_catalog.jsonb_build_object(
        'lifecycle_label', v_lifecycle_label,
        'source_modified_at', v_source_modified_at
      )
    )
    ON CONFLICT (campaign_member_id) WHERE campaign_member_id IS NOT NULL
    DO UPDATE SET
      campaign_id = EXCLUDED.campaign_id,
      channel_id = EXCLUDED.channel_id,
      touch_date = EXCLUDED.touch_date,
      parent_campaign = EXCLUDED.parent_campaign,
      sub_campaign = EXCLUDED.sub_campaign,
      observed_at = EXCLUDED.observed_at,
      source = 'n8n_sync',
      raw = EXCLUDED.raw;

    IF v_touch_exists THEN
      v_updated_touches := v_updated_touches + 1;
    ELSE
      v_inserted_touches := v_inserted_touches + 1;
    END IF;

    -- A real identity-carrying membership replaces a backfill seed in the
    -- same channel family. Current channel depth is parent -> child, so the
    -- exact child and its parent are the only seed candidates.
    DELETE FROM public.lead_campaign_touches AS seed
    WHERE seed.lead_id = v_lead_id
      AND seed.source = 'backfill'
      AND seed.channel_id IN (v_channel_id, v_parent_channel_id);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_seeds_superseded := v_seeds_superseded + v_deleted;

    v_processed := v_processed + 1;
    IF v_current_stage = 'mql' THEN
      v_mql_memberships := v_mql_memberships + 1;
    END IF;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'processed_memberships', v_processed,
    'mql_memberships', v_mql_memberships,
    'inserted_leads', v_inserted_leads,
    'updated_leads', v_updated_leads,
    'inserted_touches', v_inserted_touches,
    'updated_touches', v_updated_touches,
    'backfill_seeds_superseded', v_seeds_superseded
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sourced_apply_sfdc_campaign_members(JSONB) TO service_role;

COMMIT;
