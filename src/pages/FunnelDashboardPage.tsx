import { useMemo } from 'react';
import { useLeads } from '../hooks/useLeads';
import { useLeadCampaignTouches } from '../hooks/useLeadCampaignTouches';
import { useChannels } from '../hooks/useChannels';
import { useFunnelProjections } from '../hooks/useFunnelProjections';
import { useFunnelActuals } from '../hooks/useFunnelActuals';
import { useAttributions } from '../hooks/useAttributions';
import { useAttributionTouches } from '../hooks/useAttributionTouches';
import { useCampaignCosts } from '../hooks/useCampaignCosts';
import {
  computeChannelSpend,
  computeGrid,
  computeMonthlyLeadsForYear,
  type ChannelSpendBreakdown,
  type PeriodFilter,
} from '../lib/compute';
import { filterChannelsByYear } from '../lib/channelFilter';
import { quarterOfIsoDate } from '../lib/dates';
import FunnelReportingFilters from '../components/funnel/FunnelReportingFilters';
import type { RegionKey } from '../constants/regions';
import type { ComparisonMode } from '../types/reporting';
import ReportingBasisDisclosure from '../components/reporting/ReportingBasisDisclosure';
import { reportingContractFor } from '../constants/reportingPages';
import FunnelStageSummary from '../components/funnel/FunnelStageSummary';
import FunnelDemandTrend from '../components/funnel/FunnelDemandTrend';
import FunnelPlanPerformance from '../components/funnel/FunnelPlanPerformance';
import FunnelChannelPerformance from '../components/funnel/FunnelChannelPerformance';
import ConversionsPanel from '../components/funnel/ConversionsPanel';
import FunnelExecutiveEfficiency from '../components/funnel/FunnelExecutiveEfficiency';
import { computeFunnelConversionCohorts } from '../lib/funnelConversionCohorts';

interface FunnelDashboardPageProps {
  year: number;
  filter: PeriodFilter;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
  // Comparison mode from the shared reporting selection.
  comparison: ComparisonMode;
  onComparisonChange: (m: ComparisonMode) => void;
}

// Basis and anchor come from the single reporting-page registry, so the
// visible disclosure and the declared contract cannot disagree.
const REPORTING_BASIS = reportingContractFor('funnel-dashboard')!;

