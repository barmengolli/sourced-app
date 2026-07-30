// Tests for the Bite 4D pure campaign-touch import logic. Synthetic data
// only; fixed dates; no clock, network, or database.

import { describe, it, expect } from 'vitest';
import {
  MISSING_IDENTITY_WARNING,
  TOUCH_DATE_SENTINEL,
  buildTouchCandidate,
  extractTouchRows,
  isChannelOrDescendant,
  planTouchUpserts,
  touchUpsertKey,
} from './touchImport';
import type {
  ChannelParentMap,
  ExistingTouchLite,
  TouchCandidate,
  TouchLeadContext,
  TouchRowInput,
} from './touchImport';
import type { ColumnMapping } from './csv';

const MAPPING: ColumnMapping = {
  email: 'Email',
  marketing_sourced_date: 'Member First Associated Date',
  parent_campaign: 'Parent Campaign: Campaign Name',
  sub_campaign: 'Campaign Name',
  campaign_member_id: 'Campaign Member ID',
  campaign_id: 'Campaign ID',
};

function csvRow(over: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    Email: 'synth.person@example.test',
    'Member First Associated Date': '3/15/2026',
    'Parent Campaign: Campaign Name': 'Synthetic Parent',
    'Campaign Name': 'Synthetic Sub',
    'Campaign Member ID': 'SYNTH-CM-1',
    'Campaign ID': 'SYNTH-CAMP-1',
    ...over,
  };
}

const LEAD: TouchLeadContext = {
  leadId: 'lead-1',
  sourceChannelId: 'channel-primary',
  marketingSourcedDate: '2026-01-10',
  sourcedDateLocked: false,
};

function input(over: Partial<TouchRowInput> = {}): TouchRowInput {
  return {
    email: 'synth.person@example.test',
    campaignMemberId: 'SYNTH-CM-1',
    campaignId: 'SYNTH-CAMP-1',
    parentCampaign: 'Synthetic Parent',
    subCampaign: 'Synthetic Sub',
    reportTouchDate: '2026-03-15',
    ...over,
  };
}

function existingRow(over: Partial<ExistingTouchLite> = {}): ExistingTouchLite {
  return {
    id: 'touch-1',
    lead_id: 'lead-1',
    campaign_member_id: 'SYNTH-CM-1',
    campaign_id: 'SYNTH-CAMP-1',
    channel_id: 'channel-primary',
    touch_date: '2026-03-15',
    parent_campaign: 'Synthetic Parent',
    sub_campaign: 'Synthetic Sub',
    source: 'import',
    ...over,
  };
}

function candidate(over: Partial<TouchRowInput> = {}): TouchCandidate {
  return buildTouchCandidate(input(over), LEAD, 'channel-primary');
}

describe('per-row extraction', () => {
  it('keeps one touch row per membership: a multi-campaign person is never collapsed', () => {
    const extraction = extractTouchRows(
      [
        csvRow(),
        csvRow({
          'Campaign Member ID': 'SYNTH-CM-2',
          'Campaign ID': 'SYNTH-CAMP-2',
          'Campaign Name': 'Synthetic Other Sub',
          'Member First Associated Date': '4/02/2026',
        }),
      ],
      MAPPING,
    );
    expect(extraction.rows).toHaveLength(2);
    expect(extraction.identityMapped).toBe(true);
    expect(extraction.withMemberId).toBe(2);
    expect(extraction.rows[1].reportTouchDate).toBe('2026-04-02');
  });

  it('flags the neither-column-mapped case for the visible warning', () => {
    const { campaign_member_id, campaign_id, ...withoutIds } = MAPPING;
    void campaign_member_id;
    void campaign_id;
    const extraction = extractTouchRows([csvRow()], withoutIds);
    expect(extraction.identityMapped).toBe(false);
    expect(extraction.rows[0].campaignMemberId).toBeNull();
    expect(extraction.rows[0].campaignId).toBeNull();
    expect(MISSING_IDENTITY_WARNING).toContain('not mapped');
  });

  it('handles rows with and without the ID columns in one file', () => {
    const extraction = extractTouchRows(
      [csvRow(), csvRow({ 'Campaign Member ID': '', 'Campaign ID': '' })],
      MAPPING,
    );
    expect(extraction.withMemberId).toBe(1);
    expect(extraction.withoutIdentity).toBe(1);
  });
});

