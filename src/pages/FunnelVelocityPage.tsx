// FunnelVelocityPage — Marketing Funnel: Velocity sub-tab.
//
// Surfaces two pieces of data:
//   1. Summary cards: average + median days per boss-confirmed transition
//      (HPP→Opp and Opp→Pursuit in v1). Color-coded against the per-
//      transition thresholds in constants/velocityThresholds.ts.
//   2. Active deals table: every non-terminal deal in the selected period
//      and region, sortable by days-in-stage. Stale deals (above the
//      threshold for the next transition) are flagged.
//
// Adding a new transition card later is a two-step change:
//   - Add the transition to VELOCITY_THRESHOLDS.
//   - Mount one more <VelocityCard> below.

import { useEffect, useMemo, useState } from 'react';
import { useAttributions } from '../hooks/useAttributions';
import { useAttributionTouches } from '../hooks/useAttributionTouches';
import { useChannels } from '../hooks/useChannels';
import { useLeads } from '../hooks/useLeads';
import {
  computeChannelDistribution,
  computeDealVelocities,
  computeRegionDistribution,
  computeStageVelocityStats,
  periodBoundsFor,
  type DealVelocity,
  type PeriodFilter,
} from '../lib/compute';
import { quarterOfIsoDate } from '../lib/dates';
import PeriodSelector from '../components/funnel/PeriodSelector';
import ChartCard from '../components/charts/ChartCard';
import CampaignInfluenceView, {
  type InfluenceStatus,
} from '../components/charts/CampaignInfluenceView';
import ChannelDistributionDonut from '../components/charts/ChannelDistributionDonut';
import RegionDistributionDonut from '../components/charts/RegionDistributionDonut';
import AttributionEditorModal from '../components/attribution/AttributionEditorModal';
import {
  VELOCITY_THRESHOLDS,
  type VelocityThreshold,
} from '../constants/velocityThresholds';
import { FUNNEL_STAGE_LABELS } from '../constants/funnelStages';
import type { AttributionStageKey } from '../types/db';
import type { RegionKey } from '../constants/regions';

interface FunnelVelocityPageProps {
  year: number;
  filter: PeriodFilter;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
}

// Transitions surfaced on this page, in display order. Sourced from
// VELOCITY_THRESHOLDS (single source of truth); changes to the threshold
// map automatically reflow this list.
const TRANSITIONS: { key: string; label: string }[] = [
  { key: 'hpp->opp', label: 'HPP → Opp' },
  { key: 'opp->pursuit', label: 'Opp → Pursuit' },
];

type SortColumn =
  | 'label'
  | 'account'
  | 'region'
  | 'currentStage'
  | 'daysInCurrentStage'
  | 'daysSinceHpp'
  | 'amount';
type SortDir = 'asc' | 'desc';

