// GaugeChart — a radial progress gauge (actual vs quota) for the BDR Quota
// dashboard. Recharts has no built-in gauge, so this draws a 270° arc with a
// filled value slice over a muted track, plus a centered "actual / quota" and
// percent label (center-label pattern mirrors RegionDistributionDonut).
//
// Fill color reflects progress against the quota: danger < 50%, warning
// < 100%, success at/over 100%. With no quota set, the arc is all track and
// the label shows the raw actual.

import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { CHART_COLORS } from '../../constants/chartColors';

interface GaugeChartProps {
  label: string;
  actual: number;
  quota: number | null;
  // Optional caption under the gauge (e.g. "2025: 10").
  caption?: string;
}

// 270° sweep, starting bottom-left, ending bottom-right (a classic gauge).
const START_ANGLE = 225;
const END_ANGLE = -45;
const TOTAL_SWEEP = START_ANGLE - END_ANGLE; // 270

function fillColor(pct: number | null): string {
  if (pct === null) return CHART_COLORS.slateMuted;
  if (pct >= 1) return CHART_COLORS.success;
  if (pct >= 0.5) return CHART_COLORS.warning;
  return CHART_COLORS.danger;
}

export default function GaugeChart({
  label,
  actual,
  quota,
  caption,
}: GaugeChartProps) {
  const pct = quota && quota > 0 ? actual / quota : null;
  // Clamp the drawn fraction to [0, 1] so an over-quota gauge fills fully
  // rather than wrapping past the arc.
  const filled = pct === null ? 0 : Math.max(0, Math.min(1, pct));
  const color = fillColor(pct);

  // Two-slice pie over the 270° sweep: filled portion + remainder track.
  const valueEnd = START_ANGLE - filled * TOTAL_SWEEP;
  const pctLabel =
    pct === null ? '—' : `${Math.round(pct * 100)}%`;

  return (
    <div className="flex flex-col items-center">
      <p className="text-xs text-slate-muted mb-1">{label}</p>
      <div className="relative" style={{ width: 160, height: 120 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            {/* Track: full sweep in muted. */}
            <Pie
              data={[{ value: 1 }]}
              dataKey="value"
              cx="50%"
              cy="55%"
              startAngle={START_ANGLE}
              endAngle={END_ANGLE}
              innerRadius={52}
              outerRadius={70}
              isAnimationActive={false}
              stroke="none"
            >
              <Cell fill={CHART_COLORS.border} />
            </Pie>
            {/* Value: filled portion in the progress color. */}
            {filled > 0 && (
              <Pie
                data={[{ value: 1 }]}
                dataKey="value"
                cx="50%"
                cy="55%"
                startAngle={START_ANGLE}
                endAngle={valueEnd}
                innerRadius={52}
                outerRadius={70}
                isAnimationActive={false}
                stroke="none"
              >
                <Cell fill={color} />
              </Pie>
            )}
          </PieChart>
        </ResponsiveContainer>
        {/* Center label. */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-lg font-semibold text-charcoal leading-none">
            {actual}
            <span className="text-sm text-slate-muted">
              {quota === null ? '' : ` / ${quota}`}
            </span>
          </span>
          <span
            className="text-xs font-medium mt-0.5"
            style={{ color }}
          >
            {pctLabel}
          </span>
        </div>
      </div>
      {caption && (
        <p className="text-[11px] text-slate-muted mt-1">{caption}</p>
      )}
    </div>
  );
}