describe('edit-lock date precedence', () => {
  it('locked primary-channel touch uses the corrected date and preserves the report date in raw', () => {
    const locked: TouchLeadContext = { ...LEAD, sourcedDateLocked: true };
    const built = buildTouchCandidate(input(), locked, 'channel-primary');
    expect(built.touchDate).toBe('2026-01-10');
    expect(built.raw.sfdc_touch_date).toBe('2026-03-15');
  });

  it('unlocked primary channel uses the report date', () => {
    const built = buildTouchCandidate(input(), LEAD, 'channel-primary');
    expect(built.touchDate).toBe('2026-03-15');
    expect(built.raw.sfdc_touch_date).toBeUndefined();
  });

  it('a non-primary-channel touch ignores the lock', () => {
    const locked: TouchLeadContext = { ...LEAD, sourcedDateLocked: true };
    const built = buildTouchCandidate(input(), locked, 'channel-other');
    expect(built.touchDate).toBe('2026-03-15');
    expect(built.raw.sfdc_touch_date).toBeUndefined();
  });

  it('raw carries campaign values only, never contact fields', () => {
    const built = buildTouchCandidate(input(), LEAD, 'channel-primary');
    expect(Object.keys(built.raw).sort()).toEqual([
      'campaign_id',
      'campaign_member_id',
      'parent_campaign',
      'sub_campaign',
    ]);
    expect(JSON.stringify(built.raw)).not.toContain('example.test');
  });
});

describe('upsert keys', () => {
  it('prefers the CampaignMember Id and falls back to the natural key', () => {
    expect(touchUpsertKey(candidate())).toEqual({ kind: 'member', key: 'cm::SYNTH-CM-1' });
    expect(touchUpsertKey(candidate({ campaignMemberId: null }))).toEqual({
      kind: 'natural',
      key: 'nk::lead-1|SYNTH-CAMP-1|2026-03-15',
    });
    expect(
      touchUpsertKey(candidate({ campaignMemberId: null, reportTouchDate: null })),
    ).toEqual({ kind: 'natural', key: `nk::lead-1|SYNTH-CAMP-1|${TOUCH_DATE_SENTINEL}` });
    expect(
      touchUpsertKey(candidate({ campaignMemberId: null, campaignId: null })),
    ).toEqual({ kind: 'skip_no_identity' });
  });
});