export default function FunnelDashboardPage({
  year,
  filter,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
  comparison,
  onComparisonChange,
}: FunnelDashboardPageProps) {
  const { leads, loading: leadsLoading } = useLeads();
  const { touches } = useLeadCampaignTouches();
  const channels = useChannels();
  const projectionsHook = useFunnelProjections();
  const actualsHook = useFunnelActuals();
  const attributionsHook = useAttributions();
  const attributionTouchesHook = useAttributionTouches();
  const costsHook = useCampaignCosts();

  // "Q2 2026" or "2026", matching the other funnel pages' wording.
  const periodLabel = filter === 'year' ? `${year}` : `${filter} ${year}`;

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
        touches,
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
      touches,
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
        touches,
        channels: visibleChannels,
        year,
        regions,
        manualActuals: actualsHook.actuals,
      }),
    [leads, touches, visibleChannels, year, regions, actualsHook.actuals],
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
        touches,
        channels: priorYearChannels,
        year: year - 1,
        regions,
        manualActuals: actualsHook.actuals,
      }),
    [leads, touches, priorYearChannels, year, regions, actualsHook.actuals],
  );

  const conversionCohorts = useMemo(
    () => computeFunnelConversionCohorts({
      leads,
      touches,
      attributions: attributionsHook.attributions,
      year,
      filter,
      regions,
    }),
    [leads, touches, attributionsHook.attributions, year, filter, regions],
  );

  // Reuse the audited Spend-page calculation verbatim. This keeps executive
  // CPL, CPMQL, pipeline, won revenue, and ROI aligned with the detailed
  // channel report instead of introducing a second calculation here.
  const investmentBreakdown: ChannelSpendBreakdown[] = useMemo(
    () => computeChannelSpend({
      campaignCosts: costsHook.costs,
      channels: visibleChannels,
      leads,
      attributions: attributionsHook.attributions,
      attributionTouches: attributionTouchesHook.touches,
      year,
      filter,
      regions,
    }),
    [
      costsHook.costs,
      visibleChannels,
      leads,
      attributionsHook.attributions,
      attributionTouchesHook.touches,
      year,
      filter,
      regions,
    ],
  );

  return (
    <div className="min-h-full bg-gradient-to-b from-muted/80 via-bg to-bg p-4 sm:p-6 xl:p-8">
      <div className="mx-auto max-w-[1800px] space-y-5">
      <header className="relative overflow-hidden rounded-2xl border border-border bg-bg shadow-sm">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo via-teal to-success" />
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-indigo/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo">
              Executive reporting
            </span>
            <ReportingBasisDisclosure
              basis={REPORTING_BASIS.basis}
              showExplanation={false}
              variant="accent"
            />
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-charcoal">
            Marketing Funnel: Overview
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-muted">
            Monitor source-backed funnel performance and channel movement across the selected period.
          </p>
        </div>
        <div className="border-t border-border bg-muted/25 p-4 sm:px-6 sm:py-5">
          <div className="mb-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Reporting scope</p>
              <h2 id="overview-reporting-scope-title" className="mt-1 text-base font-semibold text-charcoal">
                Choose the period and commercial region
              </h2>
            </div>
          </div>
          <FunnelReportingFilters
            year={year}
            filter={filter}
            yearOptions={yearOptions}
            onYearChange={onYearChange}
            onFilterChange={onFilterChange}
            regions={regions}
            onRegionsChange={onRegionsChange}
            comparison={comparison}
            onComparisonChange={onComparisonChange}
          />
        </div>
      </header>

      <FunnelStageSummary
        totals={grid.totals}
        note="Source-backed totals · identical to Operations"
      />

      <section aria-labelledby="annual-context-title" className="space-y-4 rounded-2xl border border-border bg-bg p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Demand movement</p>
            <h2 id="annual-context-title" className="mt-1 text-lg font-semibold text-charcoal">
              Full-year trend
            </h2>
          </div>
          <span className="rounded-full border border-border bg-bg px-3 py-1 text-[11px] text-slate-muted shadow-sm">
            {year} · region filter applies
          </span>
        </div>
        <FunnelDemandTrend
          data={yearLeads}
          year={year}
          priorYearTotals={priorYearLeads.monthTotals}
          priorYear={year - 1}
          loading={leadsLoading || actualsHook.loading}
          embedded
        />
      </section>

      <section aria-labelledby="selected-period-title" className="space-y-4 rounded-2xl border border-border bg-bg p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Performance analysis</p>
            <h2 id="selected-period-title" className="mt-1 text-lg font-semibold text-charcoal">
              Selected period
            </h2>
          </div>
          <span className="rounded-full border border-indigo/15 bg-indigo/5 px-3 py-1 text-[11px] font-medium text-indigo">
            {periodLabel}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <FunnelPlanPerformance totals={grid.totals} />
          <ConversionsPanel conversions={conversionCohorts} />
        </div>
        <section aria-labelledby="channel-efficiency-title" className="space-y-4 rounded-xl border border-border bg-bg p-4 shadow-sm sm:p-5">
          <header className="border-b border-border pb-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Channel efficiency</p>
            <h3 id="channel-efficiency-title" className="mt-1 text-base font-semibold text-charcoal">Investment and performance by channel</h3>
            <p className="mt-1 text-xs text-slate-muted">Recorded campaign spend, attributed return, and funnel volume for the selected period.</p>
          </header>
          <FunnelExecutiveEfficiency breakdown={investmentBreakdown} embedded />
          <FunnelChannelPerformance rows={grid.rows} channels={visibleChannels} embedded />
        </section>
      </section>
      </div>
    </div>
  );
}
