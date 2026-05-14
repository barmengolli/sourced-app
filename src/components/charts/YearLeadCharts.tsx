// YearLeadCharts — two side-by-side bar charts for the Leads & MQLs
// tab. Always spans all 12 months of the input year regardless of
// the page's quarter selector; respects the region filter (via the
// already-filtered MonthlyLeadsForYear that the caller computes).
//
// Left card stacks leads by top-level channel per month. Right card
// shows the per-month total with inline value labels above each bar.

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
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';
import type { MonthlyLeadsForYear } from '../../lib/compute';
import ChartCard from './ChartCard';

interface YearLeadChartsProps {
  data: MonthlyLeadsForYear;
  year: number;
}

const MONTH_AXIS_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export default function YearLeadCharts({ data, year }: YearLeadChartsProps) {
  // Reshape for Recharts: one row per month with each top-level
  // channel as its own key. Channels with zero leads across the
  // whole year are already filtered out of data.byChannel upstream,
  // so the legend stays clean.
  const stackedData = useMemo(() => {
    return MONTH_AXIS_LABELS.map((label, i) => {
      const row: Record<string, string | number> = { month: label };
      for (const c of data.byChannel) {
        row[c.channelName] = c.perMonth[i] ?? 0;
      }
      return row;
    });
  }, [data]);

  const totalsData = useMemo(() => {
    return MONTH_AXIS_LABELS.map((label, i) => ({
      month: label,
      total: data.monthTotals[i] ?? 0,
    }));
  }, [data]);

  const subtitle = `All ${year} months. Region filter applies.`;
  const hasAnyData = data.byChannel.length > 0;

  return (
    <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ChartCard title="Leads by Channel per Month" subtitle={subtitle}>
        {hasAnyData ? (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart
              data={stackedData}
              margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.border} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                axisLine={{ stroke: CHART_COLORS.border }}
                tickLine={{ stroke: CHART_COLORS.border }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                axisLine={{ stroke: CHART_COLORS.border }}
                tickLine={{ stroke: CHART_COLORS.border }}
                tickFormatter={(v) =>
                  typeof v === 'number' ? v.toLocaleString() : String(v)
                }
                width={48}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  border: `1px solid ${CHART_COLORS.border}`,
                  borderRadius: 6,
                }}
                labelStyle={{
                  color: CHART_COLORS.charcoal,
                  fontWeight: 600,
                }}
                formatter={(v) => {
                  const n = typeof v === 'number' ? v : Number(v);
                  return Number.isFinite(n) ? n.toLocaleString() : String(v);
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {data.byChannel.map((c, idx) => (
                <Bar
                  key={c.channelId}
                  dataKey={c.channelName}
                  stackId="leads"
                  fill={CHART_PALETTE[idx % CHART_PALETTE.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
            No leads in {year} matching the region filter.
          </p>
        )}
      </ChartCard>

      <ChartCard title="Total Leads per Month" subtitle={subtitle}>
        {hasAnyData ? (
          <ResponsiveContainer width="100%" height={320}>
            <BarChart
              data={totalsData}
              margin={{ top: 16, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.border} />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                axisLine={{ stroke: CHART_COLORS.border }}
                tickLine={{ stroke: CHART_COLORS.border }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
                axisLine={{ stroke: CHART_COLORS.border }}
                tickLine={{ stroke: CHART_COLORS.border }}
                tickFormatter={(v) =>
                  typeof v === 'number' ? v.toLocaleString() : String(v)
                }
                width={48}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  border: `1px solid ${CHART_COLORS.border}`,
                  borderRadius: 6,
                }}
                labelStyle={{
                  color: CHART_COLORS.charcoal,
                  fontWeight: 600,
                }}
                formatter={(v) => {
                  const n = typeof v === 'number' ? v : Number(v);
                  return Number.isFinite(n) ? n.toLocaleString() : String(v);
                }}
              />
              <Bar
                dataKey="total"
                fill={CHART_COLORS.indigo}
                radius={[3, 3, 0, 0]}
                label={{
                  position: 'top',
                  fill: CHART_COLORS.charcoal,
                  fontSize: 11,
                  formatter: (v) => {
                    const n = typeof v === 'number' ? v : Number(v);
                    return Number.isFinite(n) && n !== 0
                      ? n.toLocaleString()
                      : '';
                  },
                }}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
            No leads in {year} matching the region filter.
          </p>
        )}
      </ChartCard>
    </section>
  );
}
