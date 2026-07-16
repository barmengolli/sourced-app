// BDR Quota tracker constants.
//
// The roster is fixed for v1. These exact strings are the dropdown options in
// the deal editor AND the values stored in attributions.bdr_name and
// bdr_quotas.bdr_name, so the computed-actual-to-quota join is an exact string
// match. Changing the roster here changes the dropdown; existing rows keep
// whatever string they were saved with.

// Active BDRs: each gets a gauge card and rolls into the Program total.
export const BDRS = ['Dave Cummins', 'Garrett McNally'] as const;

// Catch-all for deals from BDRs who have left the company. Selectable in the
// editor and counted in the year-over-year "created" chart, but it does NOT
// get its own gauge card and is NOT in the Program roll-up (no quota to hit).
export const OTHER_BDR = 'Other';

// Everything offered in the BDR dropdown: active roster + the Other bucket.
export const BDR_OPTIONS: string[] = [...BDRS, OTHER_BDR];

// The two metrics the BDR Qualification sheet tracks, as attribution stage
// keys: HPP = 'hpp' (HPP/SQL), SAO = 'opp' (Opp/SAO).
export const BDR_STAGES = ['hpp', 'opp'] as const;
export type BdrStage = (typeof BDR_STAGES)[number];

export const BDR_STAGE_LABELS: Record<BdrStage, string> = {
  hpp: 'HPP (SQL)',
  opp: 'Opp (SAO)',
};
