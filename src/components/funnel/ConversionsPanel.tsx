import type { CellValues } from '../../lib/compute';
import { conversionPercent } from '../../lib/compute';
import {
  CONVERSION_PAIRS,
  type FunnelStageKey,
} from '../../constants/funnelStages';
import { benchmarkFor } from '../../constants/benchmarks';
import { getOTColor } from '../../lib/formatters';

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
          // Color the rate against this pair's benchmark using getOTColor's
          // thresholds. ratio = (rate / benchmark), so >=1 green, >=0.75
          // yellow, below red. Falls back to no color when either is
          // missing.
          const benchmark = benchmarkFor(from, to);
          const ratio =
            p === null || benchmark === null || benchmark === 0
              ? null
              : p / 100 / benchmark;
          const color = getOTColor(ratio);
          return (
            <li key={`${from}-${to}`} className="space-y-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-charcoal">{label}</span>
                {p === null ? (
                  <span className="text-slate-muted italic">no data</span>
                ) : (
                  <span
                    className={`font-medium tabular-nums ${color}`}
                    title={
                      benchmark !== null
                        ? `Benchmark ${(benchmark * 100).toFixed(1)}%`
                        : undefined
                    }
                  >
                    {formatPct(p)}
                  </span>
                )}
              </div>
              <Bar pct={p} />
            </li>
          );
        })}
      </ul>
      <WinLossBlock totals={totals} />
    </aside>
  );
}

// Win/Loss rates: deal-level outcome breakdown. Denominator is closed deals
// (won + lost), not anything upstream — these are "of the deals that
// closed, what fraction closed each way." Renders dashes when neither side
// has signal in the period so the panel doesn't shout 0% at users.
function WinLossBlock({
  totals,
}: {
  totals: Record<FunnelStageKey, CellValues>;
}) {
  const won = totals.closeWon.actual ?? 0;
  const lost = totals.closeLost.actual ?? 0;
  const denom = won + lost;
  const winRate = denom === 0 ? null : (won / denom) * 100;
  const lossRate = denom === 0 ? null : (lost / denom) * 100;
  return (
    <div className="pt-2 border-t border-border space-y-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-charcoal">Win rate</span>
        {winRate === null ? (
          <span className="text-slate-muted italic">—</span>
        ) : (
          <span
            className="font-medium tabular-nums text-blue-600"
            title={`${won} won / ${denom} closed`}
          >
            {formatPct(winRate)}
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-charcoal">Loss rate</span>
        {lossRate === null ? (
          <span className="text-slate-muted italic">—</span>
        ) : (
          <span
            className="font-medium tabular-nums text-danger"
            title={`${lost} lost / ${denom} closed`}
          >
            {formatPct(lossRate)}
          </span>
        )}
      </div>
    </div>
  );
}
