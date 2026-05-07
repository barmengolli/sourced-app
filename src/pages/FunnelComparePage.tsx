// FunnelComparePage — week-over-week comparison view. Modeled on DataVis 1's
// Outreach Sequences "Compare" / "Data" tab. Two modes:
//
//   - "single"   → channel × stage table, one ACT column per stage with a
//                  small ▲/▼ delta vs the prior ISO week. Six summary cards
//                  on top mirror the same metric layout.
//   - "rolling4" → channel × stage table, four ACT columns per stage (the
//                  selected week and the three preceding it), no deltas. A
//                  sub-channel × week heatmap below shows lead intensity.
//
// Empty-state copy spells out the "vs zero baseline" caveat when the
// comparison week itself has no data, so deltas like "▲237" don't mislead
// the reader.
//
// Computation lives in lib/compute.ts (computeWeekly). Week math uses ISO
// 8601 (Mon-Sun, week 1 contains Jan 4); see lib/dates.ts.

import { useMemo } from 'react';
import { useLeads } from '../hooks/useLeads';
import { useChannels } from '../hooks/useChannels';
import { useAttributions } from '../hooks/useAttributions';
import { useCollapsedChannels } from '../hooks/useCollapsedChannels';
import { computeWeekly, type PeriodFilter } from '../lib/compute';
import {
  isoWeekStart,
  weeksInQuarter,
  type IsoWeek,
} from '../lib/dates';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
} from '../constants/funnelStages';
import {
  REGIONS,
  REGION_LABELS,
  type RegionKey,
} from '../constants/regions';
import type { CompareView } from '../App';

interface FunnelComparePageProps {
  year: number;
  filter: PeriodFilter;
  onYearChange: (y: number) => void;
  onFilterChange: (f: PeriodFilter) => void;
  regions: Set<RegionKey>;
  onRegionsChange: (next: Set<RegionKey>) => void;
  compareWeek: number;
  onCompareWeekChange: (w: number) => void;
  compareView: CompareView;
  onCompareViewChange: (v: CompareView) => void;
}

const QUARTER_VALUES = ['Q1', 'Q2', 'Q3', 'Q4'] as const;

