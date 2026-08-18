import { useMemo, useState } from 'react';
import { useAttributions } from '../hooks/useAttributions';
import { useAttributionTouches } from '../hooks/useAttributionTouches';
import { useChannels } from '../hooks/useChannels';
import { useLeads } from '../hooks/useLeads';
import {
  computeStageVelocityStats,
  type PeriodFilter,
} from '../lib/compute';
import {
  buildOpportunityDistributions,
  buildOpportunityExplorerRows,
  filterOpportunityExplorerRows,
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
import {
  VELOCITY_THRESHOLDS,
  type VelocityThreshold,
} from '../constants/velocityThresholds';
import { FUNNEL_STAGE_LABELS } from '../constants/funnelStages';
import { REGIONS, type RegionKey } from '../constants/regions';
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
  const [channelId, setChannelId] = useState('');
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

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

  const explorerBase = view === 'current' ? allRegionDeals : movementDeals;
  const explorerRows = useMemo(
    () =>
      buildOpportunityExplorerRows({
        deals: explorerBase,
        attributions: attributionsHook.attributions,
        channels,
      }),
    [explorerBase, attributionsHook.attributions, channels],
  );
  const channelOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of explorerRows) byId.set(row.channelId, row.channelName);
    return [...byId.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [explorerRows]);
  const visibleRows = useMemo(
    () =>
      filterOpportunityExplorerRows({
        rows: explorerRows,
        status,
        search,
        channelId: channelId || null,
      }),
    [explorerRows, status, search, channelId],
  );
  const requestedIndex = visibleRows.findIndex(
    (row) => row.deal.dealId === selectedDealId,
  );
  const selectedIndex = requestedIndex >= 0 ? requestedIndex : 0;
  const selectedRow = visibleRows[selectedIndex] ?? null;
  const selectedDeal = selectedRow?.deal ?? null;
  const allYears = useMemo(() => new Set(yearOptions), [yearOptions]);

  const toggleRegion = (region: RegionKey) => {
    const next = new Set(regions);
    if (next.has(region)) next.delete(region);
    else next.add(region);
    onRegionsChange(next);
  };
  const selectAdjacentDeal = (offset: number) => {
    if (visibleRows.length === 0) return;
    const nextIndex =
      (selectedIndex + offset + visibleRows.length) % visibleRows.length;
    setSelectedDealId(visibleRows[nextIndex].deal.dealId);
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
            <div>
              <SectionHeading id="opportunity-explorer-title" eyebrow="Opportunity journeys" title="Journey explorer" />
              <p className="mt-1 text-sm text-slate-muted">Select one opportunity to see its source influence and stage path.</p>
            </div>
            <span className="text-xs text-slate-muted">{visibleRows.length} of {explorerRows.length} opportunities</span>
          </div>

          <div className="my-4 grid gap-3 lg:grid-cols-[minmax(240px,1fr)_auto_minmax(190px,0.6fr)] lg:items-end">
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-muted">
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
            <label className="flex flex-col gap-1 text-xs font-medium text-slate-muted">
              Attributed channel
              <select value={channelId} onChange={(event) => setChannelId(event.target.value)} className="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-charcoal outline-none focus:ring-2 focus:ring-indigo/30">
                <option value="">All channels</option>
                {channelOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
              </select>
            </label>
          </div>

          {selectedDeal && selectedRow ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-muted/25 p-4">
                <label className="flex min-w-[280px] flex-1 flex-col gap-1 text-xs font-medium text-slate-muted">
                  Opportunity
                  <select value={selectedDeal.dealId} onChange={(event) => setSelectedDealId(event.target.value)} className="rounded-lg border border-border bg-bg px-3 py-2 text-sm font-medium text-charcoal outline-none focus:ring-2 focus:ring-indigo/30">
                    {visibleRows.map((row) => <option key={row.deal.dealId} value={row.deal.dealId}>{row.deal.label} · {row.deal.account ?? 'Account not available'}</option>)}
                  </select>
                </label>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => selectAdjacentDeal(-1)} disabled={visibleRows.length < 2} className="rounded-lg border border-border bg-bg px-3 py-2 text-sm font-medium text-charcoal hover:border-indigo disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
                  <span className="min-w-[72px] text-center text-xs text-slate-muted">{selectedIndex + 1} of {visibleRows.length}</span>
                  <button type="button" onClick={() => selectAdjacentDeal(1)} disabled={visibleRows.length < 2} className="rounded-lg border border-border bg-bg px-3 py-2 text-sm font-medium text-charcoal hover:border-indigo disabled:cursor-not-allowed disabled:opacity-40">Next</button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <JourneyFact label="Opportunity" className="sm:col-span-2">
                  {selectedDeal.sfLink ? <a href={selectedDeal.sfLink} target="_blank" rel="noopener noreferrer" className="text-indigo hover:underline">{selectedDeal.label} ↗</a> : selectedDeal.label}
                </JourneyFact>
                <JourneyFact label="Account">{selectedDeal.account ?? 'Not available'}</JourneyFact>
                <JourneyFact label="Current stage">{FUNNEL_STAGE_LABELS[selectedDeal.currentStage]}</JourneyFact>
                <JourneyFact label="SaaS revenue USD">{formatCurrency(selectedDeal.amount, { nullDisplay: '—' })}</JourneyFact>
                <JourneyFact label="Attributed channel">{selectedRow.channelName}</JourneyFact>
              </div>

              <div className="rounded-xl border border-border bg-bg p-3 sm:p-4">
                <CampaignInfluenceView
                  attributions={attributionsHook.attributions}
                  attributionTouches={touchesHook.touches}
                  channels={channels}
                  yearFilter={new Set<number>()}
                  statusFilter={new Set<'open' | 'closeWon' | 'closeLost'>()}
                  allYearsSet={allYears}
                  dealIdFilter={selectedDeal.dealId}
                  showFilters={false}
                />
              </div>

              <div className="border-t border-border pt-4">
                <button type="button" aria-expanded={browseOpen} onClick={() => setBrowseOpen((current) => !current)} className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-charcoal hover:border-indigo hover:text-indigo">{browseOpen ? 'Hide opportunity list' : `Browse all ${visibleRows.length} opportunities`}</button>
                {browseOpen && (
                  <div className="mt-3 max-h-80 overflow-y-auto rounded-xl border border-border" role="listbox" aria-label="Available opportunities">
                    {visibleRows.map((row) => {
                      const active = row.deal.dealId === selectedDeal.dealId;
                      return (
                        <button key={row.deal.dealId} type="button" role="option" aria-selected={active} onClick={() => setSelectedDealId(row.deal.dealId)} className={`grid w-full gap-1 border-b border-border px-4 py-3 text-left last:border-b-0 sm:grid-cols-[minmax(220px,1.5fr)_minmax(180px,1fr)_140px_140px] sm:items-center ${active ? 'bg-indigo/5' : 'bg-bg hover:bg-muted/35'}`}>
                          <span className="text-sm font-medium text-charcoal">{row.deal.label}</span>
                          <span className="text-xs text-slate-muted">{row.deal.account ?? 'Account not available'}</span>
                          <span className="text-xs text-slate-muted">{FUNNEL_STAGE_LABELS[row.deal.currentStage]}</span>
                          <span className="text-xs text-slate-muted">{row.channelName}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="rounded-xl border border-border bg-muted/30 px-4 py-8 text-center text-sm text-slate-muted">No opportunities match these filters.</p>
          )}
        </section>
      </div>
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

function JourneyFact({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border border-border bg-muted/20 p-3 ${className}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-muted">{label}</p>
      <p className="mt-1 text-sm font-medium text-charcoal">{children}</p>
    </div>
  );
}
