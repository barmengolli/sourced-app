BEGIN;

CREATE TABLE IF NOT EXISTS public.outreach_daily_runs (
  snapshot_date DATE PRIMARY KEY,
  timezone TEXT NOT NULL CHECK (timezone = 'America/Denver'),
  window_start_utc TIMESTAMPTZ NOT NULL,
  window_end_utc TIMESTAMPTZ NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'failed')),
  expected_sequences INTEGER NOT NULL CHECK (expected_sequences >= 0),
  observed_sequences INTEGER NOT NULL CHECK (observed_sequences >= 0),
  enrollments_observed INTEGER NOT NULL CHECK (enrollments_observed >= 0),
  active_sequence_states_observed INTEGER NOT NULL CHECK (active_sequence_states_observed >= 0),
  missing_measurements_by_metric JSONB NOT NULL DEFAULT '{}'::JSONB,
  pagination_complete BOOLEAN NOT NULL,
  natural_keys_unique BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (window_start_utc <= window_end_utc),
  CHECK (
    status <> 'complete'
    OR (
      pagination_complete
      AND natural_keys_unique
      AND expected_sequences = observed_sequences
    )
  )
);

CREATE TABLE IF NOT EXISTS public.outreach_daily_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date DATE NOT NULL,
  timezone TEXT NOT NULL CHECK (timezone = 'America/Denver'),
  window_start_utc TIMESTAMPTZ NOT NULL,
  window_end_utc TIMESTAMPTZ NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  source_name TEXT NOT NULL DEFAULT 'outreach' CHECK (source_name = 'outreach'),
  sequence_id BIGINT NOT NULL CHECK (sequence_id > 0),
  sequence_name TEXT NOT NULL CHECK (BTRIM(sequence_name) <> ''),
  sequence_created_at TIMESTAMPTZ,
  sequence_created_date DATE,
  enabled BOOLEAN NOT NULL,
  step_count INTEGER CHECK (step_count IS NULL OR step_count >= 0),
  duration_days INTEGER CHECK (duration_days IS NULL OR duration_days >= 0),
  prospects_enrolled INTEGER CHECK (prospects_enrolled IS NULL OR prospects_enrolled >= 0),
  prospects_active INTEGER CHECK (prospects_active IS NULL OR prospects_active >= 0),
  total_sent INTEGER CHECK (total_sent IS NULL OR total_sent >= 0),
  delivered INTEGER CHECK (delivered IS NULL OR delivered >= 0),
  bounced INTEGER CHECK (bounced IS NULL OR bounced >= 0),
  failed INTEGER CHECK (failed IS NULL OR failed >= 0),
  opened INTEGER CHECK (opened IS NULL OR opened >= 0),
  clicked INTEGER CHECK (clicked IS NULL OR clicked >= 0),
  replied INTEGER CHECK (replied IS NULL OR replied >= 0),
  positive_replies INTEGER CHECK (positive_replies IS NULL OR positive_replies >= 0),
  neutral_replies INTEGER CHECK (neutral_replies IS NULL OR neutral_replies >= 0),
  negative_replies INTEGER CHECK (negative_replies IS NULL OR negative_replies >= 0),
  opted_out INTEGER CHECK (opted_out IS NULL OR opted_out >= 0),
  outbound_calls INTEGER CHECK (outbound_calls IS NULL OR outbound_calls >= 0),
  linkedin_tasks_completed INTEGER CHECK (
    linkedin_tasks_completed IS NULL OR linkedin_tasks_completed >= 0
  ),
  expected_sequence_count INTEGER NOT NULL CHECK (expected_sequence_count >= 0),
  pagination_complete BOOLEAN NOT NULL,
  natural_keys_unique BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_date, sequence_id),
  CHECK (window_start_utc <= window_end_utc)
);

