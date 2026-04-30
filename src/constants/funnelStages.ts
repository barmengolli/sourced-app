import type { StageKey, AttributionStageKey } from '../types/db';

// Six visible columns in the funnel grid: lead-side first, then attribution.
export type FunnelStageKey = StageKey | AttributionStageKey;

export const FUNNEL_STAGES: FunnelStageKey[] = [
  'lead',
  'mql',
  'hpp',
  'opp',
  'pursuit',
  'closeWon',
];

// User-facing labels mirror DataVis 1's dual-name convention so reports are
// recognizable to readers used to the SFDC-side terminology.
export const FUNNEL_STAGE_LABELS: Record<FunnelStageKey, string> = {
  lead: 'Leads',
  mql: 'MQL',
  hpp: 'HPP (SQL)',
  opp: 'Opp (SAO)',
  pursuit: 'Pursuit',
  closeWon: 'Closed won',
};

// Stages whose actuals are computed from leads (read-only). Everything else
// is manually entered into funnel_actuals.
export const COMPUTED_STAGES: ReadonlySet<FunnelStageKey> = new Set([
  'lead',
  'mql',
]);

// Stages stored in funnel_actuals (manually entered).
export const MANUAL_ACTUAL_STAGES: AttributionStageKey[] = [
  'hpp',
  'opp',
  'pursuit',
  'closeWon',
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
