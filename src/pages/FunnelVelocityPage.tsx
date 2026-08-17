import { useMemo, useState } from 'react';
import { useAttributions } from '../hooks/useAttributions';
import { useAttributionTouches } from '../hooks/useAttributionTouches';
import { useChannels } from '../hooks/useChannels';
import { useLeads } from '../hooks/useLeads';
import {
  computeStageVelocityStats,
  type DealVelocity,
  type PeriodFilter,
} from '../lib/compute';
import {
  buildOpportunityDistributions,
  scopeOpportunityDeals,
  summarizeOpenPipeline,
  type OpportunityStatusFilter,
} from '../lib/opportunityPageReporting';
import { quarterOfIsoDate } from '../lib/dates';
import { formatCurrency } from '../lib/formatters';
import FunnelReportingFilters from '../components/funnel/FunnelReportingFilters';
import FilterChipGroup from '../components/reporting/FilterChipGroup';
import ChartCard from '../components/charts/ChartCard';
import CampaignInfluenceView from '../components/charts/CampaignInfluenceView';
import ChannelDistributionDonut from '../components/charts/ChannelDistributionDonut';
import RegionDistributionDonut from '../components/charts/RegionDistributionDonut';
import AttributionEditorModal from '../components/attribution/AttributionEditorModal';
import {
  VELOCITY_THRESHOLDS,
  type VelocityThreshold,
} from '../constants/velocityThresholds';
import { FUNNEL_STAGE_LABELS } from '../constants/funnelStages';
import { REGIONS, type RegionKey } from '../constants/regions';
import type { AttributionStageKey } from '../types/db';
import type { ComparisonMode } from '../types/reporting';
import ReportingBasisDisclosure from '../components/reporting/ReportingBasisDisclosure';
import { reportingContractFor } from '../constants/reportingPages';

interface FunnelVelocityPageProps {
  year: number;
  filter: PeriodFilter;
  onYearChange: (year: number) => void;
  onFilterChange: (filter: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
  comparison: ComparisonMode;
  onComparisonChange: (mode: ComparisonMode) => void;
}

type OpportunityView = 'current' | 'movement';
type SortColumn =
  | 'label'
  | 'account'
  | 'region'
  | 'currentStage'
  | 'daysInCurrentStage'
  | 'daysSinceHpp'
  | 'amount';
type SortDir = 'asc' | 'desc';

const REPORTING_BASIS = reportingContractFor('funnel-velocity')!;
const REGION_CHIPS = REGIONS.map((region) => ({ value: region, label: region }));
const STATUS_OPTIONS: Array<{ value: OpportunityStatusFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
  { value: 'all', label: 'All' },
];
const TRANSITIONS = [
  { key: 'hpp->opp', label: 'HPP to Opp' },
  { key: 'opp->pursuit', label: 'Opp to Pursuit' },
];

function compactCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return formatCurrency(value);
}

