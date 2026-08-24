BEGIN;

ALTER TABLE public.outreach_daily_snapshots
  ADD COLUMN IF NOT EXISTS activity_basis TEXT NOT NULL DEFAULT 'legacy_cumulative';

ALTER TABLE public.outreach_daily_runs
  ADD COLUMN IF NOT EXISTS activity_basis TEXT NOT NULL DEFAULT 'legacy_cumulative';

ALTER TABLE public.outreach_daily_runs
  ADD COLUMN IF NOT EXISTS source_counts JSONB NOT NULL DEFAULT '{}'::JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'outreach_daily_snapshots_activity_basis_valid'
      AND conrelid = 'public.outreach_daily_snapshots'::regclass
  ) THEN
    ALTER TABLE public.outreach_daily_snapshots
      ADD CONSTRAINT outreach_daily_snapshots_activity_basis_valid
      CHECK (activity_basis IN ('legacy_cumulative', 'daily_event'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'outreach_daily_runs_activity_basis_valid'
      AND conrelid = 'public.outreach_daily_runs'::regclass
  ) THEN
    ALTER TABLE public.outreach_daily_runs
      ADD CONSTRAINT outreach_daily_runs_activity_basis_valid
      CHECK (activity_basis IN ('legacy_cumulative', 'daily_event'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'outreach_daily_runs_source_counts_object'
      AND conrelid = 'public.outreach_daily_runs'::regclass
  ) THEN
    ALTER TABLE public.outreach_daily_runs
      ADD CONSTRAINT outreach_daily_runs_source_counts_object
      CHECK (pg_catalog.jsonb_typeof(source_counts) = 'object');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sourced_apply_outreach_daily_activity_v2(
  p_rows JSONB,
  p_run JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_result JSONB;
  v_snapshot_date DATE;
  v_expected INTEGER;
  v_stored INTEGER;
BEGIN
  IF pg_catalog.jsonb_typeof(p_rows) <> 'array'
     OR pg_catalog.jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'OUTREACH ACTIVITY APPLY REFUSED: p_rows must be a non-empty array';
  END IF;
  IF pg_catalog.jsonb_typeof(p_run) <> 'object' THEN
    RAISE EXCEPTION 'OUTREACH ACTIVITY APPLY REFUSED: p_run must be an object';
  END IF;
  IF p_run->>'activity_basis' <> 'daily_event' THEN
    RAISE EXCEPTION 'OUTREACH ACTIVITY APPLY REFUSED: run must use daily_event activity';
  END IF;
  IF pg_catalog.jsonb_typeof(p_run->'source_counts') <> 'object' THEN
    RAISE EXCEPTION 'OUTREACH ACTIVITY APPLY REFUSED: exact source_counts are required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item
    WHERE item->>'activity_basis' <> 'daily_event'
       OR NULLIF(item->>'total_sent', '') IS NULL
       OR NULLIF(item->>'delivered', '') IS NULL
       OR NULLIF(item->>'bounced', '') IS NULL
       OR NULLIF(item->>'failed', '') IS NULL
       OR NULLIF(item->>'opened', '') IS NULL
       OR NULLIF(item->>'clicked', '') IS NULL
       OR NULLIF(item->>'replied', '') IS NULL
       OR NULLIF(item->>'opted_out', '') IS NULL
       OR NULLIF(item->>'outbound_calls', '') IS NULL
       OR NULLIF(item->>'linkedin_tasks_completed', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'OUTREACH ACTIVITY APPLY REFUSED: dated activity rows are incomplete';
  END IF;

  v_snapshot_date := NULLIF(p_run->>'snapshot_date', '')::DATE;
  v_expected := NULLIF(p_run->>'expected_sequences', '')::INTEGER;

  v_result := public.sourced_apply_outreach_daily_snapshot(p_rows, p_run);

  UPDATE public.outreach_daily_snapshots
  SET activity_basis = 'daily_event',
      updated_at = pg_catalog.now()
  WHERE snapshot_date = v_snapshot_date;

  UPDATE public.outreach_daily_runs
  SET activity_basis = 'daily_event',
      source_counts = p_run->'source_counts',
      updated_at = pg_catalog.now()
  WHERE snapshot_date = v_snapshot_date;

  SELECT pg_catalog.count(*)
  INTO v_stored
  FROM public.outreach_daily_snapshots
  WHERE snapshot_date = v_snapshot_date
    AND activity_basis = 'daily_event';

  IF v_stored <> v_expected THEN
    RAISE EXCEPTION
      'OUTREACH ACTIVITY APPLY REFUSED: stored daily-event rows % differ from expected %',
      v_stored,
      v_expected;
  END IF;

  RETURN v_result || pg_catalog.jsonb_build_object(
    'activity_basis', 'daily_event',
    'source_counts', p_run->'source_counts'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.sourced_apply_outreach_daily_activity_v2(JSONB, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sourced_apply_outreach_daily_activity_v2(JSONB, JSONB)
  TO service_role;

COMMIT;
