import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CellValues, ComputedRow } from '../../lib/compute';
import type { Channel } from '../../types/db';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type FunnelStageKey,
} from '../../constants/funnelStages';
import { CHART_COLORS } from '../../constants/chartColors';
import { readJson, writeJson } from '../../lib/storage';

const STORAGE_KEY = 'sourced.charts.barchart.stage';

type StageFilter = 'all' | FunnelStageKey;

interface BarChartViewProps {
  totals: Record<FunnelStageKey, CellValues>;
  // When a single stage is selected, render bars per top-level channel using
  // these rows. Optional so the component still works in totals-only mode.
  rows?: ComputedRow[];
  channels?: Channel[];
}

interface BarRow {
  name: string;
  Projections: number;
  Actuals: number;
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return '';
  return n.toLocaleString();
};

export default function BarChartView({
  totals,
  rows,
  channels,
}: BarChartViewProps) {
  const [stageFilter, setStageFilter] = useState<StageFilter>(() =>
    readJson<StageFilter>(STORAGE_KEY, 'all'),
  );
  useEffect(() => {
    writeJson(STORAGE_KEY, stageFilter);
  }, [stageFilter]);

  const channelById = useMemo(
    () => new Map((channels ?? []).map((c) => [c.id, c] as const)),
    [channels],
  );

  const data: BarRow[] = useMemo(() => {
    if (stageFilter === 'all') {
      return FUNNEL_STAGES.map((stage) => ({
        name: FUNNEL_STAGE_LABELS[stage],
        Projections: totals[stage].projection ?? 0,
        Actuals: totals[stage].actual ?? 0,
      }));
    }
    // Single-stage view: one bar group per top-level channel.
    if (!rows || rows.length === 0) {
      // No per-row data available; fall back to a single aggregate bar.
      return [
        {
          name: FUNNEL_STAGE_LABELS[stageFilter],
          Projections: totals[stageFilter].projection ?? 0,
          Actuals: totals[stageFilter].actual ?? 0,
        },
      ];
    }
    return rows
      .filter((r) => r.depth === 1)
      .map((r) => {
        const c = channelById.get(r.channelId);
        return {
          name: c?.name ?? 'Unknown',
          Projections: r.cells[stageFilter].projection ?? 0,
          Actuals: r.cells[stageFilter].actual ?? 0,
        };
      })
      .filter((b) => b.Projections > 0 || b.Actuals > 0);
  }, [stageFilter, totals, rows, channelById]);

  const allZero = data.every((d) => d.Projections === 0 && d.Actuals === 0);

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
        <p className="text-xs text-slate-muted italic h-[260px] flex items-center justify-center">
          No data for the selected period.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.border} />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
              axisLine={{ stroke: CHART_COLORS.border }}
              tickLine={{ stroke: CHART_COLORS.border }}
              interval={0}
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
            <Bar
              dataKey="Projections"
              fill={CHART_COLORS.slateMuted}
              radius={[3, 3, 0, 0]}
            />
            <Bar
              dataKey="Actuals"
              fill={CHART_COLORS.indigo}
              radius={[3, 3, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