describe('upsert planning', () => {
  it('member-id path: inserts when absent, updates changed fields, upgrades natural-key rows', () => {
    const fresh = planTouchUpserts([candidate()], []);
    expect(fresh.inserts).toHaveLength(1);
    expect(fresh.inserts[0]).toMatchObject({
      lead_id: 'lead-1',
      campaign_member_id: 'SYNTH-CM-1',
      source: 'import',
    });

    const changed = planTouchUpserts([candidate()], [existingRow({ touch_date: '2026-02-01' })]);
    expect(changed.updates).toHaveLength(1);
    expect(changed.updates[0].patch.touch_date).toBe('2026-03-15');

    // An older export created this touch by natural key; the member-id
    // re-observation upgrades it instead of inserting a duplicate.
    const upgraded = planTouchUpserts(
      [candidate()],
      [existingRow({ campaign_member_id: null })],
    );
    expect(upgraded.inserts).toHaveLength(0);
    expect(upgraded.updates).toHaveLength(1);
    expect(upgraded.updates[0].patch.campaign_member_id).toBe('SYNTH-CM-1');
  });

  it('natural-key path upserts rows without a CampaignMember Id', () => {
    const noId = candidate({ campaignMemberId: null });
    const fresh = planTouchUpserts([noId], []);
    expect(fresh.inserts).toHaveLength(1);
    const rerun = planTouchUpserts([noId], [existingRow({ campaign_member_id: null })]);
    expect(rerun.inserts).toHaveLength(0);
    expect(rerun.updates).toHaveLength(0);
    expect(rerun.unchanged).toBe(1);
  });

  it('identity-less candidates are skipped: no silent partial writes', () => {
    const plan = planTouchUpserts([candidate({ campaignMemberId: null, campaignId: null })], [
      existingRow({ source: 'backfill', campaign_member_id: null, campaign_id: null }),
    ]);
    expect(plan.skippedNoIdentity).toBe(1);
    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
    // And supersession never fires for them.
    expect(plan.seedDeleteIds).toHaveLength(0);
  });

  it('supersession deletes the seed only for identity-carrying touches on the same channel', () => {
    const seed = existingRow({
      id: 'seed-1',
      source: 'backfill',
      campaign_member_id: null,
      campaign_id: null,
      channel_id: 'channel-primary',
    });
    const hit = planTouchUpserts([candidate()], [seed]);
    expect(hit.seedDeleteIds).toEqual(['seed-1']);
    // A different channel leaves the seed alone.
    const otherChannel = buildTouchCandidate(input(), LEAD, 'channel-other');
    const miss = planTouchUpserts([otherChannel], [seed]);
    expect(miss.seedDeleteIds).toHaveLength(0);
  });

  it('re-processing the same rows is a no-op', () => {
    const first = planTouchUpserts([candidate()], []);
    const stored: ExistingTouchLite[] = first.inserts.map((row, i) => ({
      id: `t-${i}`,
      lead_id: row.lead_id,
      campaign_member_id: row.campaign_member_id,
      campaign_id: row.campaign_id,
      channel_id: row.channel_id,
      touch_date: row.touch_date,
      parent_campaign: row.parent_campaign,
      sub_campaign: row.sub_campaign,
      source: row.source,
    }));
    const rerun = planTouchUpserts([candidate()], stored);
    expect(rerun.inserts).toHaveLength(0);
    expect(rerun.updates).toHaveLength(0);
    expect(rerun.seedDeleteIds).toHaveLength(0);
    expect(rerun.unchanged).toBe(1);
  });

  it('duplicate rows in one file collapse to one write', () => {
    const plan = planTouchUpserts([candidate(), candidate()], []);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.duplicateRowsCollapsed).toBe(1);
  });
});

