import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'migrations/2026-08-13_opportunity_existing_deal_adoption.sql'),
  'utf8',
);
const executable = migration.replace(/^\s*--.*$/gm, '');

describe('opportunity existing-deal adoption migration', () => {
  it('keeps the adoption ledger protected and append-only', () => {
    expect(executable).toContain('CREATE TABLE IF NOT EXISTS public.sf_opportunity_deal_adoptions');
    expect(executable).toContain('ALTER TABLE public.sf_opportunity_deal_adoptions ENABLE ROW LEVEL SECURITY');
    expect(executable).toContain('append_only_sf_opportunity_deal_adoptions');
    expect(executable).toContain('UNIQUE (actor_id, review_id, idempotency_key)');
    expect(executable).toContain('UNIQUE (review_id)');
  });

  it('offers only unique exact Salesforce-ID candidates with consistent fields', () => {
    expect(executable).toContain('sf_list_opportunity_existing_deal_candidates');
    expect(executable).toContain(
      'pg_catalog.strpos(a.sf_link, pg_catalog.left(o.sf_opportunity_id, 15)) > 0',
    );
    expect(executable).toContain('r.deal_matches = 1');
    expect(executable).toContain('c.channel_variants = 1');
    expect(executable).toContain('c.lead_variants <= 1');
    expect(executable).not.toMatch(/lower\([^)]*opportunity_name/i);
  });

  it('revalidates the candidate, review version, and active-link absence under lock', () => {
    expect(executable).toContain('CREATE OR REPLACE FUNCTION public.sf_adopt_existing_opportunity_deal');
    expect(executable).toContain('WHERE id = p_review_id FOR UPDATE');
    expect(executable).toContain('p_expected_version IS DISTINCT FROM v_current_version');
    expect(executable).toContain('updated_at = pg_catalog.now()');
    expect(executable).toContain('exact Salesforce ID does not resolve to one legacy deal');
    expect(executable).toContain('opportunity already has an active deal link');
    expect(executable).toContain('existing Sourced deal candidate changed; reload and retry');
  });

  it('adopts attribution rows in place and preserves attribution touches', () => {
    expect(executable).toContain("UPDATE public.attributions SET source_system = 'salesforce'");
    expect(executable).toContain('sf_opportunity_id = v_opp.sf_opportunity_id');
    expect(executable).toContain('attributionTouchesPreserved');
    expect(executable).not.toMatch(/DELETE FROM public\.attribution_touches[\s\S]*v_deal_id/i);
  });

  it('reconciles future reporting by stable deal and stage keys', () => {
    expect(executable).toContain(
      "ON CONFLICT (deal_id, stage_key) WHERE deal_id IS NOT NULL AND deal_id <> ''",
    );
    expect(executable).toContain('COALESCE(v_hpp_date');
    expect(executable).toContain('COALESCE(v_opp_date');
    expect(executable).toContain('COALESCE(v_pursuit_date');
    expect(executable).toContain('UPDATE public.attribution_touches t');
    expect(executable).toContain('SET attribution_id = v_hpp_attribution_id');
  });

  it('exposes no adoption function to browser roles and performs no automatic adoption', () => {
    expect(executable).toContain(
      'REVOKE ALL ON FUNCTION public.sf_adopt_existing_opportunity_deal(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated',
    );
    expect(executable).toContain(
      'GRANT EXECUTE ON FUNCTION public.sf_adopt_existing_opportunity_deal(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role',
    );
    expect(executable).not.toMatch(/SELECT\s+public\.sf_adopt_existing_opportunity_deal\s*\(/i);
  });
});
