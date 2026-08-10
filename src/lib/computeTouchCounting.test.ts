// Bite 4E: touch-based funnel counting. The highest-stakes compute change
// in the app, so the regression fixture comes first: for a
// single-membership world the touch-based counting must produce numbers
// IDENTICAL to the pre-4E lead-based counting. The expected objects below
// were CAPTURED by running the pre-4E computeGrid/computeMonthlyLeadsForYear
// over the exact same fixture (do not regenerate them from the new code).

import { describe, it, expect } from 'vitest';
import {
  computeGrid,
  computeMonthlyLeadsForYear,
  conversionPercent,
  mqlEventDates,
} from './compute';
import { computeTouchDrilldown } from './touchDrilldown';
import { REGIONS, type RegionKey } from '../constants/regions';
import {
  channel,
  lead,
  seedTouchesFor,
  stageHistory,
  touchRow,
} from '../test/fixtures/factories';
import {
  REG_ATTRIBUTIONS,
  REG_CHANNELS,
  REG_LEADS,
  REG_MANUAL_ACTUALS,
  REG_PROJECTIONS,
  regressionTouches,
} from '../test/fixtures/funnelRegressionFixture';

function snapGrid(g: ReturnType<typeof computeGrid>) {
  return {
    rows: g.rows.map((r) => ({
      channelId: r.channelId,
      lead: r.cells.lead,
      mql: { actual: r.cells.mql.actual },
      hpp: { actual: r.cells.hpp.actual },
    })),
    totals: {
      lead: g.totals.lead,
      mql: { actual: g.totals.mql.actual },
      hpp: { actual: g.totals.hpp.actual },
    },
    unassignedLeadCount: g.unassignedLeadCount,
  };
}

const REG_BASE = {
  leads: REG_LEADS,
  touches: regressionTouches(),
  channels: REG_CHANNELS,
  projections: REG_PROJECTIONS,
  manualActuals: REG_MANUAL_ACTUALS,
  attributions: REG_ATTRIBUTIONS,
};

