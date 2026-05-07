// OutreachDataPage — the Data sub-tab of the Outreach section. Mirrors
// DataVis 1's SequenceTable.tsx for the table, plus the quarter/week/region
// chip rail pattern used elsewhere in Sourced (FunnelComparePage).
//
// Source of truth: outreach_snapshots, populated weekly by the n8n cron.
// We render one row per sequence for the selected ISO week, with inline
// delta indicators against the prior week's snapshot of the same sequence.
// Region filter is inferred client-side from sequence_name.

import { useMemo, useState } from 'react';
import {
  isoWeekStart,
  weeksInQuarter,
  type IsoWeek,
} from '../lib/dates';
import {
  REGIONS,
  REGION_LABELS,
  type RegionKey,
} from '../constants/regions';
import { inferRegionFromSequenceName } from '../lib/outreach';
import type { OutreachSnapshot } from '../types/db';
import type { OutreachSubPageProps } from '../App';
import SequenceMultiSelect from '../components/outreach/SequenceMultiSelect';

const QUARTER_VALUES = [1, 2, 3, 4] as const;

type SortKey = keyof OutreachSnapshot;
type SortDir = 'asc' | 'desc';

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function weekRangeLabel(w: IsoWeek): string {
  const mon = isoWeekStart(w.year, w.week);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return `${fmtDate(mon)} – ${fmtDate(sun)}`;
}

function pct(num: number, den: number): string {
  if (!den) return '—';
  return `${((num / den) * 100).toFixed(1)}%`;
}

function Delta({ current, previous }: { current: number; previous?: number }) {
  if (previous === undefined || previous === null) return null;
  const diff = current - previous;
  if (diff === 0) {
    return <span className="text-[9px] text-slate-300 ml-0.5">–</span>;
  }
  const color = diff > 0 ? 'text-green-600' : 'text-red-500';
  const arrow = diff > 0 ? '▲' : '▼';
  return (
    <span className={`text-[9px] ${color} ml-0.5`}>
      {arrow}
      {Math.abs(diff).toLocaleString()}
    </span>
  );
}

