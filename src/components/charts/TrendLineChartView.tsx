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
import type { CellValues } from '../../lib/compute';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type FunnelStageKey,
} from '../../constants/funnelStages';
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';
import { readJson, writeJson } from '../../lib/storage';

const STORAGE_KEY = 'sourced.charts.trendline.stage';
const COMPARE_KEY = 'sourced.charts.trendline.compare';

type StageFilter = 'all' | FunnelStageKey;

interface QuarterTotals {
  quarter: 1 | 2 | 3 | 4;
  totals: Record<FunnelStageKey, CellValues>;
}

interface TrendLineChartViewProps {
  // index 0 is Q1, 3 is Q4. DashboardPage prepares this by calling
  // computeGrid four times per selected year.
  quarterly: QuarterTotals[];
  // Selected year. Names the current-year series in single-stage
  // compare mode ("2026" vs "2025" beats "MQL" vs "MQL (2025)").
  year: number;
  // Same shape for (year - 1), powering the optional YoY compare
  // lines. When omitted (or all-zero), the compare checkbox hides
  // and the chart renders current-year only.
  quarterlyPrior?: QuarterTotals[];
  priorYear?: number;
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return '';
  return n.toLocaleString();
};

export default function TrendLineChartView({
  quarterly,
  year,
  quarterlyPrior,
  priorYear,
}: TrendLineChartViewProps) {
  const [stageFilter, setStageFilter] = useState<StageFilter>(() =>
    readJson<StageFilter>(STORAGE_KEY, 'all'),
  );
  useEffect(() => {
    writeJson(STORAGE_KEY, stageFilter);
  }, [stageFilter]);

  // YoY compare toggle. Smart default until the user expresses a
  // preference: ON for a single stage (the direct-comparison ask),
  // OFF for all-stages (12 lines is a lot to opt into). Persisted
  // only on an explicit click, so the smart default keeps applying
  // across stage changes until then.
  const [compare, setCompare] = useState<boolean>(() => {
    const stored = readJson<boolean | null>(COMPARE_KEY, null);
    return stored !== null ? stored : stageFilter !== 'all';
  });
  const onCompareToggle = (next: boolean) => {
    writeJson(COMPARE_KEY, next);
    setCompare(next);
  };
  const onStageChange = (next: StageFilter) => {
    setStageFilter(next);
    if (readJson<boolean | null>(COMPARE_KEY, null) === null) {
      setCompare(next !== 'all');
    }
  };

  // Prior year counts as available only when it has at least one
  // nonzero actual in any stage; an all-zero year hides the compare
  // checkbox entirely (e.g. selector on the earliest data year).
  const priorAvailable = useMemo(() => {
    if (!quarterlyPrior || typeof priorYear !== 'number') return false;
    return quarterlyPrior.some((q) =>
      FUNNEL_STAGES.some((stage) => (q.totals[stage].actual ?? 0) !== 0),
    );
  }, [quarterlyPrior, priorYear]);
  const showPrior = compare && priorAvailable;
  const priorKeyOf = (stage: FunnelStageKey) =>
    `${FUNNEL_STAGE_LABELS[stage]} (${priorYear})`;
  // Prior-year dataKeys, used by the custom legend to detect which
  // entries should render a dashed/faded swatch. Keyed on dataKey
  // rather than display name so the year-only names in single-stage
  // mode don't break detection.
  const priorKeys = useMemo(
    () => new Set<string>(FUNNEL_STAGES.map((s) => priorKeyOf(s))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [priorYear],
  );

  // Custom legend: Recharts' default icons ignore strokeDasharray and
  // strokeOpacity, leaving the YoY pair visually identical. Render an
  // inline swatch mirroring each line's actual style instead.
  const renderTrendLegend = (props: {
    payload?: ReadonlyArray<{
      value?: string | number;
      color?: string;
      // Recharts types dataKey as string | number | function; we only
      // care about the string case and narrow before using it.
      dataKey?: unknown;
    }>;
  }) => {
    const entries = props.payload ?? [];
    return (
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-1">
        {entries.map((e, i) => {
          const isPrior =
            typeof e.dataKey === 'string' && priorKeys.has(e.dataKey);
          return (
            <span key={i} className="inline-flex items-center gap-1.5">
              <svg width={28} height={10} aria-hidden="true">
                <line
                  x1={1}
                  y1={5}
                  x2={27}
                  y2={5}
                  stroke={e.color}
                  strokeWidth={2}
                  strokeDasharray={isPrior ? '5 4' : undefined}
                  strokeOpacity={isPrior ? 0.55 : 1}
                />
              </svg>
              <span style={{ fontSize: 11, color: CHART_COLORS.slateMuted }}>
                {e.value}
              </span>
            </span>
          );
        })}
      </div>
    );
  };

  // Always build all-stage rows; we just decide which lines to render below.
  // Prior-year values join the same Q1-Q4 rows (quarter-over-quarter
  // alignment across years) under year-suffixed keys.
  const data = useMemo(() => {
    return quarterly.map((q, i) => {
      const row: Record<string, number | string> = { name: `Q${q.quarter}` };
      for (const stage of FUNNEL_STAGES) {
        row[FUNNEL_STAGE_LABELS[stage]] = q.totals[stage].actual ?? 0;
        if (showPrior && quarterlyPrior) {
          row[priorKeyOf(stage)] =
            quarterlyPrior[i]?.totals[stage].actual ?? 0;
        }
      }
      return row;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quarterly, quarterlyPrior, showPrior, priorYear]);

  const stagesToRender: FunnelStageKey[] =
    stageFilter === 'all' ? [...FUNNEL_STAGES] : [stageFilter];

  const allZero = useMemo(() => {
    return data.every((row) =>
      stagesToRender.every(
        (stage) => (row[FUNNEL_STAGE_LABELS[stage]] as number) === 0,
      ),
    );
  }, [data, stagesToRender]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-muted">Stage</label>
        <select
          value={stageFilter}
          onChange={(e) => onStageChange(e.target.value as StageFilter)}
          className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
        >
          <option value="all">All stages</option>
          {FUNNEL_STAGES.map((s) => (
            <option key={s} value={s}>
              {FUNNEL_STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        {priorAvailable && (
          <label className="flex items-center gap-1.5 text-xs text-slate-muted cursor-pointer">
            <input
              type="checkbox"
              checked={compare}
              onChange={(e) => onCompareToggle(e.target.checked)}
              className="accent-indigo"
            />
            Compare to {priorYear}
          </label>
        )}
      </div>

      {allZero ? (
        <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
          No data for the selected year.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.border} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
              axisLine={{ stroke: CHART_COLORS.border }}
              tickLine={{ stroke: CHART_COLORS.border }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
              axisLine={{ stroke: CHART_COLORS.border }}
              tickLine={{ stroke: CHART_COLORS.border }}
              tickFormatter={(v) => fmt(v)}
              width={48}
            />
            <Tooltip
              formatter={(v) => fmt(v)}
              contentStyle={{
                fontSize: 11,
                border: `1px solid ${CHART_COLORS.border}`,
                borderRadius: 6,
              }}
              labelStyle={{ color: CHART_COLORS.charcoal, fontWeight: 600 }}
            />
            <Legend content={renderTrendLegend} />
            {stagesToRender.flatMap((stage) => {
              // Use the stage's index in FUNNEL_STAGES so colors stay stable
              // across single-stage and all-stage views (Leads is always blue,
              // MQL is always purple, etc.). The prior-year line shares the
              // stage's hue, dashed and muted, so "HPP" vs "HPP (2025)" read
              // as one family.
              const colorIdx = FUNNEL_STAGES.indexOf(stage);
              const color = CHART_PALETTE[colorIdx % CHART_PALETTE.length];
              // Single stage + compare on: name the pair by year alone
              // ("2026" vs "2025"); the stage is already named in the
              // dropdown. All-stages keeps stage-based names so the 12
              // lines stay tellable-apart. dataKeys never change.
              const singleStageCompare = stageFilter !== 'all' && showPrior;
              const lines = [
                <Line
                  key={stage}
                  type="monotone"
                  dataKey={FUNNEL_STAGE_LABELS[stage]}
                  name={
                    singleStageCompare
                      ? String(year)
                      : FUNNEL_STAGE_LABELS[stage]
                  }
                  stroke={color}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                  // Per-point value labels. Smaller and slate-muted to
                  // keep multi-line charts uncluttered; zero is
                  // suppressed so empty quarters don't show "0" stacks.
                  label={{
                    position: 'top',
                    fill: CHART_COLORS.slateMuted,
                    fontSize: 10,
                    formatter: (v) => {
                      const n = typeof v === 'number' ? v : Number(v);
                      return Number.isFinite(n) && n !== 0
                        ? n.toLocaleString()
                        : '';
                    },
                  }}
                />,
              ];
              if (showPrior) {
                lines.push(
                  <Line
                    key={`${stage}-prior`}
                    type="monotone"
                    dataKey={priorKeyOf(stage)}
                    name={
                      singleStageCompare
                        ? String(priorYear)
                        : priorKeyOf(stage)
                    }
                    stroke={color}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    strokeOpacity={0.55}
                    dot={{ r: 2 }}
                    activeDot={{ r: 4 }}
                  />,
                );
              }
              return lines;
            })}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
