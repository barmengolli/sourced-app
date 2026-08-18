import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(process.cwd(), 'migrations/2026-08-18_opportunity_active_path_stage_dates.sql'),
  'utf8',
);

describe('Opportunity active-path stage-date migration', () => {
  it('changes only the protected derivation function and performs no business write', () => {
    expect(SQL).toContain('STATUS: PENDING / NOT YET APPLIED');
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.sf_derive_opportunity_stage_dates');
    expect(SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*public\./i);
    expect(SQL).not.toContain('sf_refresh_opportunity_reporting(');
    expect(SQL).not.toContain('sf_refresh_all_approved_opportunity_reporting(');
  });

  it('uses the exact source transition to fill a skipped Opportunity date', () => {
    expect(SQL).toContain('SELECT\n      from_record_type_state,\n      to_record_type_state,');
    expect(SQL).toContain("IF v_event.from_record_type_state = 'hpp' THEN");
    expect(SQL).toContain('opp_entered_at := v_event.changed_at::DATE;');
    expect(SQL).toContain('pursuit_entered_at := v_event.changed_at::DATE;');
  });

  it('clears every downstream date on regression', () => {
    expect(SQL).toMatch(
      /WHEN 'hpp' THEN[\s\S]*?hpp_entered_at := v_event\.changed_at::DATE;[\s\S]*?opp_entered_at := NULL;[\s\S]*?pursuit_entered_at := NULL;/,
    );
    expect(SQL).toMatch(
      /WHEN 'opp' THEN[\s\S]*?opp_entered_at := v_event\.changed_at::DATE;[\s\S]*?pursuit_entered_at := NULL;/,
    );
  });

  it('retains the service-role-only execution boundary', () => {
    expect(SQL).toContain('SECURITY DEFINER');
    expect(SQL).toContain('SET search_path = pg_catalog');
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.sf_derive_opportunity_stage_dates(UUID)\n  FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.sf_derive_opportunity_stage_dates(UUID)\n  TO service_role;',
    );
  });
});
