// RegionDistributionDonut — third summary card on the Opportunities tab.
// Shows the per-region split of deals in the selected period, sized by
// deal count, with $ totals in the legend and the period-wide $ total
// in the center. Intentionally region-filter-agnostic so the user
// always sees the full distribution regardless of their region toggles.

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { CHART_PALETTE } from '../../constants/chartColors';
import { REGION_LABELS, type RegionKey } from '../../constants/regions';
import type { RegionDistribution } from '../../lib/compute';

interface RegionDistributionDonutProps {
  distribution: RegionDistribution;
}

// Compact USD formatter: "$5.4M", "$420K", "$500". Used by the center
// label and the per-row legend so the card stays readable at small
// sizes.
function fmtUsdCompact(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

// Deterministic color per region. We pick by REGIONS order rather than
// donut-slice order so a region's color stays stable across periods
// (NA is always indigo, even when it's not the largest slice).
const REGION_ORDER: RegionKey[] = ['NA', 'EMEA', 'APAC', 'LATAM', 'Other'];
function colorForRegion(region: RegionKey): string {
  const idx = REGION_ORDER.indexOf(region);
  return CHART_PALETTE[idx % CHART_PALETTE.length];
}

interface TooltipPayloadEntry {
  payload?: {
    region?: RegionKey;
    dealCount?: number;
    totalAmount?: number;
    percentageOfCount?: number;
  };
}

interface DonutTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
}

function DonutTooltip({ active, payload }: DonutTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const datum = payload[0].payload;
  if (!datum || !datum.region) return null;
  return (
    <div className="bg-bg border border-border rounded shadow-sm px-2 py-1 text-xs">
      <div className="font-medium text-charcoal">
        {REGION_LABELS[datum.region]}
      </div>
      <div className="text-slate-muted">
        {datum.dealCount} deal{datum.dealCount === 1 ? '' : 's'} ·{' '}
        {fmtUsdCompact(datum.totalAmount ?? 0)} ·{' '}
        {(datum.percentageOfCount ?? 0).toFixed(0)}%
      </div>
    </div>
  );
}

export default function RegionDistributionDonut({
  distribution,
}: RegionDistributionDonutProps) {
  const { regions, totalDeals, totalAmount } = distribution;

  if (regions.length === 0) {
    return (
      <p className="text-xs text-slate-muted italic h-[280px] flex items-center justify-center">
        No deals in the selected period.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <ResponsiveContainer width="100%" height={200}>
          <PieChart>
            <Pie
              data={regions}
              cx="50%"
              cy="50%"
              innerRadius={56}
              outerRadius={90}
              paddingAngle={2}
              dataKey="dealCount"
              nameKey="region"
              isAnimationActive={false}
            >
              {regions.map((r) => (
                <Cell key={r.region} fill={colorForRegion(r.region)} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {/* Center label overlay. Absolute-positioned so it stacks on
            top of the donut without disturbing Recharts layout. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-xl font-semibold text-charcoal">
            {fmtUsdCompact(totalAmount)}
          </div>
          <div className="text-xs text-slate-muted">
            {totalDeals} deal{totalDeals === 1 ? '' : 's'} total
          </div>
        </div>
      </div>

      {/* Legend: one row per region with color dot, label, count, $, %.
          Right-aligned numbers keep the rows readable when the page is
          narrow. */}
      <ul className="text-xs space-y-1">
        {regions.map((r) => (
          <li
            key={r.region}
            className="grid grid-cols-[12px_1fr_auto_auto_auto] gap-x-2 items-center"
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: colorForRegion(r.region) }}
              aria-hidden
            />
            <span className="text-charcoal truncate">{r.region}</span>
            <span className="text-slate-muted tabular-nums text-right">
              {r.dealCount}
            </span>
            <span className="text-slate-muted tabular-nums text-right">
              {fmtUsdCompact(r.totalAmount)}
            </span>
            <span className="text-slate-muted tabular-nums text-right">
              {r.percentageOfCount.toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
