// Typed fixture factories for pure-unit tests. Every builder returns a fully
// valid domain object with sensible defaults, overridable per field. No PII:
// names/emails are synthetic tokens. Anonymized fixtures live here per the plan
// (Section 7.3); do not paste production rows.

import type {
  Channel,
  CampaignCost,
  Lead,
  Attribution,
  AttributionTouch,
  StageHistoryEntry,
  StageKey,
  AttributionStageKey,
} from '../../types/db';

let seq = 0;
// Deterministic id generator: tests must not depend on Math.random or uuid so
// runs are reproducible. Reset between files is unnecessary because ids only
// need to be unique within a test, not stable across the suite.
export function id(prefix = 'id'): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function channel(over: Partial<Channel> = {}): Channel {
  return {
    id: over.id ?? id('chan'),
    name: 'Channel',
    parent_channel_id: null,
    year: 2026,
    display_order: 0,
    hidden: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

export function campaignCost(over: Partial<CampaignCost> = {}): CampaignCost {
  return {
    id: over.id ?? id('cost'),
    channel_id: over.channel_id ?? id('chan'),
    amount: 1000,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

export function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: over.id ?? id('lead'),
    email: `lead-${seq}@example.test`,
    current_stage: 'lead' as StageKey,
    marketing_sourced_date: '2026-02-15',
    source_channel_id: over.source_channel_id ?? null,
    region: 'NA',
    stage_history: [],
    field_locks: {},
    source_sfdc: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as Lead;
}

export function stageHistory(
  stage: StageKey,
  entered_at: string,
  over: Partial<StageHistoryEntry> = {},
): StageHistoryEntry {
  return { stage, entered_at, ...over };
}

export function attribution(over: Partial<Attribution> = {}): Attribution {
  return {
    id: over.id ?? id('attr'),
    deal_id: over.deal_id ?? id('deal'),
    lead_id: null,
    stage_key: 'hpp' as AttributionStageKey,
    channel_id: over.channel_id ?? null,
    amount: null,
    year: 2026,
    period_index: 1,
    stage_entered_at: '2026-02-15',
    label: null,
    account: null,
    sf_link: null,
    region: 'NA',
    lost_reason: null,
    bdr_name: null,
    created_at: '2026-02-15T00:00:00Z',
    ...over,
  } as Attribution;
}

export function touch(over: Partial<AttributionTouch> = {}): AttributionTouch {
  return {
    id: over.id ?? id('touch'),
    attribution_id: over.attribution_id ?? id('attr'),
    touch_order: 1,
    channel_id: over.channel_id ?? null,
    touched_at: '2026-02-15',
    notes: null,
    created_at: '2026-02-15T00:00:00Z',
    ...over,
  };
}
