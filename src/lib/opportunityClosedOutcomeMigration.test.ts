import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(process.cwd(), 'migrations/2026-08-13_opportunity_closed_outcome_projection.sql'),
  'utf8',
);

describe('Salesforce closed Opportunity projection migration', () => {
  it('stays pending and changes function definitions without applying a review', () => {
    expect(SQL).toContain('STATUS: PENDING / NOT YET APPLIED');
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.sf_derive_opportunity_stage_dates');
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.sf_guard_opportunity_deal_link_duplicate');
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.sf_refresh_opportunity_reporting');
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.sf_list_opportunity_reviews');
    expect(SQL).not.toContain(
      'CREATE OR REPLACE FUNCTION public.sf_refresh_all_approved_opportunity_reporting',
    );
    expect(SQL).not.toMatch(/UPDATE public\.sf_opportunity_reviews/i);
  });

  it('keeps prior funnel stages and adds one source-backed terminal row', () => {
    expect(SQL).not.toContain('OR v_opp.is_closed IS TRUE');
    expect(SQL).toContain("WHEN COALESCE(v_opp.is_won, FALSE) THEN 'closeWon'");
    expect(SQL).toContain("ELSE 'closeLost'");
    expect(SQL).toContain('v_opp.close_date, v_lost_reason');
    expect(SQL).toContain("v_opp.stage_name = 'Closed-Lost-Competitor'");
    expect(SQL).toContain("'Closed-Lost to Competitor'");
    expect(SQL).toContain("'Closed-Lost In-House'");
    expect(SQL).toContain("'Closed-Disqualified'");
    expect(SQL).toContain('closed opportunity requires Salesforce CloseDate');
  });

  it('exposes the source outcome to the protected review dialog', () => {
    expect(SQL).toContain("'isWon', COALESCE(o.is_won, FALSE)");
    expect(SQL).toContain("'closeDate', o.close_date");
    expect(SQL).toContain("'sourceLostReason', CASE");
  });

  it('uses one ordered Salesforce-history replay for reporting and review dates', () => {
    expect(SQL).toContain(
      'FROM public.sf_derive_opportunity_stage_dates(p_sf_opportunity_uuid) d;',
    );
    expect(SQL).toContain(
      'LEFT JOIN LATERAL public.sf_derive_opportunity_stage_dates(o.id) dates ON TRUE',
    );
    expect(SQL).toContain("'hppEnteredAt', dates.hpp_entered_at");
    expect(SQL).toContain("'oppEnteredAt', dates.opp_entered_at");
    expect(SQL).toContain("'pursuitEnteredAt', dates.pursuit_entered_at");
    expect(SQL).toContain('ORDER BY changed_at, sf_history_id');
    expect(SQL).toContain('opp_entered_at := NULL;');
    expect(SQL).toContain('pursuit_entered_at := NULL;');
  });

  it('blocks an exact legacy manual deal collision without merging or deleting it', () => {
    expect(SQL).toContain('CREATE TRIGGER trg_sf_guard_opportunity_deal_link_duplicate');
    expect(SQL).toContain("(a.source_system IS NULL OR a.source_system = 'manual')");
    expect(SQL).toContain("a.source_system = 'manual'");
    expect(SQL).toContain('pg_catalog.regexp_replace(pg_catalog.btrim(a.label)');
    expect(SQL).toContain('pg_catalog.regexp_replace(pg_catalog.btrim(a.account)');
    expect(SQL).toContain('possible existing Sourced deal with the same Opportunity name and Account');
    expect(SQL).not.toMatch(/DELETE FROM public\.attributions[\s\S]*source_system\s*(?:IS NULL|= 'manual')/i);
  });

  it('keeps protected functions service-role-only', () => {
    expect(SQL.match(/SECURITY DEFINER/g)).toHaveLength(4);
    expect(SQL.match(/SET search_path = pg_catalog/g)).toHaveLength(4);
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.sf_derive_opportunity_stage_dates(UUID) FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.sf_guard_opportunity_deal_link_duplicate() FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.sf_list_opportunity_reviews(TEXT) FROM PUBLIC, anon, authenticated;',
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.sf_list_opportunity_reviews(TEXT) TO service_role;',
    );
  });
});
