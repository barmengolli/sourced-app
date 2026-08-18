import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    process.cwd(),
    'migrations/2026-08-18_opportunity_pending_legacy_reconciliation.sql',
  ),
  'utf8',
);
const executable = migration.replace(/^\s*--.*$/gm, '');

describe('pending Opportunity legacy reconciliation migration', () => {
  it('installs preview and mutation boundaries without invoking either', () => {
    expect(executable).toContain(
      'sf_list_pending_opportunity_legacy_reconciliations',
    );
    expect(executable).toContain(
      'sf_reconcile_pending_opportunity_legacy_deals',
    );
    expect(executable).not.toMatch(
      /SELECT\s+public\.sf_reconcile_pending_opportunity_legacy_deals\s*\(/i,
    );
  });

  it('requires explicit deal sets, row and touch counts, version, and identity evidence', () => {
    expect(executable).toContain('p_expected_attribution_rows');
    expect(executable).toContain('p_expected_attribution_touches');
    expect(executable).toContain(
      'candidate row or touch counts changed; reload and retry',
    );
    expect(executable).toContain('review changed; reload and retry');
    expect(executable).toContain(
      "p_identity_method NOT IN ('exact_sf_opportunity_id', 'manual_review')",
    );
    expect(executable).toContain(
      "p_manual_confirmation IS DISTINCT FROM 'I VERIFIED THE SALESFORCE OPPORTUNITY'",
    );
  });

  it('never guesses identity from names and accounts', () => {
    expect(executable).toContain(
      'exact Salesforce ID candidate set changed',
    );
    expect(executable).toContain(
      'manual identity review is not fully confirmed',
    );
    expect(executable).toContain(
      "p_identity_method = 'exact_sf_opportunity_id'",
    );
  });

  it('collapses a duplicate stage only when its fields and ordered touches are identical', () => {
    expect(executable).toContain(
      'duplicate stage rows are not semantically identical',
    );
    expect(executable).toContain(
      'duplicate_row.stage_entered_at IS DISTINCT FROM retained_row.stage_entered_at',
    );
    expect(executable).toContain(
      'duplicate_row.channel_id IS DISTINCT FROM retained_row.channel_id',
    );
    expect(executable).toContain("'touchOrder', t.touch_order");
    expect(executable).toContain("'channelId', t.channel_id");
    expect(executable).toContain("'touchedAt', t.touched_at");
  });

  it('preserves retained rows and meaningful touches while recording any exact duplicate removal', () => {
    expect(executable).toContain(
      'SET deal_id = pg_catalog.btrim(p_retained_deal_id)',
    );
    expect(executable).toContain("SET source_system = 'salesforce'");
    expect(executable).toContain("'duplicateRowsRemoved', v_duplicate_rows_removed");
    expect(executable).toContain("'duplicateTouchesRemoved', v_duplicate_touches_removed");
    expect(executable).toContain(
      "'attributionTouchesPreserved', v_touches_preserved",
    );
    expect(executable).not.toMatch(/DELETE FROM public\.attribution_touches/i);
  });

  it('canonicalizes the Opportunity URL and lets Salesforce history refresh dates', () => {
    expect(executable).toContain(
      "'https://eisgroup.lightning.force.com/lightning/r/Opportunity/'",
    );
    expect(executable).toContain(
      'v_reporting_rows := public.sf_refresh_opportunity_reporting(v_opp.id)',
    );
    expect(executable).not.toContain('stage_entered_at =');
    expect(executable).not.toMatch(
      /array_remove\([^;]*'incomplete_history'/s,
    );
  });

  it('is locked, idempotent, append-only audited, and service-role-only', () => {
    expect(executable).toContain('WHERE id = p_review_id\n  FOR UPDATE');
    expect(executable).toContain(
      'idempotency key already used for another request',
    );
    expect(executable).toContain('public.sf_opportunity_deal_adoptions');
    expect(executable).toContain('public.sf_opportunity_review_events');
    expect(executable).toContain(
      'FROM PUBLIC, anon, authenticated',
    );
    expect(executable).toContain('TO service_role');
  });
});
