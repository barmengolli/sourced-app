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
import CreateHPPModal from '../components/attribution/CreateHPPModal';
import OpportunitiesListModal from '../components/attribution/OpportunitiesListModal';
import AttributionEditorModal from '../components/attribution/AttributionEditorModal';
import { readJson, writeJson } from '../lib/storage';
import ReportingBasisDisclosure from '../components/reporting/ReportingBasisDisclosure';
import { reportingContractFor } from '../constants/reportingPages';
import { computeFunnelConversionCohorts } from '../lib/funnelConversionCohorts';

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

  const [createOpen, setCreateOpen] = useState(false);
  const [listQuery, setListQuery] = useState<ListModalQuery | null>(null);
  const [touchQuery, setTouchQuery] = useState<TouchDrilldownQuery | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

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
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            Marketing Funnel: Data entry
          </h1>
          <ReportingBasisDisclosure
            basis={REPORTING_BASIS.basis}
            explanation={REPORTING_BASIS.anchor}
          />
          <p className="mt-1 text-sm text-slate-muted">
            Edit projections inline. Click attribution cells with deals to
            view, edit, promote, or delete them. Lead actuals count campaign
            memberships in the selected cohort; MQL actuals are the members
            of that same cohort who have reached MQL.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
              'inline-flex items-center justify-center w-8 h-8 rounded border ' +
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
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="text-xs px-3 py-1.5 rounded bg-indigo text-white hover:opacity-90"
          >
            + Create HPP
          </button>
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
        <div className="text-xs text-slate-muted">
          {grid.unassignedLeadCount} lead
          {grid.unassignedLeadCount === 1 ? '' : 's'} in this period have no
          source channel and are not counted in any row. Assign a channel to
          surface them in the grid.
        </div>
      )}

      <div className="flex flex-col xl:flex-row gap-4">
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

      {createOpen && (
        <CreateHPPModal
          channels={channels}
          defaultYear={year}
          defaultPeriodIndex={periodIndex}
          attributionsHook={attributionsHook}
          touchesHook={touchesHook}
          onClose={() => setCreateOpen(false)}
          onOpenExisting={(dealId) => {
            // The editor takes an attribution row id, not a deal id.
            // Prefer the HPP row of the deal so the editor opens at
            // the canonical entry point; fall back to any row that
            // shares the deal_id if no HPP row exists.
            const rows = attributionsHook.attributions.filter(
              (a) => a.deal_id === dealId,
            );
            const target =
              rows.find((r) => r.stage_key === 'hpp') ?? rows[0] ?? null;
            if (!target) return;
            setCreateOpen(false);
            setEditId(target.id);
          }}
        />
      )}

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