function fmtMoney(v: number | null): string {
  if (v === null) return '—';
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function roundOne(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

// True when a deal has at least one stage transition in the selected
// period. Replaces the prior cohort filter (which only matched deals
// whose HPP landed in the period); the new semantic includes a deal
// that originated in a prior year but is still moving through stages
// in the current view. Mirrors dealMatchesPeriod in compute.ts.
function matchesPeriodForDeal(
  d: DealVelocity,
  year: number,
  filter: PeriodFilter,
): boolean {
  if (d.stageEnteredAts.length === 0) return false;
  const period = periodBoundsFor(year, filter);
  for (const iso of d.stageEnteredAts) {
    if (iso >= period.start && iso <= period.end) return true;
  }
  return false;
}

// Bucket avg into green / yellow / red against the threshold pair. When
// typical == stale (boss-confirmed pattern in v1), the yellow zone has
// zero width and the result collapses to binary green/red.
function colorClass(
  avg: number | null,
  threshold: VelocityThreshold,
): string {
  if (avg === null) return 'text-charcoal';
  if (avg <= threshold.typical) return 'text-success';
  if (avg <= threshold.stale) return 'text-warning';
  return 'text-danger';
}

export default function FunnelVelocityPage({
  year,
  filter,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
}: FunnelVelocityPageProps) {
  const attributionsHook = useAttributions();
  const touchesHook = useAttributionTouches();
  const channels = useChannels();
  // Pull leads only to derive yearOptions consistently with the other
  // funnel sub-pages; the velocity compute itself doesn't read leads.
  const { leads } = useLeads();

  const yearOptions = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const l of leads) {
      const sourced = quarterOfIsoDate(l.marketing_sourced_date);
      if (sourced) years.add(sourced.year);
    }
    for (const a of attributionsHook.attributions) {
      years.add(a.year);
    }
    return [...years].sort((a, b) => a - b);
  }, [leads, attributionsHook.attributions]);

  // All velocities, filtered only by region. Period filtering applies to
  // the active deals table below but NOT to the summary cards: averages
  // mean more across the full sample of measured transitions.
  const velocities = useMemo(
    () =>
      computeDealVelocities({
        attributions: attributionsHook.attributions,
        regions,
      }),
    [attributionsHook.attributions, regions],
  );

  const stats = useMemo(
    () => computeStageVelocityStats(velocities),
    [velocities],
  );
  const statsByKey = useMemo(() => {
    const m = new Map<string, (typeof stats)[number]>();
    for (const s of stats) m.set(s.transitionKey, s);
    return m;
  }, [stats]);

  // Region distribution for the "Deals by Region" donut card. The donut
  // is a distribution view: it respects the period filter (so the user
  // can see Q1 vs Q2 vs YTD) but intentionally ignores the region
  // toggles. `regions` is therefore NOT in this useMemo's deps.
  const regionDistribution = useMemo(
    () =>
      computeRegionDistribution({
        attributions: attributionsHook.attributions,
        year,
        filter,
      }),
    [attributionsHook.attributions, year, filter],
  );

  // Channel distribution: same period-yes, region-no contract as the
  // region donut. Uses the full channels list (not visibleChannels)
  // so cross-year attribution references still resolve to real names
  // instead of landing in Unknown — the donut's deal scope already
  // spans cross-year cases, so name lookup needs the same breadth.
  const channelDistribution = useMemo(
    () =>
      computeChannelDistribution({
        attributions: attributionsHook.attributions,
        channels,
        year,
        filter,
      }),
    [attributionsHook.attributions, channels, year, filter],
  );

  // Active deals table source: non-terminal, in the selected period.
  const activeDeals = useMemo(() => {
    return velocities.filter(
      (v) => !v.isTerminal && matchesPeriodForDeal(v, year, filter),
    );
  }, [velocities, year, filter]);

  // Opportunity Influence filters. Two independent multi-select axes
  // above the existing Region/Channel rows owned by the view. Both
  // default to "all on" (every available year, every status), which
  // is equivalent to the old single-tab 'all' option. Empty set on
  // either axis is treated as "no filter on that axis" (mirrors the
  // empty-set semantics the Region row already uses).
  const allYearsSet = useMemo(() => new Set<number>(yearOptions), [yearOptions]);
  const [influenceYears, setInfluenceYears] = useState<Set<number>>(
    () => new Set<number>(yearOptions),
  );
  // Re-anchor the year set to the available years whenever yearOptions
  // changes (new data brings a new year into view). Keeps the
  // "default = all on" contract without trapping the user on a stale
  // selection.
  useEffect(() => {
    setInfluenceYears(new Set<number>(yearOptions));
  }, [yearOptions]);
  const [influenceStatuses, setInfluenceStatuses] = useState<
    Set<InfluenceStatus>
  >(() => new Set<InfluenceStatus>(['open', 'closeWon', 'closeLost']));

  const [sortCol, setSortCol] = useState<SortColumn>('daysInCurrentStage');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Active deals table's inline Edit button opens AttributionEditorModal
  // against the deal's current-stage row. Auto-replace semantics: a
  // second Edit click while the modal is open swaps to the new deal
  // (the same single-modal pattern Data Entry uses).
  const [editingAttributionId, setEditingAttributionId] = useState<
    string | null
  >(null);
  const onEditDeal = (currentAttributionId: string) => {
    setEditingAttributionId(currentAttributionId);
  };

  const sortedDeals = useMemo(() => {
    const copy = activeDeals.slice();
    const dir = sortDir === 'asc' ? 1 : -1;
    copy.sort((a, b) => {
      const cmp = compareDeals(a, b, sortCol);
      return cmp * dir;
    });
    return copy;
  }, [activeDeals, sortCol, sortDir]);

  const onHeaderClick = (col: SortColumn) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      // Days columns default to descending (stalest first); text columns
      // default to ascending.
      setSortDir(
        col === 'daysInCurrentStage' ||
          col === 'daysSinceHpp' ||
          col === 'amount'
          ? 'desc'
          : 'asc',
      );
    }
  };

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            Marketing Funnel: Opportunities
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            Per-transition velocity averages and per-deal time-in-stage.
            Active deals are scoped to the selected period and region.
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

      {/* Summary section: two rows. Top row = velocity numbers, bottom
          row = distribution donuts. Both rows go 1-col on mobile and
          2-col on lg+ so the four cards form a 2x2 grid on desktop. */}
      <section className="space-y-4">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {TRANSITIONS.map((t) => {
            const s = statsByKey.get(t.key);
            const threshold = VELOCITY_THRESHOLDS[t.key];
            return (
              <VelocityCard
                key={t.key}
                label={t.label}
                average={s?.average ?? null}
                median={s?.median ?? null}
                count={s?.count ?? 0}
                threshold={threshold}
              />
            );
          })}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard
            title="Open Opportunities by Region (HPP, OPP, Pursuit)"
            subtitle="Open opportunities only (HPP, OPP, Pursuit). Excludes closed-won and closed-lost. Region filter does not apply."
          >
            <RegionDistributionDonut distribution={regionDistribution} />
          </ChartCard>
          <ChartCard
            title="Open Opportunities by Channel (HPP, OPP, Pursuit)"
            subtitle="Open opportunities only (HPP, OPP, Pursuit) for the selected period, grouped by top-level channel."
          >
            <ChannelDistributionDonut distribution={channelDistribution} />
          </ChartCard>
        </div>
      </section>

      {/* Opportunity Influence — one Sankey per deal, showing the
          full touch flow into the deal's stage chain. This section
          owns its own Region + Channel filters so the user can
          narrow the influence view without disturbing the velocity
          cards, donuts, or Active Deals table below (which still
          read the page-level Region toggle). */}
      <ChartCard
        title="Opportunity Influence"
        subtitle="Every deal's full touch flow. Use the filters below to narrow this section."
      >
        <div className="space-y-3">
          <InfluenceYearStatusFilters
            yearOptions={yearOptions}
            years={influenceYears}
            statuses={influenceStatuses}
            allYearsSet={allYearsSet}
            onYearsChange={setInfluenceYears}
            onStatusesChange={setInfluenceStatuses}
          />
          <CampaignInfluenceView
            attributions={attributionsHook.attributions}
            attributionTouches={touchesHook.touches}
            // Full channels list so cross-year attribution references
            // (e.g. a 2026 HPP attributed to a 2025 channel) still
            // resolve to a real name instead of "Unknown".
            channels={channels}
            yearFilter={influenceYears}
            statusFilter={influenceStatuses}
            allYearsSet={allYearsSet}
            // Reuse the Active deals edit handler + the already-mounted
            // AttributionEditorModal so close-lost deals can be opened and
            // their lost reason set from here.
            onEditDeal={onEditDeal}
          />
        </div>
      </ChartCard>

      {/* Active deals table */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-charcoal">
          Active deals ({sortedDeals.length})
        </h2>
        {sortedDeals.length === 0 ? (
          <p className="text-sm text-slate-muted italic px-4 py-6 border border-border rounded bg-muted/40">
            No active deals in the selected period. Create one from the
            Data Entry tab.
          </p>
        ) : (
          <div className="border border-border rounded overflow-x-auto bg-bg">
            <table className="min-w-full text-sm">
              <thead className="bg-muted text-xs text-slate-muted uppercase tracking-wide">
                <tr>
                  <Th col="label" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>
                    Deal
                  </Th>
                  <Th col="account" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>
                    Account
                  </Th>
                  <Th col="region" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>
                    Region
                  </Th>
                  <Th col="currentStage" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>
                    Current stage
                  </Th>
                  <Th col="daysInCurrentStage" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>
                    Days in current stage
                  </Th>
                  <Th col="daysSinceHpp" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>
                    Days since HPP
                  </Th>
                  <Th col="amount" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>
                    Amount
                  </Th>
                </tr>
              </thead>
              <tbody>
                {sortedDeals.map((d, i) => (
                  <tr
                    key={d.dealId}
                    className={i % 2 === 0 ? 'bg-bg' : 'bg-muted/40'}
                  >
                    <td className="px-3 py-2 text-charcoal">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onEditDeal(d.currentAttributionId)}
                          title="Edit deal"
                          aria-label="Edit deal"
                          className="inline-flex items-center justify-center w-6 h-6 rounded text-slate-muted hover:bg-muted hover:text-charcoal flex-shrink-0"
                        >
                          <span className="text-sm">✎</span>
                        </button>
                        {d.sfLink ? (
                          <a
                            href={d.sfLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-indigo hover:underline truncate"
                            title="Open in Salesforce"
                          >
                            {d.label}
                          </a>
                        ) : (
                          <span
                            className="text-charcoal truncate"
                            title="No Salesforce link"
                          >
                            {d.label}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-muted">
                      {d.account ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-muted">
                      {d.region ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-charcoal">
                      {FUNNEL_STAGE_LABELS[d.currentStage as AttributionStageKey]}
                    </td>
                    <td
                      className={
                        'px-3 py-2 ' +
                        (d.isStale ? 'text-danger font-medium' : 'text-charcoal')
                      }
                    >
                      {d.isStale ? '🚩 ' : ''}
                      {d.daysInCurrentStage}
                    </td>
                    <td className="px-3 py-2 text-charcoal">
                      {d.daysSinceHpp === null ? '—' : d.daysSinceHpp}
                    </td>
                    <td className="px-3 py-2 text-charcoal">
                      {fmtMoney(d.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editingAttributionId && (
        <AttributionEditorModal
          attributionId={editingAttributionId}
          channels={channels}
          attributionsHook={attributionsHook}
          touchesHook={touchesHook}
          onClose={() => setEditingAttributionId(null)}
        />
      )}
    </div>
  );
}

// Year + Status filter rows above the Opportunity Influence card
// list. Two independent multi-selects styled to match the Region
// pill row below (matches Sara's spec). Empty set on either axis
// is treated as "no filter on that axis" — same semantics the
// Region row already uses.
const STATUS_OPTIONS: { key: InfluenceStatus; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'closeWon', label: 'Close-Won' },
  { key: 'closeLost', label: 'Close-Lost' },
];

function InfluenceYearStatusFilters({
  yearOptions,
  years,
  statuses,
  allYearsSet,
  onYearsChange,
  onStatusesChange,
}: {
  yearOptions: number[];
  years: Set<number>;
  statuses: Set<InfluenceStatus>;
  allYearsSet: Set<number>;
  onYearsChange: (next: Set<number>) => void;
  onStatusesChange: (next: Set<InfluenceStatus>) => void;
}) {
  const toggleYear = (y: number) => {
    const next = new Set(years);
    if (next.has(y)) next.delete(y);
    else next.add(y);
    onYearsChange(next);
  };
  const toggleStatus = (s: InfluenceStatus) => {
    const next = new Set(statuses);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onStatusesChange(next);
  };
  const clearYears = () => onYearsChange(new Set(allYearsSet));
  const clearStatuses = () =>
    onStatusesChange(
      new Set<InfluenceStatus>(['open', 'closeWon', 'closeLost']),
    );

  return (
    <div className="pl-3 border-l-2 border-border space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-slate-muted mr-1 w-14">Year</span>
        <button
          type="button"
          onClick={clearYears}
          className="text-xs px-2 py-1 rounded-full border border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30"
        >
          Clear
        </button>
        {yearOptions.map((y) => {
          const on = years.has(y);
          const cls = on
            ? 'bg-indigo text-white border-indigo'
            : 'bg-bg text-charcoal border-border hover:border-charcoal/30';
          return (
            <button
              key={y}
              type="button"
              onClick={() => toggleYear(y)}
              className={`text-xs px-2 py-1 rounded-full border transition-colors ${cls}`}
              aria-pressed={on}
            >
              {y}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-xs text-slate-muted mr-1 w-14">Status</span>
        <button
          type="button"
          onClick={clearStatuses}
          className="text-xs px-2 py-1 rounded-full border border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30"
        >
          Clear
        </button>
        {STATUS_OPTIONS.map((opt) => {
          const on = statuses.has(opt.key);
          const cls = on
            ? 'bg-indigo text-white border-indigo'
            : 'bg-bg text-charcoal border-border hover:border-charcoal/30';
          return (
            <button
              key={opt.key}
              type="button"
              onClick={() => toggleStatus(opt.key)}
              className={`text-xs px-2 py-1 rounded-full border transition-colors ${cls}`}
              aria-pressed={on}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function VelocityCard({
  label,
  average,
  median,
  count,
  threshold,
}: {
  label: string;
  average: number | null;
  median: number | null;
  count: number;
  threshold: VelocityThreshold;
}) {
  const avgColor = colorClass(average, threshold);
  return (
    <div className="border border-border rounded bg-bg p-4 space-y-1">
      <div className="text-xs text-slate-muted uppercase tracking-wide">
        {label}
      </div>
      {count === 0 ? (
        <div className="text-3xl font-semibold text-slate-muted">—</div>
      ) : (
        <div className={`text-3xl font-semibold ${avgColor}`}>
          {roundOne(average ?? 0)} <span className="text-base font-normal text-slate-muted">days avg</span>
        </div>
      )}
      <div className="text-xs text-slate-muted">
        {count === 0
          ? 'No deals measured yet'
          : `Median ${median === null ? '—' : roundOne(median)} days · ${count} deal${count === 1 ? '' : 's'} measured`}
      </div>
      <div className="text-xs text-slate-muted">
        Stale threshold: {threshold.stale} days
      </div>
    </div>
  );
}

function Th({
  col,
  sortCol,
  sortDir,
  onClick,
  children,
}: {
  col: SortColumn;
  sortCol: SortColumn;
  sortDir: SortDir;
  onClick: (col: SortColumn) => void;
  children: React.ReactNode;
}) {
  const active = col === sortCol;
  return (
    <th
      onClick={() => onClick(col)}
      className="px-3 py-2 text-left font-medium cursor-pointer select-none hover:text-charcoal"
    >
      <span className={active ? 'text-charcoal' : ''}>{children}</span>
      {active && (
        <span className="ml-1 text-charcoal">
          {sortDir === 'asc' ? '↑' : '↓'}
        </span>
      )}
    </th>
  );
}

function compareDeals(
  a: DealVelocity,
  b: DealVelocity,
  col: SortColumn,
): number {
  const nullsLast = (av: number | null, bv: number | null): number => {
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv;
  };
  switch (col) {
    case 'label':
      return a.label.localeCompare(b.label);
    case 'account':
      return (a.account ?? '').localeCompare(b.account ?? '');
    case 'region':
      return (a.region ?? '').localeCompare(b.region ?? '');
    case 'currentStage':
      return a.currentStage.localeCompare(b.currentStage);
    case 'daysInCurrentStage':
      return a.daysInCurrentStage - b.daysInCurrentStage;
    case 'daysSinceHpp':
      return nullsLast(a.daysSinceHpp, b.daysSinceHpp);
    case 'amount':
      return nullsLast(a.amount, b.amount);
  }
}
