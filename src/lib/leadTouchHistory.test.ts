// Bite 4F: lead-drawer touch history and the surface-audit guarantees.
// Synthetic data only.

import { describe, it, expect } from 'vitest';
import { computeLeadTouchHistory } from './leadTouchHistory';
import { computeGrid } from './compute';
import { channel, lead, touchRow, stageHistory } from '../test/fixtures/factories';

const CHANNELS = [
  channel({ id: 'c-primary', name: 'Content Syndication' }),
  channel({ id: 'c-other', name: 'Events' }),
];

describe('lead drawer touch history', () => {
  it('lists every touch for the lead, newest first, undated last', () => {
    const entries = computeLeadTouchHistory({
      touches: [
        touchRow({ id: 't1', lead_id: 'L1', channel_id: 'c-primary', touch_date: '2026-01-10' }),
        touchRow({ id: 't2', lead_id: 'L1', channel_id: 'c-other', touch_date: '2026-05-02' }),
        touchRow({ id: 't3', lead_id: 'L1', channel_id: 'c-other', touch_date: null }),
        // Another lead's touch must never leak in.
        touchRow({ id: 't4', lead_id: 'L2', channel_id: 'c-primary', touch_date: '2026-03-03' }),
      ],
      leadId: 'L1',
      primaryChannelId: 'c-primary',
      channels: CHANNELS,
    });
    expect(entries.map((e) => e.touchId)).toEqual(['t2', 't1', 't3']);
    expect(entries.map((e) => e.channelName)).toEqual([
      'Events',
      'Content Syndication',
      'Events',
    ]);
  });

  it('marks only the primary-source channel as primary', () => {
    const entries = computeLeadTouchHistory({
      touches: [
        touchRow({ id: 't1', lead_id: 'L1', channel_id: 'c-primary', touch_date: '2026-01-10' }),
        touchRow({ id: 't2', lead_id: 'L1', channel_id: 'c-other', touch_date: '2026-02-10' }),
      ],
      leadId: 'L1',
      primaryChannelId: 'c-primary',
      channels: CHANNELS,
    });
    expect(entries.find((e) => e.touchId === 't1')!.isPrimaryChannel).toBe(true);
    expect(entries.find((e) => e.touchId === 't2')!.isPrimaryChannel).toBe(false);
  });

  it('surfaces the corrected-date indicator only when the SFDC date differs', () => {
    const entries = computeLeadTouchHistory({
      touches: [
        // 4D moved Marketing's locked date onto the touch; raw keeps the report date.
        touchRow({
          id: 't1',
          lead_id: 'L1',
          channel_id: 'c-primary',
          touch_date: '2026-01-05',
          raw: { sfdc_touch_date: '2026-04-02' },
        }),
        // Same date in raw: nothing was corrected, so no indicator.
        touchRow({
          id: 't2',
          lead_id: 'L1',
          channel_id: 'c-other',
          touch_date: '2026-02-01',
          raw: { sfdc_touch_date: '2026-02-01' },
        }),
        touchRow({ id: 't3', lead_id: 'L1', channel_id: 'c-other', touch_date: '2026-03-01' }),
      ],
      leadId: 'L1',
      primaryChannelId: 'c-primary',
      channels: CHANNELS,
    });
    expect(entries.find((e) => e.touchId === 't1')!.correctedFromSfdcDate).toBe('2026-04-02');
    expect(entries.find((e) => e.touchId === 't2')!.correctedFromSfdcDate).toBeNull();
    expect(entries.find((e) => e.touchId === 't3')!.correctedFromSfdcDate).toBeNull();
  });

  it('carries provenance and the source badge value, including seeds', () => {
    const entries = computeLeadTouchHistory({
      touches: [
        touchRow({
          id: 't1',
          lead_id: 'L1',
          channel_id: 'c-primary',
          touch_date: '2026-01-10',
          parent_campaign: '2026 - Events',
          sub_campaign: '2026 - ITC Asia',
          source: 'import',
        }),
        touchRow({ id: 't2', lead_id: 'L1', channel_id: 'c-other', touch_date: null, source: 'backfill' }),
      ],
      leadId: 'L1',
      primaryChannelId: 'c-primary',
      channels: CHANNELS,
    });
    const imported = entries.find((e) => e.touchId === 't1')!;
    expect(imported.parentCampaign).toBe('2026 - Events');
    expect(imported.subCampaign).toBe('2026 - ITC Asia');
    expect(imported.source).toBe('import');
    expect(entries.find((e) => e.touchId === 't2')!.source).toBe('backfill');
  });

  it('a channel-less touch is still listed, labeled No channel', () => {
    const entries = computeLeadTouchHistory({
      touches: [touchRow({ id: 't1', lead_id: 'L1', channel_id: null, touch_date: '2026-01-10' })],
      leadId: 'L1',
      primaryChannelId: 'c-primary',
      channels: CHANNELS,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].channelName).toBe('No channel');
    expect(entries[0].isPrimaryChannel).toBe(false);
  });

  it('a lead with no touches yields an empty history', () => {
    expect(
      computeLeadTouchHistory({
        touches: [touchRow({ lead_id: 'OTHER', channel_id: 'c-primary' })],
        leadId: 'L1',
        primaryChannelId: null,
        channels: CHANNELS,
      }),
    ).toEqual([]);
  });
});

describe('switched surfaces derive from memberships (multi-campaign proof)', () => {
  // One contact, two campaigns, one MQL event. Every surface fed by
  // computeGrid / computeMonthlyLeadsForYear must show them under BOTH
  // channels; person-level surfaces are unaffected (they read leads, not
  // touches, and are covered by their own suites).
  const person = lead({
    id: 'P1',
    region: 'NA',
    source_channel_id: 'c-primary',
    marketing_sourced_date: '2026-01-10',
    stage_history: [stageHistory('mql', '2026-02-01')],
  });
  const touches = [
    touchRow({ lead_id: 'P1', channel_id: 'c-primary', touch_date: '2026-01-10' }),
    touchRow({ lead_id: 'P1', channel_id: 'c-other', touch_date: '2026-02-15' }),
  ];
  const grid = computeGrid({
    leads: [person],
    touches,
    channels: CHANNELS,
    projections: [],
    manualActuals: [],
    attributions: [],
    year: 2026,
    filter: 'Q1',
  });

  it('Actuals vs Projections / Channel Distribution / Conversion Funnel read grid rows showing both channels', () => {
    // All three charts consume grid.rows or grid.totals, so proving the
    // rows carry both memberships proves the charts do.
    expect(grid.rows.find((r) => r.channelId === 'c-primary')!.cells.lead.actual).toBe(1);
    expect(grid.rows.find((r) => r.channelId === 'c-other')!.cells.lead.actual).toBe(1);
    expect(grid.totals.lead.actual).toBe(2);
    expect(grid.uniqueContacts.lead).toBe(1);
  });

  it('the MQL event counts under both touched channels', () => {
    expect(grid.rows.find((r) => r.channelId === 'c-primary')!.cells.mql.actual).toBe(1);
    expect(grid.rows.find((r) => r.channelId === 'c-other')!.cells.mql.actual).toBe(1);
    expect(grid.totals.mql.actual).toBe(2);
    expect(grid.uniqueContacts.mql).toBe(1);
  });

  it('membership totals exceed unique contacts, never the reverse', () => {
    expect(grid.totals.lead.actual!).toBeGreaterThan(grid.uniqueContacts.lead);
    expect(grid.uniqueContacts.lead).toBeLessThanOrEqual(grid.totals.lead.actual!);
  });
});
