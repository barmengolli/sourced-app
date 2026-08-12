import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('migrations/2026-08-11_sfdc_campaign_touch_import_supersession.sql'),
  'utf8',
);
const schema = readFileSync(resolve('SCHEMA.sql'), 'utf8');
const ledger = readFileSync(resolve('migrations/README.md'), 'utf8');
const docs = readFileSync(resolve('docs/salesforce-campaign-member-daily-sync.md'), 'utf8');
const functionStart = migration.indexOf(
  'CREATE OR REPLACE FUNCTION public.sourced_supersede_legacy_import_touch()',
);
const functionEnd = migration.indexOf('REVOKE ALL ON FUNCTION', functionStart);
const triggerFunction = migration.slice(functionStart, functionEnd);
const cleanupStart = migration.indexOf('WITH deleted AS (');
const cleanupEnd = migration.indexOf('-- Aggregate-only postconditions', cleanupStart);
const cleanup = migration.slice(cleanupStart, cleanupEnd);

describe('legacy campaign-touch import supersession', () => {
  it('records the verified production application without stale pending text', () => {
    const normalizedDocs = docs.replace(/\s+/g, ' ');
    expect(migration).toContain('STATUS: APPLIED MANUALLY TO PRODUCTION ON 2026-08-11');
    expect(migration).not.toContain('PENDING / NOT YET APPLIED');
    expect(ledger).toContain('2026-08-11_sfdc_campaign_touch_import_supersession.sql` | APPLIED');
    expect(schema).toContain('Salesforce CampaignMember legacy-import supersession');
    expect(schema).toContain('STATUS: APPLIED MANUALLY TO PRODUCTION ON 2026-08-11');
    expect(docs).toContain('applied manually to production on 2026-08-11');
    for (const evidence of [
      '0 remaining',
      '2,614 authoritative n8n touches',
      '1 intentionally unmatched legacy import',
      'prevention trigger present = true',
    ]) {
      expect(normalizedDocs).toContain(evidence);
    }
  });

  it('deletes only ID-less legacy imports shadowed by authoritative n8n rows', () => {
    expect(cleanupStart).toBeGreaterThan(-1);
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    expect(cleanup).toContain("legacy.source = 'import'");
    expect(cleanup).toContain('legacy.campaign_member_id IS NULL');
    expect(cleanup).toContain('legacy.channel_id IS NOT NULL');
    expect(cleanup).toContain("authoritative.source = 'n8n_sync'");
    expect(cleanup).toContain('authoritative.campaign_member_id IS NOT NULL');
    expect(cleanup).toContain('authoritative.lead_id = legacy.lead_id');
    expect(cleanup).toContain('authoritative.channel_id = legacy.channel_id');
  });

  it('never targets people, channels, or authoritative/manual/backfill touches', () => {
    expect(migration).not.toMatch(/DELETE FROM public\.(leads|channels)\b/i);
    expect(migration).not.toContain("legacy.source = 'n8n_sync'");
    expect(migration).not.toContain("legacy.source = 'manual'");
    expect(migration).not.toContain("legacy.source = 'backfill'");
  });

  it('installs prevention on both inserts and material identity updates', () => {
    expect(migration).toContain('AFTER INSERT OR UPDATE OF lead_id, channel_id, source, campaign_member_id');
    expect(triggerFunction).toContain("IF NEW.source = 'n8n_sync'");
    expect(triggerFunction).toContain('NEW.campaign_member_id IS NOT NULL');
    expect(triggerFunction).toContain('NEW.channel_id IS NOT NULL');
    expect(triggerFunction).toContain("legacy.source = 'import'");
    expect(triggerFunction).toContain('legacy.campaign_member_id IS NULL');
    expect(triggerFunction).toContain('legacy.lead_id = NEW.lead_id');
    expect(triggerFunction).toContain('legacy.channel_id = NEW.channel_id');
    expect(triggerFunction).toContain('legacy.id <> NEW.id');
  });

  it('restricts deletion to the postgres-owned apply path and fixes its search path', () => {
    expect(functionStart).toBeGreaterThan(-1);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(triggerFunction).not.toMatch(/^SECURITY DEFINER\b/m);
    expect(triggerFunction).toContain('SET search_path = pg_catalog');
    expect(triggerFunction).toContain("IF current_user <> 'postgres'");
    expect(triggerFunction).toContain('RETURN NEW');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.sourced_supersede_legacy_import_touch() FROM PUBLIC');
    expect(migration).toContain('FROM anon');
    expect(migration).toContain('FROM authenticated');
  });

  it('returns aggregate-only mutation and postcondition evidence', () => {
    expect(migration).toContain('legacy_import_touches_superseded');
    expect(migration).toContain('legacy_import_touches_still_shadowed');
    expect(migration).toContain('authoritative_n8n_touches');
    expect(migration).toContain('unmatched_legacy_import_touches');
    expect(migration).toContain('prevention_trigger_exists');
    expect(migration).not.toMatch(/RETURNING\s+legacy\.(lead_id|campaign_member_id|campaign_id|channel_id)/i);
  });

  it('documents the reproduced impact and the intentionally preserved row', () => {
    expect(docs).toContain('2,608 older ID-less `import` rows');
    expect(docs).toContain('150 Leads / 82 MQLs');
    expect(docs).toContain('77 Leads / 43 MQLs');
    expect(docs).toMatch(/One unmatched\s+legacy import remains untouched by design/);
  });

  it('keeps the canonical schema trigger predicate aligned with the migration', () => {
    for (const token of [
      "NEW.source = 'n8n_sync'",
      "current_user <> 'postgres'",
      'NEW.campaign_member_id IS NOT NULL',
      "legacy.source = 'import'",
      'legacy.campaign_member_id IS NULL',
      'legacy.lead_id = NEW.lead_id',
      'legacy.channel_id = NEW.channel_id',
    ]) {
      expect(schema).toContain(token);
    }
  });
});
