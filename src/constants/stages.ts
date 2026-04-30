import type { StageKey } from '../types/db';

export const STAGE_LABELS: Record<StageKey, string> = {
  lead: 'Lead',
  mql: 'MQL',
};

export const STAGE_ORDER: StageKey[] = ['lead', 'mql'];
