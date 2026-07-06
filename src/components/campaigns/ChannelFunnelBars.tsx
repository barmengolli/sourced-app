// Stacked horizontal bars showing a campaign's funnel split by the channel that
// drove each stage. One row per stage (Leads, MQLs, Opps, Won), each bar
// segmented by channel color. Data comes from computeScorecard's `byChannel`.

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
import type { ChannelFunnel } from '../../lib/campaignScorecard';
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';

type StageKey = 'leads' | 'mqls' | 'opps' | 'won';
const STAGES: { key: StageKey; label: string }[] = [
  { key: 'leads', label: 'Leads' },
  { key: 'mqls', label: 'MQLs' },
  { key: 'opps', label: 'Opps' },
  { key: 'won', label: 'Won' },
];

// "Other" (channelId === '') always renders in slate; real channels rotate the
// brand palette in the order computeScorecard returned them (leads desc).
function colorFor(channel: ChannelFunnel, index: number): string {
  if (channel.channelId === '') return CHART_COLORS.slateMuted;
  return CHART_PALETTE[index % CHART_PALETTE.length];
}

export default function ChannelFunnelBars({
  byChannel,
}: {
  byChannel: ChannelFunnel[];
}) {
  // Recharts wants one row per stage with a numeric field per channel. Use the
  // channel name as the dataKey; disambiguate collisions with an index suffix.
  const names = byChannel.map((c, i) =>
    byChannel.findIndex((o) => o.channelName === c.channelName) === i
      ? c.channelName
      : `${c.channelName} (${i + 1})`,
  );

  const oppOf = (c: ChannelFunnel) => c.hpp + c.opp + c.pursuit + c.won;
  const data = STAGES.map(({ key, label }) => {
    const row: Record<string, number | string> = { stage: label };
    byChannel.forEach((c, i) => {
      row[names[i]] =
        key === 'opps'
          ? oppOf(c)
          : (c[key as 'leads' | 'mqls' | 'won'] as number);
    });
    return row;
  });

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.border} />
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: CHART_COLORS.slateMuted }}
          axisLine={{ stroke: CHART_COLORS.border }}
          tickLine={{ stroke: CHART_COLORS.border }}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="stage"
          tick={{ fontSize: 11, fill: CHART_COLORS.charcoal }}
          axisLine={{ stroke: CHART_COLORS.border }}
          tickLine={{ stroke: CHART_COLORS.border }}
          width={48}
        />
        <Tooltip
          contentStyle={{
            fontSize: 11,
            border: `1px solid ${CHART_COLORS.border}`,
            borderRadius: 6,
          }}
          labelStyle={{ color: CHART_COLORS.charcoal, fontWeight: 600 }}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        {byChannel.map((c, i) => (
          <Bar
            key={names[i]}
            dataKey={names[i]}
            stackId="funnel"
            fill={colorFor(c, i)}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
