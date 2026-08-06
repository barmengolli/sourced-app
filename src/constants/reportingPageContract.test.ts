// reportingPageContract.test.ts
//
// The completeness gate for the reporting-filter standard.
//
// The failure this prevents is a slow one: someone adds a dashboard, gives it a
// hand-rolled month dropdown, and six months later two pages disagree about
// what "Q3" means with no test anywhere going red. These tests walk the real
// navigation registry, so a new page cannot slip through unclassified.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SIDEBAR_SECTIONS, UTILITY_PAGES } from './sidebar';
import {
  REPORTING_PAGES,
  APPROVED_NON_REPORTING_PAGES,
  REPORTING_PAGE_KEYS,
  APPROVED_NON_REPORTING_KEYS,
  reportingContractFor,
} from './reportingPages';
import type { PageKey } from '../App';

// Every page a user can actually navigate to: section children AND the
// utility pages, which live in a separate registry. Omitting utilities would
// leave a whole navigable surface unguarded.
const VISIBLE_PAGES: PageKey[] = [
  ...SIDEBAR_SECTIONS.flatMap((s) => s.children.map((c) => c.key)),
  ...UTILITY_PAGES.map((c) => c.key),
];

// Where each in-scope reporting page's component lives, so the test can assert
// the page really renders the shared bar rather than merely being listed.
const PAGE_SOURCES: Readonly<Record<string, string>> = {
  'funnel-data': 'src/pages/FunnelDataEntryPage.tsx',
  'funnel-dashboard': 'src/pages/FunnelDashboardPage.tsx',
  'funnel-velocity': 'src/pages/FunnelVelocityPage.tsx',
  'funnel-events': 'src/pages/FunnelEventsPage.tsx',
  'funnel-spend': 'src/pages/FunnelSpendPage.tsx',
  'sixsense-dashboard': 'src/pages/SixSenseDashboardPage.tsx',
  'bdr-quota-dashboard': 'src/pages/BdrDashboardPage.tsx',
  'outreach-dashboard': 'src/pages/OutreachDashboardPage.tsx',
  'linkedin-dashboard': 'src/pages/LinkedinDashboardPage.tsx',
  'campaigns-overview': 'src/pages/CampaignsOverviewPage.tsx',
};

const readSource = (key: string): string =>
  readFileSync(resolve(process.cwd(), PAGE_SOURCES[key]), 'utf8');

describe('reporting page contract completeness', () => {
  it('classifies every visible page as reporting or an approved exception', () => {
    // THE GATE. A new sidebar entry that is neither a declared reporting page
    // nor a documented exception fails here, with its key named.
    const unclassified = VISIBLE_PAGES.filter(
      (key) =>
        !REPORTING_PAGE_KEYS.has(key) && !APPROVED_NON_REPORTING_KEYS.has(key),
    );
    expect(
      unclassified,
      `Unclassified page(s): ${unclassified.join(', ')}. Add each to REPORTING_PAGES `
        + '(and render ReportingFilterBar) or to APPROVED_NON_REPORTING_PAGES with a reason.',
    ).toEqual([]);
  });

  it('never classifies a page as both reporting and an exception', () => {
    const both = REPORTING_PAGES.map((p) => p.key).filter((k) =>
      APPROVED_NON_REPORTING_KEYS.has(k),
    );
    expect(both, `Page(s) in both lists: ${both.join(', ')}`).toEqual([]);
  });

  it('lists only real, navigable pages in both registries', () => {
    // A stale entry is as bad as a missing one: it would let a deleted page
    // keep vouching for coverage that no longer exists.
    const visible = new Set<string>(VISIBLE_PAGES);
    for (const p of REPORTING_PAGES) {
      expect(visible.has(p.key), `REPORTING_PAGES lists "${p.key}" which is not in the sidebar`).toBe(true);
    }
    for (const p of APPROVED_NON_REPORTING_PAGES) {
      expect(visible.has(p.key), `APPROVED_NON_REPORTING_PAGES lists "${p.key}" which is not in the sidebar`).toBe(true);
    }
  });

  it('requires every approved exception to carry a real reason', () => {
    for (const p of APPROVED_NON_REPORTING_PAGES) {
      // An empty or placeholder reason would make the exception list a
      // rubber stamp.
      expect(p.reason.trim().length, `${p.key} needs a reason`).toBeGreaterThan(20);
      expect(p.reason, `${p.key} reason must not be a placeholder`)
        .not.toMatch(/^(tbd|todo|n\/a|none)\b/i);
    }
  });

  it('covers exactly the ten in-scope reporting pages', () => {
    expect(REPORTING_PAGES.map((p) => p.key).sort()).toEqual([
      'bdr-quota-dashboard',
      'campaigns-overview',
      'funnel-dashboard',
      'funnel-data',
      'funnel-events',
      'funnel-spend',
      'funnel-velocity',
      'linkedin-dashboard',
      'outreach-dashboard',
      'sixsense-dashboard',
    ]);
  });

  it('declares a reason for every omitted grain', () => {
    // A grain may be omitted only WITH an explanation. Omitting one silently
    // would leave a disabled control that looks broken.
    for (const p of REPORTING_PAGES) {
      const omitted = (['month', 'quarter', 'year'] as const).filter(
        (g) => !p.supportedGrains.includes(g),
      );
      if (omitted.length > 0) {
        expect(
          p.disabledGrainReason,
          `${p.key} omits ${omitted.join(', ')} and must say why`,
        ).toBeTruthy();
        expect(p.disabledGrainReason).not.toContain('—');
      }
    }
  });

  it('keeps Data Entry on its quarterly storage grain with no comparison', () => {
    // Data Entry edits stored QUARTERLY values. A month control would imply an
    // editable monthly cell that does not exist, and a comparison control
    // would promise a delta the page never computes.
    const de = reportingContractFor('funnel-data');
    expect(de).toBeDefined();
    expect(de?.supportedGrains).toEqual(['quarter', 'year']);
    expect(de?.supportsComparison).toBe(false);
  });

  it('declares a basis, anchor, and at least one supported grain per page', () => {
    for (const p of REPORTING_PAGES) {
      expect(p.basis, `${p.key} basis`).toMatch(
        /^(cohort|activity|snapshot|derived_activity|allocation)$/,
      );
      // The anchor is user-facing copy: it must name the actual date field or
      // effective date, not restate the basis word.
      expect(p.anchor.trim().length, `${p.key} anchor`).toBeGreaterThan(15);
      expect(p.supportedGrains.length, `${p.key} grains`).toBeGreaterThan(0);
      // House style: no em dashes in user-facing copy.
      expect(p.anchor, `${p.key} anchor must not use an em dash`).not.toContain('—');
      expect(p.label, `${p.key} label must not use an em dash`).not.toContain('—');
    }
  });
});

