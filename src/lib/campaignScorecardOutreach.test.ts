// campaignScorecardOutreach.test.ts
//
// Campaigns Overview must report Outreach as DERIVED ACTIVITY for the selected
// period, not lifetime-to-date counters.
//
// The defect these pin: Outreach stores cumulative lifetime totals, and the
// scorecard read the latest row. So "Sent" was everything the sequence had ever
// sent, displayed in the same KPI row as year-filtered Leads and MQLs with no
// qualifier. A reader comparing "2026 Leads" against "Sent" was comparing one
// year against all time.

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
import type { ReportingPeriod } from '../types/reporting';

const TAG_ID = 'tag-1';
const SEQ = 101;

function sequenceLink(sequenceId: number): CampaignTagLink {
  return {
    id: `link-${sequenceId}`,
    tag_id: TAG_ID,
    asset_type: 'outreach_sequence',
    asset_ref: String(sequenceId),
    created_at: '2026-01-01T00:00:00Z',
  };
}

// Outreach snapshots are weekly CUMULATIVE lifetime counters exported on
// Thursdays. Values only ever grow, absent a reset.
function snap(
  export_date: string,
  total_sent: number,
  replied: number,
  sequence_id = SEQ,
): OutreachSnapshot {
  return {
    id: `${sequence_id}-${export_date}`,
    export_date,
    year: Number(export_date.slice(0, 4)),
    week_number: 1,
    sequence_id,
    sequence_name: '[2026] - Enterprise Outbound',
    total_sent,
    delivered: total_sent,
    bounced: 0,
    opened: 0,
    clicked: 0,
    replied,
    opted_out: 0,
    outbound_calls: 0,
    linkedin_tasks_completed: 0,
    contacted_prospects: 0,
    replied_prospects: 0,
    prospects_added: 0,
    total_tasks: 0,
    created_at: '2026-01-01T00:00:00Z',
  };
}

function scorecard(
  outreachSnapshots: OutreachSnapshot[],
  period: ReportingPeriod | undefined,
  filterYear: number | null = 2026,
) {
  return computeScorecard(
    TAG_ID,
    [sequenceLink(SEQ)],
    {
      channels: [] as Channel[],
      leads: [] as Lead[],
      attributions: [] as Attribution[],
      attributionTouches: [] as AttributionTouch[],
      outreachSnapshots,
      sixSenseSnapshots: [] as SixSenseSnapshot[],
      linkedinSnapshots: [] as LinkedinAdSnapshot[],
    },
    filterYear,
    period,
  );
}

// Thursdays around the July 2026 boundary. June 25 is the last Thursday before
// July, so it is the baseline for a July period.
const JUN_25 = '2026-06-25';
const JUL_02 = '2026-07-02';
const JUL_30 = '2026-07-30';
const JULY_2026: ReportingPeriod = { grain: 'month', year: 2026, month: 7 };

describe('Campaigns Overview Outreach basis', () => {
  it('reports period activity, not the lifetime counter', () => {
    // The sequence had sent 5,000 lifetime by the June baseline and 5,900 by
    // the end of July. July's activity is 900, not 5,900.
    const snaps = [
      snap(JUN_25, 5000, 100),
      snap(JUL_02, 5200, 110),
      snap(JUL_30, 5900, 160),
    ];

    const s = scorecard(snaps, JULY_2026);
    expect(s.outreachSent).toBe(900);
    expect(s.outreachReplied).toBe(60);
    // Explicitly NOT the lifetime total that used to be displayed.
    expect(s.outreachSent).not.toBe(5900);
  });

  it('keeps the legacy lifetime behaviour only when no period is supplied', () => {
    const snaps = [snap(JUN_25, 5000, 100), snap(JUL_30, 5900, 160)];
    const s = scorecard(snaps, undefined);
    expect(s.outreachSent).toBe(5900);
  });

  it('subtracts a real pre-period baseline rather than starting from zero', () => {
    // Without baseline subtraction the July figure would be the full 5,900.
    const withHistory = scorecard(
      [snap(JUN_25, 5000, 100), snap(JUL_30, 5900, 160)],
      JULY_2026,
    );
    expect(withHistory.outreachSent).toBe(900);
  });

  it('reports per-sequence rows as period activity too', () => {
    const s = scorecard(
      [snap(JUN_25, 5000, 100), snap(JUL_30, 5900, 160)],
      JULY_2026,
    );
    expect(s.emailBySequence).toHaveLength(1);
    expect(s.emailBySequence[0].sent).toBe(900);
    expect(s.emailBySequence[0].replied).toBe(60);
    // The bracketed year prefix is still stripped from the display name.
    expect(s.emailBySequence[0].name).toBe('Enterprise Outbound');
  });

  it('does not count a period with no activity as lifetime volume', () => {
    // Flat counters across July mean nothing was sent in July, even though the
    // sequence has 5,000 lifetime sends.
    const s = scorecard(
      [snap(JUN_25, 5000, 100), snap(JUL_30, 5000, 100)],
      JULY_2026,
    );
    expect(s.outreachSent).toBe(0);
    expect(s.outreachReplied).toBe(0);
  });

  it('separates two periods instead of reporting the same total twice', () => {
    // The clearest expression of the defect: under lifetime counters, June and
    // July would both report the running total and look identical.
    const snaps = [
      snap('2026-05-28', 1000, 10),
      snap(JUN_25, 5000, 100),
      snap(JUL_30, 5900, 160),
    ];
    const june = scorecard(snaps, { grain: 'month', year: 2026, month: 6 });
    const july = scorecard(snaps, JULY_2026);
    expect(june.outreachSent).toBe(4000);
    expect(july.outreachSent).toBe(900);
    expect(june.outreachSent).not.toBe(july.outreachSent);
  });

  it('reports nothing measurable rather than a row of zeros', () => {
    // A sequence with no pre-period baseline and no in-period pair cannot have
    // its activity established. Showing 0 would read as "sent nothing".
    const s = scorecard([snap(JUL_30, 5900, 160)], {
      grain: 'month',
      year: 2026,
      month: 9,
    });
    expect(s.emailBySequence).toEqual([]);
    expect(s.outreachSent).toBe(0);
  });

  it('handles a quarter period as well as a month', () => {
    const snaps = [
      snap('2026-06-25', 5000, 100), // baseline before Q3
      snap('2026-09-24', 6500, 200),
    ];
    const q3 = scorecard(snaps, { grain: 'quarter', year: 2026, quarter: 3 });
    expect(q3.outreachSent).toBe(1500);
    expect(q3.outreachReplied).toBe(100);
  });
});