function isoLabel(w: IsoWeek): string {
  return `W${w.week}`;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function weekRangeLabel(w: IsoWeek): string {
  const mon = isoWeekStart(w.year, w.week);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return `${fmtDate(mon)} – ${fmtDate(sun)}`;
}

export default function FunnelComparePage({
  year,
  filter,
  onYearChange,
  onFilterChange,
  regions,
  onRegionsChange,
  compareWeek,
  onCompareWeekChange,
  compareView,
  onCompareViewChange,
}: FunnelComparePageProps) {
  const { leads } = useLeads();
  const channels = useChannels();
  const attributionsHook = useAttributions();
  // Collapse state shared with Funnel Data Entry via the same localStorage
  // key prefix. One hook instance per page render so both modes (single
  // and rolling4) read/write the same set without re-syncing.
  const collapse = useCollapsedChannels(channels);

  // Quarter chip state lives in the existing PeriodFilter prop. Compare only
  // makes sense within a single quarter, so 'year' filter coerces to the
  // current calendar quarter for chip-active feedback.
  const activeQuarter = useMemo<1 | 2 | 3 | 4>(() => {
    if (filter !== 'year') {
      return parseInt(filter.replace('Q', ''), 10) as 1 | 2 | 3 | 4;
    }
    return (Math.floor(new Date().getMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  }, [filter]);

  const quarterWeeks = useMemo(
    () => weeksInQuarter(year, activeQuarter),
    [year, activeQuarter],
  );

  const yearOptions = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const l of leads) {
      const d = l.marketing_sourced_date;
      if (d) {
        const m = /^(\d{4})/.exec(d);
        if (m) years.add(parseInt(m[1], 10));
      }
    }
    return [...years].sort((a, b) => a - b);
  }, [leads]);

  // Selected week within the active quarter. If the saved compareWeek is no
  // longer in range (after a quarter switch), fall back to the first week.
  const selectedWeek: IsoWeek = useMemo(() => {
    const match = quarterWeeks.find((w) => w.week === compareWeek);
    return match ?? quarterWeeks[0] ?? { year, week: 1 };
  }, [quarterWeeks, compareWeek, year]);

  // Comparison set: in single mode it's [prev, selected]; in rolling4 it's
  // the four weeks ending at the selected week.
  const compareWeeks: IsoWeek[] = useMemo(() => {
    if (compareView === 'rolling4') {
      const idx = quarterWeeks.findIndex((w) => w.week === selectedWeek.week);
      if (idx < 0) return quarterWeeks.slice(0, 4);
      const start = Math.max(0, idx - 3);
      // If we're early in the quarter we'll have fewer than 4 weeks; the
      // table renders fewer columns gracefully.
      return quarterWeeks.slice(start, idx + 1);
    }
    const idx = quarterWeeks.findIndex((w) => w.week === selectedWeek.week);
    if (idx <= 0) return [selectedWeek];
    return [quarterWeeks[idx - 1], selectedWeek];
  }, [compareView, quarterWeeks, selectedWeek]);

  const grid = useMemo(
    () =>
      computeWeekly({
        leads,
        channels,
        attributions: attributionsHook.attributions,
        weeks: compareWeeks,
        regions,
      }),
    [leads, channels, attributionsHook.attributions, compareWeeks, regions],
  );

  // Single-mode: did the comparison week have any data? If not, deltas
  // read like "▲237" against a zero baseline; the disclaimer below says so.
  const compareIsZero = useMemo(() => {
    if (compareView !== 'single') return false;
    if (compareWeeks.length < 2) return true;
    const totals = grid.totals;
    return FUNNEL_STAGES.every((s) => (totals[s].counts[0] ?? 0) === 0);
  }, [compareView, compareWeeks, grid]);

  const allRegionsOn = regions.size === REGIONS.length;
  const toggleRegion = (r: RegionKey) => {
    const next = new Set(regions);
    if (next.has(r)) next.delete(r);
    else next.add(r);
    onRegionsChange(next);
  };

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">
            Marketing Funnel: Compare
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            Week over week comparison. ISO weeks (Mon-Sun). HPP and below
            count by week of attribution creation, not stage transition.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-muted">
            Year
            <select
              value={year}
              onChange={(e) => onYearChange(parseInt(e.target.value, 10))}
              className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-1">
            {QUARTER_VALUES.map((q) => {
              const active = filter === q;
              return (
                <button
                  key={q}
                  type="button"
                  onClick={() => onFilterChange(q)}
                  className={
                    'text-xs px-2 py-1 rounded border transition-colors ' +
                    (active
                      ? 'bg-indigo text-white border-indigo'
                      : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
                  }
                >
                  {q}
                </button>
              );
            })}
          </div>
          <ViewToggle view={compareView} onChange={onCompareViewChange} />
        </div>
      </header>

      {/* Week chips + region group */}
      <section className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-slate-muted mr-1">Week</span>
          {quarterWeeks.map((w) => {
            const active = w.week === selectedWeek.week;
            return (
              <button
                key={`${w.year}-${w.week}`}
                type="button"
                title={weekRangeLabel(w)}
                onClick={() => onCompareWeekChange(w.week)}
                className={
                  'text-xs px-2 py-1 rounded border transition-colors ' +
                  (active
                    ? 'bg-indigo text-white border-indigo'
                    : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
                }
              >
                {isoLabel(w)}
              </button>
            );
          })}
          {compareView === 'single' && compareWeeks.length === 2 && (
            <span className="text-xs text-slate-muted ml-2">
              vs {isoLabel(compareWeeks[0])}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs text-slate-muted mr-1">Region</span>
          <button
            type="button"
            onClick={() =>
              onRegionsChange(allRegionsOn ? new Set() : new Set(REGIONS))
            }
            className="text-xs px-2 py-1 rounded-full border border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30"
          >
            {allRegionsOn ? 'Clear' : 'All'}
          </button>
          {REGIONS.map((r) => {
            const on = regions.has(r);
            return (
              <button
                key={r}
                type="button"
                onClick={() => toggleRegion(r)}
                title={REGION_LABELS[r]}
                className={
                  'text-xs px-2 py-1 rounded-full border transition-colors ' +
                  (on
                    ? 'bg-indigo text-white border-indigo'
                    : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
                }
              >
                {r}
              </button>
            );
          })}
        </div>
      </section>

      {compareView === 'single' ? (
        <SingleWeekView
          grid={grid}
          channels={channels}
          weeks={compareWeeks}
          selectedWeek={selectedWeek}
          compareIsZero={compareIsZero}
          collapse={collapse}
        />
      ) : (
        <RollingFourView
          grid={grid}
          channels={channels}
          weeks={compareWeeks}
          collapse={collapse}
        />
      )}
    </div>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: CompareView;
  onChange: (v: CompareView) => void;
}) {
  const options: { value: CompareView; label: string }[] = [
    { value: 'single', label: 'This week' },
    { value: 'rolling4', label: 'Rolling 4 weeks' },
  ];
  return (
    <div className="flex items-center gap-1">
      {options.map((o) => {
        const active = o.value === view;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={
              'text-xs px-2 py-1 rounded border transition-colors ' +
              (active
                ? 'bg-indigo text-white border-indigo'
                : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Single-week view ----------

interface SingleViewProps {
  grid: ReturnType<typeof computeWeekly>;
  channels: ReturnType<typeof useChannels>;
  weeks: IsoWeek[]; // [prev, selected] or [selected]
  selectedWeek: IsoWeek;
  compareIsZero: boolean;
  collapse: ReturnType<typeof useCollapsedChannels>;
}

function SingleWeekView({
  grid,
  channels,
  weeks,
  selectedWeek,
  compareIsZero,
  collapse,
}: SingleViewProps) {
  const channelById = useMemo(
    () => new Map(channels.map((c) => [c.id, c] as const)),
    [channels],
  );
  const selIdx = weeks.length - 1;
  const prevIdx = weeks.length === 2 ? 0 : -1;

  const prevLabel = prevIdx >= 0 ? `W${weeks[prevIdx].week}` : 'baseline';
  const selLabel = `W${selectedWeek.week}`;

  return (
    <div className="space-y-4">
      <SummaryCards
        totals={grid.totals}
        selIdx={selIdx}
        prevIdx={prevIdx}
        prevLabel={prevLabel}
        selLabel={selLabel}
      />

      {grid.rows.length === 0 ? (
        <p className="text-sm text-slate-muted italic">
          No channels configured.
        </p>
      ) : (
        <div className="overflow-x-auto border border-border rounded-lg bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40 text-charcoal">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Channel</th>
                {FUNNEL_STAGES.map((s) => (
                  <th
                    key={s}
                    className="text-right px-3 py-2 font-medium whitespace-nowrap"
                  >
                    {FUNNEL_STAGE_LABELS[s]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row) => {
                const channel = channelById.get(row.channelId);
                if (collapse.isHiddenByAncestors(row.ancestors)) return null;
                const isCollapsed =
                  row.hasChildren && collapse.isCollapsed(row.channelId);
                const paddingLeft = 4 + (row.depth - 1) * 24;
                const bg =
                  row.depth === 1
                    ? 'bg-white'
                    : row.depth === 2
                      ? 'bg-muted/30'
                      : 'bg-muted/50';
                return (
                  <tr
                    key={row.channelId}
                    className={`${bg} border-t border-border`}
                  >
                    <td
                      className={
                        'px-3 py-1.5 whitespace-nowrap ' +
                        (row.depth === 1
                          ? 'font-medium text-charcoal'
                          : 'text-slate-muted')
                      }
                      style={{ paddingLeft }}
                    >
                      {row.hasChildren ? (
                        <button
                          type="button"
                          onClick={() => collapse.toggle(row.channelId)}
                          aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                          className="inline-flex items-center justify-center w-5 h-5 mr-1 text-slate-muted hover:text-charcoal align-middle"
                        >
                          <span className="text-[10px]">
                            {isCollapsed ? '▶' : '▼'}
                          </span>
                        </button>
                      ) : null}
                      {channel?.name ?? '(unknown)'}
                    </td>
                    {FUNNEL_STAGES.map((s) => {
                      const cur = row.cells[s].counts[selIdx] ?? 0;
                      const prev =
                        prevIdx >= 0 ? row.cells[s].counts[prevIdx] ?? 0 : 0;
                      return (
                        <td
                          key={s}
                          className="px-3 py-1.5 text-right tabular-nums"
                        >
                          <DeltaCell
                            current={cur}
                            previous={prev}
                            hasPrev={prevIdx >= 0}
                            prevLabel={prevLabel}
                            selLabel={selLabel}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              <tr className="border-t border-border bg-muted/60 font-medium">
                <td className="px-3 py-2 text-charcoal">Totals</td>
                {FUNNEL_STAGES.map((s) => {
                  const cur = grid.totals[s].counts[selIdx] ?? 0;
                  const prev =
                    prevIdx >= 0 ? grid.totals[s].counts[prevIdx] ?? 0 : 0;
                  return (
                    <td
                      key={s}
                      className="px-3 py-2 text-right tabular-nums"
                    >
                      <DeltaCell
                        current={cur}
                        previous={prev}
                        hasPrev={prevIdx >= 0}
                        prevLabel={prevLabel}
                        selLabel={selLabel}
                      />
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {prevIdx < 0 && (
        <p className="text-xs text-slate-muted italic">
          {selLabel} is the first week of this quarter; deltas are vs zero
          baseline.
        </p>
      )}
      {prevIdx >= 0 && compareIsZero && (
        <p className="text-xs text-slate-muted italic">
          {prevLabel} has no data; deltas are vs zero baseline.
        </p>
      )}
      {prevIdx >= 0 &&
        !compareIsZero &&
        FUNNEL_STAGES.every(
          (s) => (grid.totals[s].counts[selIdx] ?? 0) === 0,
        ) && (
          <p className="text-xs text-slate-muted italic">
            No leads in {selLabel}. Try a different week.
          </p>
        )}
    </div>
  );
}

function DeltaCell({
  current,
  previous,
  hasPrev,
  prevLabel,
  selLabel,
}: {
  current: number;
  previous: number;
  hasPrev: boolean;
  prevLabel: string;
  selLabel: string;
}) {
  const delta = current - previous;
  const tooltip = hasPrev
    ? `${prevLabel}: ${previous}, ${selLabel}: ${current}`
    : `${selLabel}: ${current}`;
  let arrow: string;
  let cls: string;
  if (delta > 0) {
    arrow = `▲${delta}`;
    cls = 'text-success';
  } else if (delta < 0) {
    arrow = `▼${Math.abs(delta)}`;
    cls = 'text-danger';
  } else {
    arrow = '–';
    cls = 'text-slate-muted';
  }
  return (
    <span title={tooltip} className="inline-flex items-baseline gap-1.5">
      <span className="text-charcoal">{current}</span>
      <span className={`text-[11px] ${cls}`}>{arrow}</span>
    </span>
  );
}

function SummaryCards({
  totals,
  selIdx,
  prevIdx,
  prevLabel,
  selLabel,
}: {
  totals: ReturnType<typeof computeWeekly>['totals'];
  selIdx: number;
  prevIdx: number;
  prevLabel: string;
  selLabel: string;
}) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {FUNNEL_STAGES.map((s) => {
        const cur = totals[s].counts[selIdx] ?? 0;
        const prev = prevIdx >= 0 ? totals[s].counts[prevIdx] ?? 0 : 0;
        const delta = cur - prev;
        const pct =
          prev === 0 ? null : Math.round((delta / prev) * 1000) / 10;
        let arrow: string;
        let cls: string;
        if (delta > 0) {
          arrow = `▲${delta}`;
          cls = 'text-success';
        } else if (delta < 0) {
          arrow = `▼${Math.abs(delta)}`;
          cls = 'text-danger';
        } else {
          arrow = '–';
          cls = 'text-slate-muted';
        }
        return (
          <div
            key={s}
            className="bg-white border border-border rounded-lg p-3 shadow-sm"
            title={
              prevIdx >= 0
                ? `${prevLabel}: ${prev}, ${selLabel}: ${cur}`
                : `${selLabel}: ${cur}`
            }
          >
            <div className="text-[10px] uppercase tracking-wider text-slate-muted">
              {FUNNEL_STAGE_LABELS[s]}
            </div>
            <div className="mt-1 text-2xl font-semibold text-charcoal tabular-nums">
              {cur}
            </div>
            <div className={`text-xs mt-0.5 ${cls}`}>
              {arrow}
              {pct !== null && delta !== 0 && (
                <span className="ml-1 text-slate-muted">
                  ({pct > 0 ? '+' : ''}
                  {pct}%)
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Rolling-4 view ----------

interface RollingViewProps {
  grid: ReturnType<typeof computeWeekly>;
  channels: ReturnType<typeof useChannels>;
  weeks: IsoWeek[];
  collapse: ReturnType<typeof useCollapsedChannels>;
}

function RollingFourView({
  grid,
  channels,
  weeks,
  collapse,
}: RollingViewProps) {
  const channelById = useMemo(
    () => new Map(channels.map((c) => [c.id, c] as const)),
    [channels],
  );

  // Heatmap shows sub-channels (depth >= 2) so the panel reads as a detail
  // view. Lead-stage counts only — that's the intensity we color by.
  const heatRows = useMemo(
    () => grid.rows.filter((r) => r.depth >= 2),
    [grid.rows],
  );

  const heatMax = useMemo(() => {
    let m = 0;
    for (const r of heatRows) {
      for (const c of r.cells.lead.counts) if (c > m) m = c;
    }
    return m || 1;
  }, [heatRows]);

  return (
    <div className="space-y-4">
      {grid.rows.length === 0 ? (
        <p className="text-sm text-slate-muted italic">
          No channels configured.
        </p>
      ) : (
        <div className="overflow-x-auto border border-border rounded-lg bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40 text-charcoal">
              <tr>
                <th
                  className="text-left px-3 py-2 font-medium align-bottom"
                  rowSpan={2}
                >
                  Channel
                </th>
                {FUNNEL_STAGES.map((s) => (
                  <th
                    key={s}
                    className="text-center px-3 py-2 font-medium border-l border-border"
                    colSpan={weeks.length}
                  >
                    {FUNNEL_STAGE_LABELS[s]}
                  </th>
                ))}
              </tr>
              <tr>
                {FUNNEL_STAGES.map((s) =>
                  weeks.map((w) => (
                    <th
                      key={`${s}-${w.year}-${w.week}`}
                      className="text-right px-2 py-1 text-[10px] font-normal text-slate-muted whitespace-nowrap"
                    >
                      W{w.week}
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row) => {
                const channel = channelById.get(row.channelId);
                if (collapse.isHiddenByAncestors(row.ancestors)) return null;
                const isCollapsed =
                  row.hasChildren && collapse.isCollapsed(row.channelId);
                const paddingLeft = 4 + (row.depth - 1) * 24;
                const bg =
                  row.depth === 1
                    ? 'bg-white'
                    : row.depth === 2
                      ? 'bg-muted/30'
                      : 'bg-muted/50';
                return (
                  <tr
                    key={row.channelId}
                    className={`${bg} border-t border-border`}
                  >
                    <td
                      className={
                        'px-3 py-1.5 whitespace-nowrap ' +
                        (row.depth === 1
                          ? 'font-medium text-charcoal'
                          : 'text-slate-muted')
                      }
                      style={{ paddingLeft }}
                    >
                      {row.hasChildren ? (
                        <button
                          type="button"
                          onClick={() => collapse.toggle(row.channelId)}
                          aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                          className="inline-flex items-center justify-center w-5 h-5 mr-1 text-slate-muted hover:text-charcoal align-middle"
                        >
                          <span className="text-[10px]">
                            {isCollapsed ? '▶' : '▼'}
                          </span>
                        </button>
                      ) : null}
                      {channel?.name ?? '(unknown)'}
                    </td>
                    {FUNNEL_STAGES.map((s) =>
                      weeks.map((_w, i) => (
                        <td
                          key={`${row.channelId}-${s}-${i}`}
                          className="px-2 py-1.5 text-right tabular-nums text-charcoal"
                        >
                          {row.cells[s].counts[i] || (
                            <span className="text-slate-muted">–</span>
                          )}
                        </td>
                      )),
                    )}
                  </tr>
                );
              })}
              <tr className="border-t border-border bg-muted/60 font-medium">
                <td className="px-3 py-2 text-charcoal">Totals</td>
                {FUNNEL_STAGES.map((s) =>
                  weeks.map((_w, i) => (
                    <td
                      key={`tot-${s}-${i}`}
                      className="px-2 py-2 text-right tabular-nums"
                    >
                      {grid.totals[s].counts[i] || (
                        <span className="text-slate-muted">–</span>
                      )}
                    </td>
                  )),
                )}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <section className="bg-white border border-border rounded-lg p-4 space-y-2 shadow-sm">
        <header>
          <h3 className="text-sm font-semibold text-charcoal">
            Activity heatmap
          </h3>
          <p className="text-xs text-slate-muted mt-0.5">
            Lead counts per sub-channel across the selected weeks. Darker =
            higher.
          </p>
        </header>
        {heatRows.length === 0 ? (
          <p className="text-xs text-slate-muted italic">
            No sub-channel activity in this window.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1 font-medium text-slate-muted">
                    Sub-channel
                  </th>
                  {weeks.map((w) => (
                    <th
                      key={`${w.year}-${w.week}`}
                      className="text-center px-2 py-1 font-medium text-slate-muted"
                      title={weekRangeLabel(w)}
                    >
                      W{w.week}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heatRows.map((row) => {
                  const channel = channelById.get(row.channelId);
                  return (
                    <tr key={row.channelId} className="border-t border-border">
                      <td
                        className="px-2 py-1 text-charcoal"
                        style={{ paddingLeft: 8 + (row.depth - 2) * 16 }}
                      >
                        {channel?.name ?? '(unknown)'}
                      </td>
                      {row.cells.lead.counts.map((c, i) => {
                        const intensity = c / heatMax;
                        const bg = heatColor(intensity);
                        const text =
                          intensity > 0.55 ? '#FFFFFF' : '#0F172A';
                        return (
                          <td
                            key={i}
                            className="text-center px-2 py-1 tabular-nums"
                            style={{
                              backgroundColor: bg,
                              color: text,
                              minWidth: 48,
                            }}
                            title={`W${weeks[i].week}: ${c} leads`}
                          >
                            {c || ''}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// Light teal → saturated indigo. Pure white at intensity 0 so empty cells
// stay clean. Mid range is a teal hue; high end pulls toward indigo to
// match the brand palette.
function heatColor(t: number): string {
  if (t <= 0) return '#FFFFFF';
  const x = Math.min(1, Math.max(0, t));
  const r = Math.round(0x06 + (0x4f - 0x06) * x);
  const g = Math.round(0xb6 + (0x46 - 0xb6) * x);
  const b = Math.round(0xd4 + (0xe5 - 0xd4) * x);
  // Mix toward white at the low end so 0.05 doesn't already look saturated.
  const wash = (1 - x) * 0.6;
  const fr = Math.round(r + (255 - r) * wash);
  const fg = Math.round(g + (255 - g) * wash);
  const fb = Math.round(b + (255 - b) * wash);
  return `rgb(${fr}, ${fg}, ${fb})`;
}
