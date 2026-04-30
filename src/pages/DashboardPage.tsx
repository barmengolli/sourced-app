import { useEffect, useMemo, useState } from 'react';
import { useLeads } from '../hooks/useLeads';
import { useChannels } from '../hooks/useChannels';
import { useFunnelProjections } from '../hooks/useFunnelProjections';
import { useFunnelActuals } from '../hooks/useFunnelActuals';
import { computeGrid, type PeriodFilter } from '../lib/compute';
import { currentQuarter, quarterOfIsoDate } from '../lib/dates';
import { readJson, writeJson } from '../lib/storage';
import FunnelTable from '../components/funnel/FunnelTable';
import ConversionsPanel from '../components/funnel/ConversionsPanel';
import PeriodSelector from '../components/funnel/PeriodSelector';
import ChartCard from '../components/charts/ChartCard';
import BarChartView from '../components/charts/BarChartView';
import DonutChartView from '../components/charts/DonutChartView';
import FunnelChartView from '../components/charts/FunnelChartView';
import TrendLineChartView from '../components/charts/TrendLineChartView';
import AttributionSummaryView from '../components/charts/AttributionSummaryView';

const CHARTS_OPEN_KEY = 'sourced.dashboard.chartsOpen';

export default function DashboardPage() {
  const { leads } = useLeads();
  const channels = useChannels();
  const projectionsHook = useFunnelProjections();
  const actualsHook = useFunnelActuals();

  // Year range derived from data: pull years out of marketing_sourced_date
  // and stage_history.entered_at, always include the current year.
  const yearOptions = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const l of leads) {
      const sourced = quarterOfIsoDate(l.marketing_sourced_date);
      if (sourced) years.add(sourced.year);
      for (const h of l.stage_history ?? []) {
        const q = quarterOfIsoDate(h.entered_at);
        if (q) years.add(q.year);
      }
    }
    return [...years].sort((a, b) => a - b);
  }, [leads]);

  const initial = currentQuarter();
  const [year, setYear] = useState<number>(initial.year);
  const [filter, setFilter] = useState<PeriodFilter>(
    `Q${initial.quarter}` as PeriodFilter,
  );

  // Persist the charts toggle in localStorage so the Dashboard remembers
  // whether the user wants the chart cards above the grid between sessions.
  const [chartsOpen, setChartsOpen] = useState<boolean>(() =>
    readJson<boolean>(CHARTS_OPEN_KEY, false),
  );
  useEffect(() => {
    writeJson(CHARTS_OPEN_KEY, chartsOpen);
  }, [chartsOpen]);

  const grid = useMemo(
    () =>
      computeGrid({
        leads,
        channels,
        projections: projectionsHook.projections,
        manualActuals: actualsHook.actuals,
        year,
        filter,
      }),
    [
      leads,
      channels,
      projectionsHook.projections,
      actualsHook.actuals,
      year,
      filter,
    ],
  );

  // Per-quarter totals across the selected year, for the trend chart. Skips
  // the work entirely when the charts toggle is off — calling computeGrid
  // four times each render would be wasted otherwise.
  const quarterly = useMemo(() => {
    if (!chartsOpen) return [];
    return ([1, 2, 3, 4] as const).map((q) => ({
      quarter: q,
      totals: computeGrid({
        leads,
        channels,
        projections: projectionsHook.projections,
        manualActuals: actualsHook.actuals,
        year,
        filter: `Q${q}` as PeriodFilter,
      }).totals,
    }));
  }, [
    chartsOpen,
    leads,
    channels,
    projectionsHook.projections,
    actualsHook.actuals,
    year,
  ]);

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">Funnel</h1>
          <p className="mt-1 text-sm text-slate-muted">
            Channel × stage actuals and projections, computed live from leads
            for the lead and MQL columns; manually entered for the four
            attribution stages until M7.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PeriodSelector
            year={year}
            filter={filter}
            yearOptions={yearOptions}
            onYearChange={setYear}
            onFilterChange={setFilter}
          />
          <button
            type="button"
            onClick={() => setChartsOpen((v) => !v)}
            aria-pressed={chartsOpen}
            className={
              'text-xs px-2 py-1 rounded border transition-colors ' +
              (chartsOpen
                ? 'bg-indigo text-white border-indigo'
                : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
            }
          >
            {chartsOpen ? 'Hide charts' : 'Show charts'}
          </button>
        </div>
      </header>

      {grid.unassignedLeadCount > 0 && (
        <div className="text-xs text-slate-muted">
          {grid.unassignedLeadCount} lead
          {grid.unassignedLeadCount === 1 ? '' : 's'} in this period have no
          source channel and are not counted in any row. Assign a channel to
          surface them in the grid.
        </div>
      )}

      {chartsOpen && (
        <section className="space-y-4">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <ChartCard title="Actuals vs projections">
              <BarChartView totals={grid.totals} />
            </ChartCard>
            <ChartCard title="Channel distribution (leads)">
              <DonutChartView rows={grid.rows} channels={channels} />
            </ChartCard>
            <ChartCard title="Conversion funnel">
              <FunnelChartView totals={grid.totals} />
            </ChartCard>
            <ChartCard title={`${year} quarterly trend`}>
              <TrendLineChartView quarterly={quarterly} />
            </ChartCard>
          </div>
          <ChartCard
            title="Channel influence"
            subtitle="Placeholder until M7 brings attribution touches"
          >
            <AttributionSummaryView rows={grid.rows} channels={channels} />
          </ChartCard>
        </section>
      )}

      <div className="flex flex-col xl:flex-row gap-4">
        <FunnelTable
          grid={grid}
          channels={channels}
          onProjectionChange={(channelId, stage, value) =>
            projectionsHook.upsert(channelId, year, periodIndexFromFilter(filter), stage, value)
          }
          onActualChange={(channelId, stage, value) =>
            actualsHook.upsert(channelId, year, periodIndexFromFilter(filter), stage, value)
          }
        />
        <ConversionsPanel totals={grid.totals} />
      </div>
    </div>
  );
}

// Editing a cell while the year filter is active is ambiguous (which quarter
// does the value go to?). Defaulting to Q1 in that case is wrong. We pick
// the current quarter as the write target when filter is 'year'; the user
// can switch to a specific Q to edit that quarter explicitly.
function periodIndexFromFilter(filter: PeriodFilter): 1 | 2 | 3 | 4 {
  if (filter === 'year') return currentQuarter().quarter;
  return parseInt(filter.replace('Q', ''), 10) as 1 | 2 | 3 | 4;
}