describe('reporting pages adopt the shared controls', () => {
  it('renders ReportingFilterBar on every in-scope reporting page', () => {
    // Listing a page in the registry is a claim. This checks the claim against
    // the component source, so the registry cannot drift from reality.
    for (const p of REPORTING_PAGES) {
      const src = readSource(p.key);
      // Either directly, or through a shared wrapper that renders it. Both are
      // one implementation; what is forbidden is a page-local period control.
      const usesShared =
        src.includes('<ReportingFilterBar')
        || src.includes('<FunnelReportingFilters');
      expect(usesShared, `${p.key} must render a shared reporting filter bar`)
        .toBe(true);
      expect(src, `${p.key} must not keep the legacy PeriodSelector`)
        .not.toContain('<PeriodSelector');
    }
  });

  it('does not hand-roll period controls alongside the shared bar', () => {
    // A page-specific month or quarter picker beside the shared bar is how two
    // controls end up disagreeing about the visible period.
    for (const p of REPORTING_PAGES) {
      const src = readSource(p.key);
      const codeOnly = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n');
      expect(codeOnly, `${p.key} must not define its own month picker`)
        .not.toMatch(/MONTH_OPTIONS\s*[:=]/);
      expect(codeOnly, `${p.key} must not define its own quarter picker`)
        .not.toMatch(/QUARTER_OPTIONS\s*[:=]/);
    }
  });

  it('keeps administrative pages free of the reporting bar', () => {
    // Forcing a period filter onto a data-entry grid would hide the very rows
    // the user is trying to edit.
    for (const p of APPROVED_NON_REPORTING_PAGES) {
      const path = PAGE_SOURCES[p.key];
      if (!path) continue;
      expect(readSource(p.key), `${p.key} is an approved exception and must not render the bar`)
        .not.toContain('<ReportingFilterBar');
    }
  });

  it('shows a reporting-basis disclosure on every reporting page', () => {
    for (const p of REPORTING_PAGES) {
      expect(readSource(p.key), `${p.key} must disclose its reporting basis`)
        .toContain('ReportingBasisDisclosure');
    }
  });

  it('resolves a contract for every reporting page and none other', () => {
    for (const p of REPORTING_PAGES) {
      expect(reportingContractFor(p.key)).toBeDefined();
    }
    for (const p of APPROVED_NON_REPORTING_PAGES) {
      expect(reportingContractFor(p.key)).toBeUndefined();
    }
  });
});
