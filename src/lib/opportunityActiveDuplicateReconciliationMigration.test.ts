import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'migrations/2026-08-14_opportunity_active_duplicate_reconciliation.sql',
  ),
  'utf8',
);
const executable = migration.replace(/^\s*--.*$/gm, '');

describe('opportunity active-duplicate reconciliation migration', () => {
  it('admits only one exact Salesforce-ID legacy deal', () => {
    expect(executable).toContain('sf_list_opportunity_active_duplicate_candidates');
    expect(executable).toContain(
      'pg_catalog.strpos(a.sf_link, pg_catalog.left(x.sf_opportunity_id, 15)) > 0',
    );
    expect(executable).toContain('cc.legacy_deal_matches = 1');
    expect(executable).not.toMatch(/lower\([^)]*opportunity_name/i);
  });

  it('requires matching stage sets and rejects conflicting funnel fields', () => {
    expect(executable).toContain("ORDER BY m.stage_key");
    expect(executable).toContain("ORDER BY g.stage_key");
    expect(executable).toContain('m.channel_id IS DISTINCT FROM g.channel_id');
    expect(executable).toContain('m.stage_entered_at IS DISTINCT FROM g.stage_entered_at');
    expect(executable).toContain('m.lead_id IS NOT NULL AND g.lead_id IS NOT NULL');
    expect(executable).toContain('m.amount IS NOT NULL AND g.amount IS NOT NULL');
  });

  it('refuses generated copies with touches so two histories are never guessed together', () => {
    expect(executable).toContain('JOIN public.attributions g ON g.id = t.attribution_id');
    expect(executable).toContain('WHERE g.deal_id = l.active_deal_id');
    expect(executable).toContain('v_generated_touches <> 0');
  });

  it('keeps the legacy deal and its touches while removing only the empty generated copy', () => {
    const deleteIndex = executable.indexOf('DELETE FROM public.attributions');
    const adoptIndex = executable.indexOf(
      "UPDATE public.attributions\n  SET source_system = 'salesforce'",
    );
    const relinkIndex = executable.indexOf('UPDATE public.sf_opportunity_deal_links');
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(adoptIndex).toBeGreaterThan(deleteIndex);
    expect(relinkIndex).toBeGreaterThan(adoptIndex);
    expect(executable).toContain("adoption_kind,\n    attribution_rows_adopted");
    expect(executable).toContain("'active_duplicate'");
    expect(executable).not.toMatch(/DELETE FROM public\.attribution_touches/i);
  });

  it('revalidates versions, active link identity, and candidate eligibility under lock', () => {
    expect(executable).toContain('WHERE id = p_review_id\n  FOR UPDATE');
    expect(executable).toContain("p_expected_version IS DISTINCT FROM v_current_version");
    expect(executable).toContain(
      'v_link.deal_id IS DISTINCT FROM pg_catalog.btrim(p_expected_active_deal_id)',
    );
    expect(executable).toContain('v_candidate_count <> 1');
  });

  it('is idempotent and exposed only to service_role', () => {
    expect(executable).toContain('idempotency key already used for another request');
    expect(executable).toContain("v_existing.adoption_kind = 'active_duplicate'");
    expect(executable).toContain(
      'REVOKE ALL ON FUNCTION public.sf_reconcile_active_opportunity_duplicate(\n  UUID, TEXT, TEXT, TEXT, TEXT, TEXT\n) FROM PUBLIC, anon, authenticated',
    );
    expect(executable).toContain(
      'GRANT EXECUTE ON FUNCTION public.sf_reconcile_active_opportunity_duplicate(\n  UUID, TEXT, TEXT, TEXT, TEXT, TEXT\n) TO service_role',
    );
    expect(executable).not.toMatch(
      /SELECT\s+public\.sf_reconcile_active_opportunity_duplicate\s*\(/i,
    );
  });
});
