import { useMemo } from 'react';
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
import type { CellValues } from '../../lib/compute';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type FunnelStageKey,
} from '../../constants/funnelStages';
import { CHART_COLORS } from '../../constants/chartColors';

interface BarChartViewProps {
  totals: Record<FunnelStageKey, CellValues>;
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

export default function BarChartView({ totals }: BarChartViewProps) {
  const data: BarRow[] = useMemo(() => {
    return FUNNEL_STAGES.map((stage) => ({
      name: FUNNEL_STAGE_LABELS[stage],
      Projections: totals[stage].projection ?? 0,
      Actuals: totals[stage].actual ?? 0,
    }));
  }, [totals]);

  const allZero = data.every((d) => d.Projections === 0 && d.Actuals === 0);
  if (allZero) {
    return (
      <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
        No data for the selected period.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
        <Bar dataKey="Projections" fill={CHART_COLORS.slateMuted} radius={[3, 3, 0, 0]} />
        <Bar dataKey="Actuals" fill={CHART_COLORS.indigo} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