function roundOne(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

function periodLabel(year: number, filter: PeriodFilter): string {
  return filter === 'year' ? String(year) : `${filter} ${year}`;
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
  const { leads } = useLeads();
  const [view, setView] = useState<OpportunityView>('current');
  const [status, setStatus] = useState<OpportunityStatusFilter>('open');
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortColumn>('daysInCurrentStage');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [editingAttributionId, setEditingAttributionId] = useState<string | null>(null);
  const [influenceDealId, setInfluenceDealId] = useState<string | null>(null);

  const yearOptions = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const lead of leads) {
      const sourced = quarterOfIsoDate(lead.marketing_sourced_date);
      if (sourced) years.add(sourced.year);
    }
    for (const attribution of attributionsHook.attributions) years.add(attribution.year);
    return [...years].sort((a, b) => a - b);
  }, [leads, attributionsHook.attributions]);

  const allRegionDeals = useMemo(
    () => scopeOpportunityDeals({ attributions: attributionsHook.attributions, regions }),
    [attributionsHook.attributions, regions],
  );
  const movementDeals = useMemo(
    () =>
      scopeOpportunityDeals({
        attributions: attributionsHook.attributions,
        regions,
        period: { year, filter },
      }),
    [attributionsHook.attributions, regions, year, filter],
  );
  const currentOpenDeals = useMemo(
    () => allRegionDeals.filter((deal) => !deal.isTerminal),
    [allRegionDeals],
  );
  const movementOpenDeals = useMemo(
    () => movementDeals.filter((deal) => !deal.isTerminal),
    [movementDeals],
  );
  const pipelineSummary = useMemo(
    () => summarizeOpenPipeline(currentOpenDeals),
    [currentOpenDeals],
  );
  const chartDeals = view === 'current' ? currentOpenDeals : movementOpenDeals;
  const distributions = useMemo(
    () =>
      buildOpportunityDistributions({
        deals: chartDeals,
        attributions: attributionsHook.attributions,
        channels,
      }),
    [chartDeals, attributionsHook.attributions, channels],
  );
  const velocityStats = useMemo(
    () => computeStageVelocityStats(allRegionDeals, { year, filter }),
    [allRegionDeals, year, filter],
  );
  const statsByKey = useMemo(
    () => new Map(velocityStats.map((stat) => [stat.transitionKey, stat])),
    [velocityStats],
  );

  const tableBase = view === 'current' ? allRegionDeals : movementDeals;
  const visibleDeals = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = tableBase.filter((deal) => {
      const statusMatch =
        status === 'all' ||
        (status === 'open' && !deal.isTerminal) ||
        (status === 'won' && deal.currentStage === 'closeWon') ||
        (status === 'lost' && deal.currentStage === 'closeLost');
      if (!statusMatch) return false;
      if (!query) return true;
      return deal.label.toLowerCase().includes(query) || (deal.account ?? '').toLowerCase().includes(query);
    });
    const direction = sortDir === 'asc' ? 1 : -1;
    return filtered.sort((left, right) => compareDeals(left, right, sortCol) * direction);
  }, [tableBase, status, search, sortCol, sortDir]);

  const influenceDeal = influenceDealId
    ? allRegionDeals.find((deal) => deal.dealId === influenceDealId) ?? null
    : null;
  const allYears = useMemo(() => new Set(yearOptions), [yearOptions]);

  const toggleRegion = (region: RegionKey) => {
    const next = new Set(regions);
    if (next.has(region)) next.delete(region);
    else next.add(region);
    onRegionsChange(next);
  };
  const onHeaderClick = (column: SortColumn) => {
    if (sortCol === column) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortCol(column);
    setSortDir(
      column === 'daysInCurrentStage' || column === 'daysSinceHpp' || column === 'amount'
        ? 'desc'
        : 'asc',
    );
  };

  return (
    <div className="min-h-full bg-gradient-to-b from-muted/80 via-bg to-bg p-4 sm:p-6 xl:p-8">
      <div className="mx-auto max-w-[1800px] space-y-5">
        <header className="relative overflow-hidden rounded-2xl border border-border bg-bg shadow-sm">
          <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo via-teal to-success" />
          <div className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-indigo/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo">Pipeline analytics</span>
              <ReportingBasisDisclosure basis={REPORTING_BASIS.basis} showExplanation={false} variant="accent" />
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-charcoal">Marketing Funnel: Opportunities</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-muted">Monitor the current pipeline, stage movement, and opportunity influence from one workspace.</p>
          </div>
          <div className="border-t border-border bg-muted/25 p-4 sm:px-6 sm:py-5">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Reporting view</p>
                <h2 className="mt-1 text-base font-semibold text-charcoal">{view === 'current' ? 'Current pipeline' : 'Movement and velocity'}</h2>
              </div>
              <div className="inline-flex rounded-lg border border-border bg-bg p-1" role="group" aria-label="Opportunity reporting view">
                <ViewButton active={view === 'current'} onClick={() => setView('current')}>Current pipeline</ViewButton>
                <ViewButton active={view === 'movement'} onClick={() => setView('movement')}>Movement and velocity</ViewButton>
              </div>
            </div>
            {view === 'current' ? (
              <div className="space-y-3">
                <FilterChipGroup
                  label="Commercial region"
                  chips={REGION_CHIPS}
                  selected={[...regions]}
                  onToggle={toggleRegion}
                  onClear={() => onRegionsChange(new Set<RegionKey>())}
                  onSelectAll={() => onRegionsChange(new Set(REGIONS))}
                />
                <p className="text-xs text-slate-muted">Current pipeline includes every open opportunity in the selected regions, regardless of when it was created.</p>
              </div>
            ) : (
              <FunnelReportingFilters
                year={year}
                filter={filter}
                yearOptions={yearOptions}
                onYearChange={onYearChange}
                onFilterChange={onFilterChange}
                regions={regions}
                onRegionsChange={onRegionsChange}
                showComparison={false}
              />
            )}
          </div>
        </header>

        {view === 'current' ? (
          <section aria-labelledby="pipeline-snapshot-title" className="rounded-2xl border border-border bg-bg p-4 shadow-sm sm:p-5">
            <SectionHeading id="pipeline-snapshot-title" eyebrow="Executive pipeline" title="Current pipeline snapshot" />
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
              <MetricCard label="Open pipeline" value={compactCurrency(pipelineSummary.totalAmount)} accent="indigo" />
              <MetricCard label="Open opportunities" value={String(pipelineSummary.openDeals)} accent="teal" />
              <MetricCard label="HPP (SQL)" value={String(pipelineSummary.byStage.hpp)} accent="blue" />
              <MetricCard label="Opp (SAO)" value={String(pipelineSummary.byStage.opp)} accent="purple" />
              <MetricCard label="Pursuit" value={String(pipelineSummary.byStage.pursuit)} accent="orange" />
            </div>
          </section>
        ) : (
          <section aria-labelledby="velocity-title" className="rounded-2xl border border-border bg-bg p-4 shadow-sm sm:p-5">
            <SectionHeading id="velocity-title" eyebrow="Stage movement" title={`Velocity for ${periodLabel(year, filter)}`} />
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              {TRANSITIONS.map((transition) => {
                const stat = statsByKey.get(transition.key);
                return (
                  <VelocityCard
                    key={transition.key}
                    label={transition.label}
                    average={stat?.average ?? null}
                    median={stat?.median ?? null}
                    count={stat?.count ?? 0}
                    invalidCount={stat?.invalidCount ?? 0}
                    threshold={VELOCITY_THRESHOLDS[transition.key]}
                  />
                );
              })}
            </div>
          </section>
        )}

        <section aria-labelledby="pipeline-mix-title" className="rounded-2xl border border-border bg-bg p-4 shadow-sm sm:p-5">
          <SectionHeading
            id="pipeline-mix-title"
            eyebrow="Pipeline mix"
            title={view === 'current' ? 'Open pipeline distribution' : `Open opportunities moving in ${periodLabel(year, filter)}`}
          />
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="By commercial region" subtitle="Distinct open opportunities in the reporting view." className="shadow-none">
              <RegionDistributionDonut distribution={distributions.regionDistribution} />
            </ChartCard>
            <ChartCard title="By attributed channel" subtitle="Distinct open opportunities grouped by their approved top-level channel." className="shadow-none">
              <ChannelDistributionDonut distribution={distributions.channelDistribution} />
            </ChartCard>
          </div>
        </section>

        <section aria-labelledby="opportunity-explorer-title" className="rounded-2xl border border-border bg-bg p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
            <SectionHeading id="opportunity-explorer-title" eyebrow="Opportunity detail" title="Opportunity explorer" />
            <span className="text-xs text-slate-muted">{visibleDeals.length} of {tableBase.length} opportunities</span>
          </div>
          <div className="my-4 flex flex-wrap items-end gap-3">
            <label className="flex min-w-[260px] flex-1 flex-col gap-1 text-xs font-medium text-slate-muted">
              Search
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Opportunity or account" className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-charcoal outline-none focus:ring-2 focus:ring-indigo/30" />
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-slate-muted">Status</span>
              <div className="inline-flex rounded-lg border border-border bg-muted/30 p-1" role="group" aria-label="Opportunity status">
                {STATUS_OPTIONS.map((option) => (
                  <ViewButton key={option.value} active={status === option.value} onClick={() => setStatus(option.value)}>{option.label}</ViewButton>
                ))}
              </div>
            </div>
          </div>
          {visibleDeals.length === 0 ? (
            <p className="rounded-xl border border-border bg-muted/30 px-4 py-8 text-center text-sm text-slate-muted">No opportunities match these filters.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="min-w-full text-sm">
                <thead className="bg-muted text-xs uppercase tracking-wide text-slate-muted">
                  <tr>
                    <Th col="label" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>Opportunity</Th>
                    <Th col="account" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>Account</Th>
                    <Th col="region" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>Region</Th>
                    <Th col="currentStage" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>Current stage</Th>
                    <Th col="daysInCurrentStage" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>Days in stage</Th>
                    <Th col="daysSinceHpp" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>Days since HPP</Th>
                    <Th col="amount" sortCol={sortCol} sortDir={sortDir} onClick={onHeaderClick}>SaaS revenue USD</Th>
                    <th className="px-3 py-2 text-left font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDeals.map((deal, index) => (
                    <tr key={deal.dealId} className={index % 2 === 0 ? 'bg-bg' : 'bg-muted/30'}>
                      <td className="px-3 py-3 font-medium text-charcoal">
                        {deal.sfLink ? <a href={deal.sfLink} target="_blank" rel="noopener noreferrer" className="text-indigo hover:underline">{deal.label}</a> : deal.label}
                      </td>
                      <td className="px-3 py-3 text-slate-muted">{deal.account ?? '—'}</td>
                      <td className="px-3 py-3 text-slate-muted">{deal.region ?? 'Other'}</td>
                      <td className="px-3 py-3 text-charcoal">{FUNNEL_STAGE_LABELS[deal.currentStage as AttributionStageKey]}</td>
                      <td className={`px-3 py-3 ${deal.isStale ? 'font-medium text-danger' : 'text-charcoal'}`}>{deal.daysInCurrentStage}</td>
                      <td className="px-3 py-3 text-charcoal">{deal.daysSinceHpp ?? '—'}</td>
                      <td className="px-3 py-3 text-charcoal">{formatCurrency(deal.amount, { nullDisplay: '—' })}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => setInfluenceDealId(deal.dealId)} className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-charcoal hover:border-indigo hover:text-indigo">View influence</button>
                          <button type="button" onClick={() => setEditingAttributionId(deal.currentAttributionId)} className="rounded-md border border-border px-2.5 py-1.5 text-xs text-slate-muted hover:text-charcoal">Edit</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {influenceDeal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/45 p-4" role="dialog" aria-modal="true" aria-labelledby="influence-dialog-title">
          <div className="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-2xl border border-border bg-bg shadow-xl">
            <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-bg p-5">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Opportunity influence</p>
                <h2 id="influence-dialog-title" className="mt-1 text-xl font-semibold text-charcoal">{influenceDeal.label}</h2>
                <p className="mt-1 text-sm text-slate-muted">{influenceDeal.account ?? 'Account not available'}</p>
              </div>
              <button type="button" onClick={() => setInfluenceDealId(null)} className="rounded-md border border-border px-3 py-2 text-sm text-charcoal hover:bg-muted">Close</button>
            </header>
            <div className="p-5">
              <CampaignInfluenceView
                attributions={attributionsHook.attributions}
                attributionTouches={touchesHook.touches}
                channels={channels}
                yearFilter={new Set<number>()}
                statusFilter={new Set<'open' | 'closeWon' | 'closeLost'>()}
                allYearsSet={allYears}
                dealIdFilter={influenceDeal.dealId}
                showFilters={false}
                onEditDeal={(attributionId) => setEditingAttributionId(attributionId)}
              />
            </div>
          </div>
        </div>
      )}

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

function SectionHeading({ id, eyebrow, title }: { id: string; eyebrow: string; title: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">{eyebrow}</p>
      <h2 id={id} className="mt-1 text-lg font-semibold text-charcoal">{title}</h2>
    </div>
  );
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'bg-indigo text-white shadow-sm' : 'text-slate-muted hover:text-charcoal'}`}>{children}</button>;
}

function MetricCard({ label, value, accent }: { label: string; value: string; accent: 'indigo' | 'teal' | 'blue' | 'purple' | 'orange' }) {
  const accentClass = { indigo: 'border-t-indigo', teal: 'border-t-teal', blue: 'border-t-blue-500', purple: 'border-t-purple-500', orange: 'border-t-orange-500' }[accent];
  return <div className={`rounded-xl border border-border border-t-2 ${accentClass} bg-bg p-4 shadow-sm`}><p className="text-[11px] font-semibold uppercase tracking-wide text-slate-muted">{label}</p><p className="mt-2 text-2xl font-semibold text-charcoal">{value}</p></div>;
}

function VelocityCard({ label, average, median, count, invalidCount, threshold }: { label: string; average: number | null; median: number | null; count: number; invalidCount: number; threshold: VelocityThreshold }) {
  const color = average === null ? 'text-charcoal' : average <= threshold.typical ? 'text-success' : average <= threshold.stale ? 'text-warning' : 'text-danger';
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-muted">{label}</p>
      <p className={`mt-2 text-3xl font-semibold ${color}`}>{average === null ? '—' : roundOne(average)}{average !== null && <span className="ml-1 text-base font-normal text-slate-muted">days average</span>}</p>
      <p className="mt-2 text-xs text-slate-muted">{count === 0 ? 'No valid transitions in this period' : `Median ${median === null ? '—' : roundOne(median)} days · ${count} transition${count === 1 ? '' : 's'}`}</p>
      {invalidCount > 0 && <p className="mt-1 text-xs text-warning">{invalidCount} contradictory date interval{invalidCount === 1 ? '' : 's'} excluded</p>}
    </div>
  );
}

function Th({ col, sortCol, sortDir, onClick, children }: { col: SortColumn; sortCol: SortColumn; sortDir: SortDir; onClick: (column: SortColumn) => void; children: React.ReactNode }) {
  const active = col === sortCol;
  return <th onClick={() => onClick(col)} className="cursor-pointer select-none px-3 py-2 text-left font-medium hover:text-charcoal"><span className={active ? 'text-charcoal' : ''}>{children}</span>{active && <span className="ml-1 text-charcoal">{sortDir === 'asc' ? '↑' : '↓'}</span>}</th>;
}

function compareDeals(left: DealVelocity, right: DealVelocity, column: SortColumn): number {
  const nullsLast = (leftValue: number | null, rightValue: number | null): number => {
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return leftValue - rightValue;
  };
  if (column === 'label') return left.label.localeCompare(right.label);
  if (column === 'account') return (left.account ?? '').localeCompare(right.account ?? '');
  if (column === 'region') return (left.region ?? '').localeCompare(right.region ?? '');
  if (column === 'currentStage') return left.currentStage.localeCompare(right.currentStage);
  if (column === 'daysInCurrentStage') return left.daysInCurrentStage - right.daysInCurrentStage;
  if (column === 'daysSinceHpp') return nullsLast(left.daysSinceHpp, right.daysSinceHpp);
  return nullsLast(left.amount, right.amount);
}
