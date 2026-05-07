// OutreachDashboardPage — the Dashboard sub-tab of the Outreach section.
// Mirrors DataVis 1's outreach dashboard panels (RegionCompare,
// EngagementFunnel, TopPerformers / Sequence Rankings, ActivityHeatmap),
// adapted to Sourced's IA: shared selectors live on App.tsx (year, quarter,
// week, regions, selectedSequences) and a single useOutreachSnapshots()
// query feeds every panel.
//
// Computation: filter the snapshot stream by year/region/sequence in-memory
// per panel, then bucket by ISO week. Region is inferred client-side from
// sequence_name via inferRegionFromSequenceName.

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

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function weekRangeLabel(w: IsoWeek): string {
  const mon = isoWeekStart(w.year, w.week);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  return `${fmtDate(mon)} – ${fmtDate(sun)}`;
}

export default function OutreachDashboardPage({
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
  const yearOptions = useMemo(() => {
    const ys = new Set<number>([new Date().getFullYear()]);
    for (const s of snapshots) ys.add(s.year);
    return [...ys].sort((a, b) => a - b);
  }, [snapshots]);

  const quarterWeeks = useMemo(
    () => weeksInQuarter(year, quarter),
    [year, quarter],
  );

  const effectiveWeek = useMemo(() => {
    return quarterWeeks.find((w) => w.week === week) ?? quarterWeeks[0];
  }, [quarterWeeks, week]);

  const prevWeek: IsoWeek | null = useMemo(() => {
    if (!effectiveWeek) return null;
    const idx = quarterWeeks.findIndex((w) => w.week === effectiveWeek.week);
    if (idx <= 0) return null;
    return quarterWeeks[idx - 1];
  }, [quarterWeeks, effectiveWeek]);

  // Sequences for the multi-select (distinct ids in the data).
  const sequenceOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of snapshots) {
      if (!m.has(s.sequence_id)) m.set(s.sequence_id, s.sequence_name);
    }
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [snapshots]);

  // Pre-filter snapshots for the active year + region + sequences set.
  // Empty selectedSequences = "All Sequences" (DataVis convention).
  const scopedSnapshots = useMemo(() => {
    const allRegionsOn = regions.size === REGIONS.length;
    const allSeqs =
      selectedSequences.size === 0 ||
      selectedSequences.size === sequenceOptions.length;
    return snapshots.filter((s) => {
      if (s.year !== year) return false;
      if (!allRegionsOn) {
        const r = inferRegionFromSequenceName(s.sequence_name);
        if (!regions.has(r)) return false;
      }
      if (!allSeqs && !selectedSequences.has(s.sequence_id)) return false;
      return true;
    });
  }, [snapshots, year, regions, selectedSequences, sequenceOptions]);

  const currentRows = useMemo(() => {
    if (!effectiveWeek) return [];
    return scopedSnapshots.filter((s) => s.week_number === effectiveWeek.week);
  }, [scopedSnapshots, effectiveWeek]);

  const prevRows = useMemo(() => {
    if (!prevWeek) return [];
    return scopedSnapshots.filter((s) => s.week_number === prevWeek.week);
  }, [scopedSnapshots, prevWeek]);

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
            Outreach — Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            Aggregate metrics for the selected ISO week. Cards and charts
            recompute from outreach_snapshots; deltas compare to the prior
            week.
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

      {loading && currentRows.length === 0 ? (
        <p className="text-sm text-slate-muted italic">Loading…</p>
      ) : (
        <>
          <SummaryCards current={currentRows} previous={prevRows} prevWeek={prevWeek} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RegionPerformanceCard
              currentRows={currentRows}
              previousRows={prevRows}
              currentWeek={effectiveWeek}
              prevWeek={prevWeek}
            />
            <EngagementFunnelCard rows={currentRows} />
            <SequenceRankingsCard rows={currentRows} />
            <ActivityHeatmapCard
              snapshots={scopedSnapshots}
              quarterWeeks={quarterWeeks}
              effectiveWeek={effectiveWeek}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Aggregations ----------

interface RegionStats {
  sent: number;
  delivered: number;
  opened: number;
  replied: number;
  calls: number;
  linkedin: number;
}

function aggregate(snaps: OutreachSnapshot[]): RegionStats {
  const init: RegionStats = {
    sent: 0,
    delivered: 0,
    opened: 0,
    replied: 0,
    calls: 0,
    linkedin: 0,
  };
  for (const s of snaps) {
    init.sent += s.total_sent;
    init.delivered += s.delivered;
    init.opened += s.opened;
    init.replied += s.replied;
    init.calls += s.outbound_calls;
    init.linkedin += s.linkedin_tasks_completed;
  }
  return init;
}

// ---------- Summary cards ----------

function SummaryCards({
  current,
  previous,
  prevWeek,
}: {
  current: OutreachSnapshot[];
  previous: OutreachSnapshot[];
  prevWeek: IsoWeek | null;
}) {
  const cur = aggregate(current);
  const prev = aggregate(previous);
  const cards: { label: string; key: keyof RegionStats }[] = [
    { label: 'Emails Sent', key: 'sent' },
    { label: 'Delivered', key: 'delivered' },
    { label: 'Opened', key: 'opened' },
    { label: 'Replied', key: 'replied' },
    { label: 'Outbound Calls', key: 'calls' },
    { label: 'LinkedIn Tasks', key: 'linkedin' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map(({ label, key }) => {
        const c = cur[key];
        const p = prev[key];
        const delta = c - p;
        const pct = p === 0 ? null : Math.round((delta / p) * 1000) / 10;
        let arrow: string;
        let cls: string;
        if (delta > 0) {
          arrow = `▲${delta.toLocaleString()}`;
          cls = 'text-green-600';
        } else if (delta < 0) {
          arrow = `▼${Math.abs(delta).toLocaleString()}`;
          cls = 'text-red-500';
        } else {
          arrow = '–';
          cls = 'text-slate-muted';
        }
        return (
          <div
            key={key}
            className="bg-white border border-border rounded-lg p-3 shadow-sm"
            title={
              prevWeek
                ? `W${prevWeek.week}: ${p.toLocaleString()}, current: ${c.toLocaleString()}`
                : `current: ${c.toLocaleString()}`
            }
          >
            <div className="text-[10px] uppercase tracking-wider text-slate-muted">
              {label}
            </div>
            <div className="mt-1 text-2xl font-semibold text-charcoal tabular-nums">
              {c.toLocaleString()}
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

// ---------- Region Performance ----------

function DeltaBadge({
  current,
  previous,
}: {
  current: number;
  previous: number;
}) {
  if (current === 0 && previous === 0) {
    return <span className="text-[9px] text-slate-300">–</span>;
  }
  const diff = current - previous;
  if (diff === 0) return <span className="text-[9px] text-slate-300">–</span>;
  const color = diff > 0 ? 'text-green-600' : 'text-red-500';
  const arrow = diff > 0 ? '▲' : '▼';
  return (
    <span className={`text-[9px] ${color}`}>
      {arrow}
      {Math.abs(diff).toLocaleString()}
    </span>
  );
}

const REGION_METRICS: { key: keyof RegionStats; label: string }[] = [
  { key: 'sent', label: 'Emails Sent' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'opened', label: 'Opened' },
  { key: 'replied', label: 'Replied' },
  { key: 'calls', label: 'Outbound Calls' },
  { key: 'linkedin', label: 'LinkedIn Tasks' },
];

function RegionPerformanceCard({
  currentRows,
  previousRows,
  currentWeek,
  prevWeek,
}: {
  currentRows: OutreachSnapshot[];
  previousRows: OutreachSnapshot[];
  currentWeek: IsoWeek | null;
  prevWeek: IsoWeek | null;
}) {
  const data = useMemo(() => {
    const targetRegions: RegionKey[] = ['NA', 'EMEA'];
    return targetRegions.map((region) => ({
      region,
      current: aggregate(
        currentRows.filter(
          (s) => inferRegionFromSequenceName(s.sequence_name) === region,
        ),
      ),
      previous: aggregate(
        previousRows.filter(
          (s) => inferRegionFromSequenceName(s.sequence_name) === region,
        ),
      ),
    }));
  }, [currentRows, previousRows]);

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold text-charcoal">
          Region Performance
        </h3>
        {currentWeek && prevWeek && (
          <span className="text-[10px] text-slate-muted">
            W{currentWeek.week} vs W{prevWeek.week}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-0">
        {data.map(({ region, current, previous }, ri) => (
          <div
            key={region}
            className={ri === 0 ? 'pr-4 border-r border-border' : 'pl-4'}
          >
            <h4 className="text-sm font-bold text-charcoal mb-3 text-center">
              {region}
            </h4>
            <div className="divide-y divide-border">
              {REGION_METRICS.map((m) => (
                <div
                  key={m.key}
                  className="flex items-center justify-between py-2"
                >
                  <span className="text-xs text-slate-muted">{m.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-charcoal tabular-nums">
                      {current[m.key].toLocaleString()}
                    </span>
                    <DeltaBadge
                      current={current[m.key]}
                      previous={previous[m.key]}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Engagement Funnel ----------

const FUNNEL_STAGES = [
  { key: 'total_sent', label: 'Sent', color: '#3b82f6' },
  { key: 'delivered', label: 'Delivered', color: '#6366f1' },
  { key: 'opened', label: 'Opened', color: '#8b5cf6' },
  { key: 'clicked', label: 'Clicked', color: '#a855f7' },
  { key: 'replied', label: 'Replied', color: '#c084fc' },
] as const;

function EngagementFunnelCard({ rows }: { rows: OutreachSnapshot[] }) {
  const stages = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const stage of FUNNEL_STAGES) {
      totals[stage.key] = rows.reduce(
        (sum, s) => sum + ((s[stage.key] as number) || 0),
        0,
      );
    }
    const maxVal = Math.max(...Object.values(totals), 1);
    return FUNNEL_STAGES.map((stage, i) => {
      const value = totals[stage.key];
      const prev = i > 0 ? totals[FUNNEL_STAGES[i - 1].key] : null;
      const conversionRate = prev && prev > 0 ? value / prev : null;
      const widthPct = Math.max((value / maxVal) * 100, 8);
      return { ...stage, value, conversionRate, widthPct };
    });
  }, [rows]);

  const hasData = stages.some((s) => s.value > 0);

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4">
      <h3 className="text-sm font-semibold text-charcoal mb-4">
        Engagement Funnel
      </h3>
      {!hasData ? (
        <p className="py-6 text-center text-slate-muted text-sm italic">
          No data
        </p>
      ) : (
        <div className="space-y-2">
          {stages.map((stage, i) => (
            <div key={stage.key} className="flex items-center gap-3">
              <div className="w-20 text-right text-xs font-medium text-slate-muted shrink-0">
                {stage.label}
              </div>
              <div className="flex-1 relative">
                <div
                  className="h-9 rounded-md flex items-center justify-end px-3 transition-all duration-300"
                  style={{
                    width: `${Math.min(Math.max(stage.widthPct, 5), 100)}%`,
                    backgroundColor: stage.color,
                    minWidth: '60px',
                  }}
                >
                  <span className="text-white text-xs font-bold tabular-nums">
                    {stage.value.toLocaleString()}
                  </span>
                </div>
              </div>
              <div className="w-14 text-right text-xs text-slate-muted shrink-0">
                {i > 0 && stage.conversionRate !== null
                  ? `${(stage.conversionRate * 100).toFixed(1)}%`
                  : ''}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Sequence Rankings ----------

const RATE_METRICS = [
  {
    key: 'open_rate',
    label: 'Open Rate',
    compute: (s: OutreachSnapshot) =>
      s.delivered > 0 ? s.opened / s.delivered : 0,
    format: (v: number) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'reply_rate',
    label: 'Reply Rate',
    compute: (s: OutreachSnapshot) =>
      s.delivered > 0 ? s.replied / s.delivered : 0,
    format: (v: number) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'click_rate',
    label: 'Click Rate',
    compute: (s: OutreachSnapshot) =>
      s.delivered > 0 ? s.clicked / s.delivered : 0,
    format: (v: number) => `${(v * 100).toFixed(1)}%`,
  },
  {
    key: 'outbound_calls',
    label: 'Outbound Calls',
    compute: (s: OutreachSnapshot) => s.outbound_calls,
    format: (v: number) => v.toLocaleString(),
  },
  {
    key: 'linkedin_tasks',
    label: 'LinkedIn Tasks',
    compute: (s: OutreachSnapshot) => s.linkedin_tasks_completed,
    format: (v: number) => v.toLocaleString(),
  },
] as const;

function SequenceRankingsCard({ rows }: { rows: OutreachSnapshot[] }) {
  const [metricIdx, setMetricIdx] = useState(0);
  const metric = RATE_METRICS[metricIdx];

  const ranked = useMemo(() => {
    return rows
      .filter((s) => s.enabled && s.delivered > 10)
      .map((s) => ({ ...s, rate: metric.compute(s) }))
      .sort((a, b) => b.rate - a.rate);
  }, [rows, metric]);

  const top5 = ranked.slice(0, 5);
  const bottom5 = ranked.length > 5 ? ranked.slice(-5).reverse() : [];
  const maxRate = ranked.length > 0 ? ranked[0].rate : 1;

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold text-charcoal">
          Sequence Rankings
        </h3>
        <select
          value={metricIdx}
          onChange={(e) => setMetricIdx(Number(e.target.value))}
          className="text-xs border border-border rounded px-2 py-1 bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo/30"
        >
          {RATE_METRICS.map((m, i) => (
            <option key={m.key} value={i}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {ranked.length === 0 ? (
        <p className="py-6 text-center text-slate-muted text-sm italic">
          No sequences with enough data
        </p>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-[10px] text-green-600 font-semibold uppercase tracking-wider mb-1.5">
              Top Performers
            </p>
            <div className="space-y-1">
              {top5.map((s, i) => (
                <div key={s.sequence_id} className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-muted w-4 shrink-0">
                    {i + 1}.
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="h-5 rounded-full bg-green-100 relative overflow-hidden">
                      <div
                        className="h-full rounded-full bg-green-400"
                        style={{
                          width: `${maxRate > 0 ? (s.rate / maxRate) * 100 : 0}%`,
                        }}
                      />
                      <span className="absolute inset-0 flex items-center px-2 text-[10px] text-charcoal font-medium truncate">
                        {s.sequence_name}
                      </span>
                    </div>
                  </div>
                  <span className="text-xs font-semibold text-green-700 shrink-0 w-16 text-right tabular-nums">
                    {metric.format(s.rate)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {bottom5.length > 0 && (
            <div>
              <p className="text-[10px] text-red-500 font-semibold uppercase tracking-wider mb-1.5">
                Needs Attention
              </p>
              <div className="space-y-1">
                {bottom5.map((s, i) => (
                  <div key={s.sequence_id} className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-muted w-4 shrink-0">
                      {ranked.length - bottom5.length + i + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="h-5 rounded-full bg-red-50 relative overflow-hidden">
                        <div
                          className="h-full rounded-full bg-red-300"
                          style={{
                            width: `${maxRate > 0 ? (s.rate / maxRate) * 100 : 0}%`,
                          }}
                        />
                        <span className="absolute inset-0 flex items-center px-2 text-[10px] text-charcoal font-medium truncate">
                          {s.sequence_name}
                        </span>
                      </div>
                    </div>
                    <span className="text-xs font-semibold text-red-600 shrink-0 w-16 text-right tabular-nums">
                      {metric.format(s.rate)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Activity Heatmap ----------

const HEATMAP_METRICS = [
  { key: 'total_sent', label: 'Emails Sent' },
  { key: 'replied', label: 'Replied' },
  { key: 'outbound_calls', label: 'Outbound Calls' },
  { key: 'linkedin_tasks_completed', label: 'LinkedIn Tasks' },
] as const;

type HeatmapMetricKey = (typeof HEATMAP_METRICS)[number]['key'];

function heatColor(t: number): string {
  if (t <= 0) return '#FFFFFF';
  const x = Math.min(1, Math.max(0, t));
  const r = Math.round(0x06 + (0x4f - 0x06) * x);
  const g = Math.round(0xb6 + (0x46 - 0xb6) * x);
  const b = Math.round(0xd4 + (0xe5 - 0xd4) * x);
  const wash = (1 - x) * 0.6;
  const fr = Math.round(r + (255 - r) * wash);
  const fg = Math.round(g + (255 - g) * wash);
  const fb = Math.round(b + (255 - b) * wash);
  return `rgb(${fr}, ${fg}, ${fb})`;
}

function ActivityHeatmapCard({
  snapshots,
  quarterWeeks,
  effectiveWeek,
}: {
  snapshots: OutreachSnapshot[];
  quarterWeeks: IsoWeek[];
  effectiveWeek: IsoWeek | null;
}) {
  const [metric, setMetric] = useState<HeatmapMetricKey>('total_sent');

  // Rolling window: the 5 weeks ending at the selected week, clamped to
  // the quarter. Earlier weeks fall off the left edge.
  const windowWeeks = useMemo(() => {
    if (!effectiveWeek) return [];
    const idx = quarterWeeks.findIndex((w) => w.week === effectiveWeek.week);
    if (idx < 0) return quarterWeeks.slice(-5);
    const start = Math.max(0, idx - 4);
    return quarterWeeks.slice(start, idx + 1);
  }, [quarterWeeks, effectiveWeek]);

  const { sequences, maxVal } = useMemo(() => {
    const seqMap = new Map<
      number,
      { id: number; name: string; data: Map<number, number> }
    >();
    const windowSet = new Set(windowWeeks.map((w) => w.week));
    for (const s of snapshots) {
      if (!windowSet.has(s.week_number)) continue;
      if (!seqMap.has(s.sequence_id)) {
        seqMap.set(s.sequence_id, {
          id: s.sequence_id,
          name: s.sequence_name,
          data: new Map(),
        });
      }
      const val = (s[metric] as number) || 0;
      const existing = seqMap.get(s.sequence_id)!.data.get(s.week_number) || 0;
      if (val > existing) seqMap.get(s.sequence_id)!.data.set(s.week_number, val);
    }
    const seqs = [...seqMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    let max = 0;
    for (const seq of seqs) {
      for (const v of seq.data.values()) if (v > max) max = v;
    }
    return { sequences: seqs, maxVal: max || 1 };
  }, [snapshots, windowWeeks, metric]);

  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold text-charcoal">
          Activity Heatmap
        </h3>
        <select
          value={metric}
          onChange={(e) => setMetric(e.target.value as HeatmapMetricKey)}
          className="text-xs border border-border rounded px-2 py-1 bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo/30"
        >
          {HEATMAP_METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      {sequences.length === 0 ? (
        <p className="py-6 text-center text-slate-muted text-sm italic">
          No sequence activity in this window
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[10px]">
              <thead>
                <tr>
                  <th className="text-left px-2 py-1 text-slate-muted font-medium min-w-[180px]">
                    Sequence
                  </th>
                  {windowWeeks.map((w) => (
                    <th
                      key={w.week}
                      className="text-center px-1 py-1 text-slate-muted font-medium w-12"
                      title={weekRangeLabel(w)}
                    >
                      W{w.week}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sequences.map((seq) => (
                  <tr key={seq.id}>
                    <td
                      className="px-2 py-1 text-charcoal font-medium truncate max-w-[220px]"
                      title={seq.name}
                    >
                      {seq.name}
                    </td>
                    {windowWeeks.map((w) => {
                      const val = seq.data.get(w.week) || 0;
                      const intensity = val / maxVal;
                      const bg = heatColor(intensity);
                      const text = intensity > 0.55 ? '#FFFFFF' : '#0F172A';
                      return (
                        <td key={w.week} className="px-1 py-1 text-center">
                          <div
                            className="rounded px-1 py-0.5 text-[9px] font-medium tabular-nums"
                            style={{ backgroundColor: bg, color: text }}
                            title={`${seq.name} — W${w.week}: ${val.toLocaleString()}`}
                          >
                            {val > 0 ? val.toLocaleString() : ''}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 mt-3 justify-end">
            <span className="text-[9px] text-slate-muted">Low</span>
            <div className="flex gap-0.5">
              {[0.1, 0.3, 0.5, 0.7, 0.9].map((t) => (
                <div
                  key={t}
                  className="w-4 h-3 rounded"
                  style={{ backgroundColor: heatColor(t) }}
                />
              ))}
            </div>
            <span className="text-[9px] text-slate-muted">High</span>
          </div>
        </>
      )}
    </div>
  );
}
