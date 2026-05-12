// ChannelDistributionDonut — fourth summary card on the Opportunities
// tab. Parallel to RegionDistributionDonut: same hover-driven center
// label, same legend layout, but buckets by top-level parent channel
// instead of region. Intentionally ignores the page-level region
// toggles for the same reason the region donut does.

import { useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { CHART_PALETTE } from '../../constants/chartColors';
import {
  NO_CHANNEL_KEY,
  type ChannelDistribution,
} from '../../lib/compute';

interface ChannelDistributionDonutProps {
  distribution: ChannelDistribution;
}

function fmtUsdCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

// Color per channel: cycle through CHART_PALETTE in distribution order
// so the largest slice gets the brand indigo. NO_CHANNEL is always a
// neutral gray so it reads as a residual bucket rather than a real
// channel.
const NO_CHANNEL_COLOR = '#94A3B8'; // slate-400, neutral but visible
function colorForChannel(channelId: string, index: number): string {
  if (channelId === NO_CHANNEL_KEY) return NO_CHANNEL_COLOR;
  return CHART_PALETTE[index % CHART_PALETTE.length];
}

export default function ChannelDistributionDonut({
  distribution,
}: ChannelDistributionDonutProps) {
  const { channels, totalDeals, totalAmount } = distribution;
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  if (channels.length === 0) {
    return (
      <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
        No deals in the selected period.
      </p>
    );
  }

  // Index lookup once so the legend and the Cell loop share the same
  // color assignment. NO_CHANNEL gets its own constant, so its index
  // doesn't matter for color but we still use the distribution-order
  // index for everything else.
  const idxById = new Map(channels.map((c, i) => [c.channelId, i] as const));
  const hovered = hoveredId
    ? channels.find((c) => c.channelId === hoveredId) ?? null
    : null;

  return (
    <div className="space-y-3">
      <div className="relative">
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={channels}
              cx="50%"
              cy="50%"
              innerRadius={56}
              outerRadius={90}
              paddingAngle={2}
              dataKey="dealCount"
              nameKey="channelName"
              isAnimationActive={false}
              // Recharts types the handler payload as PieSectorDataItem,
              // but the original datum fields are still on it at runtime.
              // Read defensively via an unknown cast.
              onMouseEnter={(d: unknown) => {
                const id = (d as { channelId?: string } | undefined)?.channelId;
                setHoveredId(id ?? null);
              }}
              onMouseLeave={() => setHoveredId(null)}
            >
              {channels.map((c) => {
                const dim = hoveredId !== null && hoveredId !== c.channelId;
                return (
                  <Cell
                    key={c.channelId}
                    fill={colorForChannel(c.channelId, idxById.get(c.channelId) ?? 0)}
                    fillOpacity={dim ? 0.4 : 1}
                  />
                );
              })}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-2">
          {hovered ? (
            <>
              <div className="text-sm font-semibold text-charcoal">
                {hovered.channelName}
              </div>
              <div className="text-xs text-slate-muted">
                {hovered.dealCount} deal{hovered.dealCount === 1 ? '' : 's'} ·{' '}
                {fmtUsdCompact(hovered.totalAmount)} ·{' '}
                {hovered.percentageOfCount.toFixed(0)}%
              </div>
            </>
          ) : (
            <>
              <div className="text-xl font-semibold text-charcoal">
                {fmtUsdCompact(totalAmount)}
              </div>
              <div className="text-xs text-slate-muted">
                {totalDeals} deal{totalDeals === 1 ? '' : 's'} total
              </div>
            </>
          )}
        </div>
      </div>

      <ul className="text-xs space-y-1">
        {channels.map((c, i) => (
          <li
            key={c.channelId}
            className="grid grid-cols-[12px_1fr_auto_auto_auto] gap-x-2 items-center"
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: colorForChannel(c.channelId, i) }}
              aria-hidden
            />
            <span className="text-charcoal truncate">{c.channelName}</span>
            <span className="text-slate-muted tabular-nums text-right">
              {c.dealCount}
            </span>
            <span className="text-slate-muted tabular-nums text-right">
              {fmtUsdCompact(c.totalAmount)}
            </span>
            <span className="text-slate-muted tabular-nums text-right">
              {c.percentageOfCount.toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
