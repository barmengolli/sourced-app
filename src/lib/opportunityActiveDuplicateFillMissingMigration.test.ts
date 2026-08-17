import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'migrations/2026-08-17_opportunity_active_duplicate_fill_missing.sql',
  ),
  'utf8',
);
const executable = migration.replace(/^\s*--.*$/gm, '');

describe('opportunity active-duplicate fill-missing migration', () => {
  it('stores a nonnegative reviewer-owned revenue fallback', () => {
    expect(executable).toContain(
      'ADD COLUMN IF NOT EXISTS saas_revenue_usd_override NUMERIC(14, 2)',
    );
    expect(executable).toContain(
      'saas_revenue_usd_override IS NULL OR saas_revenue_usd_override >= 0',
    );
    expect(executable).toContain("'active_duplicate_fill_missing'");
  });

  it('applies the override at every Salesforce reporting write boundary', () => {
    expect(executable).toContain('sf_apply_opportunity_revenue_override');
    expect(executable).toContain("NEW.source_system = 'salesforce'");
    expect(executable).toContain("r.review_state IN ('approved', 'linked')");
    expect(executable).toContain('NEW.amount := v_override');
    expect(executable).toContain(
      'BEFORE INSERT OR UPDATE OF amount, source_system, sf_opportunity_id',
    );
  });

  it('admits only one exact Salesforce-ID legacy deal with an empty generated history', () => {
    expect(executable).toContain('cc.legacy_deal_matches = 1');
    expect(executable).toContain(
      'pg_catalog.strpos(a.sf_link, pg_catalog.left(x.sf_opportunity_id, 15)) > 0',
    );
    expect(executable).toContain('WHERE g.deal_id = l.active_deal_id');
    expect(executable).toContain('v_generated_touches <> 0');
    expect(executable).not.toMatch(/lower\([^)]*opportunity_name[^)]*\)\s*=\s*lower\([^)]*account/i);
  });

  it('allows only missing revenue or BDR to be filled and keeps Salesforce dates authoritative', () => {
    expect(executable).toContain('COALESCE(l.saas_revenue_usd, 0) = 0');
    expect(executable).toContain('l.legacy_amount > 0');
    expect(executable).toContain('l.legacy_amount_variants <= 1');
    expect(executable).toContain('l.legacy_bdr_variants <= 1');
    expect(executable).toContain(
      "'salesforce_history_first_legacy_only_when_missing'",
    );
    expect(executable).not.toContain(
      'm.stage_entered_at IS DISTINCT FROM g.stage_entered_at',
    );
  });

  it('still rejects channel, lead, region, and nonmissing source conflicts', () => {
    expect(executable).toContain('m.channel_id IS DISTINCT FROM g.channel_id');
    expect(executable).toContain(
      'm.lead_id IS NOT NULL AND g.lead_id IS NOT NULL',
    );
    expect(executable).toContain('m.region IS DISTINCT FROM g.region');
    expect(executable).toContain('COALESCE(l.saas_revenue_usd, 0) <> 0');
  });

  it('preserves manual rows and touches while removing only the empty generated copy', () => {
    const deleteIndex = executable.indexOf('DELETE FROM public.attributions');
    const adoptIndex = executable.indexOf(
      "UPDATE public.attributions\n  SET source_system = 'salesforce'",
    );
    const linkIndex = executable.indexOf('UPDATE public.sf_opportunity_deal_links');
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(adoptIndex).toBeGreaterThan(deleteIndex);
    expect(linkIndex).toBeGreaterThan(adoptIndex);
    expect(executable).not.toMatch(/DELETE FROM public\.attribution_touches/i);
    expect(executable).toContain('attributionTouchesPreserved');
  });

  it('revalidates under lock and refuses a preexisting conflicting override', () => {
    expect(executable).toContain('WHERE id = p_review_id\n  FOR UPDATE');
    expect(executable).toContain(
      'p_expected_version IS DISTINCT FROM v_current_version',
    );
    expect(executable).toContain(
      'existing revenue override conflicts with the legacy value',
    );
    expect(executable).toContain(
      'existing reviewed BDR conflicts with the legacy value',
    );
  });

  it('is idempotent, service-role-only, and never invokes itself', () => {
    expect(executable).toContain('idempotency key already used for another request');
    expect(executable).toContain(
      "v_existing.adoption_kind = 'active_duplicate_fill_missing'",
    );
    expect(executable).toContain(
      'REVOKE ALL ON FUNCTION public.sf_reconcile_active_opportunity_duplicate_fill_missing(\n  UUID, TEXT, TEXT, TEXT, TEXT, TEXT\n) FROM PUBLIC, anon, authenticated',
    );
    expect(executable).toContain(
      'GRANT EXECUTE ON FUNCTION public.sf_reconcile_active_opportunity_duplicate_fill_missing(\n  UUID, TEXT, TEXT, TEXT, TEXT, TEXT\n) TO service_role',
    );
    expect(executable).not.toMatch(
      /SELECT\s+public\.sf_reconcile_active_opportunity_duplicate_fill_missing\s*\(/i,
    );
  });
});
