import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const reconciliationSql = readFileSync(
  resolve(process.cwd(), 'docs/opportunity-existing-deal-reconciliation.sql'),
  'utf8',
);
const executableSql = reconciliationSql.replace(/^\s*--.*$/gm, '');

describe('opportunity existing-deal reconciliation audit', () => {
  it('is read-only and aggregate-only', () => {
    expect(executableSql).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL)\b/i,
    );
    expect(executableSql).toContain('SELECT metric, value');
    expect(executableSql).not.toMatch(/\b(email|reviewer_note|notes)\b/i);
  });

  it('separates exact Salesforce identity from normalized name and Account matching', () => {
    expect(executableSql).toContain("position(left(q.sf_opportunity_id, 15) IN mr.sf_link) > 0");
    expect(executableSql).toContain("'exact_salesforce_id_unique'");
    expect(executableSql).toContain("'exact_salesforce_id_ambiguous'");
    expect(executableSql).toContain("'exact_name_account_unique'");
    expect(executableSql).toContain("'exact_name_account_ambiguous'");
    expect(executableSql).toContain("'no_match'");
    expect(executableSql).toContain('count(DISTINCT deal_id) AS match_count');
  });

  it('measures conflicts and attribution touches that adoption must preserve', () => {
    expect(executableSql).toContain('channel_variants');
    expect(executableSql).toContain('lead_variants');
    expect(executableSql).toContain('region_variants');
    expect(executableSql).toContain('bdr_variants');
    expect(executableSql).toContain("'08_unique_matches_with_conflicting_legacy_fields'");
    expect(executableSql).toContain("'09_unique_matches_with_attribution_touches'");
    expect(executableSql).toContain("'10_attribution_touches_on_unique_matches'");
  });

  it('also inventories duplicates that approval already created', () => {
    expect(executableSql).toContain("'12_active_links_with_possible_legacy_duplicate'");
    expect(executableSql).toContain("'13_active_links_with_ambiguous_legacy_duplicates'");
    expect(executableSql).toContain("'14_orphan_salesforce_projection_opportunities'");
  });
});
