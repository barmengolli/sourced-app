// funnelRegressionFixture.ts: the Bite 4E zero-drift regression dataset.
//
// A SINGLE-MEMBERSHIP world: every lead has at most one campaign
// membership, mirroring the pre-4E model where a lead counted in exactly
// its source channel. For this dataset the touch-based counting MUST
// produce numbers identical to the pre-4E lead-based counting; the
// expected values in computeTouchCounting.test.ts were captured by
// running the PRE-4E computeGrid/computeMonthlyLeadsForYear over this
// exact fixture. Every id and date is explicit so the fixture is stable
// across suite ordering. All MQLs land in the same period as their
// lead's sourced date on purpose: cross-period MQL counting is a
// DELIBERATE 4E behavior change and is tested separately, never as
// regression.

import type { Channel, FunnelActual, FunnelProjection, Lead } from '../../types/db';
import { attribution, channel, lead, stageHistory } from './factories';
import type { LeadCampaignTouchRow } from '../../types/db';

export const REG_CHANNELS: Channel[] = [
  channel({ id: 'c-root1', name: 'Events Root', display_order: 1 }),
  channel({ id: 'c-sub1', name: 'Summit Sub', parent_channel_id: 'c-root1', display_order: 1 }),
  channel({ id: 'c-root2', name: 'Content Root', display_order: 2 }),
];

export const REG_LEADS: Lead[] = [
  lead({
    id: 'L1',
    source_channel_id: 'c-sub1',
    marketing_sourced_date: '2026-01-15',
    region: 'NA',
    stage_history: [stageHistory('mql', '2026-02-10')],
  }),
  lead({
    id: 'L2',
    source_channel_id: 'c-sub1',
    marketing_sourced_date: '2026-02-20',
    region: 'EMEA cont & LATAM',
  }),
  lead({
    id: 'L3',
    source_channel_id: 'c-root2',
    marketing_sourced_date: '2026-04-05',
    region: 'NA',
    stage_history: [stageHistory('mql', '2026-05-10')],
  }),
  lead({
    id: 'L4',
    source_channel_id: 'c-root2',
    marketing_sourced_date: '2025-11-05',
    region: 'NA',
  }),
  lead({
    id: 'L5',
    source_channel_id: null,
    marketing_sourced_date: '2026-01-20',
    region: 'NA',
  }),
  lead({
    id: 'L6',
    source_channel_id: 'c-sub1',
    marketing_sourced_date: null,
    region: 'NA',
  }),
];

export const REG_PROJECTIONS: FunnelProjection[] = [
  {
    id: 'proj-1',
    channel_id: 'c-sub1',
    year: 2026,
    period_index: 1,
    stage_key: 'lead',
    projection: 10,
    edited_at: '2026-01-01T00:00:00Z',
  },
];

export const REG_MANUAL_ACTUALS: FunnelActual[] = [
  // Applies: nothing in the c-root1 family has 2025 source data.
  {
    id: 'fa-1',
    channel_id: 'c-root1',
    year: 2025,
    period_index: 1,
    stage_key: 'lead',
    actual: 12,
    edited_at: '2026-01-01T00:00:00Z',
  },
  // Suppressed: L4 covers (c-root2, 2025 Q4, lead) at source.
  {
    id: 'fa-2',
    channel_id: 'c-root2',
    year: 2025,
    period_index: 4,
    stage_key: 'lead',
    actual: 30,
    edited_at: '2026-01-01T00:00:00Z',
  },
  // Applies: c-root2 has no 2026 Q1 lead signal.
  {
    id: 'fa-3',
    channel_id: 'c-root2',
    year: 2026,
    period_index: 1,
    stage_key: 'lead',
    actual: 7,
    edited_at: '2026-01-01T00:00:00Z',
  },
];

export const REG_ATTRIBUTIONS = [
  attribution({
    id: 'attr-1',
    channel_id: 'c-root2',
    stage_key: 'hpp',
    year: 2026,
    period_index: 1,
    region: 'NA',
  }),
];

// The seed-equivalent touches for this dataset: exactly what the 4C
// backfill produced for these leads (one touch per lead from its primary
// source; L5 has no channel so its seed-equivalent touch is channel-less;
// L6 has a channel but no date).
export function regressionTouches(): LeadCampaignTouchRow[] {
  return REG_LEADS.filter((l) => l.source_channel_id || l.marketing_sourced_date).map(
    (l, i) =>
      ({
        id: `touch-reg-${i}`,
        lead_id: l.id,
        campaign_member_id: null,
        campaign_id: null,
        channel_id: l.source_channel_id ?? null,
        touch_date: l.marketing_sourced_date ?? null,
        parent_campaign: null,
        sub_campaign: null,
        observed_at: '2026-07-01T00:00:00Z',
        source: 'backfill',
        raw: {},
        created_at: '2026-07-01T00:00:00Z',
      }) as LeadCampaignTouchRow,
  );
}
