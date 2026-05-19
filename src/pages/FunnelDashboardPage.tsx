import { useMemo } from 'react';
import { useLeads } from '../hooks/useLeads';
import { useChannels } from '../hooks/useChannels';
import { useFunnelProjections } from '../hooks/useFunnelProjections';
import { useFunnelActuals } from '../hooks/useFunnelActuals';
import { useAttributions } from '../hooks/useAttributions';
import { useCampaignCosts } from '../hooks/useCampaignCosts';
import {
  computeGrid,
  computeMonthlyLeadsForYear,
  type PeriodFilter,
} from '../lib/compute';
import { quarterOfIsoDate } from '../lib/dates';
import PeriodSelector from '../components/funnel/PeriodSelector';
import ChartCard from '../components/charts/ChartCard';
import BarChartView from '../components/charts/BarChartView';
import DonutChartView from '../components/charts/DonutChartView';
import FunnelChartView from '../components/charts/FunnelChartView';
import TrendLineChartView from '../components/charts/TrendLineChartView';
import FunnelSankeyView from '../components/charts/FunnelSankeyView';
import YearLeadCharts from '../components/charts/YearLeadCharts';
import type { RegionKey } from '../constants/regions';

interface FunnelDashboardPageProps {
  year: number;
  filter: PeriodFilter;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
}

export default function FunnelDashboardPage({
  year,
  filter,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
}: FunnelDashboardPageProps) {
  const { leads } = useLeads();
  const channels = useChannels();
  const projectionsHook = useFunnelProjections();
  const actualsHook = useFunnelActuals();
  const attributionsHook = useAttributions();
  // Only consumed by the year-selector derivation below; this page's
  // charts don't read budgets directly.
  const costsHook = useCampaignCosts();

  const yearOptions = useMemo(() => {
    // Unified derivation: any year touched by a lead, attribution, or
    // budget surfaces here. See FunnelSpendPage for the reference
    // pattern.
    const years = new Set<number>([new Date().getFullYear()]);
    for (const l of leads) {
      const sourced = quarterOfIsoDate(l.marketing_sourced_date);
      if (sourced) years.add(sourced.year);
      for (const h of l.stage_history ?? []) {
        const q = quarterOfIsoDate(h.entered_at);
        if (q) years.add(q.year);
      }
    }
    for (const a of attributionsHook.attributions) {
      years.add(a.year);
    }
    for (const c of costsHook.costs) {
      const m = /^(\d{4})/.exec(c.start_date);
      if (m) years.add(parseInt(m[1], 10));
    }
    return [...years].sort((a, b) => a - b);
  }, [leads, attributionsHook.attributions, costsHook.costs]);

  const grid = useMemo(
    () =>
      computeGrid({
        leads,
        channels,
        projections: projectionsHook.projections,
        manualActuals: actualsHook.actuals,
        attributions: attributionsHook.attributions,
        year,
        filter,
        regions,
      }),
    [
      leads,
      channels,
      projectionsHook.projections,
      actualsHook.actuals,
      attributionsHook.attributions,
      year,
      filter,
      regions,
    ],
  );

  // Year-wide leads-by-channel + per-month totals for the two bar
  // charts at the top. Intentionally ignores the quarter selector
  // (the charts always show all 12 months); year and regions still
  // apply.
  const yearLeads = useMemo(
    () =>
      computeMonthlyLeadsForYear({
        leads,
        channels,
        year,
        regions,
      }),
    [leads, channels, year, regions],
  );

  // Per-quarter totals across the selected year, for the trend chart. Always
  // computed on this page since charts ARE the surface.
  const quarterly = useMemo(() => {
    return ([1, 2, 3, 4] as const).map((q) => ({
      quarter: q,
      totals: computeGrid({
        leads,
        channels,
        projections: projectionsHook.projections,
        manualActuals: actualsHook.actuals,
        attributions: attributionsHook.attributions,
        year,
        filter: `Q${q}` as PeriodFilter,
        regions,
      }).totals,
    }));
  }, [
    leads,
    channels,
    projectionsHook.projections,
    actualsHook.actuals,
    attributionsHook.attributions,
    year,
    regions,
  ]);

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            Marketing Funnel: Leads & MQLs
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            Read-only funnel charts for the selected period. Edit values on
            the Data Entry tab.
          </p>
        </div>
        <PeriodSelector
          year={year}
          filter={filter}
          yearOptions={yearOptions}
          onYearChange={onYearChange}
          onFilterChange={onFilterChange}
          regions={regions}
          onRegionsChange={onRegionsChange}
        />
      </header>

      {grid.unassignedLeadCount > 0 && (
        <div className="text-xs text-slate-muted">
          {grid.unassignedLeadCount} lead
          {grid.unassignedLeadCount === 1 ? '' : 's'} in this period have no
          source channel and are not counted in any chart.
        </div>
      )}

      <section className="space-y-4">
        {/* Year-wide bar charts sit at the top so the user lands on
            the portfolio shape before drilling into per-period
            details. These two ignore the quarter selector. */}
        <YearLeadCharts data={yearLeads} year={year} />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <ChartCard title="Actuals vs Projections">
            <BarChartView
              totals={grid.totals}
              rows={grid.rows}
              channels={channels}
            />
          </ChartCard>
          <ChartCard title="Channel Distribution">
            <DonutChartView rows={grid.rows} channels={channels} />
          </ChartCard>
          <ChartCard title="Conversion Funnel">
            <FunnelChartView
              totals={grid.totals}
              rows={grid.rows}
              channels={channels}
            />
          </ChartCard>
          <ChartCard title={`${year} Quarterly Trend`}>
            <TrendLineChartView quarterly={quarterly} />
          </ChartCard>
        </div>
        <ChartCard
          title="Funnel Flow"
          subtitle="Lead cohort progression through the funnel, with channel attribution preserved end-to-end. Drop-off is the gap between each stage's incoming and outgoing edges."
        >
          <FunnelSankeyView
            leads={leads}
            attributions={attributionsHook.attributions}
            channels={channels}
            year={year}
            filter={filter}
            regions={regions}
          />
        </ChartCard>

      </section>
    </div>
  );
}