describe('fixture-file walkthrough (acceptance scenario)', () => {
  it('single-campaign, multi-campaign, locked-date, and mixed-ID rows land as specified', () => {
    const rows = [
      // Single-campaign lead.
      csvRow({ Email: 'single@example.test' }),
      // Multi-campaign lead: two rows, same email, two memberships.
      csvRow({ Email: 'multi@example.test', 'Campaign Member ID': 'SYNTH-CM-M1' }),
      csvRow({
        Email: 'multi@example.test',
        'Campaign Member ID': 'SYNTH-CM-M2',
        'Campaign ID': 'SYNTH-CAMP-2',
        'Campaign Name': 'Synthetic Other Sub',
      }),
      // Locked lead (its primary-channel touch must keep the corrected date).
      csvRow({ Email: 'locked@example.test', 'Campaign Member ID': 'SYNTH-CM-L1' }),
      // Row without the ID columns' values.
      csvRow({ Email: 'noid@example.test', 'Campaign Member ID': '', 'Campaign ID': '' }),
    ];
    const extraction = extractTouchRows(rows, MAPPING);
    expect(extraction.rows).toHaveLength(5);

    const leads: Record<string, TouchLeadContext> = {
      'single@example.test': { ...LEAD, leadId: 'lead-single' },
      'multi@example.test': { ...LEAD, leadId: 'lead-multi' },
      'locked@example.test': {
        leadId: 'lead-locked',
        sourceChannelId: 'channel-primary',
        marketingSourcedDate: '2026-01-02',
        sourcedDateLocked: true,
      },
      'noid@example.test': { ...LEAD, leadId: 'lead-noid' },
    };
    // 4D.1: the report's touches land on a CHILD of each lead's primary
    // channel; descendant-aware supersession and locked-date precedence
    // must behave exactly as they did for the equal-channel case.
    const walkParents: ChannelParentMap = {
      'channel-primary': null,
      'channel-primary-child': 'channel-primary',
    };
    const candidates = extraction.rows.map((row) =>
      buildTouchCandidate(row, leads[row.email], 'channel-primary-child', walkParents),
    );
    const seeds: ExistingTouchLite[] = Object.values(leads).map((lead, i) => ({
      id: `seed-${i}`,
      lead_id: lead.leadId,
      campaign_member_id: null,
      campaign_id: null,
      channel_id: 'channel-primary',
      touch_date: '2026-01-01',
      parent_campaign: null,
      sub_campaign: null,
      source: 'backfill',
    }));

    const plan = planTouchUpserts(candidates, seeds, walkParents);
    // Four identity-carrying touches insert (multi lead contributes two).
    expect(plan.inserts).toHaveLength(4);
    expect(plan.inserts.filter((t) => t.lead_id === 'lead-multi')).toHaveLength(2);
    // The locked lead's touch carries the corrected date.
    const lockedTouch = plan.inserts.find((t) => t.lead_id === 'lead-locked')!;
    expect(lockedTouch.touch_date).toBe('2026-01-02');
    expect(lockedTouch.raw.sfdc_touch_date).toBe('2026-03-15');
    // The identity-less row writes nothing and keeps its seed.
    expect(plan.skippedNoIdentity).toBe(1);
    expect(plan.seedDeleteIds.sort()).toEqual(['seed-0', 'seed-1', 'seed-2']);

    // Re-importing the same file changes nothing.
    const stored: ExistingTouchLite[] = plan.inserts.map((row, i) => ({
      id: `t-${i}`,
      lead_id: row.lead_id,
      campaign_member_id: row.campaign_member_id,
      campaign_id: row.campaign_id,
      channel_id: row.channel_id,
      touch_date: row.touch_date,
      parent_campaign: row.parent_campaign,
      sub_campaign: row.sub_campaign,
      source: row.source,
    }));
    const rerun = planTouchUpserts(candidates, stored, walkParents);
    expect(rerun.inserts).toHaveLength(0);
    expect(rerun.updates).toHaveLength(0);
    expect(rerun.seedDeleteIds).toHaveLength(0);
    expect(rerun.unchanged).toBe(4);
  });
});

