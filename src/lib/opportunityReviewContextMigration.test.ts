import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(process.cwd(), 'migrations/2026-08-13_opportunity_review_context.sql'),
  'utf8',
);

describe('opportunity review context migration', () => {
  it('records the confirmed application date and changes protected read functions only', () => {
    expect(SQL).toContain('STATUS: APPLIED MANUALLY TO PRODUCTION ON 2026-08-13');
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.sf_list_opportunity_reviews');
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.sf_find_lead_by_email');
    expect(SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it('maps Primary Campaign Source only to one exact child channel', () => {
    expect(SQL).toContain('pg_catalog.left(t.campaign_id, 15) = pg_catalog.left(o.primary_campaign_source, 15)');
    expect(SQL).toContain('c.parent_channel_id IS NOT NULL');
    expect(SQL).toContain('HAVING pg_catalog.count(DISTINCT c.id) = 1');
    expect(SQL).not.toMatch(/\bILIKE\b/i);
  });

  it('uses normalized exact email matching and returns at most two rows for ambiguity detection', () => {
    expect(SQL).toContain(
      'pg_catalog.lower(pg_catalog.btrim(l.email)) = pg_catalog.lower(pg_catalog.btrim(p_email))',
    );
    expect(SQL).toMatch(/ORDER BY l\.id\s+LIMIT 2;/);
    expect(SQL).not.toMatch(/\bLIKE\b/i);
  });

  it('keeps both functions service-role-only with hardened search paths', () => {
    expect(SQL.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(SQL.match(/SET search_path = pg_catalog/g)).toHaveLength(2);
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.sf_find_lead_by_email(TEXT) FROM PUBLIC, anon, authenticated;',
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.sf_find_lead_by_email(TEXT) TO service_role;',
    );
  });
});
