import { useEffect, useMemo, useState } from 'react';
import { useLeads } from '../hooks/useLeads';
import { useLeadCampaignTouches } from '../hooks/useLeadCampaignTouches';
import { useChannels } from '../hooks/useChannels';
import { descendantIds } from '../hooks/useChannelMutations';
import { useFunnelProjections } from '../hooks/useFunnelProjections';
import { useFunnelActuals } from '../hooks/useFunnelActuals';
import { useAttributions } from '../hooks/useAttributions';
import { useAttributionTouches } from '../hooks/useAttributionTouches';
import { useCampaignCosts } from '../hooks/useCampaignCosts';
import { computeGrid, type PeriodFilter } from '../lib/compute';
import { matchesRegionFilter } from '../lib/regionFilter';
import { filterChannelsByYear } from '../lib/channelFilter';
import { currentQuarter, quarterOfIsoDate } from '../lib/dates';
import type { AttributionStageKey, PeriodIndex } from '../types/db';
import type { RegionKey } from '../constants/regions';
import FunnelTable, {
  attributionCellKey,
} from '../components/funnel/FunnelTable';
import ConversionsPanel from '../components/funnel/ConversionsPanel';
import FunnelReportingFilters from '../components/funnel/FunnelReportingFilters';
import TouchDrilldownPanel from '../components/funnel/TouchDrilldownPanel';
import OpportunitiesListModal from '../components/attribution/OpportunitiesListModal';
import AttributionEditorModal from '../components/attribution/AttributionEditorModal';
import { readJson, writeJson } from '../lib/storage';
import ReportingBasisDisclosure from '../components/reporting/ReportingBasisDisclosure';
import { reportingContractFor } from '../constants/reportingPages';
import { computeFunnelConversionCohorts } from '../lib/funnelConversionCohorts';
import OpportunityQueuePanel from '../components/opportunities/OpportunityQueuePanel';
import FunnelStageSummary from '../components/funnel/FunnelStageSummary';

const EDITS_LOCKED_STORAGE_KEY = 'sourced.funnel.editsLocked';

interface FunnelDataEntryPageProps {
  year: number;
  filter: PeriodFilter;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
}

interface TouchDrilldownQuery {
  channelId: string;
  stage: 'lead' | 'mql';
}

interface ListModalQuery {
  // The clicked row's channel id (parent or leaf). Used as the
  // header's channel label and as the single-channel filter when
  // channelIds is undefined (leaf-row case).
  channelId: string;
  stage: AttributionStageKey;
  // Set when the click came from a parent row. Contains the parent's
  // own id plus every descendant id at any depth; the listAttributions
  // filter switches to set-membership so the modal sums across
  // sub-channels — mirroring what the grid cell rendered.
  channelIds?: string[];
}

// Basis and anchor come from the single reporting-page registry, so the
// visible disclosure and the declared contract cannot disagree.
const REPORTING_BASIS = reportingContractFor('funnel-data')!;