CREATE INDEX IF NOT EXISTS idx_outreach_daily_snapshots_sequence_date
  ON public.outreach_daily_snapshots (sequence_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_outreach_daily_snapshots_date
  ON public.outreach_daily_snapshots (snapshot_date DESC);

ALTER TABLE public.outreach_daily_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outreach_daily_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public read" ON public.outreach_daily_runs;
CREATE POLICY "Allow public read" ON public.outreach_daily_runs
  FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow public read" ON public.outreach_daily_snapshots;
CREATE POLICY "Allow public read" ON public.outreach_daily_snapshots
  FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION public.sourced_apply_outreach_daily_snapshot(
  p_rows JSONB,
  p_run JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_snapshot_date DATE;
  v_expected INTEGER;
  v_observed INTEGER;
  v_input_count INTEGER;
  v_distinct_keys INTEGER;
  v_existing_count INTEGER;
BEGIN
  IF pg_catalog.jsonb_typeof(p_rows) <> 'array' OR pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'OUTREACH APPLY REFUSED: p_rows must be a non-empty array';
  END IF;
  IF pg_catalog.jsonb_typeof(p_run) <> 'object' THEN
    RAISE EXCEPTION 'OUTREACH APPLY REFUSED: p_run must be an object';
  END IF;

  v_snapshot_date := NULLIF(p_run->>'snapshot_date', '')::DATE;
  v_expected := NULLIF(p_run->>'expected_sequences', '')::INTEGER;
  v_observed := NULLIF(p_run->>'observed_sequences', '')::INTEGER;
  v_input_count := pg_catalog.jsonb_array_length(p_rows);

  IF v_snapshot_date IS NULL OR v_expected IS NULL OR v_observed IS NULL THEN
    RAISE EXCEPTION 'OUTREACH APPLY REFUSED: run identity and counts are required';
  END IF;
  IF p_run->>'timezone' <> 'America/Denver'
     OR COALESCE((p_run->>'pagination_complete')::BOOLEAN, false) IS NOT TRUE
     OR COALESCE((p_run->>'natural_keys_unique')::BOOLEAN, false) IS NOT TRUE
     OR p_run->>'status' <> 'complete'
     OR v_expected <> v_observed
     OR v_observed <> v_input_count THEN
    RAISE EXCEPTION 'OUTREACH APPLY REFUSED: extraction completeness checks failed';
  END IF;

  SELECT COUNT(DISTINCT (item->>'snapshot_date') || '|' || (item->>'sequence_id'))
  INTO v_distinct_keys
  FROM pg_catalog.jsonb_array_elements(p_rows) AS item;
  IF v_distinct_keys <> v_input_count THEN
    RAISE EXCEPTION 'OUTREACH APPLY REFUSED: duplicate snapshot_date + sequence_id key';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item
    WHERE NULLIF(item->>'snapshot_date', '')::DATE IS DISTINCT FROM v_snapshot_date
       OR item->>'timezone' <> 'America/Denver'
       OR COALESCE((item->>'pagination_complete')::BOOLEAN, false) IS NOT TRUE
       OR COALESCE((item->>'natural_keys_unique')::BOOLEAN, false) IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'OUTREACH APPLY REFUSED: row scope or completeness differs from run';
  END IF;

  INSERT INTO public.outreach_daily_snapshots (
    snapshot_date, timezone, window_start_utc, window_end_utc, collected_at,
    source_name, sequence_id, sequence_name, sequence_created_at,
    sequence_created_date, enabled, step_count, duration_days,
    prospects_enrolled, prospects_active, total_sent, delivered, bounced,
    failed, opened, clicked, replied, positive_replies, neutral_replies,
    negative_replies, opted_out, outbound_calls, linkedin_tasks_completed,
    expected_sequence_count, pagination_complete, natural_keys_unique
  )
  SELECT
    x.snapshot_date, x.timezone, x.window_start_utc, x.window_end_utc,
    x.collected_at, x.source_name, x.sequence_id, x.sequence_name,
    x.sequence_created_at, x.sequence_created_date, x.enabled, x.step_count,
    x.duration_days, x.prospects_enrolled, x.prospects_active, x.total_sent,
    x.delivered, x.bounced, x.failed, x.opened, x.clicked, x.replied,
    x.positive_replies, x.neutral_replies, x.negative_replies, x.opted_out,
    x.outbound_calls, x.linkedin_tasks_completed, x.expected_sequence_count,
    x.pagination_complete, x.natural_keys_unique
  FROM pg_catalog.jsonb_to_recordset(p_rows) AS x(
    snapshot_date DATE,
    timezone TEXT,
    window_start_utc TIMESTAMPTZ,
    window_end_utc TIMESTAMPTZ,
    collected_at TIMESTAMPTZ,
    source_name TEXT,
    sequence_id BIGINT,
    sequence_name TEXT,
    sequence_created_at TIMESTAMPTZ,
    sequence_created_date DATE,
    enabled BOOLEAN,
    step_count INTEGER,
    duration_days INTEGER,
    prospects_enrolled INTEGER,
    prospects_active INTEGER,
    total_sent INTEGER,
    delivered INTEGER,
    bounced INTEGER,
    failed INTEGER,
    opened INTEGER,
    clicked INTEGER,
    replied INTEGER,
    positive_replies INTEGER,
    neutral_replies INTEGER,
    negative_replies INTEGER,
    opted_out INTEGER,
    outbound_calls INTEGER,
    linkedin_tasks_completed INTEGER,
    expected_sequence_count INTEGER,
    pagination_complete BOOLEAN,
    natural_keys_unique BOOLEAN
  )
  ON CONFLICT (snapshot_date, sequence_id) DO UPDATE SET
    timezone = EXCLUDED.timezone,
    window_start_utc = EXCLUDED.window_start_utc,
    window_end_utc = EXCLUDED.window_end_utc,
    collected_at = EXCLUDED.collected_at,
    source_name = EXCLUDED.source_name,
    sequence_name = EXCLUDED.sequence_name,
    sequence_created_at = EXCLUDED.sequence_created_at,
    sequence_created_date = EXCLUDED.sequence_created_date,
    enabled = EXCLUDED.enabled,
    step_count = EXCLUDED.step_count,
    duration_days = EXCLUDED.duration_days,
    prospects_enrolled = EXCLUDED.prospects_enrolled,
    prospects_active = EXCLUDED.prospects_active,
    total_sent = EXCLUDED.total_sent,
    delivered = EXCLUDED.delivered,
    bounced = EXCLUDED.bounced,
    failed = EXCLUDED.failed,
    opened = EXCLUDED.opened,
    clicked = EXCLUDED.clicked,
    replied = EXCLUDED.replied,
    positive_replies = EXCLUDED.positive_replies,
    neutral_replies = EXCLUDED.neutral_replies,
    negative_replies = EXCLUDED.negative_replies,
    opted_out = EXCLUDED.opted_out,
    outbound_calls = EXCLUDED.outbound_calls,
    linkedin_tasks_completed = EXCLUDED.linkedin_tasks_completed,
    expected_sequence_count = EXCLUDED.expected_sequence_count,
    pagination_complete = EXCLUDED.pagination_complete,
    natural_keys_unique = EXCLUDED.natural_keys_unique,
    updated_at = NOW();

  SELECT COUNT(*) INTO v_existing_count
  FROM public.outreach_daily_snapshots
  WHERE snapshot_date = v_snapshot_date;
  IF v_existing_count <> v_expected THEN
    RAISE EXCEPTION
      'OUTREACH APPLY REFUSED: stored sequence count % differs from expected %',
      v_existing_count, v_expected;
  END IF;

  INSERT INTO public.outreach_daily_runs (
    snapshot_date, timezone, window_start_utc, window_end_utc, collected_at,
    status, expected_sequences, observed_sequences, enrollments_observed,
    active_sequence_states_observed, missing_measurements_by_metric,
    pagination_complete, natural_keys_unique
  ) VALUES (
    v_snapshot_date,
    p_run->>'timezone',
    (p_run->>'window_start_utc')::TIMESTAMPTZ,
    (p_run->>'window_end_utc')::TIMESTAMPTZ,
    (p_run->>'collected_at')::TIMESTAMPTZ,
    p_run->>'status',
    v_expected,
    v_observed,
    COALESCE((p_run->>'enrollments_observed')::INTEGER, 0),
    COALESCE((p_run->>'active_sequence_states_observed')::INTEGER, 0),
    COALESCE(p_run->'missing_measurements_by_metric', '{}'::JSONB),
    (p_run->>'pagination_complete')::BOOLEAN,
    (p_run->>'natural_keys_unique')::BOOLEAN
  )
  ON CONFLICT (snapshot_date) DO UPDATE SET
    timezone = EXCLUDED.timezone,
    window_start_utc = EXCLUDED.window_start_utc,
    window_end_utc = EXCLUDED.window_end_utc,
    collected_at = EXCLUDED.collected_at,
    status = EXCLUDED.status,
    expected_sequences = EXCLUDED.expected_sequences,
    observed_sequences = EXCLUDED.observed_sequences,
    enrollments_observed = EXCLUDED.enrollments_observed,
    active_sequence_states_observed = EXCLUDED.active_sequence_states_observed,
    missing_measurements_by_metric = EXCLUDED.missing_measurements_by_metric,
    pagination_complete = EXCLUDED.pagination_complete,
    natural_keys_unique = EXCLUDED.natural_keys_unique,
    updated_at = NOW();

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'snapshot_date', v_snapshot_date,
    'sequences_applied', v_observed,
    'natural_key', 'snapshot_date + sequence_id'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sourced_apply_outreach_daily_snapshot(JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sourced_apply_outreach_daily_snapshot(JSONB, JSONB)
  TO service_role;

COMMIT;
