import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Data Entry presentation-only redesign contract', () => {
  const page = read('src/pages/FunnelDataEntryPage.tsx');
  const overview = read('src/pages/FunnelDashboardPage.tsx');
  const summary = read('src/components/funnel/FunnelStageSummary.tsx');

  it('keeps the authoritative calculators, filters, and operational panels wired', () => {
    expect(page).toContain('computeGrid({');
    expect(page).toContain('computeFunnelConversionCohorts({');
    expect(page).toContain('<FunnelReportingFilters');
    expect(page).toContain('<OpportunityQueuePanel');
    expect(page).toContain('<FunnelTable');
    expect(page).toContain('<ConversionsPanel');
  });

  it('keeps conversion beside the table and opportunity review below the detail section', () => {
    expect(page.indexOf('<FunnelTable')).toBeLessThan(page.indexOf('<ConversionsPanel'));
    expect(page.indexOf('<ConversionsPanel')).toBeLessThan(page.indexOf('<OpportunityQueuePanel'));
    expect(page.indexOf('<FunnelTable')).toBeLessThan(page.indexOf('id="opportunity-review-title"'));
    expect(page).toContain("xl:grid-cols-[minmax(0,1fr)_20rem]");
  });

  it('keeps manual editing locked by default while removing manual HPP creation', () => {
    expect(page).toContain('setActualsLocked');
    expect(page).toContain('EDITS_LOCKED_STORAGE_KEY');
    expect(page).not.toContain('CreateHPPModal');
    expect(page).not.toContain('+ Create HPP');
  });

  it('keeps the existing projection and actual write paths unchanged', () => {
    expect(page).toContain('projectionsHook.upsert(');
    expect(page).toContain('actualsHook.upsert(');
    expect(page).toContain('attributionsHook={attributionsHook}');
    expect(page).toContain('touchesHook={touchesHook}');
  });

  it('makes the visual summary a pure view over the table totals', () => {
    expect(page).toContain('<FunnelStageSummary totals={grid.totals} />');
    expect(summary).not.toMatch(/use[A-Z]|supabase|fetch\(|computeGrid|conversionPercent/);
    expect(summary).toContain("import type { ComputedGrid } from '../../lib/compute'");
  });

  it('reuses the same authoritative overview calculations in the modern layout', () => {
    expect(overview).toContain('computeGrid({');
    expect(overview).toContain('computeMonthlyLeadsForYear({');
    expect(overview).toContain('computeFunnelConversionCohorts({');
    expect(overview).toContain('<FunnelReportingFilters');
    expect(overview).toContain('totals={grid.totals}');
    expect(overview).toContain('<FunnelDemandTrend');
    expect(overview).toContain('<FunnelPlanPerformance');
    expect(overview).toContain('<ConversionsPanel');
    expect(overview).toContain('<FunnelChannelPerformance');
    expect(overview).not.toContain('<YearLeadCharts');
    expect(overview).not.toContain('<DonutChartView');
  });

  it('combines each page heading and reporting controls into one surface', () => {
    expect(overview.indexOf('<FunnelReportingFilters')).toBeLessThan(overview.indexOf('</header>'));
    expect(page.indexOf('<FunnelReportingFilters')).toBeLessThan(page.indexOf('</header>'));
  });

  it('gives the selected-period cards equal width', () => {
    expect(overview).toContain('xl:grid-cols-2');
    expect(overview).not.toContain('minmax(0,1.3fr)');
  });
});
