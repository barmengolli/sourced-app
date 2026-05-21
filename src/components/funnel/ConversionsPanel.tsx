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
          // MQL → SQL exception: under strict-cohort the rest of the
          // table is bounded ≤ 100%, but this row can still exceed it
          // because MQL count is leads-based while HPP count is
          // deals-based and the join via attribution.lead_id isn't
          // reliable for the 2025 backfill. The tooltip explains the
          // discrepancy so a reader doesn't assume bad data.
          const showMqlSqlNote = from === 'mql' && to === 'hpp';
          return (
            <li key={`${from}-${to}`} className="space-y-1">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-charcoal flex items-center gap-1">
                  {label}
                  {showMqlSqlNote && (
                    <span
                      tabIndex={0}
                      role="img"
                      aria-label="About this conversion rate"
                      title="Computed from period totals. May exceed 100% when deals are sourced outside the standard funnel."
                      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-slate-muted text-slate-muted text-[9px] leading-none cursor-help"
                    >
                      ?
                    </span>
                  )}
                </span>
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

// Cohort outcome split: Win / Loss / In Flight all share the HPP-cohort
// denominator so the three rates sum to 100% of the deals that entered
// the funnel in this period. Reads as a clean "where did this cohort
// end up" breakdown. Renders "no data" across the row when there are
// no HPPs in scope so the panel doesn't shout 0% at users with empty
// periods.
function WinLossBlock({
  totals,
}: {
  totals: Record<FunnelStageKey, CellValues>;
}) {
  const hpp = totals.hpp.actual ?? 0;
  const won = totals.closeWon.actual ?? 0;
  const lost = totals.closeLost.actual ?? 0;
  const inFlight = Math.max(0, hpp - won - lost);
  const winRate = hpp > 0 ? (won / hpp) * 100 : null;
  const lossRate = hpp > 0 ? (lost / hpp) * 100 : null;
  const inFlightRate = hpp > 0 ? (inFlight / hpp) * 100 : null;
  return (
    <div className="pt-2 border-t border-border space-y-2">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-charcoal flex items-center gap-1">
          Win rate
          <span
            tabIndex={0}
            role="img"
            aria-label="About win, loss, and in-flight rates"
            title="Win rate = Closed Won ÷ HPP cohort for the selected period. Loss rate and In Flight rate use the same denominator; the three sum to 100%."
            className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-slate-muted text-slate-muted text-[9px] leading-none cursor-help"
          >
            ?
          </span>
        </span>
        {winRate === null ? (
          <span className="text-slate-muted italic">no data</span>
        ) : (
          <span
            className="font-medium tabular-nums text-blue-600"
            title={`${won} won / ${hpp} HPP`}
          >
            {formatPct(winRate)}
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-charcoal">Loss rate</span>
        {lossRate === null ? (
          <span className="text-slate-muted italic">no data</span>
        ) : (
          <span
            className="font-medium tabular-nums text-danger"
            title={`${lost} lost / ${hpp} HPP`}
          >
            {formatPct(lossRate)}
          </span>
        )}
      </div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-charcoal">In Flight rate</span>
        {inFlightRate === null ? (
          <span className="text-slate-muted italic">no data</span>
        ) : (
          <span
            className="font-medium tabular-nums text-charcoal"
            title={`${inFlight} in flight / ${hpp} HPP`}
          >
            {formatPct(inFlightRate)}
          </span>
        )}
      </div>
    </div>
  );
}
