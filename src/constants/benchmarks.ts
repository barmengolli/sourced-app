// Per-stage conversion benchmarks. Used by the Conversions panel to color
// each rate against the same getOTColor scale the funnel grid uses:
// >= benchmark → green, >= 75% of benchmark → yellow, below → red.
//
// v1 defaults below; tune per business once we have a few clean quarters
// of data. Keys match CONVERSION_PAIRS so a lookup is a join on (from, to).
//
// Values are decimals (0.20 = 20%), to match getOTColor's contract.

import type { FunnelStageKey } from './funnelStages';

export interface ConversionBenchmark {
  from: FunnelStageKey;
  to: FunnelStageKey;
  benchmark: number;
}

export const CONVERSION_BENCHMARKS: ConversionBenchmark[] = [
  { from: 'lead', to: 'mql', benchmark: 0.2 },
  { from: 'mql', to: 'hpp', benchmark: 0.12 },
  { from: 'hpp', to: 'opp', benchmark: 0.3 },
  { from: 'opp', to: 'pursuit', benchmark: 0.18 },
  { from: 'pursuit', to: 'closeWon', benchmark: 0.14 },
  { from: 'lead', to: 'closeWon', benchmark: 0.001 },
];

export function benchmarkFor(
  from: FunnelStageKey,
  to: FunnelStageKey,
): number | null {
  const match = CONVERSION_BENCHMARKS.find(
    (b) => b.from === from && b.to === to,
  );
  return match?.benchmark ?? null;
}
