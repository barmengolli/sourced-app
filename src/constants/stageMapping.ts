import type { StageKey } from '../types/db';

export const STAGE_FROM_LIFECYCLE: Record<string, StageKey> = {
  'Lead': 'lead',
  'Marketing Qualified Lead': 'mql',
  'Prospect': 'lead',
  // B2B parent-account rule: a HubSpot Customer is the parent account being a
  // customer; the contact is still a lead until they themselves convert.
  'Customer': 'lead',
  'Opportunity': 'mql',
  '': 'lead',
};

export function mapLifecycleStage(input: string | undefined | null): StageKey {
  const k = (input ?? '').trim();
  return STAGE_FROM_LIFECYCLE[k] ?? 'lead';
}
