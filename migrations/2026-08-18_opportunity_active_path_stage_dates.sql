-- 2026-08-18_opportunity_active_path_stage_dates.sql
-- STATUS: PENDING / NOT YET APPLIED.
--
-- Aligns the protected reporting-date replay with the active-path contract:
--
--   * a witnessed HPP -> Pursuit jump records Opportunity and Pursuit on the
--     same Salesforce history date;
--   * a regression resets the destination milestone and clears every later
--     milestone, so a future forward move receives fresh dates;
--   * a current snapshot without supporting history still invents nothing.
--
-- This migration replaces one calculation function only. It does not invoke
-- the function, refresh reporting, approve a review, or mutate business rows.

BEGIN;

CREATE OR REPLACE FUNCTION public.sf_derive_opportunity_stage_dates(
  p_sf_opportunity_uuid UUID
) RETURNS TABLE (
  hpp_entered_at DATE,
  opp_entered_at DATE,
  pursuit_entered_at DATE
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_opp public.sf_opportunities%ROWTYPE;
  v_review public.sf_opportunity_reviews%ROWTYPE;
  v_event RECORD;
BEGIN
  SELECT * INTO v_opp
  FROM public.sf_opportunities
  WHERE id = p_sf_opportunity_uuid;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_review
  FROM public.sf_opportunity_reviews
  WHERE sf_opportunity_uuid = p_sf_opportunity_uuid;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  hpp_entered_at := v_review.hpp_entered_at_override;
  opp_entered_at := v_review.opp_entered_at_override;
  pursuit_entered_at := v_review.pursuit_entered_at_override;

  IF hpp_entered_at IS NULL AND v_opp.sf_created_at IS NOT NULL THEN
    hpp_entered_at := v_opp.sf_created_at::DATE;
  END IF;

  FOR v_event IN
    SELECT
      from_record_type_state,
      to_record_type_state,
      changed_at
    FROM public.sf_opportunity_events
    WHERE sf_opportunity_uuid = p_sf_opportunity_uuid
      AND event_kind = 'record_type'
    ORDER BY changed_at, sf_history_id
  LOOP
    CASE v_event.to_record_type_state
      WHEN 'hpp' THEN
        -- HPP is the new active path. Anything downstream was regressed away.
        hpp_entered_at := v_event.changed_at::DATE;
        opp_entered_at := NULL;
        pursuit_entered_at := NULL;
      WHEN 'opp' THEN
        -- Re-entry into Opportunity always gets the latest source date.
        opp_entered_at := v_event.changed_at::DATE;
        pursuit_entered_at := NULL;
      WHEN 'pursuit' THEN
        -- A direct HPP -> Pursuit move crosses Opportunity on the same day.
        -- Do not use this rule for an incomplete baseline or for Opp -> Pursuit:
        -- only the exact source old/new pair proves the forward skip.
        IF v_event.from_record_type_state = 'hpp' THEN
          opp_entered_at := v_event.changed_at::DATE;
        END IF;
        pursuit_entered_at := v_event.changed_at::DATE;
      WHEN 'out_of_scope' THEN
        hpp_entered_at := NULL;
        opp_entered_at := NULL;
        pursuit_entered_at := NULL;
      ELSE
        NULL;
    END CASE;
  END LOOP;

  RETURN NEXT;
END;
$$;

ALTER FUNCTION public.sf_derive_opportunity_stage_dates(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sf_derive_opportunity_stage_dates(UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sf_derive_opportunity_stage_dates(UUID)
  TO service_role;

COMMIT;