describe('channel ancestry (Bite 4D.1)', () => {
  // channel-parent (root) -> channel-child -> channel-grandchild
  const PARENTS: ChannelParentMap = {
    'channel-parent': null,
    'channel-child': 'channel-parent',
    'channel-grandchild': 'channel-child',
    'channel-unrelated': null,
  };

  it('walks self, child, and grandchild relationships', () => {
    expect(isChannelOrDescendant('channel-parent', 'channel-parent', PARENTS)).toBe(true);
    expect(isChannelOrDescendant('channel-child', 'channel-parent', PARENTS)).toBe(true);
    expect(isChannelOrDescendant('channel-grandchild', 'channel-parent', PARENTS)).toBe(true);
    // Never in the other direction, and never across families.
    expect(isChannelOrDescendant('channel-parent', 'channel-child', PARENTS)).toBe(false);
    expect(isChannelOrDescendant('channel-unrelated', 'channel-parent', PARENTS)).toBe(false);
    expect(isChannelOrDescendant(null, 'channel-parent', PARENTS)).toBe(false);
    expect(isChannelOrDescendant('channel-child', null, PARENTS)).toBe(false);
  });

  it('the cycle guard terminates on corrupt parentage', () => {
    const cyclic: ChannelParentMap = { a: 'b', b: 'a' };
    expect(isChannelOrDescendant('a', 'z', cyclic)).toBe(false);
    expect(isChannelOrDescendant('a', 'b', cyclic)).toBe(true);
  });

  it('a parent-level seed is superseded by a child-level touch', () => {
    const seed = existingRow({
      id: 'seed-parent',
      source: 'backfill',
      campaign_member_id: null,
      campaign_id: null,
      channel_id: 'channel-parent',
    });
    const childTouch = buildTouchCandidate(input(), LEAD, 'channel-child', PARENTS);
    const plan = planTouchUpserts([childTouch], [seed], PARENTS);
    expect(plan.seedDeleteIds).toEqual(['seed-parent']);
    // Grandchild reaches the same seed through the full walk.
    const grandchildTouch = buildTouchCandidate(
      input({ campaignMemberId: 'SYNTH-CM-G' }),
      LEAD,
      'channel-grandchild',
      PARENTS,
    );
    const deep = planTouchUpserts([grandchildTouch], [seed], PARENTS);
    expect(deep.seedDeleteIds).toEqual(['seed-parent']);
  });

  it('an unrelated-channel touch never supersedes the parent seed', () => {
    const seed = existingRow({
      id: 'seed-parent',
      source: 'backfill',
      campaign_member_id: null,
      campaign_id: null,
      channel_id: 'channel-parent',
    });
    const unrelated = buildTouchCandidate(input(), LEAD, 'channel-unrelated', PARENTS);
    expect(planTouchUpserts([unrelated], [seed], PARENTS).seedDeleteIds).toHaveLength(0);
    // And a child seed is never superseded by its PARENT's touch (upward
    // only from the touch, downward never).
    const childSeed = existingRow({
      id: 'seed-child',
      source: 'backfill',
      campaign_member_id: null,
      campaign_id: null,
      channel_id: 'channel-child',
    });
    const parentTouch = buildTouchCandidate(input(), LEAD, 'channel-parent', PARENTS);
    expect(planTouchUpserts([parentTouch], [childSeed], PARENTS).seedDeleteIds).toHaveLength(0);
  });

  it('locked-date precedence applies on a child of the primary channel', () => {
    const locked: TouchLeadContext = {
      leadId: 'lead-1',
      sourceChannelId: 'channel-parent',
      marketingSourcedDate: '2026-01-10',
      sourcedDateLocked: true,
    };
    const onChild = buildTouchCandidate(input(), locked, 'channel-child', PARENTS);
    expect(onChild.touchDate).toBe('2026-01-10');
    expect(onChild.raw.sfdc_touch_date).toBe('2026-03-15');
    const onUnrelated = buildTouchCandidate(input(), locked, 'channel-unrelated', PARENTS);
    expect(onUnrelated.touchDate).toBe('2026-03-15');
    expect(onUnrelated.raw.sfdc_touch_date).toBeUndefined();
  });

  it('the descendant supersession decision is idempotent', () => {
    const seed = existingRow({
      id: 'seed-parent',
      source: 'backfill',
      campaign_member_id: null,
      campaign_id: null,
      channel_id: 'channel-parent',
    });
    const childTouch = buildTouchCandidate(input(), LEAD, 'channel-child', PARENTS);
    const first = planTouchUpserts([childTouch], [seed], PARENTS);
    expect(first.seedDeleteIds).toEqual(['seed-parent']);
    // Second run: the seed is gone and the touch exists; nothing happens.
    const stored: ExistingTouchLite[] = first.inserts.map((row, i) => ({
      id: `t-${i}`,
      lead_id: row.lead_id,
      campaign_member_id: row.campaign_member_id,
      campaign_id: row.campaign_id,
      channel_id: row.channel_id,
      touch_date: row.touch_date,
      parent_campaign: row.parent_campaign,
      sub_campaign: row.sub_campaign,
      source: row.source,
    }));
    const rerun = planTouchUpserts([childTouch], stored, PARENTS);
    expect(rerun.inserts).toHaveLength(0);
    expect(rerun.updates).toHaveLength(0);
    expect(rerun.seedDeleteIds).toHaveLength(0);
    expect(rerun.unchanged).toBe(1);
  });
});