describe('zero-drift regression: single-membership data matches the pre-4E outputs', () => {
  // Captured from the PRE-4E implementation on 2026-07-30.
  it('full year 2026', () => {
    expect(snapGrid(computeGrid({ ...REG_BASE, year: 2026, filter: 'year' }))).toEqual({
      rows: [
        { channelId: 'c-root1', lead: { actual: 2, projection: 10 }, mql: { actual: 1 }, hpp: { actual: null } },
        { channelId: 'c-sub1', lead: { actual: 2, projection: 10 }, mql: { actual: 1 }, hpp: { actual: null } },
        { channelId: 'c-root2', lead: { actual: 8, projection: null }, mql: { actual: 1 }, hpp: { actual: 1 } },
      ],
      totals: { lead: { actual: 10, projection: 10 }, mql: { actual: 2 }, hpp: { actual: 1 } },
      unassignedLeadCount: 1,
    });
  });

  it('Q1 2026 (manual fallback still applies where no touch signal exists)', () => {
    expect(snapGrid(computeGrid({ ...REG_BASE, year: 2026, filter: 'Q1' }))).toEqual({
      rows: [
        { channelId: 'c-root1', lead: { actual: 2, projection: 10 }, mql: { actual: 1 }, hpp: { actual: null } },
        { channelId: 'c-sub1', lead: { actual: 2, projection: 10 }, mql: { actual: 1 }, hpp: { actual: null } },
        { channelId: 'c-root2', lead: { actual: 7, projection: null }, mql: { actual: null }, hpp: { actual: 1 } },
      ],
      totals: { lead: { actual: 9, projection: 10 }, mql: { actual: 1 }, hpp: { actual: 1 } },
      unassignedLeadCount: 1,
    });
  });

  it('year 2026 with NA-only region filter', () => {
    expect(
      snapGrid(
        computeGrid({ ...REG_BASE, year: 2026, filter: 'year', regions: new Set<RegionKey>(['NA']) }),
      ),
    ).toEqual({
      rows: [
        { channelId: 'c-root1', lead: { actual: 1, projection: 10 }, mql: { actual: 1 }, hpp: { actual: null } },
        { channelId: 'c-sub1', lead: { actual: 1, projection: 10 }, mql: { actual: 1 }, hpp: { actual: null } },
        { channelId: 'c-root2', lead: { actual: 8, projection: null }, mql: { actual: 1 }, hpp: { actual: 1 } },
      ],
      totals: { lead: { actual: 9, projection: 10 }, mql: { actual: 2 }, hpp: { actual: 1 } },
      unassignedLeadCount: 1,
    });
  });

  it('fallback year 2025 (pre-Sourced manual actuals unchanged)', () => {
    expect(snapGrid(computeGrid({ ...REG_BASE, year: 2025, filter: 'year' }))).toEqual({
      rows: [
        { channelId: 'c-root1', lead: { actual: 12, projection: null }, mql: { actual: null }, hpp: { actual: null } },
        { channelId: 'c-sub1', lead: { actual: null, projection: null }, mql: { actual: null }, hpp: { actual: null } },
        { channelId: 'c-root2', lead: { actual: 1, projection: null }, mql: { actual: 0 }, hpp: { actual: null } },
      ],
      totals: { lead: { actual: 13, projection: null }, mql: { actual: 0 }, hpp: { actual: null } },
      unassignedLeadCount: 0,
    });
  });

  it('monthly leads-for-year 2026 and 2025', () => {
    const allRegions = new Set<RegionKey>(REGIONS);
    expect(
      computeMonthlyLeadsForYear({
        leads: REG_LEADS,
        touches: regressionTouches(),
        channels: REG_CHANNELS,
        year: 2026,
        regions: allRegions,
        manualActuals: REG_MANUAL_ACTUALS,
      }),
    ).toEqual({
      byChannel: [
        { channelId: 'c-root1', channelName: 'Events Root', perMonth: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        { channelId: 'c-root2', channelName: 'Content Root', perMonth: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
      ],
      monthTotals: [1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
      quarterlyFallback: [
        { channelId: 'c-root2', channelName: 'Content Root', quarter: 1, value: 7 },
      ],
    });
    expect(
      computeMonthlyLeadsForYear({
        leads: REG_LEADS,
        touches: regressionTouches(),
        channels: REG_CHANNELS,
        year: 2025,
        regions: allRegions,
        manualActuals: REG_MANUAL_ACTUALS,
      }),
    ).toEqual({
      byChannel: [
        { channelId: 'c-root2', channelName: 'Content Root', perMonth: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0] },
      ],
      monthTotals: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
      quarterlyFallback: [
        { channelId: 'c-root1', channelName: 'Events Root', quarter: 1, value: 12 },
      ],
    });
  });
});

describe('multi-attribution counting (the deliberate change)', () => {
  const cA = channel({ id: 'cA', name: 'Channel A', display_order: 1 });
  const cB = channel({ id: 'cB', name: 'Channel B', display_order: 2 });

  function base(leads: ReturnType<typeof lead>[], touches: ReturnType<typeof touchRow>[]) {
    return {
      leads,
      touches,
      channels: [cA, cB],
      projections: [],
      manualActuals: [],
      attributions: [],
    };
  }

  it('a multi-campaign person counts in both channels in the correct periods', () => {
    const person = lead({ id: 'P1', region: 'NA' });
    const touches = [
      touchRow({ lead_id: 'P1', channel_id: 'cA', touch_date: '2026-01-10' }),
      touchRow({ lead_id: 'P1', channel_id: 'cB', touch_date: '2026-08-05' }),
    ];
    const q1 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q1' });
    expect(q1.rows.find((r) => r.channelId === 'cA')?.cells.lead.actual).toBe(1);
    expect(q1.rows.find((r) => r.channelId === 'cB')?.cells.lead.actual).toBeNull();
    const q3 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q3' });
    expect(q3.rows.find((r) => r.channelId === 'cA')?.cells.lead.actual).toBeNull();
    expect(q3.rows.find((r) => r.channelId === 'cB')?.cells.lead.actual).toBe(1);
    // Year view: totals sum memberships (2), unique contacts is 1.
    const year = computeGrid({ ...base([person], touches), year: 2026, filter: 'year' });
    expect(year.totals.lead.actual).toBe(2);
    expect(year.uniqueContacts.lead).toBe(1);
    expect(year.uniqueContacts.lead).toBeLessThanOrEqual(year.totals.lead.actual!);
  });

  it('keeps MQLs inside the original lead cohort without subtracting them from Leads', () => {
    const cohort = Array.from({ length: 20 }, (_, i) =>
      lead({
        id: `P${i + 1}`,
        region: 'NA',
        stage_history:
          i < 10 ? [stageHistory('mql', '2026-09-15')] : [],
      }),
    );
    const touches = cohort.map((person) =>
      touchRow({
        lead_id: person.id,
        channel_id: 'cA',
        touch_date: '2026-01-10',
      }),
    );

    const q1 = computeGrid({ ...base(cohort, touches), year: 2026, filter: 'Q1' });
    const row = q1.rows.find((candidate) => candidate.channelId === 'cA');
    expect(row?.cells.lead.actual).toBe(20);
    expect(row?.cells.mql.actual).toBe(10);
    expect(conversionPercent(row?.cells.mql.actual ?? null, row?.cells.lead.actual ?? null)).toBe(50);

    // The MQL happened in Q3, but Data Entry is an acquisition-cohort report:
    // the conversion follows the Q1 membership rather than becoming Q3 volume.
    const q3 = computeGrid({ ...base(cohort, touches), year: 2026, filter: 'Q3' });
    expect(q3.totals.lead.actual).toBeNull();
    expect(q3.totals.mql.actual).toBeNull();
  });

  it('anchors each campaign membership to its own touch period', () => {
    const person = lead({
      id: 'P1',
      region: 'NA',
      stage_history: [stageHistory('mql', '2026-09-15')],
    });
    const touches = [
      touchRow({ lead_id: 'P1', channel_id: 'cA', touch_date: '2026-01-10' }),
      touchRow({ lead_id: 'P1', channel_id: 'cB', touch_date: '2026-08-05' }),
    ];
    const q1 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q1' });
    expect(q1.rows.find((r) => r.channelId === 'cA')?.cells.mql.actual).toBe(1);
    expect(q1.rows.find((r) => r.channelId === 'cB')?.cells.mql.actual).toBeNull();
    const q3 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q3' });
    expect(q3.rows.find((r) => r.channelId === 'cA')?.cells.mql.actual).toBeNull();
    expect(q3.rows.find((r) => r.channelId === 'cB')?.cells.mql.actual).toBe(1);
  });

  it('counts a person observed at MQL even when historical transition timing is unavailable', () => {
    const person = lead({ id: 'P1', region: 'NA', current_stage: 'mql', stage_history: [] });
    const touches = [touchRow({ lead_id: 'P1', channel_id: 'cA', touch_date: '2026-01-10' })];
    const q1 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q1' });
    expect(q1.rows.find((r) => r.channelId === 'cA')?.cells.mql.actual).toBe(1);
  });

  it('shows a proven zero when a lead cohort has no MQL members', () => {
    const person = lead({ id: 'P1', region: 'NA', current_stage: 'lead', stage_history: [] });
    const touches = [touchRow({ lead_id: 'P1', channel_id: 'cA', touch_date: '2026-01-10' })];
    const q1 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q1' });
    expect(q1.rows.find((r) => r.channelId === 'cA')?.cells.mql.actual).toBe(0);
  });

  it('does not overlay a manual MQL fallback on a proven zero cohort', () => {
    const person = lead({ id: 'P1', region: 'NA', current_stage: 'lead', stage_history: [] });
    const touches = [touchRow({ lead_id: 'P1', channel_id: 'cA', touch_date: '2026-01-10' })];
    const q1 = computeGrid({
      ...base([person], touches),
      manualActuals: [{
        id: 'manual-mql',
        channel_id: 'cA',
        year: 2026,
        period_index: 1,
        stage_key: 'mql',
        actual: 9,
        edited_at: '2026-04-01T00:00:00Z',
      }],
      year: 2026,
      filter: 'Q1',
    });
    expect(q1.rows.find((r) => r.channelId === 'cA')?.cells.mql.actual).toBe(0);
  });

  it('demotion and re-qualification never double-count the same cohort member', () => {
    const person = lead({
      id: 'P1',
      region: 'NA',
      current_stage: 'mql',
      stage_history: [
        stageHistory('mql', '2026-08-10'),
        stageHistory('lead', '2026-11-02'), // demoted in Q4
        stageHistory('mql', '2027-02-01'), // re-qualified next year
      ],
    });
    const touches = [touchRow({ lead_id: 'P1', channel_id: 'cA', touch_date: '2026-07-01' })];
    expect(mqlEventDates(person)).toEqual(['2026-08-10', '2027-02-01']);
    // Q3 is the membership cohort and counts this person once.
    const q3 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q3' });
    expect(q3.rows.find((r) => r.channelId === 'cA')?.cells.mql.actual).toBe(1);
    // A later re-qualification is activity, not a second cohort member.
    const q1_27 = computeGrid({ ...base([person], touches), year: 2027, filter: 'Q1' });
    expect(q1_27.rows.find((r) => r.channelId === 'cA')?.cells.mql.actual).toBeNull();
    const y2026 = computeGrid({ ...base([person], touches), year: 2026, filter: 'year' });
    expect(y2026.totals.mql.actual).toBe(1);
  });

  it('a locked-date lead buckets by the corrected touch date', () => {
    // 4D wrote the corrected date onto the touch; compute buckets purely by
    // touch_date, so the correction is authoritative even though the report
    // said otherwise (preserved in raw only).
    const person = lead({ id: 'P1', region: 'NA', marketing_sourced_date: '2026-01-05' });
    const touches = [
      touchRow({
        lead_id: 'P1',
        channel_id: 'cA',
        touch_date: '2026-01-05',
        raw: { sfdc_touch_date: '2026-04-02' },
      }),
    ];
    const q1 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q1' });
    expect(q1.rows.find((r) => r.channelId === 'cA')?.cells.lead.actual).toBe(1);
    const q2 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q2' });
    expect(q2.rows.find((r) => r.channelId === 'cA')?.cells.lead.actual).toBeNull();
  });

  it('region filtering applies through the touch lead', () => {
    const na = lead({ id: 'P1', region: 'NA' });
    const emea = lead({ id: 'P2', region: 'EMEA cont & LATAM' });
    const touches = [
      touchRow({ lead_id: 'P1', channel_id: 'cA', touch_date: '2026-01-10' }),
      touchRow({ lead_id: 'P2', channel_id: 'cA', touch_date: '2026-01-12' }),
    ];
    const filtered = computeGrid({
      ...base([na, emea], touches),
      year: 2026,
      filter: 'Q1',
      regions: new Set<RegionKey>(['NA']),
    });
    expect(filtered.rows.find((r) => r.channelId === 'cA')?.cells.lead.actual).toBe(1);
    expect(filtered.uniqueContacts.lead).toBe(1);
  });

  it('a NULL touch_date cannot be assigned to a Lead or MQL cohort', () => {
    const person = lead({
      id: 'P1',
      region: 'NA',
      stage_history: [stageHistory('mql', '2026-02-01')],
    });
    const touches = [touchRow({ lead_id: 'P1', channel_id: 'cA', touch_date: null })];
    const q1 = computeGrid({ ...base([person], touches), year: 2026, filter: 'Q1' });
    expect(q1.rows.find((r) => r.channelId === 'cA')?.cells.lead.actual).toBeNull();
    expect(q1.rows.find((r) => r.channelId === 'cA')?.cells.mql.actual).toBeNull();
  });

  it('conversion cells may exceed 100% and are never clamped', () => {
    expect(conversionPercent(3, 2)).toBe(150);
  });

  it('unique contacts never exceed summed totals', () => {
    const people = [lead({ id: 'P1', region: 'NA' }), lead({ id: 'P2', region: 'NA' })];
    const touches = [
      touchRow({ lead_id: 'P1', channel_id: 'cA', touch_date: '2026-01-10' }),
      touchRow({ lead_id: 'P1', channel_id: 'cB', touch_date: '2026-02-10' }),
      touchRow({ lead_id: 'P2', channel_id: 'cA', touch_date: '2026-03-01' }),
    ];
    const grid = computeGrid({ ...base(people, touches), year: 2026, filter: 'Q1' });
    expect(grid.totals.lead.actual).toBe(3);
    expect(grid.uniqueContacts.lead).toBe(2);
    expect(grid.uniqueContacts.lead).toBeLessThanOrEqual(grid.totals.lead.actual!);
  });

  it('seed touches without campaign identity count exactly like memberships (production 509)', () => {
    const person = lead({ id: 'P1', region: 'NA' });
    const seeds = seedTouchesFor([
      { ...person, source_channel_id: 'cA', marketing_sourced_date: '2026-02-01' },
    ]);
    const grid = computeGrid({ ...base([person], seeds), year: 2026, filter: 'Q1' });
    expect(grid.rows.find((r) => r.channelId === 'cA')?.cells.lead.actual).toBe(1);
  });
});

describe('touch drilldown', () => {
  const person = lead({
    id: 'P1',
    region: 'NA',
    account: 'Synthetic Account',
    stage_history: [stageHistory('mql', '2026-09-01')],
  });

  it('lead stage lists one row per counted touch and groups undated separately', () => {
    const touches = [
      touchRow({ id: 't1', lead_id: 'P1', channel_id: 'cA', touch_date: '2026-01-10', source: 'import' }),
      touchRow({ id: 't2', lead_id: 'P1', channel_id: 'cA', touch_date: '2026-02-11', source: 'backfill' }),
      touchRow({ id: 't3', lead_id: 'P1', channel_id: 'cA', touch_date: null }),
      touchRow({ id: 't4', lead_id: 'P1', channel_id: 'cA', touch_date: '2026-08-01' }),
    ];
    const dd = computeTouchDrilldown({
      touches,
      leads: [person],
      channelIds: new Set(['cA']),
      stage: 'lead',
      year: 2026,
      filter: 'Q1',
    });
    // The same lead appears once per counted touch; the out-of-period touch
    // is absent; the undated touch is surfaced, never silently dropped.
    expect(dd.counted.map((e) => e.touchId)).toEqual(['t1', 't2']);
    expect(dd.counted[1].source).toBe('backfill');
    expect(dd.undated.map((e) => e.touchId)).toEqual(['t3']);
  });

  it('mql stage lists qualifying memberships in their acquisition cohort', () => {
    const touches = [
      touchRow({ id: 't1', lead_id: 'P1', channel_id: 'cA', touch_date: '2026-01-10' }),
    ];
    const dd = computeTouchDrilldown({
      touches,
      leads: [person],
      channelIds: new Set(['cA']),
      stage: 'mql',
      year: 2026,
      filter: 'Q1',
    });
    expect(dd.counted).toHaveLength(1);
    // The later MQL date is context; the Q1 touch keeps this row in Q1.
    expect(dd.counted[0].mqlEventDate).toBe('2026-09-01');
    expect(dd.counted[0].touchId).toBe('t1');
  });
});
