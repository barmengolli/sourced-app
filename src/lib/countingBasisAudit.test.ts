// Bite 4F: the counting-basis audit must stay complete. If a new surface
// starts consuming leads/touches/computeGrid without being classified in
// docs/counting-basis-audit.md, this fails and forces the decision rather
// than letting a surface silently mix the two models.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const AUDIT = readFileSync(resolve(process.cwd(), 'docs/counting-basis-audit.md'), 'utf8');

function pageFiles(): string[] {
  const dir = resolve(process.cwd(), 'src/pages');
  return readdirSync(dir).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'));
}

// Pages that consume lead/MQL-derived data and therefore need a basis entry.
// The audit names surfaces in prose, so we assert on the page's own name
// stem appearing somewhere in the doc.
const AUDIT_SUBJECTS: Record<string, string> = {
  'FunnelDashboardPage.tsx': 'Leads & MQLs',
  'FunnelDataEntryPage.tsx': 'Data Entry',
  'FunnelEventsPage.tsx': 'Events page',
  'FunnelSpendPage.tsx': 'Spend page',
  'FunnelVelocityPage.tsx': 'Opportunities page',
  'LeadsPage.tsx': 'Leads utility page',
  'ChannelsPage.tsx': 'Channels utility page',
  'CampaignsOverviewPage.tsx': 'Campaigns scorecard',
  'FunnelComparePage.tsx': 'Funnel Compare page',
};

describe('counting-basis audit completeness', () => {
  it('classifies every known lead/MQL surface', () => {
    for (const [, subject] of Object.entries(AUDIT_SUBJECTS)) {
      expect(AUDIT, `audit is missing: ${subject}`).toContain(subject);
    }
  });

  it('every page consuming leads or touches is a known audit subject', () => {
    const dir = resolve(process.cwd(), 'src/pages');
    const unclassified: string[] = [];
    for (const file of pageFiles()) {
      const source = readFileSync(resolve(dir, file), 'utf8');
      const consumesLeadData =
        source.includes('useLeads()') || source.includes('useLeadCampaignTouches()');
      if (!consumesLeadData) continue;
      // Import/entry surfaces write data rather than reporting counts.
      if (file === 'FunnelImportPage.tsx' || file === 'CampaignsSection.tsx') continue;
      if (!(file in AUDIT_SUBJECTS)) unclassified.push(file);
    }
    expect(unclassified, 'new lead-consuming pages must be added to docs/counting-basis-audit.md').toEqual([]);
  });

  it('records the three basis vocabularies and the open Spend question', () => {
    expect(AUDIT).toContain('Memberships (overlapping)');
    expect(AUDIT).toContain('Primary source');
    expect(AUDIT).toContain('Unique contacts');
    expect(AUDIT).toContain('Open question');
    // The hidden surfaces must stay flagged until classified.
    expect(AUDIT).toContain('Hidden, unaudited, legacy basis');
  });
});