export default function OutreachDataPage({
  year,
  quarter,
  week,
  regions,
  selectedSequences,
  onYearChange,
  onQuarterChange,
  onWeekChange,
  onRegionsChange,
  onSelectedSequencesChange,
  snapshots,
  loading,
}: OutreachSubPageProps) {
  const [sortKey, setSortKey] = useState<SortKey>('total_sent');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Year options: the years actually present in the snapshots, plus the
  // current calendar year so the picker is non-empty even before any data
  // arrives.
  const yearOptions = useMemo(() => {
    const ys = new Set<number>([new Date().getFullYear()]);
    for (const s of snapshots) ys.add(s.year);
    return [...ys].sort((a, b) => a - b);
  }, [snapshots]);

  const quarterWeeks = useMemo(
    () => weeksInQuarter(year, quarter),
    [year, quarter],
  );

  // Clamp selected week into the chosen quarter; fall back to first week.
  const effectiveWeek = useMemo(() => {
    const match = quarterWeeks.find((w) => w.week === week);
    return match ?? quarterWeeks[0];
  }, [quarterWeeks, week]);

  const prevWeek: IsoWeek | null = useMemo(() => {
    if (!effectiveWeek) return null;
    const idx = quarterWeeks.findIndex((w) => w.week === effectiveWeek.week);
    if (idx <= 0) return null;
    return quarterWeeks[idx - 1];
  }, [quarterWeeks, effectiveWeek]);

  // Sequences for the multi-select dropdown: distinct (id, name) pairs that
  // appear anywhere in the loaded snapshots. Sorted by name for stable
  // chrome.
  const sequenceOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of snapshots) {
      if (!m.has(s.sequence_id)) m.set(s.sequence_id, s.sequence_name);
    }
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snapshots]);

  // Filter snapshots: by year + selected week + region (after sequence_name
  // inference) + selected sequences. PostgREST already returned everything;
  // we trim in-memory. Empty selectedSequences means "All Sequences".
  const currentRows = useMemo(() => {
    if (!effectiveWeek) return [];
    const allOn = regions.size === REGIONS.length;
    const allSeqs =
      selectedSequences.size === 0 ||
      selectedSequences.size === sequenceOptions.length;
    return snapshots.filter((s) => {
      if (s.year !== year) return false;
      if (s.week_number !== effectiveWeek.week) return false;
      if (!allOn) {
        const r = inferRegionFromSequenceName(s.sequence_name);
        if (!regions.has(r)) return false;
      }
      if (!allSeqs && !selectedSequences.has(s.sequence_id)) return false;
      return true;
    });
  }, [snapshots, year, effectiveWeek, regions, selectedSequences, sequenceOptions]);

  // Prior-week snapshots for the same sequences, keyed by sequence_id, so
  // the table can render inline ▲/▼ deltas against last week's values.
  const prevByIdMap = useMemo(() => {
    const m = new Map<number, OutreachSnapshot>();
    if (!prevWeek) return m;
    for (const s of snapshots) {
      if (s.year !== year) continue;
      if (s.week_number !== prevWeek.week) continue;
      m.set(s.sequence_id, s);
    }
    return m;
  }, [snapshots, year, prevWeek]);

  const sortedRows = useMemo(() => {
    const arr = [...currentRows];
    arr.sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === 'asc' ? Number(av) - Number(bv) : Number(bv) - Number(av);
    });
    return arr;
  }, [currentRows, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

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
            Outreach — Data
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            Weekly snapshot per sequence. Loaded from outreach_snapshots,
            populated by the n8n cron each Monday. Deltas compare to the
            prior ISO week.
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
              const active = q === quarter;
              return (
                <button
                  key={q}
                  type="button"
                  onClick={() => onQuarterChange(q)}
                  className={
                    'text-xs px-2 py-1 rounded border transition-colors ' +
                    (active
                      ? 'bg-indigo text-white border-indigo'
                      : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
                  }
                >
                  Q{q}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <section className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-slate-muted mr-1">Week</span>
          {quarterWeeks.map((w) => {
            const active = effectiveWeek?.week === w.week;
            return (
              <button
                key={`${w.year}-${w.week}`}
                type="button"
                title={weekRangeLabel(w)}
                onClick={() => onWeekChange(w.week)}
                className={
                  'text-xs px-2 py-1 rounded border transition-colors ' +
                  (active
                    ? 'bg-indigo text-white border-indigo'
                    : 'bg-bg text-charcoal border-border hover:border-charcoal/30')
                }
              >
                W{w.week}
              </button>
            );
          })}
          {prevWeek && (
            <span className="text-xs text-slate-muted ml-2">
              vs W{prevWeek.week}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <SequenceMultiSelect
            sequences={sequenceOptions}
            selectedIds={selectedSequences}
            onChange={onSelectedSequencesChange}
          />
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

      <SequenceTable
        loading={loading}
        rows={sortedRows}
        prevById={prevByIdMap}
        sortKey={sortKey}
        sortDir={sortDir}
        toggleSort={toggleSort}
      />
    </div>
  );
}

interface SequenceTableProps {
  loading: boolean;
  rows: OutreachSnapshot[];
  prevById: Map<number, OutreachSnapshot>;
  sortKey: SortKey;
  sortDir: SortDir;
  toggleSort: (k: SortKey) => void;
}

function SequenceTable({
  loading,
  rows,
  prevById,
  sortKey,
  sortDir,
  toggleSort,
}: SequenceTableProps) {
  return (
    <div className="overflow-x-auto border border-border rounded-lg bg-white shadow-sm">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-muted/40 border-b border-border">
            <th className="sticky left-0 bg-muted/40 z-10 px-3 py-2 text-left text-[10px] font-semibold text-slate-muted uppercase tracking-wider border-r border-border min-w-[260px]">
              Sequence
            </th>
            <SortHeader label="Sent" field="total_sent" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <SortHeader label="Delivered" field="delivered" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <th className="px-2 py-2 text-[10px] font-semibold text-slate-muted uppercase tracking-wider text-center">Del%</th>
            <SortHeader label="Opened" field="opened" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <th className="px-2 py-2 text-[10px] font-semibold text-slate-muted uppercase tracking-wider text-center">Open%</th>
            <SortHeader label="Clicked" field="clicked" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <th className="px-2 py-2 text-[10px] font-semibold text-slate-muted uppercase tracking-wider text-center border-r border-border">
              Click%
            </th>
            <SortHeader label="Replied" field="replied" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <th className="px-2 py-2 text-[10px] font-semibold text-slate-muted uppercase tracking-wider text-center">Reply%</th>
            <SortHeader label="+" field="positive_replies" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <SortHeader label="~" field="neutral_replies" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <SortHeader label="–" field="negative_replies" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} extraClass="border-r border-border" />
            <SortHeader label="Contacted" field="contacted_prospects" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <SortHeader label="Added" field="prospects_added" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <SortHeader label="Active" field="prospects_active" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} extraClass="border-r border-border" />
            <SortHeader label="Calls" field="outbound_calls" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
            <SortHeader label="LinkedIn" field="linkedin_tasks_completed" sortKey={sortKey} sortDir={sortDir} toggle={toggleSort} />
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            <tr>
              <td colSpan={18} className="py-8 text-center text-slate-muted text-sm">
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={18} className="py-8 text-center text-slate-muted text-sm">
                No outreach data for this week.
              </td>
            </tr>
          ) : (
            rows.map((s) => {
              const prev = prevById.get(s.sequence_id);
              const openRate = s.delivered > 0 ? s.opened / s.delivered : 0;
              const replyRate = s.delivered > 0 ? s.replied / s.delivered : 0;
              return (
                <tr
                  key={s.id}
                  className="border-b border-border hover:bg-muted/30 transition-colors"
                >
                  <td className="sticky left-0 z-10 bg-white px-3 py-2 border-r border-border whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          'text-xs font-medium ' +
                          (s.enabled
                            ? 'text-charcoal'
                            : 'text-slate-400 line-through')
                        }
                      >
                        {s.sequence_name}
                      </span>
                      {!s.enabled && (
                        <span className="text-[9px] text-slate-muted bg-muted/60 rounded px-1">
                          OFF
                        </span>
                      )}
                    </div>
                  </td>
                  <MetricCell value={s.total_sent} prev={prev?.total_sent} />
                  <MetricCell value={s.delivered} prev={prev?.delivered} />
                  <td className="px-2 py-1.5 text-center text-xs text-slate-muted">
                    {pct(s.delivered, s.total_sent)}
                  </td>
                  <MetricCell value={s.opened} prev={prev?.opened} />
                  <td
                    className={
                      'px-2 py-1.5 text-center text-xs font-medium ' +
                      (openRate >= 0.3
                        ? 'text-green-600'
                        : openRate >= 0.15
                          ? 'text-yellow-600'
                          : 'text-red-500')
                    }
                  >
                    {pct(s.opened, s.delivered)}
                  </td>
                  <MetricCell value={s.clicked} prev={prev?.clicked} />
                  <td className="px-2 py-1.5 text-center text-xs text-slate-muted border-r border-border">
                    {pct(s.clicked, s.delivered)}
                  </td>
                  <MetricCell value={s.replied} prev={prev?.replied} />
                  <td
                    className={
                      'px-2 py-1.5 text-center text-xs font-medium ' +
                      (replyRate >= 0.05
                        ? 'text-green-600'
                        : replyRate >= 0.02
                          ? 'text-yellow-600'
                          : 'text-red-500')
                    }
                  >
                    {pct(s.replied, s.delivered)}
                  </td>
                  <td className="px-2 py-1.5 text-center text-xs text-green-600">
                    {s.positive_replies || '–'}
                  </td>
                  <td className="px-2 py-1.5 text-center text-xs text-slate-muted">
                    {s.neutral_replies || '–'}
                  </td>
                  <td className="px-2 py-1.5 text-center text-xs text-red-500 border-r border-border">
                    {s.negative_replies || '–'}
                  </td>
                  <MetricCell value={s.contacted_prospects} prev={prev?.contacted_prospects} />
                  <MetricCell value={s.prospects_added} prev={prev?.prospects_added} />
                  <td className="px-2 py-1.5 text-center text-xs text-charcoal border-r border-border">
                    {s.prospects_active.toLocaleString()}
                  </td>
                  <MetricCell value={s.outbound_calls} prev={prev?.outbound_calls} />
                  <MetricCell value={s.linkedin_tasks_completed} prev={prev?.linkedin_tasks_completed} />
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function MetricCell({
  value,
  prev,
}: {
  value: number;
  prev?: number;
}) {
  return (
    <td className="px-2 py-1.5 text-center text-xs text-charcoal whitespace-nowrap tabular-nums">
      {value.toLocaleString()}
      <Delta current={value} previous={prev} />
    </td>
  );
}

function SortHeader({
  label,
  field,
  sortKey,
  sortDir,
  toggle,
  extraClass,
}: {
  label: string;
  field: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  toggle: (k: SortKey) => void;
  extraClass?: string;
}) {
  const active = sortKey === field;
  return (
    <th
      className={
        'px-2 py-2 text-[10px] font-semibold text-slate-muted uppercase tracking-wider text-center cursor-pointer hover:text-charcoal select-none ' +
        (extraClass ?? '')
      }
      onClick={() => toggle(field)}
    >
      {label} {active ? (sortDir === 'asc' ? '↑' : '↓') : ''}
    </th>
  );
}
