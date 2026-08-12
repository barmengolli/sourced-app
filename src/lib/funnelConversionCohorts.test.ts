import { describe, expect, it } from 'vitest';
import { computeFunnelConversionCohorts } from './funnelConversionCohorts';
import { attribution, channel, lead, stageHistory, touchRow } from '../test/fixtures/factories';

const c = channel({ id: 'c1' });

describe('funnel conversion cohorts', () => {
  it('follows selected-period Lead memberships forward instead of dividing activity totals', () => {
    const people = [
      lead({ id: 'p1', stage_history: [stageHistory('mql', '2026-08-05')] }),
      lead({ id: 'p2' }),
      lead({ id: 'p3', stage_history: [stageHistory('mql', '2026-08-06')] }),
    ];
    const touches = [
      touchRow({ id: 't1', lead_id: 'p1', channel_id: c.id, touch_date: '2026-05-01' }),
      touchRow({ id: 't2', lead_id: 'p2', channel_id: c.id, touch_date: '2026-05-02' }),
      // Q3 membership is outside the Q2 denominator.
      touchRow({ id: 't3', lead_id: 'p3', channel_id: c.id, touch_date: '2026-08-01' }),
    ];
    const result = computeFunnelConversionCohorts({
      leads: people,
      touches,
      attributions: [],
      year: 2026,
      filter: 'Q2',
    });
    expect(result.leadToMql).toMatchObject({
      numerator: 1,
      denominator: 2,
      percent: 50,
      status: 'ready',
    });
  });

  it('counts every campaign membership while keeping distinct people separate elsewhere', () => {
    const person = lead({ id: 'p1', stage_history: [stageHistory('mql', '2026-03-01')] });
    const result = computeFunnelConversionCohorts({
      leads: [person],
      touches: [
        touchRow({ id: 't1', lead_id: 'p1', channel_id: c.id, touch_date: '2026-01-01' }),
        touchRow({ id: 't2', lead_id: 'p1', channel_id: c.id, touch_date: '2026-02-01' }),
      ],
      attributions: [],
      year: 2026,
      filter: 'Q1',
    });
    expect(result.leadToMql).toMatchObject({ numerator: 2, denominator: 2, percent: 100 });
  });

  it('follows one HPP-entry cohort across quarters and never divides unrelated period activity', () => {
    const result = computeFunnelConversionCohorts({
      leads: [],
      touches: [],
      attributions: [
        attribution({ id: 'd1-hpp', deal_id: 'd1', stage_key: 'hpp', year: 2026, period_index: 2 }),
        attribution({ id: 'd1-opp', deal_id: 'd1', stage_key: 'opp', year: 2026, period_index: 3 }),
        attribution({ id: 'd1-pursuit', deal_id: 'd1', stage_key: 'pursuit', year: 2026, period_index: 3 }),
        attribution({ id: 'd2-hpp', deal_id: 'd2', stage_key: 'hpp', year: 2026, period_index: 2 }),
        // An unrelated Q3 Opp never enters the Q2 HPP cohort.
        attribution({ id: 'd3-opp', deal_id: 'd3', stage_key: 'opp', year: 2026, period_index: 3 }),
      ],
      year: 2026,
      filter: 'Q2',
    });
    expect(result.hppToOpp).toMatchObject({ numerator: 1, denominator: 2, percent: 50 });
    expect(result.oppToPursuit).toMatchObject({ numerator: 1, denominator: 1, percent: 100 });
    expect(result.outcomes).toEqual({ hppCohort: 2, won: 0, lost: 0, inFlight: 2 });
  });

  it('respects the reversible current-qualified projection after a regression', () => {
    // The append-only Salesforce ledger may remember a past Opp visit, but
    // the reporting projection contains only HPP after the regression.
    const result = computeFunnelConversionCohorts({
      leads: [],
      touches: [],
      attributions: [
        attribution({ id: 'd1-hpp', deal_id: 'd1', stage_key: 'hpp', year: 2026, period_index: 3 }),
      ],
      year: 2026,
      filter: 'Q3',
    });
    expect(result.hppToOpp).toMatchObject({ numerator: 0, denominator: 1, percent: 0 });
  });

  it('does not fabricate the cross-grain MQL-account conversion without exact account identity', () => {
    const result = computeFunnelConversionCohorts({
      leads: [lead({
        id: 'p1',
        stage_history: [stageHistory('mql', '2026-08-05', { event_kind: 'transition' })],
      })],
      touches: [touchRow({
        id: 't1', lead_id: 'p1', channel_id: c.id, touch_date: '2026-05-01',
      })],
      attributions: [],
      year: 2026,
      filter: 'Q3',
    });
    expect(result.mqlAccountToHpp).toMatchObject({
      status: 'unavailable',
      numerator: null,
      denominator: null,
      percent: null,
    });
    expect(result.mqlAccountToHpp.coverage).toEqual({ measured: 0, total: 1 });
  });

  it('counts many MQL people at one Salesforce Account as one account conversion', () => {
    const result = computeFunnelConversionCohorts({
      leads: [
        lead({
          id: 'peter',
          sfdc_account_id: '001ACCOUNT000001AAA',
          stage_history: [stageHistory('mql', '2026-08-05', { event_kind: 'transition' })],
        }),
        lead({
          id: 'richard',
          sfdc_account_id: '001ACCOUNT000001AAA',
          stage_history: [stageHistory('mql', '2026-08-06', { event_kind: 'transition' })],
        }),
      ],
      touches: [
        touchRow({ id: 't1', lead_id: 'peter', channel_id: c.id, touch_date: '2026-05-01' }),
        touchRow({ id: 't2', lead_id: 'richard', channel_id: c.id, touch_date: '2026-06-01' }),
      ],
      attributions: [attribution({
        id: 'allstate-hpp',
        deal_id: 'allstate-deal',
        stage_key: 'hpp',
        sfdc_account_id: '001ACCOUNT000001AAA',
        year: 2026,
        period_index: 3,
      })],
      year: 2026,
      filter: 'Q3',
    });

    expect(result.mqlAccountToHpp).toMatchObject({
      status: 'ready',
      numerator: 1,
      denominator: 1,
      percent: 100,
      coverage: { measured: 2, total: 2 },
    });
  });

  it('labels incomplete Account ID coverage as partial instead of silently shrinking the cohort', () => {
    const result = computeFunnelConversionCohorts({
      leads: [
        lead({
          id: 'known',
          sfdc_account_id: '001ACCOUNT000001AAA',
          stage_history: [stageHistory('mql', '2026-08-05', { event_kind: 'transition' })],
        }),
        lead({
          id: 'missing',
          stage_history: [stageHistory('mql', '2026-08-06', { event_kind: 'transition' })],
        }),
      ],
      touches: [
        touchRow({ id: 't1', lead_id: 'known', channel_id: c.id, touch_date: '2026-05-01' }),
        touchRow({ id: 't2', lead_id: 'missing', channel_id: c.id, touch_date: '2026-06-01' }),
      ],
      attributions: [],
      year: 2026,
      filter: 'Q3',
    });

    expect(result.mqlAccountToHpp).toMatchObject({
      status: 'partial',
      numerator: 0,
      denominator: 1,
      percent: 0,
      coverage: { measured: 1, total: 2 },
    });
  });
});
