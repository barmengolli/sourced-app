// Tests for the primary-source and campaign-influence attribution contract
// (Bite 4A). Synthetic identifiers and fixed dates only.

import { describe, it, expect } from 'vitest';
import {
  dedupeTouches,
  resolvePrimarySources,
  influenceReport,
  touchRowToLeadCampaignTouch,
} from './campaignAttribution';
import type { LeadCampaignTouch } from './campaignAttribution';
import type { LeadCampaignTouchRow } from '../types/db';

function touch(over: Partial<LeadCampaignTouch> & Pick<LeadCampaignTouch, 'leadId' | 'campaignId'>): LeadCampaignTouch {
  return {
    campaignMemberId: null,
    touchDate: '2026-04-01',
    observedAt: '2026-04-02T03:00:00Z',
    ...over,
  };
}

describe('idempotent touch ingestion', () => {
  it('processing the same Campaign Member ID multiple times is idempotent', () => {
    const t = touch({ leadId: 'l1', campaignId: 'camp-po', campaignMemberId: 'cm-001' });
    const once = dedupeTouches([t]);
    const thrice = dedupeTouches([t, { ...t }, { ...t }]);
    expect(once.touches).toHaveLength(1);
    expect(thrice.touches).toHaveLength(1);
    expect(thrice.duplicatesRemoved).toBe(2);
    // Same-lead touches from DIFFERENT campaign memberships are kept.
    const two = dedupeTouches([
      t,
      touch({ leadId: 'l1', campaignId: 'camp-bac', campaignMemberId: 'cm-002', touchDate: '2026-05-01' }),
    ]);
    expect(two.touches).toHaveLength(2);
  });

  it('a touch without a Campaign Member ID still dedupes on the natural key and is flagged', () => {
    const t = touch({ leadId: 'l1', campaignId: 'camp-po' });
    const r = dedupeTouches([t, { ...t }]);
    expect(r.touches).toHaveLength(1);
    expect(r.duplicatesRemoved).toBe(1);
    expect(r.issues.find((i) => i.kind === 'missing_campaign_member_id')?.count).toBe(2);
  });

  it('touches missing lead or campaign identity are rejected with issues, never guessed', () => {
    const r = dedupeTouches([
      touch({ leadId: '', campaignId: 'camp-po' }),
      touch({ leadId: 'l1', campaignId: '  ' }),
      touch({ leadId: 'l2', campaignId: 'camp-po', campaignMemberId: 'cm-9' }),
    ]);
    expect(r.touches).toHaveLength(1);
    expect(r.rejected).toHaveLength(2);
    expect(r.issues.some((i) => i.kind === 'missing_lead_identity')).toBe(true);
    expect(r.issues.some((i) => i.kind === 'missing_campaign_identity')).toBe(true);
  });
});

