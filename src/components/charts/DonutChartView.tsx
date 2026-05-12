import { useEffect, useMemo, useState } from 'react';
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { Channel } from '../../types/db';
import type { ComputedRow } from '../../lib/compute';
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type FunnelStageKey,
} from '../../constants/funnelStages';
import { readJson, writeJson } from '../../lib/storage';

const STORAGE_KEY = 'sourced.charts.donut.stage';

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
  // Single-stage view (matches DataVis behavior). Default to Leads on first
  // mount, then persist whatever the user chose.
  const [stage, setStage] = useState<FunnelStageKey>(() =>
    readJson<FunnelStageKey>(STORAGE_KEY, 'lead'),
  );
  useEffect(() => {
    writeJson(STORAGE_KEY, stage);
  }, [stage]);

  const channelById = useMemo(
    () => new Map(channels.map((c) => [c.id, c] as const)),
    [channels],
  );

  const data: SliceDatum[] = useMemo(() => {
    const slices: SliceDatum[] = [];
    let i = 0;
    for (const row of rows) {
      if (row.depth !== 1) continue;
      const value = row.cells[stage].actual ?? 0;
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
  }, [rows, channelById, stage]);

  const total = useMemo(() => data.reduce((s, d) => s + d.value, 0), [data]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-muted">Stage</label>
        <select
          value={stage}
          onChange={(e) => setStage(e.target.value as FunnelStageKey)}
          className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
        >
          {FUNNEL_STAGES.map((s) => (
            <option key={s} value={s}>
              {FUNNEL_STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {total === 0 ? (
        <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
          No {FUNNEL_STAGE_LABELS[stage].toLowerCase()} in the selected period.
        </p>
      ) : (
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
              // Slice percentage labels inline. Slices under 5% are
              // unlabeled so tiny segments don't pile up unreadable
              // text. labelLine={false} kills the default connector
              // lines that Recharts otherwise draws to each label.
              label={({ percent }: { percent?: number }) => {
                const pct = Math.round((percent ?? 0) * 100);
                return pct >= 5 ? `${pct}%` : '';
              }}
              labelLine={false}
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
      )}
    </div>
  );
}
