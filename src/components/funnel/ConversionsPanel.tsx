import type { CellValues } from '../../lib/compute';
import { conversionPercent } from '../../lib/compute';
import {
  CONVERSION_PAIRS,
  type FunnelStageKey,
} from '../../constants/funnelStages';

interface ConversionsPanelProps {
  totals: Record<FunnelStageKey, CellValues>;
}

function formatPct(p: number | null): string {
  if (p === null) return '';
  return `${p.toFixed(1)}%`;
}

function Bar({ pct }: { pct: number | null }) {
  const width = pct === null ? 0 : Math.min(100, Math.max(0, pct));
  return (
    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
      <div
        className="h-full bg-indigo transition-all"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export default function ConversionsPanel({ totals }: ConversionsPanelProps) {
  return (
    <aside className="w-72 flex-shrink-0 border border-border rounded-lg bg-bg p-4 space-y-3 self-start">
      <h2 className="text-sm font-semibold text-charcoal">Conversion rates</h2>
      <p className="text-xs text-slate-muted">
        Computed from totals across all channels in the selected period.
      </p>
      <ul className="space-y-3">
        {CONVERSION_PAIRS.map(({ from, to, label }) => {
          const numerator = totals[to].actual;
          const denominator = totals[from].actual;
          const p = conversionPercent(numerator, denominator);
          return (
            <li key={`${from}-${to}`} className="space-y-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-charcoal">{label}</span>
                {p === null ? (
                  <span className="text-slate-muted italic">no data</span>
                ) : (
                  <span className="font-medium text-charcoal tabular-nums">
                    {formatPct(p)}
                  </span>
                )}
              </div>
              <Bar pct={p} />
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
