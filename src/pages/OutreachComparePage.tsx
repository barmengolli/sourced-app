// OutreachComparePage — the Compare sub-tab. Two modes:
//
//   Mode 1 "Sequence comparison": pick two sequences (A vs B), each with
//   its own week range; render a side-by-side metrics card and an overlaid
//   trend line chart.
//   Mode 2 "Period comparison": pick two week ranges and a sequence set;
//   render aggregate side-by-side and an overlaid trend chart for the two
//   periods.
//
// Both modes consume the lifted Outreach selectors from App.tsx (year /
// region / selectedSequences) for filtering the snapshot stream. Region
// is inferred client-side from sequence_name. The page-local controls
// (selected sequences A/B, period A/B ranges, mode toggle, trend metric)
// are intentionally NOT lifted: they don't make sense outside the Compare
// view.

import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  REGIONS,
  REGION_LABELS,
  type RegionKey,
} from '../constants/regions';
import { inferRegionFromSequenceName } from '../lib/outreach';
import type { OutreachSnapshot } from '../types/db';
import type { OutreachSubPageProps } from '../App';
import SequenceMultiSelect from '../components/outreach/SequenceMultiSelect';

type Mode = 'sequence' | 'period';

const COMPARE_METRICS: {
  label: string;
  isRate?: boolean;
  // For raw counts:
  countKey?: keyof OutreachSnapshot;
  // For computed rates:
  rateNum?: keyof OutreachSnapshot;
  rateDen?: keyof OutreachSnapshot;
}[] = [
  { label: 'Emails Sent', countKey: 'total_sent' },
  { label: 'Delivered', countKey: 'delivered' },
  { label: 'Delivery Rate', isRate: true, rateNum: 'delivered', rateDen: 'total_sent' },
  { label: 'Opened', countKey: 'opened' },
  { label: 'Open Rate', isRate: true, rateNum: 'opened', rateDen: 'delivered' },
  { label: 'Clicked', countKey: 'clicked' },
  { label: 'Click Rate', isRate: true, rateNum: 'clicked', rateDen: 'delivered' },
  { label: 'Replied', countKey: 'replied' },
  { label: 'Reply Rate', isRate: true, rateNum: 'replied', rateDen: 'delivered' },
  { label: 'Opted Out', countKey: 'opted_out' },
  { label: 'Outbound Calls', countKey: 'outbound_calls' },
  { label: 'LinkedIn Tasks', countKey: 'linkedin_tasks_completed' },
];

type TrendMetricKey =
  | 'open_rate'
  | 'reply_rate'
  | 'click_rate'
  | 'total_sent'
  | 'delivered'
  | 'opened'
  | 'replied';

interface TrendMetricRate {
  key: TrendMetricKey;
  label: string;
  isRate: true;
  rateNum: keyof OutreachSnapshot;
  rateDen: keyof OutreachSnapshot;
}
interface TrendMetricCount {
  key: TrendMetricKey;
  label: string;
  isRate: false;
  countKey: keyof OutreachSnapshot;
}
type TrendMetric = TrendMetricRate | TrendMetricCount;

const TREND_METRICS: TrendMetric[] = [
  { key: 'open_rate', label: 'Open Rate', isRate: true, rateNum: 'opened', rateDen: 'delivered' },
  { key: 'reply_rate', label: 'Reply Rate', isRate: true, rateNum: 'replied', rateDen: 'delivered' },
  { key: 'click_rate', label: 'Click Rate', isRate: true, rateNum: 'clicked', rateDen: 'delivered' },
  { key: 'total_sent', label: 'Sent', isRate: false, countKey: 'total_sent' },
  { key: 'delivered', label: 'Delivered', isRate: false, countKey: 'delivered' },
  { key: 'opened', label: 'Opened', isRate: false, countKey: 'opened' },
  { key: 'replied', label: 'Replied', isRate: false, countKey: 'replied' },
];

function getNum(snap: OutreachSnapshot, key: keyof OutreachSnapshot): number {
  return (snap[key] as number) || 0;
}

