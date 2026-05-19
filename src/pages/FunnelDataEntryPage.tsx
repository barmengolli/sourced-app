import { useEffect, useMemo, useState } from 'react';
import { useLeads } from '../hooks/useLeads';
import { useChannels } from '../hooks/useChannels';
import { useFunnelProjections } from '../hooks/useFunnelProjections';
import { useFunnelActuals } from '../hooks/useFunnelActuals';
import { useAttributions } from '../hooks/useAttributions';
import { useAttributionTouches } from '../hooks/useAttributionTouches';
import { useCampaignCosts } from '../hooks/useCampaignCosts';
import { computeGrid, type PeriodFilter } from '../lib/compute';
import { currentQuarter, quarterOfIsoDate } from '../lib/dates';
import type { AttributionStageKey, PeriodIndex } from '../types/db';
import type { RegionKey } from '../constants/regions';
import FunnelTable, {
  attributionCellKey,
} from '../components/funnel/FunnelTable';
import ConversionsPanel from '../components/funnel/ConversionsPanel';
import PeriodSelector from '../components/funnel/PeriodSelector';
import CreateHPPModal from '../components/attribution/CreateHPPModal';
import OpportunitiesListModal from '../components/attribution/OpportunitiesListModal';
import AttributionEditorModal from '../components/attribution/AttributionEditorModal';
import { readJson, writeJson } from '../lib/storage';

const EDITS_LOCKED_STORAGE_KEY = 'sourced.funnel.editsLocked';

interface FunnelDataEntryPageProps {
  year: number;
  filter: PeriodFilter;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
}

interface ListModalQuery {
  channelId: string;
  stage: AttributionStageKey;
}

export default function FunnelDataEntryPage({
  year,
  filter,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
}: FunnelDataEntryPageProps) {
  const { leads } = useLeads();
  const channels = useChannels();
  const projectionsHook = useFunnelProjections();
  const actualsHook = useFunnelActuals();
  const attributionsHook = useAttributions();
  const touchesHook = useAttributionTouches();
  // Used only to widen the year selector (any year with a budget
  // shows up in the dropdown). Spend data itself lives on the Spend tab.
  const costsHook = useCampaignCosts();

  const yearOptions = useMemo(() => {
    // Unified derivation: any year touched by a lead, attribution, or
    // budget surfaces here so the user can navigate to it. Mirrors
    // FunnelSpendPage so cross-tab the dropdown reads the same set.
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

  const periodIndex = periodIndexFromFilter(filter);

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

  // Per-cell attribution counts for the active period. Keys match what the
  // FunnelTable's RowCells looks up via attributionCellKey(channelId, stage).
  const attributionsByCell = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of attributionsHook.attributions) {
      if (!a.channel_id) continue;
      if (a.year !== year) continue;
      // When viewing 'year' filter, count attributions across all quarters.
      if (filter !== 'year' && `Q${a.period_index}` !== filter) continue;
      const k = attributionCellKey(a.channel_id, a.stage_key);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [attributionsHook.attributions, year, filter]);

  const [createOpen, setCreateOpen] = useState(false);
  const [listQuery, setListQuery] = useState<ListModalQuery | null>(null);
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
  const listAttributions = useMemo(() => {
    if (!listQuery) return [];
    return attributionsHook.attributions.filter(
      (a) =>
        a.channel_id === listQuery.channelId &&
        a.stage_key === listQuery.stage &&
        a.year === year &&
        (filter === 'year' || `Q${a.period_index}` === filter),
    );
  }, [attributionsHook.attributions, listQuery, year, filter]);

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
          <p className="mt-1 text-sm text-slate-muted">
            Edit projections inline. Click attribution cells with deals to
            view, edit, promote, or delete them. Lead and MQL actuals are
            computed from leads.
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
          <PeriodSelector
            year={year}
            filter={filter}
            yearOptions={yearOptions}
            onYearChange={onYearChange}
            onFilterChange={onFilterChange}
            regions={regions}
            onRegionsChange={onRegionsChange}
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
          channels={channels}
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
          onAttributionCellClick={(channelId, stage) =>
            setListQuery({ channelId, stage })
          }
          editsLocked={editsLocked}
        />
        <ConversionsPanel totals={grid.totals} />
      </div>

      {createOpen && (
        <CreateHPPModal
          channels={channels}
          defaultYear={year}
          defaultPeriodIndex={periodIndex}
          attributionsHook={attributionsHook}
          touchesHook={touchesHook}
          onClose={() => setCreateOpen(false)}
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
