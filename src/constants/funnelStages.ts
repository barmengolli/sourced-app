import type { StageKey, AttributionStageKey } from '../types/db';

// Seven visible columns in the funnel grid: lead-side first, then four
// attribution stages, then Closed Lost as a parallel terminal stage to
// Closed Won. Order is load-bearing: charts and the FunnelTable iterate
// this array, so closeLost lands rightmost which keeps the happy-path
// (Lead → … → Closed Won) visually clean.
export type FunnelStageKey = StageKey | AttributionStageKey;

export const FUNNEL_STAGES: FunnelStageKey[] = [
  'lead',
  'mql',
  'hpp',
  'opp',
  'pursuit',
  'closeWon',
  'closeLost',
];

// Stages whose PROJECTIONS roll up from a parent channel's sub-campaigns
// (so the parent PROJ = sum of children). The remaining stages
// (HPP/Opp/Pursuit/closed) keep the parent's own entered projection and stay
// directly editable, since those late-funnel targets are set at the parent
// level rather than attributed to a specific sub-campaign. Actuals always roll
// up for every stage regardless of this set.
export const PROJ_ROLLUP_STAGES: ReadonlySet<FunnelStageKey> = new Set([
  'lead',
  'mql',
]);

// User-facing labels mirror DataVis 1's dual-name convention so reports are
// recognizable to readers used to the SFDC-side terminology.
export const FUNNEL_STAGE_LABELS: Record<FunnelStageKey, string> = {
  lead: 'Leads',
  mql: 'MQL',
  hpp: 'HPP (SQL)',
  opp: 'Opp (SAO)',
  pursuit: 'Pursuit',
  closeWon: 'Closed won',
  closeLost: 'Closed lost',
};

// Stages whose actuals are computed from leads (read-only). Everything else
// is manually entered into funnel_actuals.
export const COMPUTED_STAGES: ReadonlySet<FunnelStageKey> = new Set([
  'lead',
  'mql',
]);

// Stages a deal can be marked Lost FROM. Excludes closeWon (terminal) and
// closeLost itself (already terminal). Excludes lead/mql (pre-attribution).
export const LOSS_ELIGIBLE_STAGES: AttributionStageKey[] = [
  'hpp',
  'opp',
  'pursuit',
];

// Terminal stages: deals at these stages have no Promote and no Close Lost.
export const TERMINAL_STAGES: AttributionStageKey[] = [
  'closeWon',
  'closeLost',
];

// Reason a deal was closed-lost. Required (at the UI layer) whenever a deal
// is newly marked lost. Stored verbatim in attributions.lost_reason; the
// column is plain TEXT so this list can grow without a migration.
export type LostReason =
  | 'Closed-Lost to Competitor'
  | 'Closed-Lost In-House'
  | 'Closed-Disqualified';

export const LOST_REASONS: LostReason[] = [
  'Closed-Lost to Competitor',
  'Closed-Lost In-House',
  'Closed-Disqualified',
];

export interface ConversionPair {
  from: FunnelStageKey;
  to: FunnelStageKey;
  label: string;
}

export const CONVERSION_PAIRS: ConversionPair[] = [
  { from: 'lead', to: 'mql', label: 'Lead to MQL' },
  { from: 'mql', to: 'hpp', label: 'MQL to SQL' },
  { from: 'hpp', to: 'opp', label: 'SQL to SAO' },
  { from: 'opp', to: 'pursuit', label: 'SAO to Pursuit' },
  { from: 'pursuit', to: 'closeWon', label: 'Pursuit to Won' },
  { from: 'lead', to: 'closeWon', label: 'Lead to Won' },
];
