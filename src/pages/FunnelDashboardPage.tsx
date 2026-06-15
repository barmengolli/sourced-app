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
import { filterChannelsByYear } from '../lib/channelFilter';
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
  // Keep FunnelSankeyView reachable for TS while the Funnel Flow
  // card is commented out below. The void reference satisfies the
  // compiler's no-unused-locals check without emitting any runtime
  // work; remove this line when the card is restored.
  void FunnelSankeyView;
  const { leads, loading: leadsLoading } = useLeads();
  const channels = useChannels();
  const projectionsHook = useFunnelProjections();
  const actualsHook = useFunnelActuals();
  const attributionsHook = useAttributions();
  // Used only to widen the year selector below; this page's charts
  // don't read budgets directly.
  const costsHook = useCampaignCosts();

  const yearOptions = useMemo(() => {
    // Unified derivation: any year touched by a lead, attribution,
    // budget, actual, or projection surfaces here. Includes
    // historical-year backfills seeded into funnel_actuals /
    // funnel_projections (e.g. 2025 pre-Sourced).
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
    for (const a of actualsHook.actuals) {
      years.add(a.year);
    }
    for (const p of projectionsHook.projections) {
      years.add(p.year);
    }
    return [...years].sort((a, b) => a - b);
  }, [
    leads,
    attributionsHook.attributions,
    costsHook.costs,
    actualsHook.actuals,
    projectionsHook.projections,
  ]);

  // Year-filtered channel set drives every chart on this page so a
  // 2025-tagged channel doesn't surface as an empty row in the 2026
  // view (and vice versa). Evergreen channels (year IS NULL) always
  // surface.
  const visibleChannels = useMemo(
    () => filterChannelsByYear(channels, year),
    [channels, year],
  );

  const grid = useMemo(
    () =>
      computeGrid({
        leads,
        channels: visibleChannels,
        projections: projectionsHook.projections,
        manualActuals: actualsHook.actuals,
        attributions: attributionsHook.attributions,
        year,
        filter,
        regions,
      }),
    [
      leads,
      visibleChannels,
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
  //
  // manualActuals is threaded so historical-year backfills (e.g. 2025
  // pre-Sourced lead actuals seeded into funnel_actuals) spread into
  // the monthly buckets. Real leads, when present, take precedence;
  // see the dedupe comment in computeMonthlyLeadsForYear.
  const yearLeads = useMemo(
    () =>
      computeMonthlyLeadsForYear({
        leads,
        channels: visibleChannels,
        year,
        regions,
        manualActuals: actualsHook.actuals,
      }),
    [leads, visibleChannels, year, regions, actualsHook.actuals],
  );

  // Prior-year totals for the YoY overlay on the Total Leads per Month
  // card. visibleChannels is filtered to the current year so we
  // recompute the channel set for (year - 1) here — otherwise a
  // channel only tagged for the prior year would silently drop its
  // leads from the comparison.
  const priorYearChannels = useMemo(
    () => filterChannelsByYear(channels, year - 1),
    [channels, year],
  );
  const priorYearLeads = useMemo(
    () =>
      computeMonthlyLeadsForYear({
        leads,
        channels: priorYearChannels,
        year: year - 1,
        regions,
        manualActuals: actualsHook.actuals,
      }),
    [leads, priorYearChannels, year, regions, actualsHook.actuals],
  );

  // Per-quarter totals across the selected year, for the trend chart. Always
  // computed on this page since charts ARE the surface.
  const quarterly = useMemo(() => {
    return ([1, 2, 3, 4] as const).map((q) => ({
      quarter: q,
      totals: computeGrid({
        leads,
        channels: visibleChannels,
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
    visibleChannels,
    projectionsHook.projections,
    actualsHook.actuals,
    attributionsHook.attributions,
    year,
    regions,
  ]);

  // Prior-year per-quarter totals for the trend chart's YoY compare
  // lines. Mirrors `quarterly` with (year - 1) and that year's
  // channel set; quarter-over-quarter alignment happens in the chart.
  const quarterlyPrior = useMemo(() => {
    return ([1, 2, 3, 4] as const).map((q) => ({
      quarter: q,
      totals: computeGrid({
        leads,
        channels: priorYearChannels,
        projections: projectionsHook.projections,
        manualActuals: actualsHook.actuals,
        attributions: attributionsHook.attributions,
        year: year - 1,
        filter: `Q${q}` as PeriodFilter,
        regions,
      }).totals,
    }));
  }, [
    leads,
    priorYearChannels,
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
          <p className="mt-1 text-sm text-slate-muted">
            Cohort reporting: each lead is counted in the period they
            entered the funnel and tracked forward over time. This is not
            a point-in-time snapshot of current funnel volumes.
          </p>
        </div>
        {/* Page-wide filters only (Year + Region). The quarter buttons live
            lower, above the period-specific charts they actually filter, so
            the top annual charts aren't sitting under a control that doesn't
            affect them. */}
        <PeriodSelector
          year={year}
          filter={filter}
          yearOptions={yearOptions}
          onYearChange={onYearChange}
          onFilterChange={onFilterChange}
          regions={regions}
          onRegionsChange={onRegionsChange}
          variant="global"
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
        <YearLeadCharts
          data={yearLeads}
          year={year}
          priorYearTotals={priorYearLeads.monthTotals}
          priorYearByChannel={priorYearLeads.byChannel}
          priorYear={year - 1}
          loading={leadsLoading || actualsHook.loading}
        />
        {/* Period (quarter) selector for the charts below only. The three
            annual charts above span the full year and ignore it; placing it
            here makes that scope visible. */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-border">
          <PeriodSelector
            year={year}
            filter={filter}
            yearOptions={yearOptions}
            onYearChange={onYearChange}
            onFilterChange={onFilterChange}
            regions={regions}
            onRegionsChange={onRegionsChange}
            variant="period"
          />
          <span className="text-xs text-slate-muted">
            Applies to the charts below. The three charts above cover the full
            year.
          </span>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <ChartCard title="Actuals vs Projections">
            <BarChartView
              totals={grid.totals}
              rows={grid.rows}
              channels={visibleChannels}
            />
          </ChartCard>
          <ChartCard title="Channel Distribution">
            <DonutChartView rows={grid.rows} channels={visibleChannels} />
          </ChartCard>
          <ChartCard title="Conversion Funnel">
            <FunnelChartView
              totals={grid.totals}
              rows={grid.rows}
              channels={visibleChannels}
            />
          </ChartCard>
          <ChartCard title="Quarterly Trend">
            <TrendLineChartView
              quarterly={quarterly}
              quarterlyPrior={quarterlyPrior}
              year={year}
              priorYear={year - 1}
            />
          </ChartCard>
        </div>
        {/* Funnel Flow Sankey hidden 2026-05-21: visual rendering is
            misleading at current data volumes (Leads dominates,
            downstream stages compress to near-invisible threads).
            Restore once the component is reworked. The
            FunnelSankeyView component and its imports/hooks are
            intentionally retained. */}
        {/*
        <ChartCard
          title="Funnel Flow"
          subtitle="Lead cohort progression through the funnel, with channel attribution preserved end-to-end. Drop-off is the gap between each stage's incoming and outgoing edges."
        >
          <FunnelSankeyView
            leads={leads}
            attributions={attributionsHook.attributions}
            channels={visibleChannels}
            year={year}
            filter={filter}
            regions={regions}
          />
        </ChartCard>
        */}

      </section>
    </div>
  );
}
