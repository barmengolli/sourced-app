// BDR Quota tracker constants.
//
// The roster is fixed for v1. These exact strings are the dropdown options in
// the deal editor AND the values stored in attributions.bdr_name and
// bdr_quotas.bdr_name, so the computed-actual-to-quota join is an exact string
// match. Changing the roster here changes the dropdown; existing rows keep
// whatever string they were saved with.

export const BDRS = ['Dave Cummins', 'Garrett McNally'] as const;
export type Bdr = (typeof BDRS)[number];

// The two metrics the BDR Qualification sheet tracks, as attribution stage
// keys: HPP = 'hpp' (HPP/SQL), SAO = 'opp' (Opp/SAO).
export const BDR_STAGES = ['hpp', 'opp'] as const;
export type BdrStage = (typeof BDR_STAGES)[number];

export const BDR_STAGE_LABELS: Record<BdrStage, string> = {
  hpp: 'HPP (SQL)',
  opp: 'Opp (SAO)',
};

// A deal counts toward BDR quota only when its first-touch top-level channel
// resolves to this base name (year prefix stripped, e.g. "2026 - Marketing
// SDR" -> "Marketing SDR"). Any sub-campaign under it qualifies.
export const MARKETING_SDR_BASE_NAME = 'Marketing SDR';
