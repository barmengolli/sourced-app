// ChannelDistributionDonut — fourth summary card on the Opportunities
// tab. Parallel to RegionDistributionDonut: same boxed tooltip, same
// legend layout, but buckets by top-level parent channel instead of
// region. Intentionally ignores the page-level region toggles for the
// same reason the region donut does.

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { CHART_COLORS, CHART_PALETTE } from '../../constants/chartColors';
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

interface TooltipPayloadEntry {
  payload?: {
    channelId?: string;
    channelName?: string;
    dealCount?: number;
    totalAmount?: number;
    percentageOfCount?: number;
  };
}

interface DonutTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  // The distribution-order index map flows in via a closure on the
  // wrapping component so we can recover the per-slice color without
  // re-deriving order.
  colorOf?: (channelId: string) => string;
}

function DonutTooltip({ active, payload, colorOf }: DonutTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  if (!d || !d.channelId) return null;
  return (
    <div
      className="bg-bg rounded shadow-sm text-xs"
      style={{
        border: `1px solid ${CHART_COLORS.border}`,
        padding: 8,
      }}
    >
      <div
        className="font-semibold"
        style={{ color: colorOf ? colorOf(d.channelId) : CHART_COLORS.charcoal }}
      >
        {d.channelName ?? 'Unknown'}
      </div>
      <div className="text-charcoal tabular-nums mt-1">
        Deals: {d.dealCount ?? 0}
      </div>
      <div className="text-charcoal tabular-nums">
        Amount: {fmtUsdCompact(d.totalAmount ?? 0)}
      </div>
      <div className="text-charcoal tabular-nums">
        Share: {(d.percentageOfCount ?? 0).toFixed(0)}%
      </div>
    </div>
  );
}

export default function ChannelDistributionDonut({
  distribution,
}: ChannelDistributionDonutProps) {
  const { channels, totalDeals, totalAmount } = distribution;

  if (channels.length === 0) {
    return (
      <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
        No deals in the selected period.
      </p>
    );
  }

  const idxById = new Map(channels.map((c, i) => [c.channelId, i] as const));
  const colorOf = (channelId: string) =>
    colorForChannel(channelId, idxById.get(channelId) ?? 0);

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
            >
              {channels.map((c) => (
                <Cell key={c.channelId} fill={colorOf(c.channelId)} />
              ))}
            </Pie>
            {/* Cursor-follow placement, matching the Channel
                Distribution donut on Leads & MQLs. */}
            <Tooltip content={<DonutTooltip colorOf={colorOf} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-2">
          <div className="text-xl font-semibold text-charcoal">
            {fmtUsdCompact(totalAmount)}
          </div>
          <div className="text-xs text-slate-muted">
            {totalDeals} deal{totalDeals === 1 ? '' : 's'} total
          </div>
        </div>
      </div>

      <ul className="text-xs space-y-1">
        {channels.map((c) => (
          <li
            key={c.channelId}
            className="grid grid-cols-[12px_1fr_auto_auto_auto] gap-x-2 items-center"
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: colorOf(c.channelId) }}
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
