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

  it('keeps protected functions service-role-only', () => {
    expect(SQL.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(SQL.match(/SET search_path = pg_catalog/g)).toHaveLength(2);
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.sf_list_opportunity_reviews(TEXT) FROM PUBLIC, anon, authenticated;',
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.sf_list_opportunity_reviews(TEXT) TO service_role;',
    );
  });
});
