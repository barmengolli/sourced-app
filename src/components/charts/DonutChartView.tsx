import { useMemo } from 'react';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { Channel } from '../../types/db';
import type { ComputedRow } from '../../lib/compute';
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';

interface DonutChartViewProps {
  rows: ComputedRow[];
  channels: Channel[];
}

interface SliceDatum {
  name: string;
  value: number;
  color: string;
}

const fmt = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return '';
  return n.toLocaleString();
};

export default function DonutChartView({ rows, channels }: DonutChartViewProps) {
  const channelById = useMemo(
    () => new Map(channels.map((c) => [c.id, c] as const)),
    [channels],
  );

  const data: SliceDatum[] = useMemo(() => {
    const slices: SliceDatum[] = [];
    let i = 0;
    for (const row of rows) {
      if (row.depth !== 1) continue;
      const value = row.cells.lead.actual ?? 0;
      if (value <= 0) continue;
      const channel = channelById.get(row.channelId);
      if (!channel) continue;
      slices.push({
        name: channel.name,
        value,
        color: CHART_PALETTE[i % CHART_PALETTE.length],
      });
      i += 1;
    }
    return slices.sort((a, b) => b.value - a.value);
  }, [rows, channelById]);

  const total = useMemo(() => data.reduce((s, d) => s + d.value, 0), [data]);

  if (total === 0) {
    return (
      <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
        No leads in the selected period.
      </p>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={56}
          outerRadius={100}
          paddingAngle={2}
          dataKey="value"
          stroke="none"
        >
          {data.map((d, i) => (
            <Cell key={i} fill={d.color} />
          ))}
        </Pie>
        <Tooltip
          formatter={(v) => fmt(v)}
          contentStyle={{
            fontSize: 11,
            border: `1px solid ${CHART_COLORS.border}`,
            borderRadius: 6,
          }}
          labelStyle={{ color: CHART_COLORS.charcoal, fontWeight: 600 }}
        />
        <Legend
          wrapperStyle={{ fontSize: 11 }}
          formatter={(value: string) => {
            const entry = data.find((d) => d.name === value);
            const pct = entry && total > 0
              ? ((entry.value / total) * 100).toFixed(0)
              : '0';
            return `${value} (${pct}%)`;
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
