import { useEffect, useMemo, useState } from 'react';
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type FunnelStageKey,
} from '../../constants/funnelStages';
import {
  funnelEfficiencyPercent,
  type CellValues,
  type ComputedRow,
} from '../../lib/compute';
import type { Channel } from '../../types/db';
import { FUNNEL_STAGE_BARS } from '../../constants/chartColors';
import { readJson, writeJson } from '../../lib/storage';

const STORAGE_KEY = 'sourced.charts.funnel.channel';

interface FunnelChartViewProps {
  totals: Record<FunnelStageKey, CellValues>;
  // When a single channel is selected, the funnel reads that channel's
  // per-stage actuals from rows instead of grid.totals. Optional so the
  // component still works in totals-only mode.
  rows?: ComputedRow[];
  channels?: Channel[];
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

export default function FunnelChartView({
  totals,
  rows: gridRows,
  channels,
}: FunnelChartViewProps) {
  const [channelFilter, setChannelFilter] = useState<string>(() =>
    readJson<string>(STORAGE_KEY, 'all'),
  );
  useEffect(() => {
    writeJson(STORAGE_KEY, channelFilter);
  }, [channelFilter]);

  const topLevelChannels = useMemo(
    () =>
      (channels ?? [])
        .filter((c) => !c.parent_channel_id)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels],
  );

  // If the persisted channel was deleted or renamed away, fall back to all.
  const effectiveFilter =
    channelFilter === 'all' ||
    topLevelChannels.some((c) => c.id === channelFilter)
      ? channelFilter
      : 'all';

  const cellsForFilter: Record<FunnelStageKey, CellValues> = useMemo(() => {
    if (effectiveFilter === 'all') return totals;
    if (!gridRows) return totals;
    const row = gridRows.find((r) => r.channelId === effectiveFilter);
    return row ? row.cells : totals;
  }, [effectiveFilter, totals, gridRows]);

  const rows: Row[] = useMemo(() => {
    return FUNNEL_STAGES.map((stage, i) => {
      const isLost = stage === 'closeLost';
      const actual = cellsForFilter[stage].actual;
      const prev = i > 0 ? cellsForFilter[FUNNEL_STAGES[i - 1]].actual : null;
      // closeLost is a parallel terminal, not a downstream step. Suppress
      // the % so the literal funnel shape reads correctly: every other row
      // is "X% of the row above me; closeLost is just a horizontal bar in
      // red below Won, paired with it visually."
      const conversion =
        i > 0 && !isLost ? funnelEfficiencyPercent(actual, prev) : null;
      return {
        key: stage,
        label: FUNNEL_STAGE_LABELS[stage],
        actual,
        conversion,
        color: isLost
          ? // CSS var lookup at runtime via inline style would force a
            // refactor; closeLost gets the danger token's hex value
            // directly to match the FunnelTable header tint and the
            // Sankey Lost edges.
            '#EF4444'
          : (FUNNEL_STAGE_BARS[i] ??
            FUNNEL_STAGE_BARS[FUNNEL_STAGE_BARS.length - 1]),
      };
    });
  }, [cellsForFilter]);

  const max = useMemo(() => {
    let m = 0;
    for (const r of rows) {
      if (r.actual !== null && r.actual > m) m = r.actual;
    }
    return m;
  }, [rows]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-xs text-slate-muted">Channel</label>
        <select
          value={effectiveFilter}
          onChange={(e) => setChannelFilter(e.target.value)}
          className="text-xs px-2 py-1 border border-border rounded bg-bg text-charcoal"
        >
          <option value="all">All channels</option>
          {topLevelChannels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {max === 0 ? (
        <p className="text-xs text-slate-muted italic h-[240px] flex items-center justify-center">
          No data for the selected period.
        </p>
      ) : (
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
                  {r.conversion !== null
                    ? `${r.conversion.toFixed(0)}%`
                    : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
