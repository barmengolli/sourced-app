// Step 5: prove the two stage-precedence concepts are INTENTIONALLY different
// and must not be merged.
//
//   PROMOTION_STAGE_RANK (useAttributions): "is X strictly downstream of Y?"
//     closeWon == closeLost (parallel terminals, neither is further along).
//   DEAL_DEDUPE_PRECEDENCE (campaignScorecard, private): "which terminal wins a
//     dedupe?" closeWon > closeLost (a deal with both rows counts as won).
//
// PROMOTION_STAGE_RANK is public, so tested directly. The dedupe precedence is
// observed through the public computeScorecard: a deal with both a won and a
// lost row must count as won, never lost.

import { describe, it, expect } from 'vitest';
import { PROMOTION_STAGE_RANK } from '../hooks/useAttributions';
import { computeScorecard } from './campaignScorecard';
import type { CampaignTagLink } from '../types/db';
import { channel, attribution } from '../test/fixtures/factories';

describe('PROMOTION_STAGE_RANK — parallel terminals', () => {
  it('ranks closeWon and closeLost EQUAL (neither is downstream of the other)', () => {
    expect(PROMOTION_STAGE_RANK.closeWon).toBe(PROMOTION_STAGE_RANK.closeLost);
  });

  it('orders the progression hpp < opp < pursuit < terminals', () => {
    expect(PROMOTION_STAGE_RANK.hpp).toBeLessThan(PROMOTION_STAGE_RANK.opp);
    expect(PROMOTION_STAGE_RANK.opp).toBeLessThan(PROMOTION_STAGE_RANK.pursuit);
    expect(PROMOTION_STAGE_RANK.pursuit).toBeLessThan(PROMOTION_STAGE_RANK.closeWon);
  });
});

describe('DEAL_DEDUPE_PRECEDENCE — won outranks lost (via computeScorecard)', () => {
  it('counts a deal with BOTH won and lost rows as won, not lost', () => {
    const c = channel({ id: 'c1' });
    const tagId = 'tag-1';
    const links: CampaignTagLink[] = [
      { id: 'l1', tag_id: tagId, asset_type: 'channel', asset_ref: 'c1', created_at: '2026-01-01T00:00:00Z' },
    ];
    // One deal, conflicting terminal rows on the same channel/year.
    const attrs = [
      attribution({ deal_id: 'd1', stage_key: 'closeWon', channel_id: 'c1', amount: 5000, year: 2026 }),
      attribution({ deal_id: 'd1', stage_key: 'closeLost', channel_id: 'c1', amount: 5000, year: 2026 }),
    ];
    const score = computeScorecard(
      tagId,
      links,
      {
        channels: [c],
        leads: [],
        attributions: attrs,
        attributionTouches: [],
        outreachSnapshots: [],
        sixSenseSnapshots: [],
        linkedinSnapshots: [],
      },
      2026,
    );
    // If dedupe used the promotion rank (won == lost), the tie could resolve
    // either way. With won > lost, the deal is unambiguously won.
    expect(score.won).toBe(1);
  });
});