function aggregateRate(
  snaps: OutreachSnapshot[],
  num: keyof OutreachSnapshot,
  den: keyof OutreachSnapshot,
): number {
  let n = 0;
  let d = 0;
  for (const s of snaps) {
    n += getNum(s, num);
    d += getNum(s, den);
  }
  return d > 0 ? n / d : 0;
}

function aggregateSum(
  snaps: OutreachSnapshot[],
  key: keyof OutreachSnapshot,
): number {
  let total = 0;
  for (const s of snaps) total += getNum(s, key);
  return total;
}

export default function OutreachComparePage({
  year,
  regions,
  selectedSequences,
  onYearChange,
  onRegionsChange,
  onSelectedSequencesChange,
  snapshots,
  loading,
}: OutreachSubPageProps) {
  const [mode, setMode] = useState<Mode>('sequence');

  // Year-scoped + region-filtered snapshots. Mode-specific filtering
  // happens below.
  const yearScoped = useMemo(() => {
    const allOn = regions.size === REGIONS.length;
    return snapshots.filter((s) => {
      if (s.year !== year) return false;
      if (!allOn) {
        const r = inferRegionFromSequenceName(s.sequence_name);
        if (!regions.has(r)) return false;
      }
      return true;
    });
  }, [snapshots, year, regions]);

  const sequenceOptions = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of yearScoped) {
      if (!m.has(s.sequence_id)) m.set(s.sequence_id, s.sequence_name);
    }
    return [...m.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [yearScoped]);

  const yearOptions = useMemo(() => {
    const ys = new Set<number>([new Date().getFullYear()]);
    for (const s of snapshots) ys.add(s.year);
    return [...ys].sort((a, b) => a - b);
  }, [snapshots]);

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
            Outreach — Compare
          </h1>
          <p className="mt-1 text-sm text-slate-muted">
            Compare two sequences across the same period, or one sequence
            set across two periods. Aggregate totals on the left, overlaid
            trend on the right.
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
          <ModeToggle mode={mode} onChange={setMode} />
        </div>
      </header>

      <section className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 ml-auto">
          {mode === 'period' && (
            <SequenceMultiSelect
              sequences={sequenceOptions}
              selectedIds={selectedSequences}
              onChange={onSelectedSequencesChange}
            />
          )}
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

      {loading && yearScoped.length === 0 ? (
        <p className="text-sm text-slate-muted italic">Loading…</p>
      ) : mode === 'sequence' ? (
        <SequenceComparison
          yearScoped={yearScoped}
          sequenceOptions={sequenceOptions}
        />
      ) : (
        <PeriodComparison
          yearScoped={yearScoped}
          selectedSequences={selectedSequences}
          sequenceOptions={sequenceOptions}
        />
      )}
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  const opts: { value: Mode; label: string }[] = [
    { value: 'sequence', label: 'Sequence comparison' },
    { value: 'period', label: 'Period comparison' },
  ];
  return (
    <div className="flex items-center gap-1">
      {opts.map((o) => {
        const active = o.value === mode;
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

// ---------- Mode 1: Sequence comparison ----------

interface SequenceComparisonProps {
  yearScoped: OutreachSnapshot[];
  sequenceOptions: { id: number; name: string }[];
}

function SequenceComparison({
  yearScoped,
  sequenceOptions,
}: SequenceComparisonProps) {
  const [seqAId, setSeqAId] = useState<number | null>(null);
  const [seqBId, setSeqBId] = useState<number | null>(null);
  const [weekFromA, setWeekFromA] = useState<number | null>(null);
  const [weekToA, setWeekToA] = useState<number | null>(null);
  const [weekFromB, setWeekFromB] = useState<number | null>(null);
  const [weekToB, setWeekToB] = useState<number | null>(null);
  const [trendMetric, setTrendMetric] = useState<TrendMetricKey>('open_rate');

  // Default A/B to the top two sequences (by total sent in year scope)
  // once data arrives. Top performers, not alphabetical, so the page
  // boots into a meaningful comparison.
  useEffect(() => {
    if (sequenceOptions.length === 0) return;
    if (seqAId !== null && seqBId !== null) return;
    const totals = new Map<number, number>();
    for (const s of yearScoped) {
      totals.set(s.sequence_id, (totals.get(s.sequence_id) ?? 0) + s.total_sent);
    }
    const ranked = [...sequenceOptions]
      .map((opt) => ({ ...opt, total: totals.get(opt.id) ?? 0 }))
      .sort((a, b) => b.total - a.total);
    if (seqAId === null && ranked[0]) setSeqAId(ranked[0].id);
    if (seqBId === null && ranked[1]) setSeqBId(ranked[1].id);
  }, [yearScoped, sequenceOptions, seqAId, seqBId]);

  const allWeeks = useMemo(
    () =>
      [...new Set(yearScoped.map((s) => s.week_number))].sort((a, b) => a - b),
    [yearScoped],
  );

  const weeksA = useMemo(
    () =>
      seqAId
        ? allWeeks.filter((w) =>
            yearScoped.some(
              (s) => s.sequence_id === seqAId && s.week_number === w,
            ),
          )
        : allWeeks,
    [seqAId, yearScoped, allWeeks],
  );
  const weeksB = useMemo(
    () =>
      seqBId
        ? allWeeks.filter((w) =>
            yearScoped.some(
              (s) => s.sequence_id === seqBId && s.week_number === w,
            ),
          )
        : allWeeks,
    [seqBId, yearScoped, allWeeks],
  );

  // From/To resolution: nullable selectors mean "first" / "latest" of the
  // sequence's available weeks; swap if the user picks an inverted range.
  let effFromA = weekFromA ?? weeksA[0] ?? null;
  let effToA = weekToA ?? weeksA[weeksA.length - 1] ?? null;
  if (effFromA && effToA && effFromA > effToA) {
    [effFromA, effToA] = [effToA, effFromA];
  }
  let effFromB = weekFromB ?? weeksB[0] ?? null;
  let effToB = weekToB ?? weeksB[weeksB.length - 1] ?? null;
  if (effFromB && effToB && effFromB > effToB) {
    [effFromB, effToB] = [effToB, effFromB];
  }

  const snapsA = useMemo(() => {
    if (!seqAId || !effFromA || !effToA) return [];
    return yearScoped.filter(
      (s) =>
        s.sequence_id === seqAId &&
        s.week_number >= effFromA &&
        s.week_number <= effToA,
    );
  }, [yearScoped, seqAId, effFromA, effToA]);
  const snapsB = useMemo(() => {
    if (!seqBId || !effFromB || !effToB) return [];
    return yearScoped.filter(
      (s) =>
        s.sequence_id === seqBId &&
        s.week_number >= effFromB &&
        s.week_number <= effToB,
    );
  }, [yearScoped, seqBId, effFromB, effToB]);

  const seqAName = sequenceOptions.find((s) => s.id === seqAId)?.name ?? '';
  const seqBName = sequenceOptions.find((s) => s.id === seqBId)?.name ?? '';

  // Trend chart: walk the weeks in each range, evaluate the metric per
  // weekly snapshot. Two lines, one per sequence. X axis is the week
  // number; for unequal ranges we plot whichever weeks each sequence has.
  const trendData = useMemo(() => {
    const meta = TREND_METRICS.find((m) => m.key === trendMetric)!;
    const sortedA = [...snapsA].sort((a, b) => a.week_number - b.week_number);
    const sortedB = [...snapsB].sort((a, b) => a.week_number - b.week_number);
    const xLabels = [
      ...new Set([
        ...sortedA.map((s) => s.week_number),
        ...sortedB.map((s) => s.week_number),
      ]),
    ].sort((a, b) => a - b);
    const valueOf = (s: OutreachSnapshot): number => {
      if (meta.isRate) {
        const den = getNum(s, meta.rateDen);
        if (den === 0) return 0;
        return Math.round((getNum(s, meta.rateNum) / den) * 10000) / 100;
      }
      return getNum(s, meta.countKey);
    };
    return xLabels.map((week) => {
      const a = sortedA.find((s) => s.week_number === week);
      const b = sortedB.find((s) => s.week_number === week);
      const point: Record<string, string | number | null> = {
        week: `W${week}`,
      };
      if (a) point[seqAName || 'A'] = valueOf(a);
      if (b) point[seqBName || 'B'] = valueOf(b);
      return point;
    });
  }, [snapsA, snapsB, trendMetric, seqAName, seqBName]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SequenceCard
          accent="blue"
          label="Sequence A"
          sequenceOptions={sequenceOptions}
          seqId={seqAId}
          onSeqChange={(id) => {
            setSeqAId(id);
            setWeekFromA(null);
            setWeekToA(null);
          }}
          weeks={weeksA}
          weekFrom={weekFromA}
          weekTo={weekToA}
          setWeekFrom={setWeekFromA}
          setWeekTo={setWeekToA}
        />
        <SequenceCard
          accent="purple"
          label="Sequence B"
          sequenceOptions={sequenceOptions}
          seqId={seqBId}
          onSeqChange={(id) => {
            setSeqBId(id);
            setWeekFromB(null);
            setWeekToB(null);
          }}
          weeks={weeksB}
          weekFrom={weekFromB}
          weekTo={weekToB}
          setWeekFrom={setWeekFromB}
          setWeekTo={setWeekToB}
        />
      </div>

      {snapsA.length > 0 && snapsB.length > 0 ? (
        <SideBySideMetrics
          aName={seqAName}
          bName={seqBName}
          aRange={`W${effFromA}-W${effToA}`}
          bRange={`W${effFromB}-W${effToB}`}
          aSnaps={snapsA}
          bSnaps={snapsB}
        />
      ) : (
        <p className="py-12 text-center text-slate-muted text-sm italic">
          Pick two sequences and a week range to compare.
        </p>
      )}

      {trendData.length > 0 && (
        <TrendCard
          aName={seqAName || 'A'}
          bName={seqBName || 'B'}
          data={trendData}
          metric={trendMetric}
          onMetricChange={setTrendMetric}
        />
      )}
    </div>
  );
}

// ---------- Sequence card (used in Mode 1) ----------

function SequenceCard({
  accent,
  label,
  sequenceOptions,
  seqId,
  onSeqChange,
  weeks,
  weekFrom,
  weekTo,
  setWeekFrom,
  setWeekTo,
}: {
  accent: 'blue' | 'purple';
  label: string;
  sequenceOptions: { id: number; name: string }[];
  seqId: number | null;
  onSeqChange: (id: number | null) => void;
  weeks: number[];
  weekFrom: number | null;
  weekTo: number | null;
  setWeekFrom: (w: number | null) => void;
  setWeekTo: (w: number | null) => void;
}) {
  const accentBorder =
    accent === 'blue' ? 'border-blue-200' : 'border-purple-200';
  const accentText =
    accent === 'blue' ? 'text-blue-700' : 'text-purple-700';
  const focusRing =
    accent === 'blue' ? 'focus:ring-blue-300' : 'focus:ring-purple-300';

  return (
    <div className={`bg-white rounded-lg border ${accentBorder} shadow-sm p-3`}>
      <label
        className={`block text-[10px] ${accentText} font-semibold uppercase tracking-wider mb-1`}
      >
        {label}
      </label>
      <select
        value={seqId ?? ''}
        onChange={(e) => onSeqChange(e.target.value ? Number(e.target.value) : null)}
        className={`w-full border border-border rounded px-3 py-2 text-sm bg-bg text-charcoal focus:outline-none focus:ring-2 ${focusRing} mb-2`}
      >
        <option value="">Select…</option>
        {sequenceOptions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <WeekRangeSelector
        weeks={weeks}
        from={weekFrom}
        to={weekTo}
        setFrom={setWeekFrom}
        setTo={setWeekTo}
      />
    </div>
  );
}

function WeekRangeSelector({
  weeks,
  from,
  to,
  setFrom,
  setTo,
}: {
  weeks: number[];
  from: number | null;
  to: number | null;
  setFrom: (w: number | null) => void;
  setTo: (w: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] text-slate-muted">
      <span>Weeks:</span>
      <select
        value={from ?? ''}
        onChange={(e) => setFrom(e.target.value ? Number(e.target.value) : null)}
        className="border border-border rounded px-1.5 py-0.5 text-[10px] bg-bg text-charcoal"
      >
        <option value="">First</option>
        {weeks.map((w) => (
          <option key={w} value={w}>
            W{w}
          </option>
        ))}
      </select>
      <span>to</span>
      <select
        value={to ?? ''}
        onChange={(e) => setTo(e.target.value ? Number(e.target.value) : null)}
        className="border border-border rounded px-1.5 py-0.5 text-[10px] bg-bg text-charcoal"
      >
        <option value="">Latest</option>
        {weeks.map((w) => (
          <option key={w} value={w}>
            W{w}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------- Side-by-side aggregate metrics (shared by both modes) ----------

function SideBySideMetrics({
  aName,
  bName,
  aRange,
  bRange,
  aSnaps,
  bSnaps,
}: {
  aName: string;
  bName: string;
  aRange: string;
  bRange: string;
  aSnaps: OutreachSnapshot[];
  bSnaps: OutreachSnapshot[];
}) {
  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="text-center">
          <span className="text-xs font-semibold text-blue-700">{aName}</span>
          <span className="text-[10px] text-slate-muted ml-1">{aRange}</span>
        </div>
        <div className="text-center">
          <span className="text-xs font-semibold text-purple-700">{bName}</span>
          <span className="text-[10px] text-slate-muted ml-1">{bRange}</span>
        </div>
      </div>
      <div className="divide-y divide-border">
        {COMPARE_METRICS.map((m, i) => {
          let valA: number;
          let valB: number;
          if (m.isRate && m.rateNum && m.rateDen) {
            valA = aggregateRate(aSnaps, m.rateNum, m.rateDen);
            valB = aggregateRate(bSnaps, m.rateNum, m.rateDen);
          } else if (m.countKey) {
            valA = aggregateSum(aSnaps, m.countKey);
            valB = aggregateSum(bSnaps, m.countKey);
          } else {
            valA = 0;
            valB = 0;
          }
          return (
            <MetricBar
              key={i}
              label={m.label}
              valA={valA}
              valB={valB}
              isRate={m.isRate}
            />
          );
        })}
      </div>
    </div>
  );
}

function MetricBar({
  label,
  valA,
  valB,
  isRate,
}: {
  label: string;
  valA: number;
  valB: number;
  isRate?: boolean;
}) {
  const max = Math.max(valA, valB, 0.001);
  const widthA = (valA / max) * 100;
  const widthB = (valB / max) * 100;
  const aWins = valA > valB;
  const bWins = valB > valA;
  const fmt = (v: number) =>
    isRate ? `${(v * 100).toFixed(1)}%` : v.toLocaleString();
  // Percentage difference: A vs B, signed. Renders next to the leader.
  const delta =
    valA === 0 && valB === 0
      ? null
      : valA === valB
        ? 0
        : valA > valB
          ? valB === 0
            ? null
            : ((valA - valB) / valB) * 100
          : valA === 0
            ? null
            : ((valB - valA) / valA) * 100;
  const deltaLabel =
    delta === null
      ? ''
      : `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-slate-muted">{label}</span>
        {delta !== null && delta !== 0 && (
          <span
            className={
              'text-[9px] font-medium ' +
              (aWins ? 'text-blue-700' : 'text-purple-700')
            }
          >
            {aWins ? '◀ A' : 'B ▶'} {deltaLabel}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="text-right">
          <span
            className={
              'text-xs font-medium tabular-nums ' +
              (aWins ? 'text-blue-700' : 'text-charcoal')
            }
          >
            {fmt(valA)}
          </span>
          <div className="flex justify-end mt-0.5">
            <div
              className="h-2 rounded-full bg-blue-400"
              style={{ width: `${widthA}%`, minWidth: valA > 0 ? '4px' : '0' }}
            />
          </div>
        </div>
        <div>
          <span
            className={
              'text-xs font-medium tabular-nums ' +
              (bWins ? 'text-purple-700' : 'text-charcoal')
            }
          >
            {fmt(valB)}
          </span>
          <div className="mt-0.5">
            <div
              className="h-2 rounded-full bg-purple-400"
              style={{ width: `${widthB}%`, minWidth: valB > 0 ? '4px' : '0' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Trend card (overlaid two-line chart) ----------

function TrendCard({
  aName,
  bName,
  data,
  metric,
  onMetricChange,
}: {
  aName: string;
  bName: string;
  data: Record<string, string | number | null>[];
  metric: TrendMetricKey;
  onMetricChange: (k: TrendMetricKey) => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-border shadow-sm p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-semibold text-charcoal">
          Period-over-Period Trend
        </h3>
        <select
          value={metric}
          onChange={(e) => onMetricChange(e.target.value as TrendMetricKey)}
          className="text-xs border border-border rounded px-2 py-1 bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo/30"
        >
          {TREND_METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
          <XAxis dataKey="week" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 10 }} />
          <Line
            type="monotone"
            dataKey={aName}
            stroke="#3b82f6"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey={bName}
            stroke="#8b5cf6"
            strokeWidth={2}
            dot={{ r: 3 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------- Mode 2: Period comparison ----------

interface PeriodComparisonProps {
  yearScoped: OutreachSnapshot[];
  selectedSequences: Set<number>;
  sequenceOptions: { id: number; name: string }[];
}

function PeriodComparison({
  yearScoped,
  selectedSequences,
  sequenceOptions,
}: PeriodComparisonProps) {
  const allWeeks = useMemo(
    () =>
      [...new Set(yearScoped.map((s) => s.week_number))].sort((a, b) => a - b),
    [yearScoped],
  );

  const [pAFrom, setPAFrom] = useState<number | null>(null);
  const [pATo, setPATo] = useState<number | null>(null);
  const [pBFrom, setPBFrom] = useState<number | null>(null);
  const [pBTo, setPBTo] = useState<number | null>(null);
  const [trendMetric, setTrendMetric] = useState<TrendMetricKey>('open_rate');

  // Sensible default ranges once data arrives: Period A = the latest 4
  // weeks, Period B = the 4 weeks before that. Common quarter-on-quarter
  // pattern.
  useEffect(() => {
    if (allWeeks.length === 0) return;
    if (pAFrom !== null || pATo !== null || pBFrom !== null || pBTo !== null) {
      return;
    }
    const last = allWeeks[allWeeks.length - 1];
    const aTo = last;
    const aFrom = allWeeks[Math.max(0, allWeeks.length - 4)] ?? last;
    const bTo = allWeeks[Math.max(0, allWeeks.length - 5)] ?? aFrom;
    const bFrom = allWeeks[Math.max(0, allWeeks.length - 8)] ?? bTo;
    setPAFrom(aFrom);
    setPATo(aTo);
    setPBFrom(bFrom);
    setPBTo(bTo);
  }, [allWeeks, pAFrom, pATo, pBFrom, pBTo]);

  const allSeqs =
    selectedSequences.size === 0 ||
    selectedSequences.size === sequenceOptions.length;
  const sequenceFiltered = useMemo(
    () =>
      allSeqs
        ? yearScoped
        : yearScoped.filter((s) => selectedSequences.has(s.sequence_id)),
    [yearScoped, selectedSequences, allSeqs],
  );

  let effFromA = pAFrom ?? allWeeks[0] ?? null;
  let effToA = pATo ?? allWeeks[allWeeks.length - 1] ?? null;
  if (effFromA && effToA && effFromA > effToA) {
    [effFromA, effToA] = [effToA, effFromA];
  }
  let effFromB = pBFrom ?? allWeeks[0] ?? null;
  let effToB = pBTo ?? allWeeks[allWeeks.length - 1] ?? null;
  if (effFromB && effToB && effFromB > effToB) {
    [effFromB, effToB] = [effToB, effFromB];
  }

  const snapsA = useMemo(() => {
    if (!effFromA || !effToA) return [];
    return sequenceFiltered.filter(
      (s) => s.week_number >= effFromA && s.week_number <= effToA,
    );
  }, [sequenceFiltered, effFromA, effToA]);
  const snapsB = useMemo(() => {
    if (!effFromB || !effToB) return [];
    return sequenceFiltered.filter(
      (s) => s.week_number >= effFromB && s.week_number <= effToB,
    );
  }, [sequenceFiltered, effFromB, effToB]);

  const aName = `Period A`;
  const bName = `Period B`;

  // Trend chart: walk weeks in each period, aggregate the metric across
  // the selected sequences for each week. Two lines, one per period.
  // X labels are normalized to "W1, W2, ..." offsets so two unequal
  // ranges still overlay readably.
  const trendData = useMemo(() => {
    const meta = TREND_METRICS.find((m) => m.key === trendMetric)!;
    const weeksA = effFromA && effToA
      ? allWeeks.filter((w) => w >= effFromA && w <= effToA)
      : [];
    const weeksB = effFromB && effToB
      ? allWeeks.filter((w) => w >= effFromB && w <= effToB)
      : [];
    const len = Math.max(weeksA.length, weeksB.length);
    const valueFor = (subset: OutreachSnapshot[]): number =>
      meta.isRate
        ? Math.round(aggregateRate(subset, meta.rateNum, meta.rateDen) * 10000) /
          100
        : aggregateSum(subset, meta.countKey);
    const points: Record<string, string | number | null>[] = [];
    for (let i = 0; i < len; i++) {
      const wa = weeksA[i];
      const wb = weeksB[i];
      const point: Record<string, string | number | null> = {
        week: `+${i + 1}`,
      };
      if (wa !== undefined) {
        point[`${aName} (W${wa})`] = valueFor(
          snapsA.filter((s) => s.week_number === wa),
        );
      }
      if (wb !== undefined) {
        point[`${bName} (W${wb})`] = valueFor(
          snapsB.filter((s) => s.week_number === wb),
        );
      }
      points.push(point);
    }
    return points;
  }, [snapsA, snapsB, allWeeks, effFromA, effToA, effFromB, effToB, trendMetric]);

  // Recharts needs the actual line dataKey strings; build them from the
  // first data point so the legend matches the labels above.
  const lineKeys = useMemo(() => {
    if (trendData.length === 0) return { a: aName, b: bName };
    const keys = Object.keys(trendData[0]).filter((k) => k !== 'week');
    return {
      a: keys.find((k) => k.startsWith(aName)) ?? aName,
      b: keys.find((k) => k.startsWith(bName)) ?? bName,
    };
  }, [trendData, aName, bName]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-lg border border-blue-200 shadow-sm p-3">
          <label className="block text-[10px] text-blue-700 font-semibold uppercase tracking-wider mb-1">
            Period A
          </label>
          <WeekRangeSelector
            weeks={allWeeks}
            from={pAFrom}
            to={pATo}
            setFrom={setPAFrom}
            setTo={setPATo}
          />
        </div>
        <div className="bg-white rounded-lg border border-purple-200 shadow-sm p-3">
          <label className="block text-[10px] text-purple-700 font-semibold uppercase tracking-wider mb-1">
            Period B
          </label>
          <WeekRangeSelector
            weeks={allWeeks}
            from={pBFrom}
            to={pBTo}
            setFrom={setPBFrom}
            setTo={setPBTo}
          />
        </div>
      </div>

      {snapsA.length > 0 && snapsB.length > 0 ? (
        <SideBySideMetrics
          aName={aName}
          bName={bName}
          aRange={`W${effFromA}-W${effToA}`}
          bRange={`W${effFromB}-W${effToB}`}
          aSnaps={snapsA}
          bSnaps={snapsB}
        />
      ) : (
        <p className="py-12 text-center text-slate-muted text-sm italic">
          Pick two periods to compare. Use the Sequences dropdown above to
          scope the comparison.
        </p>
      )}

      {trendData.length > 0 && (
        <TrendCard
          aName={lineKeys.a}
          bName={lineKeys.b}
          data={trendData}
          metric={trendMetric}
          onMetricChange={setTrendMetric}
        />
      )}
    </div>
  );
}
