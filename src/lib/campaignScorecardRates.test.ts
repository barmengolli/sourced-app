// campaignScorecardRates.test.ts
//
// Rate-aggregation regression tests for the campaign scorecard.
//
// The defect these pin: multi-segment 6sense reach and engagement were an
// UNWEIGHTED MEAN of each segment's own percentage. That is only correct when
// segments are the same size, and campaigns routinely span very different ones.
// The standard requires every rate to be recomputed from summed numerators and
// denominators (CLAUDE.md section 4).
//
// The scorecard had no test file at all, which is how this survived.

import { describe, it, expect } from 'vitest';
import { computeScorecard } from './campaignScorecard';
import type {
  Channel,
  Lead,
  Attribution,
  AttributionTouch,
  OutreachSnapshot,
  SixSenseSnapshot,
  LinkedinAdSnapshot,
  CampaignTagLink,
} from '../types/db';

const TAG_ID = 'tag-1';

function segmentLink(segment: string): CampaignTagLink {
  return {
    id: `link-${segment}`,
    tag_id: TAG_ID,
    asset_type: 'sixsense_segment',
    asset_ref: segment,
    created_at: '2026-01-01T00:00:00Z',
  };
}

// Only the fields the 6sense branch reads. Everything else is irrelevant here
// and left at a neutral zero.
function snapshot(over: {
  segment: string;
  reach: number;
  engagement: number;
  total_accounts: number;
  snapshot_date?: string;
  year?: number;
}): SixSenseSnapshot {
  return {
    id: `${over.segment}-${over.snapshot_date ?? '2026-07-31'}`,
    segment: over.segment,
    snapshot_date: over.snapshot_date ?? '2026-07-31',
    year: over.year ?? 2026,
    week_number: 7, // legacy column: MONTH 1..12 for 6sense, never an ISO week
    total_accounts: over.total_accounts,
    reach: over.reach,
    engagement: over.engagement,
    // Remaining required fields are neutral; only the four above drive the
    // blending under test. Filled explicitly rather than cast, so a schema
    // change surfaces here instead of being silently swallowed.
    window_start: null,
    window_end: null,
    accounts_with_activity: 0,
    no_activity: 0,
    intent: 0,
    crm_map_campaigns_reached: 0,
    sales_reached: 0,
    sixsense_campaigns_reached: 0,
    external_campaigns_reached: 0,
    linkedin_campaigns_reached: 0,
    ai_emails_reached: 0,
    sixsense_keyword_research: 0,
    bombora_topics: 0,
    g2_intent: null,
    trustradius_intent: null,
    anonymous_web_engaged: 0,
    known_web_engaged: 0,
    crm_map_campaigns_engaged: 0,
    sales_engaged: 0,
    sixsense_campaigns_engaged: 0,
    external_campaigns_engaged: 0,
    linkedin_campaigns_engaged: 0,
    attended_webinars: 0,
    attended_trade_shows: 0,
    attended_field_events: 0,
    ai_emails_engaged: 0,
    source: '',
    file_name: null,
    imported_at: null,
    created_at: '',
  };
}

function scorecard(
  links: CampaignTagLink[],
  sixSenseSnapshots: SixSenseSnapshot[],
  filterYear: number | null = 2026,
) {
  return computeScorecard(
    TAG_ID,
    links,
    {
      channels: [] as Channel[],
      leads: [] as Lead[],
      attributions: [] as Attribution[],
      attributionTouches: [] as AttributionTouch[],
      outreachSnapshots: [] as OutreachSnapshot[],
      sixSenseSnapshots,
      linkedinSnapshots: [] as LinkedinAdSnapshot[],
    },
    filterYear,
  );
}

