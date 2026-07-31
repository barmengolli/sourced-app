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

  it('records the three basis vocabularies', () => {
    expect(AUDIT).toContain('Memberships (overlapping)');
    expect(AUDIT).toContain('Primary source');
    expect(AUDIT).toContain('Unique contacts');
  });

  it('records Spend as a LOCKED primary-source decision, not an open question', () => {
    // Program section 2 locks primary source for spend/CPL math; the audit
    // must state the decision rather than reopen it.
    expect(AUDIT).toContain('Recorded decision: Spend stays primary-source-based');
    expect(AUDIT).toContain('never become Spend');
    // The intentional-divergence warning must survive.
    expect(AUDIT).toContain('will not reconcile');
    // No lingering "open question" framing for Spend.
    expect(AUDIT).not.toContain('Open question for Benjamin');
  });

  it('keeps the hidden surfaces flagged and does not overclaim the headline', () => {
    expect(AUDIT).toContain('Hidden, unaudited, legacy basis');
    expect(AUDIT).toContain('Follow-ups before any hidden surface returns');
    // The headline must be scoped to visible, in-scope surfaces.
    expect(AUDIT).toContain(
      'No currently visible, in-scope surface required a calculation switch in',
    );
    expect(AUDIT).not.toMatch(/^No surface needed switching/m);
  });
});