export default function FunnelDataEntryPage({
  year,
  filter,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
}: FunnelDataEntryPageProps) {
  const { leads } = useLeads();
  const { touches } = useLeadCampaignTouches();
  const channels = useChannels();
  const projectionsHook = useFunnelProjections();
  const actualsHook = useFunnelActuals();
  const attributionsHook = useAttributions();
  const touchesHook = useAttributionTouches();
  // Used only to widen the year selector below so a year that has a
  // budget but no leads still shows up in the dropdown.
  const costsHook = useCampaignCosts();

  const yearOptions = useMemo(() => {
    // Unified derivation: any year touched by a lead, attribution,
    // budget, actual, or projection surfaces in the dropdown. Lets
    // historical-year backfills (e.g. 2025 pre-Sourced lead/MQL
    // actuals seeded via funnel_actuals) be reachable here.
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

  const periodIndex = periodIndexFromFilter(filter);

  // Year-filtered channels feed the grid + table. Modals keep using
  // the full channel list so their ChannelSelect can apply its own
  // per-stage-date filter; channelById (used for resolving names in
  // OpportunitiesListModal) also reads the full set so historical
  // deals still resolve names regardless of year tag.
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

  // parent map keyed by child id: id → parent id. Drives the
  // ancestor walk in attributionsByCell so a leaf-channel attribution
  // also increments every ancestor's cell, giving parent rows a
  // clickable badge that matches the rolled-up grid count.
  const parentByChild = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of channels) m.set(c.id, c.parent_channel_id ?? null);
    return m;
  }, [channels]);

  // Per-cell attribution counts for the active period. Keys match what the
  // FunnelTable's RowCells looks up via attributionCellKey(channelId, stage).
  // Parent rows accumulate their descendants' counts via an ancestor walk
  // so clicking a parent cell opens the same rollup the grid is showing.
  const attributionsByCell = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of attributionsHook.attributions) {
      if (!a.channel_id) continue;
      if (a.year !== year) continue;
      // When viewing 'year' filter, count attributions across all quarters.
      if (filter !== 'year' && `Q${a.period_index}` !== filter) continue;
      // Region filter matches the ACT column in computeGrid so the
      // per-row badges always reconcile with their cell value.
      if (!matchesRegionFilter(a.region, regions)) continue;
      // Increment the leaf cell plus every ancestor's cell. The ancestor
      // walk is bounded by the channel tree depth (typically 2–3 levels);
      // a `seen` set guards against malformed cycles in the parent chain.
      let cur: string | null | undefined = a.channel_id;
      const seen = new Set<string>();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        const k = attributionCellKey(cur, a.stage_key);
        m.set(k, (m.get(k) ?? 0) + 1);
        cur = parentByChild.get(cur) ?? null;
      }
    }
    return m;
  }, [attributionsHook.attributions, year, filter, parentByChild, regions]);

  const [listQuery, setListQuery] = useState<ListModalQuery | null>(null);
  const [touchQuery, setTouchQuery] = useState<TouchDrilldownQuery | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);

  // Lock for the manual-actual columns (HPP/Opp/Pursuit/CloseWon on leaves).
  // Default-on so first-time visitors can't accidentally clobber actuals;
  // explicit unlocks persist via localStorage.
  const [editsLocked, setActualsLocked] = useState<boolean>(() =>
    readJson<boolean>(EDITS_LOCKED_STORAGE_KEY, true),
  );
  useEffect(() => {
    writeJson(EDITS_LOCKED_STORAGE_KEY, editsLocked);
  }, [editsLocked]);

  // Attributions matching the active list-modal query, derived live so that
  // creating/deleting/promoting in another tab updates the visible list.
  // When the click came from a parent row, listQuery.channelIds carries
  // the parent + every descendant; we switch to set membership so the
  // modal sums across sub-channels.
  const listAttributions = useMemo(() => {
    if (!listQuery) return [];
    const idSet = listQuery.channelIds
      ? new Set(listQuery.channelIds)
      : null;
    return attributionsHook.attributions.filter(
      (a) =>
        (idSet
          ? Boolean(a.channel_id) && idSet.has(a.channel_id as string)
          : a.channel_id === listQuery.channelId) &&
        a.stage_key === listQuery.stage &&
        a.year === year &&
        (filter === 'year' || `Q${a.period_index}` === filter) &&
        matchesRegionFilter(a.region, regions),
    );
  }, [attributionsHook.attributions, listQuery, year, filter, regions]);

  const channelById = useMemo(
    () => new Map(channels.map((c) => [c.id, c] as const)),
    [channels],
  );

  return (
    <div className="min-h-full bg-gradient-to-b from-muted/80 via-bg to-bg p-4 sm:p-6 xl:p-8">
      <div className="mx-auto max-w-[1800px] space-y-5">
      <header className="relative overflow-hidden rounded-2xl border border-border bg-bg shadow-sm">
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-indigo via-teal to-success" />
        <div className="flex flex-col gap-5 p-5 sm:p-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-indigo/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-indigo">
                Revenue operations
              </span>
              <ReportingBasisDisclosure
                basis={REPORTING_BASIS.basis}
                showExplanation={false}
                variant="accent"
              />
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-charcoal">
              Marketing Funnel: Operations
            </h1>
            <p className="mt-2 text-sm leading-6 text-slate-muted">
              View source-backed funnel results and manage projections and approved opportunities
              in one place.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <button
            type="button"
            onClick={() => setActualsLocked((v) => !v)}
            aria-pressed={editsLocked}
            title={
              editsLocked
                ? 'Edits are locked (Projections + Actuals). Click to unlock.'
                : 'Edits are unlocked. Click to lock.'
            }
            className={
              'inline-flex h-9 w-9 items-center justify-center rounded-lg border shadow-sm transition hover:-translate-y-0.5 ' +
              (editsLocked
                ? 'border-danger/40 bg-danger/5 text-danger hover:bg-danger/10'
                : 'border-success/40 bg-success/5 text-success hover:bg-success/10')
            }
          >
            {editsLocked ? (
              // Closed padlock
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            ) : (
              // Open padlock
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="4" y="11" width="16" height="10" rx="2" />
                <path d="M8 11V7a4 4 0 0 1 8 0" />
              </svg>
            )}
          </button>
          </div>
        </div>
        <div className="border-t border-border bg-muted/25 p-4 sm:px-6 sm:py-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Reporting scope</p>
              <h2 id="reporting-scope-title" className="mt-1 text-base font-semibold text-charcoal">
                Choose the period and commercial region
              </h2>
            </div>
            <span className="rounded-full border border-border bg-muted/60 px-3 py-1 text-[11px] text-slate-muted">
              Filters apply to every value below
            </span>
          </div>
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
        </div>
      </header>

      {grid.unassignedLeadCount > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-charcoal">
          <span aria-hidden="true" className="mt-0.5 h-2 w-2 flex-none rounded-full bg-warning" />
          <span>
          {grid.unassignedLeadCount} lead
          {grid.unassignedLeadCount === 1 ? '' : 's'} in this period have no
          source channel and are not counted in any row. Assign a channel to
          surface them in the grid.
          </span>
        </div>
      )}

      <FunnelStageSummary totals={grid.totals} />

      <section aria-labelledby="funnel-detail-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">Source-backed detail</p>
            <h2 id="funnel-detail-title" className="mt-1 text-lg font-semibold text-charcoal">
              Channel performance and cohort conversion
            </h2>
          </div>
          <p className="text-xs text-slate-muted">
            Click actuals to inspect records · unlock only when editing stored values
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <FunnelTable
          grid={grid}
          channels={visibleChannels}
          onProjectionChange={(channelId, stage, value) =>
            projectionsHook.upsert(
              channelId,
              year,
              periodIndex,
              stage,
              value,
            )
          }
          onActualChange={(channelId, stage, value) =>
            actualsHook.upsert(
              channelId,
              year,
              periodIndex,
              stage,
              value,
            )
          }
          attributionsByCell={attributionsByCell}
          uniqueContacts={grid.uniqueContacts}
          onLeadCellClick={(channelId, stage) => setTouchQuery({ channelId, stage })}
          onAttributionCellClick={(channelId, stage) => {
            // Parent rows: open the rollup. descendantIds includes the
            // root itself, so the filter set spans parent + every
            // descendant at any depth. Leaf rows fall through with
            // channelIds undefined, preserving the existing single-id
            // query path.
            const hasChildren = channels.some(
              (c) => c.parent_channel_id === channelId,
            );
            if (hasChildren) {
              const ids = [...descendantIds(channels, channelId)];
              setListQuery({ channelId, stage, channelIds: ids });
            } else {
              setListQuery({ channelId, stage });
            }
          }}
          editsLocked={editsLocked}
        />
        <ConversionsPanel conversions={conversionCohorts} />
        </div>
      </section>

      <section aria-labelledby="opportunity-review-title" className="overflow-hidden rounded-2xl border border-border bg-bg shadow-sm">
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo">
              Salesforce governance
            </p>
            <h2 id="opportunity-review-title" className="mt-1 text-lg font-semibold text-charcoal">
              Opportunity review
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-muted">
              Review imported Salesforce opportunities and approve their reporting channel.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setQueueOpen((open) => !open)}
            aria-expanded={queueOpen}
            aria-controls="opportunity-review-queue"
            className="inline-flex items-center justify-center gap-2 self-start rounded-lg border border-border bg-bg px-3.5 py-2 text-xs font-medium text-charcoal shadow-sm transition hover:-translate-y-0.5 hover:border-indigo/30 hover:shadow sm:self-auto"
          >
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warning" />
            {queueOpen ? 'Hide opportunity queue' : 'Review Salesforce opportunities'}
          </button>
        </div>
        {queueOpen && (
          <div id="opportunity-review-queue" className="border-t border-border">
            <OpportunityQueuePanel channels={channels.map(({ id, name }) => ({ id, name }))} />
          </div>
        )}
      </section>

      {touchQuery && (
        <TouchDrilldownPanel
          stage={touchQuery.stage}
          channelLabel={channelById.get(touchQuery.channelId)?.name ?? 'Channel'}
          channelIds={[...descendantIds(channels, touchQuery.channelId)]}
          touches={touches}
          leads={leads}
          channels={channels}
          year={year}
          filter={filter}
          regions={regions}
          onClose={() => setTouchQuery(null)}
        />
      )}

      {listQuery && (
        <OpportunitiesListModal
          attributions={listAttributions}
          channelName={
            channelById.get(listQuery.channelId)?.name ?? 'Channel'
          }
          stageKey={listQuery.stage}
          year={year}
          periodIndex={periodIndex}
          isRollup={Boolean(listQuery.channelIds)}
          attributionsHook={attributionsHook}
          touchesHook={touchesHook}
          onClose={() => setListQuery(null)}
          onEdit={(id) => {
            setListQuery(null);
            setEditId(id);
          }}
        />
      )}

      {editId && (
        <AttributionEditorModal
          attributionId={editId}
          channels={channels}
          attributionsHook={attributionsHook}
          touchesHook={touchesHook}
          onClose={() => setEditId(null)}
        />
      )}
      </div>
    </div>
  );
}

// Editing a cell while the year filter is active is ambiguous (which quarter
// does the value go to?). Defaulting to Q1 in that case is wrong. We pick
// the current quarter as the write target when filter is 'year'; the user
// can switch to a specific Q to edit that quarter explicitly.
function periodIndexFromFilter(filter: PeriodFilter): PeriodIndex {
  if (filter === 'year') return currentQuarter().quarter;
  return parseInt(filter.replace('Q', ''), 10) as PeriodIndex;
}