describe('6sense reach and engagement blending', () => {
  it('blends unequal segments from summed totals, not an average of percentages', () => {
    // 10,000 accounts at 10% reach beside 100 accounts at 90%.
    //   Correct  : (1000 + 90) / 10100 = 10.792...%
    //   Defective: (10 + 90) / 2       = 50%
    // Nearly a five-fold overstatement, which is why this is a real defect and
    // not a rounding preference.
    const links = [segmentLink('Enterprise'), segmentLink('Pilot')];
    const snaps = [
      snapshot({ segment: 'Enterprise', reach: 1000, engagement: 500, total_accounts: 10000 }),
      snapshot({ segment: 'Pilot', reach: 90, engagement: 80, total_accounts: 100 }),
    ];

    const s = scorecard(links, snaps);

    expect(s.reachPct).toBeCloseTo((1090 / 10100) * 100, 10);
    expect(s.engagementPct).toBeCloseTo((580 / 10100) * 100, 10);
    // The denominator is the summed account base.
    expect(s.sixSenseAccounts).toBe(10100);
    // Explicitly NOT the unweighted mean.
    expect(s.reachPct).not.toBeCloseTo(50, 6);
  });

  it('agrees with the mean only when segments are equally sized', () => {
    // The old code was right in this one case, which is why it looked fine.
    const links = [segmentLink('A'), segmentLink('B')];
    const snaps = [
      snapshot({ segment: 'A', reach: 20, engagement: 10, total_accounts: 100 }),
      snapshot({ segment: 'B', reach: 40, engagement: 30, total_accounts: 100 }),
    ];

    const s = scorecard(links, snaps);
    expect(s.reachPct).toBeCloseTo(30, 10); // (60 / 200) * 100
    expect(s.engagementPct).toBeCloseTo(20, 10);
  });

  it('uses each segment latest snapshot and never sums across time', () => {
    // 6sense is point-in-time. Summing June and July would double-count the
    // account base and report a reach that never existed.
    const links = [segmentLink('A')];
    const snaps = [
      snapshot({ segment: 'A', reach: 10, engagement: 5, total_accounts: 100, snapshot_date: '2026-06-30' }),
      snapshot({ segment: 'A', reach: 30, engagement: 20, total_accounts: 100, snapshot_date: '2026-07-31' }),
    ];

    const s = scorecard(links, snaps);
    // July only: 30/100. Not (10+30)/(100+100) = 20%, and not 40/200.
    expect(s.reachPct).toBeCloseTo(30, 10);
    expect(s.engagementPct).toBeCloseTo(20, 10);
    expect(s.sixSenseAccounts).toBe(100);
  });

  it('blends across segments while still taking the latest per segment', () => {
    const links = [segmentLink('A'), segmentLink('B')];
    const snaps = [
      snapshot({ segment: 'A', reach: 5, engagement: 1, total_accounts: 50, snapshot_date: '2026-05-31' }),
      snapshot({ segment: 'A', reach: 25, engagement: 10, total_accounts: 500, snapshot_date: '2026-07-31' }),
      snapshot({ segment: 'B', reach: 45, engagement: 20, total_accounts: 50, snapshot_date: '2026-07-31' }),
    ];

    const s = scorecard(links, snaps);
    // Latest per segment: A = 25/500, B = 45/50 -> (25+45)/(500+50).
    expect(s.reachPct).toBeCloseTo((70 / 550) * 100, 10);
    expect(s.sixSenseAccounts).toBe(550);
  });

  it('keeps a zero account base null rather than reporting 0% reach', () => {
    // "No target accounts" and "0% of the target reached" are different facts.
    const links = [segmentLink('Empty')];
    const snaps = [
      snapshot({ segment: 'Empty', reach: 0, engagement: 0, total_accounts: 0 }),
    ];

    const s = scorecard(links, snaps);
    expect(s.reachPct).toBeNull();
    expect(s.engagementPct).toBeNull();
  });

  it('reports null when no segment is tagged', () => {
    const s = scorecard([], []);
    expect(s.reachPct).toBeNull();
    expect(s.engagementPct).toBeNull();
    expect(s.sixSenseAccounts).toBeNull();
  });

  it('reports null when a tagged segment has no snapshot in the selected year', () => {
    // Missing data is not zero.
    const links = [segmentLink('A')];
    const snaps = [
      snapshot({ segment: 'A', reach: 10, engagement: 5, total_accounts: 100, year: 2025, snapshot_date: '2025-07-31' }),
    ];

    const s = scorecard(links, snaps, 2026);
    expect(s.reachPct).toBeNull();
    expect(s.sixSenseAccounts).toBeNull();
  });

  it('honours a real zero numerator against a real denominator', () => {
    // Genuinely nobody reached, out of a known 200 accounts, is 0% and must
    // stay distinct from the null cases above.
    const links = [segmentLink('A')];
    const snaps = [
      snapshot({ segment: 'A', reach: 0, engagement: 0, total_accounts: 200 }),
    ];

    const s = scorecard(links, snaps);
    expect(s.reachPct).toBe(0);
    expect(s.engagementPct).toBe(0);
    expect(s.sixSenseAccounts).toBe(200);
  });
});
