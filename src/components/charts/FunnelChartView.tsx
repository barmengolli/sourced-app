import { useMemo } from 'react';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type FunnelStageKey,
} from '../../constants/funnelStages';
import {
  funnelEfficiencyPercent,
  type CellValues,
} from '../../lib/compute';
import { FUNNEL_STAGE_BARS } from '../../constants/chartColors';

interface FunnelChartViewProps {
  totals: Record<FunnelStageKey, CellValues>;
}

interface Row {
  key: FunnelStageKey;
  label: string;
  actual: number | null;
  conversion: number | null;
  color: string;
}

const fmt = (v: number | null): string => {
  if (v === null || v === undefined) return '';
  return v.toLocaleString();
};

export default function FunnelChartView({ totals }: FunnelChartViewProps) {
  const rows: Row[] = useMemo(() => {
    return FUNNEL_STAGES.map((stage, i) => {
      const actual = totals[stage].actual;
      const prev = i > 0 ? totals[FUNNEL_STAGES[i - 1]].actual : null;
      const conversion =
        i > 0 ? funnelEfficiencyPercent(actual, prev) : null;
      return {
        key: stage,
        label: FUNNEL_STAGE_LABELS[stage],
        actual,
        conversion,
        color: FUNNEL_STAGE_BARS[i] ?? FUNNEL_STAGE_BARS[FUNNEL_STAGE_BARS.length - 1],
      };
    });
  }, [totals]);

  const max = useMemo(() => {
    let m = 0;
    for (const r of rows) {
      if (r.actual !== null && r.actual > m) m = r.actual;
    }
    return m;
  }, [rows]);

  if (max === 0) {
    return (
      <p className="text-xs text-slate-muted italic h-[260px] flex items-center justify-center">
        No data for the selected period.
      </p>
    );
  }

  return (
    <div className="space-y-2 py-1">
      {rows.map((r) => {
        const widthPct =
          r.actual === null || max === 0
            ? 0
            : Math.min(100, Math.max(5, (r.actual / max) * 100));
        return (
          <div key={r.key} className="flex items-center gap-3">
            <div className="w-24 text-right text-xs font-medium text-charcoal shrink-0">
              {r.label}
            </div>
            <div className="flex-1 relative">
              {r.actual === null || r.actual === 0 ? (
                <div className="h-8 flex items-center text-xs text-slate-muted italic">
                  (no data)
                </div>
              ) : (
                <div
                  className="h-8 rounded-md flex items-center justify-end px-3 transition-all duration-300"
                  style={{
                    width: `${widthPct}%`,
                    backgroundColor: r.color,
                    minWidth: 60,
                  }}
                >
                  <span className="text-white text-xs font-semibold tabular-nums">
                    {fmt(r.actual)}
                  </span>
                </div>
              )}
            </div>
            <div className="w-14 text-right text-xs text-slate-muted shrink-0 tabular-nums">
              {r.conversion !== null ? `${r.conversion.toFixed(0)}%` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