describe('primary source versus influence', () => {
  // Product Overview download on Apr 1, Book a Call on May 10.
  const touches: LeadCampaignTouch[] = [
    touch({ leadId: 'l1', campaignId: 'camp-product-overview', campaignMemberId: 'cm-1', touchDate: '2026-04-01' }),
    touch({ leadId: 'l1', campaignId: 'camp-book-a-call', campaignMemberId: 'cm-2', touchDate: '2026-05-10' }),
  ];

  it('the earliest touch is the primary source and a later touch never replaces it', () => {
    const r = resolvePrimarySources(touches);
    expect(r.byLead['l1'].campaignId).toBe('camp-product-overview');
    expect(r.byLead['l1'].basis).toBe('earliest_touch');
    // Recomputing with the later touch first changes nothing (order-independent).
    const reversed = resolvePrimarySources([touches[1], touches[0]]);
    expect(reversed.byLead['l1'].campaignId).toBe('camp-product-overview');
  });

  it('the same person appears under both campaigns in the influence report', () => {
    const r = influenceReport(touches);
    const byId = Object.fromEntries(r.campaigns.map((c) => [c.campaignId, c.uniqueLeads]));
    expect(byId['camp-product-overview']).toBe(1);
    expect(byId['camp-book-a-call']).toBe(1);
    // Overlapping participation, deduplicated people.
    expect(r.participationTotal).toBe(2);
    expect(r.uniquePeople).toBe(1);
    expect(r.peopleInMultipleCampaigns).toBe(1);
    expect(r.nonAdditive).toBe(true);
  });

  it('influence totals overlap while the unique-person count stays deduplicated', () => {
    const many: LeadCampaignTouch[] = [
      touch({ leadId: 'l1', campaignId: 'camp-a', campaignMemberId: 'cm-1' }),
      touch({ leadId: 'l1', campaignId: 'camp-b', campaignMemberId: 'cm-2' }),
      touch({ leadId: 'l2', campaignId: 'camp-a', campaignMemberId: 'cm-3' }),
      touch({ leadId: 'l3', campaignId: 'camp-b', campaignMemberId: 'cm-4' }),
    ];
    const r = influenceReport(many);
    expect(r.participationTotal).toBe(4);
    expect(r.uniquePeople).toBe(3);
    // The overlapping participation total is never the efficiency denominator;
    // uniquePeople is exposed separately for that purpose.
    expect(r.participationTotal).toBeGreaterThan(r.uniquePeople);
  });

  it('primary-source totals are mutually exclusive and reconcile to unique people', () => {
    const many: LeadCampaignTouch[] = [
      touch({ leadId: 'l1', campaignId: 'camp-a', campaignMemberId: 'cm-1', touchDate: '2026-04-01' }),
      touch({ leadId: 'l1', campaignId: 'camp-b', campaignMemberId: 'cm-2', touchDate: '2026-04-09' }),
      touch({ leadId: 'l2', campaignId: 'camp-b', campaignMemberId: 'cm-3', touchDate: '2026-04-02' }),
      touch({ leadId: 'l3', campaignId: 'camp-a', campaignMemberId: 'cm-4', touchDate: null }),
    ];
    const r = resolvePrimarySources(many);
    const assigned = Object.values(r.byCampaign).reduce((a, b) => a + b, 0);
    expect(assigned + r.unresolved).toBe(r.uniqueLeads);
    expect(r.byCampaign['camp-a']).toBe(1);
    expect(r.byCampaign['camp-b']).toBe(1);
    // l3 has no dated touch: unresolved with an issue, not silently assigned.
    expect(r.unresolved).toBe(1);
    expect(r.byLead['l3'].state).toBe('incomplete');
    expect(r.byLead['l3'].issues.some((i) => i.kind === 'no_dated_touch')).toBe(true);
  });

  it('a manual Marketing correction (edit lock) always wins over recomputation', () => {
    const r = resolvePrimarySources(touches, { l1: 'camp-corrected' });
    expect(r.byLead['l1'].campaignId).toBe('camp-corrected');
    expect(r.byLead['l1'].basis).toBe('manual_lock');
    expect(r.byCampaign['camp-corrected']).toBe(1);
    expect(r.byCampaign['camp-product-overview']).toBeUndefined();
  });

  it('same-day touches break ties on the earlier observation deterministically', () => {
    const sameDay: LeadCampaignTouch[] = [
      touch({ leadId: 'l1', campaignId: 'camp-late-obs', campaignMemberId: 'cm-1', touchDate: '2026-04-01', observedAt: '2026-04-01T12:00:00Z' }),
      touch({ leadId: 'l1', campaignId: 'camp-early-obs', campaignMemberId: 'cm-2', touchDate: '2026-04-01', observedAt: '2026-04-01T08:00:00Z' }),
    ];
    expect(resolvePrimarySources(sameDay).byLead['l1'].campaignId).toBe('camp-early-obs');
  });

  it('an empty population is missing, not zero', () => {
    expect(resolvePrimarySources([]).state).toBe('missing');
    expect(influenceReport([]).state).toBe('missing');
  });
});

describe('touchRowToLeadCampaignTouch (Bite 4C storage mapping)', () => {
  function row(over: Partial<LeadCampaignTouchRow> = {}): LeadCampaignTouchRow {
    return {
      id: 'row-1',
      lead_id: 'lead-1',
      campaign_member_id: 'CM-SYNTH-1',
      campaign_id: 'CAMP-SYNTH-1',
      channel_id: 'channel-1',
      touch_date: '2026-03-01',
      parent_campaign: 'Synthetic Parent',
      sub_campaign: 'Synthetic Sub',
      observed_at: '2026-03-02T00:00:00Z',
      source: 'import',
      raw: { note: 'synthetic' },
      created_at: '2026-03-02T00:00:00Z',
      ...over,
    };
  }

  it('maps every storage field onto the 4A calculation type', () => {
    const mapped = touchRowToLeadCampaignTouch(row());
    expect(mapped).toEqual({
      leadId: 'lead-1',
      campaignMemberId: 'CM-SYNTH-1',
      campaignId: 'CAMP-SYNTH-1',
      channelId: 'channel-1',
      touchDate: '2026-03-01',
      parentCampaign: 'Synthetic Parent',
      subCampaign: 'Synthetic Sub',
      observedAt: '2026-03-02T00:00:00Z',
      raw: { note: 'synthetic' },
    });
  });

  it('a mapped membership row survives dedupeTouches unchanged', () => {
    const result = dedupeTouches([touchRowToLeadCampaignTouch(row())]);
    expect(result.touches).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.duplicatesRemoved).toBe(0);
  });

  it('a backfill seed row without campaign identity is rejected by dedupe, by design', () => {
    // Seed rows are the mirrored primary source, not campaign memberships;
    // the migration's own guard protects them instead of the natural key.
    const seed = touchRowToLeadCampaignTouch(
      row({ campaign_member_id: null, campaign_id: null, source: 'backfill' }),
    );
    expect(seed.campaignId).toBe('');
    const result = dedupeTouches([seed]);
    expect(result.touches).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.issues.some((i) => i.kind === 'missing_campaign_identity')).toBe(true);
  });

  it('an Id-less report-export row dedupes on the natural key after mapping', () => {
    const a = touchRowToLeadCampaignTouch(row({ id: 'row-a', campaign_member_id: null }));
    const b = touchRowToLeadCampaignTouch(row({ id: 'row-b', campaign_member_id: null }));
    const result = dedupeTouches([a, b]);
    expect(result.touches).toHaveLength(1);
    expect(result.duplicatesRemoved).toBe(1);
  });
});
