// Per-transition velocity thresholds in days. Color logic on the
// Velocity dashboard cards:
//   avg <= typical → green (healthy)
//   typical < avg <= stale → yellow (warning zone)
//   avg > stale → red (red flag)
//
// When typical == stale, the yellow zone collapses to zero width and
// the card displays binary green/red. This is the case for HPP→Opp
// and Opp→Pursuit because the sales lead specified a single threshold
// rather than a typical/stale pair.

export interface VelocityThreshold {
  typical: number;
  stale: number;
}

// Only the two boss-confirmed transitions are surfaced in v1. Add
// 'mql->hpp' and 'pursuit->closeWon' entries here later if business
// demand emerges; the compute layer is already capable of measuring
// those (see compute.ts comments). Adding a transition to this map
// plus a corresponding <VelocityCard> on FunnelVelocityPage is the
// entire extension path.
export const VELOCITY_THRESHOLDS: Record<string, VelocityThreshold> = {
  // Boss-confirmed 2026-05-07:
  // - HPP → Opp: 90+ days at HPP is a red flag
  // - Opp → Pursuit: 115+ days at Opp is a red flag
  // - Combined HPP → Pursuit goal: 205 days (90 + 115)
  'hpp->opp':     { typical: 90,  stale: 90 },
  'opp->pursuit': { typical: 115, stale: 115 },
};
