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

type StageFilter = 'all' | FunnelStageKey;

interface QuarterTotals {
  quarter: 1 | 2 | 3 | 4;
  totals: Record<FunnelStageKey, CellValues>;
}

interface TrendLineChartViewProps {
  // index 0 is Q1, 3 is Q4. DashboardPage prepares this by calling
  // computeGrid four times per selected year.
  quarterly: QuarterTotals[];
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return '';
  return n.toLocaleString();
};

export default function TrendLineChartView({
  quarterly,
}: TrendLineChartViewProps) {
  const [stageFilter, setStageFilter] = useState<StageFilter>(() =>
    readJson<StageFilter>(STORAGE_KEY, 'all'),
  );
  useEffect(() => {
    writeJson(STORAGE_KEY, stageFilter);
  }, [stageFilter]);

  // Always build all-stage rows; we just decide which lines to render below.
  const data = useMemo(() => {
    return quarterly.map((q) => {
      const row: Record<string, number | string> = { name: `Q${q.quarter}` };
      for (const stage of FUNNEL_STAGES) {
        row[FUNNEL_STAGE_LABELS[stage]] = q.totals[stage].actual ?? 0;
      }
      return row;
    });
  }, [quarterly]);

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
      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-muted">Stage</label>
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value as StageFilter)}
          className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
        >
          <option value="all">All stages</option>
          {FUNNEL_STAGES.map((s) => (
            <option key={s} value={s}>
              {FUNNEL_STAGE_LABELS[s]}
            </option>
          ))}
        </select>
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
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {stagesToRender.map((stage) => {
              // Use the stage's index in FUNNEL_STAGES so colors stay stable
              // across single-stage and all-stage views (Leads is always blue,
              // MQL is always purple, etc.).
              const colorIdx = FUNNEL_STAGES.indexOf(stage);
              return (
                <Line
                  key={stage}
                  type="monotone"
                  dataKey={FUNNEL_STAGE_LABELS[stage]}
                  stroke={CHART_PALETTE[colorIdx % CHART_PALETTE.length]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
