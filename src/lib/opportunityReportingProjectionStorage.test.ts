import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  new URL('../../migrations/2026-08-12_opportunity_reporting_projection.sql', import.meta.url),
  'utf8',
);
const EXECUTABLE = MIGRATION.replace(/^\s*--.*$/gm, '');

describe('Opportunity reporting projection storage', () => {
  it('records its true applied status and remains structural only', () => {
    expect(MIGRATION).toContain('Applied manually to production on 2026-08-12');
    expect(MIGRATION).toContain('no attribution was created');
    expect(MIGRATION).not.toContain('PENDING / NOT YET APPLIED');
    expect(MIGRATION).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b(?![^\n]*business)/i);
  });

  it('separates generated Salesforce rows from manual attributions', () => {
    expect(MIGRATION).toContain("DEFAULT 'manual'");
    expect(MIGRATION).toContain("source_system IN ('manual', 'salesforce')");
    expect(MIGRATION).toContain("WHERE source_system = 'salesforce'");
    expect(MIGRATION).toContain('(sf_opportunity_id, stage_key)');
  });

  it('requires exact Opportunity identity only for generated rows', () => {
    expect(MIGRATION).toContain('attributions_salesforce_identity_required');
    expect(MIGRATION).toContain("source_system = 'manual'");
    expect(MIGRATION).toContain("NULLIF(pg_catalog.btrim(sf_opportunity_id), '') IS NOT NULL");
  });

  it('does not create an approval or browser execution function', () => {
    expect(EXECUTABLE).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(EXECUTABLE).not.toMatch(/GRANT\s+EXECUTE/i);
    expect(EXECUTABLE).not.toMatch(/\b(anon|authenticated|service_role)\b/i);
  });
});
