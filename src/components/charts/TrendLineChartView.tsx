import { useMemo } from 'react';
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
  const data = useMemo(() => {
    return quarterly.map((q) => {
      const row: Record<string, number | string> = { name: `Q${q.quarter}` };
      for (const stage of FUNNEL_STAGES) {
        row[FUNNEL_STAGE_LABELS[stage]] = q.totals[stage].actual ?? 0;
      }
      return row;
    });
  }, [quarterly]);

  const allZero = useMemo(() => {
    return data.every((row) =>
      FUNNEL_STAGES.every(
        (stage) => (row[FUNNEL_STAGE_LABELS[stage]] as number) === 0,
      ),
    );
  }, [data]);

  if (allZero) {
    return (
      <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
        No data for the selected year.
      </p>
    );
  }

  return (
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
        {FUNNEL_STAGES.map((stage, i) => (
          <Line
            key={stage}
            type="monotone"
            dataKey={FUNNEL_STAGE_LABELS[stage]}
            stroke={CHART_PALETTE[i % CHART_PALETTE.length]}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
