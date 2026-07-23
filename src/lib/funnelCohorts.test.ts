// Tests for the pure funnel cohort / lifecycle-history / deal-uniqueness
// contract (Bite 4A). Synthetic identifiers and fixed dates only; no clock,
// network, or database access.

import { describe, it, expect } from 'vitest';
import {
  assessLeadLifecycle,
  eventsFromObservation,
  eventsFromObservations,
  acquisitionCohortReport,
  compareAcquisitionCohorts,
  summarizeDealStages,
  dealCohortReport,
} from './funnelCohorts';
import type {
  LifecycleEvent,
  LifecycleObservation,
  LeadLifecycleInput,
  DealStageRow,
} from './funnelCohorts';

const Q2_2026 = { grain: 'quarter', year: 2026, quarter: 2 } as const;
const Q3_2026 = { grain: 'quarter', year: 2026, quarter: 3 } as const;

function leadEvent(leadId: string, date: string): LifecycleEvent {
  return {
    leadId,
    fromStage: null,
    toStage: 'lead',
    effectiveDate: date,
    observedAt: `${date}T08:00:00Z`,
    dateSource: 'salesforce_confirmed',
  };
}

function mqlEvent(leadId: string, date: string): LifecycleEvent {
  return {
    leadId,
    fromStage: 'lead',
    toStage: 'mql',
    effectiveDate: date,
    observedAt: `${date}T08:00:00Z`,
    dateSource: 'salesforce_confirmed',
  };
}

function returnEvent(leadId: string, date: string): LifecycleEvent {
  return {
    leadId,
    fromStage: 'mql',
    toStage: 'lead',
    effectiveDate: date,
    observedAt: `${date}T08:00:00Z`,
    dateSource: 'salesforce_confirmed',
  };
}

describe('non-additive acquisition cohort', () => {
  it('100 leads with 20 MQL conversions: Leads 100, MQLs 20, unique 100, efficiency 20%', () => {
    const lifecycles: LeadLifecycleInput[] = [];
    for (let i = 0; i < 100; i += 1) {
      const id = `lead-${i}`;
      const events: LifecycleEvent[] = [leadEvent(id, '2026-04-10')];
      if (i < 20) events.push(mqlEvent(id, '2026-05-15'));
      lifecycles.push({ leadId: id, events });
    }
    const r = acquisitionCohortReport(lifecycles, Q2_2026, '2026-07-01');
    expect(r.state).toBe('complete');
    expect(r.leads).toBe(100);
    expect(r.mqls).toBe(20);
    // The unique-person total stays 100; stage counts are never summed.
    expect(r.uniqueLeads).toBe(100);
    expect(r.efficiencyPercent).toBe(20);
  });

  it('Q2 lead converting in Q3 stays in the Q2 cohort and updates it once asOf reaches the transition', () => {
    const lifecycles: LeadLifecycleInput[] = [
      { leadId: 'l1', events: [leadEvent('l1', '2026-05-01'), mqlEvent('l1', '2026-08-15')] },
    ];
    // Before the Q3 transition: cohort member, no MQL yet.
    const before = acquisitionCohortReport(lifecycles, Q2_2026, '2026-07-31');
    expect(before.leads).toBe(1);
    expect(before.mqls).toBe(0);
    // After the transition: still the Q2 cohort, now with the MQL.
    const after = acquisitionCohortReport(lifecycles, Q2_2026, '2026-09-01');
    expect(after.leads).toBe(1);
    expect(after.mqls).toBe(1);
    // The person never appears in the Q3 acquisition cohort.
    const q3 = acquisitionCohortReport(lifecycles, Q3_2026, '2026-09-01');
    expect(q3.leads).toBe(0);
  });

  it('a transition after the asOf date does not appear early', () => {
    const a = assessLeadLifecycle(
      'l1',
      [leadEvent('l1', '2026-05-01'), mqlEvent('l1', '2026-08-15')],
      '2026-08-14',
    );
    expect(a.firstMql).toBeNull();
    expect(a.currentStage).toBe('lead');
  });
});

describe('repeatable lifecycle transitions', () => {
  it('Lead > MQL > Lead > MQL yields one acquisition MQL and one requalification', () => {
    const events = [
      leadEvent('l1', '2026-01-10'),
      mqlEvent('l1', '2026-02-01'),
      returnEvent('l1', '2026-03-01'),
      mqlEvent('l1', '2026-04-20'),
    ];
    const a = assessLeadLifecycle('l1', events, '2026-12-31');
    expect(a.firstMql?.date).toBe('2026-02-01');
    expect(a.requalifications).toBe(1);
    expect(a.returnsToLead).toBe(1);
    expect(a.currentStage).toBe('mql');

    const r = acquisitionCohortReport(
      [{ leadId: 'l1', events }],
      { grain: 'quarter', year: 2026, quarter: 1 },
      '2026-12-31',
    );
    // The original cohort's unique-MQL count is 1; the requalification is a
    // separate activity metric, never added to it.
    expect(r.mqls).toBe(1);
    expect(r.requalifications).toBe(1);
  });

  it('same-day Lead and MQL is a valid zero-day conversion', () => {
    const a = assessLeadLifecycle(
      'l1',
      [leadEvent('l1', '2026-03-05'), mqlEvent('l1', '2026-03-05')],
      '2026-04-01',
    );
    expect(a.state).toBe('complete');
    expect(a.conversionDays).toBe(0);
    expect(a.firstMql?.date).toBe('2026-03-05');
  });

  it('MQL dated before Lead is invalid and flagged, never swapped', () => {
    const a = assessLeadLifecycle(
      'l1',
      [leadEvent('l1', '2026-03-05'), mqlEvent('l1', '2026-03-01')],
      '2026-04-01',
    );
    expect(a.state).toBe('invalid');
    expect(a.issues.some((i) => i.kind === 'mql_before_lead')).toBe(true);
    // The reverse-dated conversion is not silently accepted.
    expect(a.firstMql).toBeNull();
    // The lead's own date is untouched (no swapping).
    expect(a.leadDate.date).toBe('2026-03-05');
  });
});

describe('date provenance: confirmed, observed, unknown', () => {
  it('first record already MQL with no date: stage known, transition date unknown, not invented', () => {
    const obs = eventsFromObservation({
      leadId: 'l1',
      currentStage: 'mql',
      confirmedLeadDate: '2026-02-01',
      confirmedMqlDate: null,
      observedAt: '2026-06-08T03:00:00Z',
      priorKnownStage: null,
    });
    expect(obs.issues.some((i) => i.kind === 'unknown_mql_transition_date')).toBe(true);
    const a = assessLeadLifecycle('l1', obs.events, '2026-07-01');
    expect(a.currentStage).toBe('mql');
    expect(a.firstMql?.date).toBeNull();
    expect(a.firstMql?.source).toBe('unknown');
    expect(a.state).toBe('incomplete');
  });

  it('observed Lead > MQL without a confirmed date uses the observation day, marked observed', () => {
    const obs = eventsFromObservation({
      leadId: 'l1',
      currentStage: 'mql',
      confirmedLeadDate: '2026-02-01',
      confirmedMqlDate: null,
      observedAt: '2026-06-08T03:00:00Z',
      priorKnownStage: 'lead',
    });
    const mql = obs.events.find((e) => e.toStage === 'mql');
    expect(mql?.effectiveDate).toBe('2026-06-08');
    expect(mql?.dateSource).toBe('n8n_observed');
    expect(obs.reviewRequired).toBe(false);
  });

  it('a confirmed MQL date on a record still claiming Lead is a contradiction routed to review', () => {
    const obs = eventsFromObservation({
      leadId: 'l1',
      currentStage: 'lead',
      confirmedLeadDate: '2026-02-01',
      confirmedMqlDate: '2026-03-01',
      observedAt: '2026-06-08T03:00:00Z',
    });
    expect(obs.reviewRequired).toBe(true);
    expect(obs.issues.some((i) => i.kind === 'stage_date_contradiction')).toBe(true);
    // No MQL event is fabricated from the contradictory date.
    expect(obs.events.every((e) => e.toStage !== 'mql')).toBe(true);
  });

  it('reverse confirmed dates from an observation are flagged for review, not corrected', () => {
    const obs = eventsFromObservation({
      leadId: 'l1',
      currentStage: 'mql',
      confirmedLeadDate: '2026-03-05',
      confirmedMqlDate: '2026-03-01',
      observedAt: '2026-06-08T03:00:00Z',
    });
    expect(obs.reviewRequired).toBe(true);
    expect(obs.issues.some((i) => i.kind === 'mql_before_lead')).toBe(true);
    // Raw values preserved on the flagged event.
    const mql = obs.events.find((e) => e.toStage === 'mql');
    expect(mql?.effectiveDate).toBe('2026-03-01');
  });
});

describe('observation sequences (hardening)', () => {
  function obs(over: Partial<LifecycleObservation>): LifecycleObservation {
    return {
      leadId: 'l1',
      currentStage: 'lead',
      confirmedLeadDate: '2026-01-10',
      confirmedMqlDate: null,
      observedAt: '2026-01-11T03:00:00Z',
      ...over,
    };
  }

  // The full round trip as nightly observations would deliver it. Salesforce
  // keeps the historical dates on later records, as it does in production.
  const roundTrip: LifecycleObservation[] = [
    obs({ currentStage: 'lead', observedAt: '2026-01-11T03:00:00Z' }),
    obs({ currentStage: 'mql', confirmedMqlDate: '2026-02-01', observedAt: '2026-02-02T03:00:00Z' }),
    obs({ currentStage: 'mql', confirmedMqlDate: '2026-02-01', observedAt: '2026-02-09T03:00:00Z' }),
    obs({ currentStage: 'lead', confirmedMqlDate: '2026-02-01', observedAt: '2026-03-01T03:00:00Z' }),
    obs({ currentStage: 'lead', confirmedMqlDate: '2026-02-01', observedAt: '2026-03-08T03:00:00Z' }),
    obs({ currentStage: 'mql', confirmedMqlDate: '2026-04-19', observedAt: '2026-04-20T03:00:00Z' }),
  ];

  it('end to end: lead, MQL, unchanged, return, unchanged, second MQL', () => {
    const r = eventsFromObservations(roundTrip);
    // Exactly four events: acquisition, first MQL, return, requalification.
    // The two unchanged observations emit nothing.
    expect(r.events).toHaveLength(4);
    expect(r.events.map((e) => `${e.fromStage ?? 'none'}>${e.toStage}`)).toEqual([
      'none>lead',
      'lead>mql',
      'mql>lead',
      'lead>mql',
    ]);
    expect(r.issues).toEqual([]);
    expect(r.reviewRequired).toBe(false);

    const a = assessLeadLifecycle('l1', r.events, '2026-12-31');
    expect(a.state).toBe('complete');
    // One original acquisition in one cohort, dated by the confirmed date.
    expect(a.leadDate).toEqual({ date: '2026-01-10', source: 'salesforce_confirmed' });
    // The original MQL transition, not the requalification.
    expect(a.firstMql).toEqual({ date: '2026-02-01', source: 'salesforce_confirmed' });
    expect(a.returnsToLead).toBe(1);
    expect(a.requalifications).toBe(1);
    expect(a.currentStage).toBe('mql');

    // The person belongs only to the January acquisition cohort, once.
    const cohort = acquisitionCohortReport(
      [{ leadId: 'l1', events: r.events }],
      { grain: 'quarter', year: 2026, quarter: 1 },
      '2026-12-31',
    );
    expect(cohort.uniqueLeads).toBe(1);
    expect(cohort.mqls).toBe(1);
    expect(cohort.requalifications).toBe(1);
  });

  it('unchanged Lead > Lead and MQL > MQL observations emit no transition and are idempotent', () => {
    const unchangedLead = eventsFromObservation(
      obs({ currentStage: 'lead', priorKnownStage: 'lead' }),
    );
    expect(unchangedLead.events).toEqual([]);
    expect(unchangedLead.issues).toEqual([]);

    const unchangedMql = eventsFromObservation(
      obs({ currentStage: 'mql', confirmedMqlDate: '2026-02-01', priorKnownStage: 'mql' }),
    );
    expect(unchangedMql.events).toEqual([]);
    expect(unchangedMql.issues).toEqual([]);

    // Reprocessing: appending a duplicate of the last observation to the
    // sequence changes nothing.
    const withDuplicate = eventsFromObservations([...roundTrip, { ...roundTrip[5] }]);
    const without = eventsFromObservations(roundTrip);
    expect(withDuplicate.events).toEqual(without.events);
    expect(withDuplicate.issues).toEqual(without.issues);
  });

  it('a return to Lead is dated by the observation day, never the Became a Lead Date', () => {
    const r = eventsFromObservation(
      obs({
        currentStage: 'lead',
        priorKnownStage: 'mql',
        mqlSeenBefore: true,
        confirmedLeadDate: '2026-01-10',
        confirmedMqlDate: '2026-02-01',
        observedAt: '2026-03-01T03:00:00Z',
      }),
    );
    expect(r.events).toHaveLength(1);
    const ret = r.events[0];
    expect(ret.fromStage).toBe('mql');
    expect(ret.toStage).toBe('lead');
    expect(ret.effectiveDate).toBe('2026-03-01');
    expect(ret.dateSource).toBe('n8n_observed');
    // The original acquisition date is not reused for the regression.
    expect(ret.effectiveDate).not.toBe('2026-01-10');
    expect(r.issues).toEqual([]);
  });

  it('a residual MQL date after a seen MQL is expected; one never seen is a contradiction', () => {
    // After the round trip, Salesforce still carries the MQL date on a
    // lead-stage record: expected, not flagged.
    const afterReturn = eventsFromObservation(
      obs({ currentStage: 'lead', priorKnownStage: 'lead', mqlSeenBefore: true, confirmedMqlDate: '2026-02-01' }),
    );
    expect(afterReturn.issues).toEqual([]);
    expect(afterReturn.reviewRequired).toBe(false);
    // A confirmed MQL date appearing while the stage claims Lead and MQL was
    // never seen is routed to review.
    const neverSeen = eventsFromObservation(
      obs({ currentStage: 'lead', priorKnownStage: 'lead', confirmedMqlDate: '2026-02-01' }),
    );
    expect(neverSeen.issues.some((i) => i.kind === 'stage_date_contradiction')).toBe(true);
    expect(neverSeen.reviewRequired).toBe(true);
  });

  it('observation order is stable: shuffled input produces the same history', () => {
    const shuffled = [roundTrip[4], roundTrip[1], roundTrip[5], roundTrip[0], roundTrip[3], roundTrip[2]];
    expect(eventsFromObservations(shuffled).events).toEqual(eventsFromObservations(roundTrip).events);
  });

  it('a first observation already at MQL emits the acquisition baseline and the transition once', () => {
    const r = eventsFromObservations([
      obs({ currentStage: 'mql', confirmedMqlDate: '2026-02-01', observedAt: '2026-02-02T03:00:00Z' }),
      obs({ currentStage: 'mql', confirmedMqlDate: '2026-02-01', observedAt: '2026-02-09T03:00:00Z' }),
    ]);
    expect(r.events.filter((e) => e.toStage === 'lead' && e.fromStage === null)).toHaveLength(1);
    expect(r.events.filter((e) => e.toStage === 'mql')).toHaveLength(1);
  });
});

describe('cohort maturity and comparison', () => {
  const lifecycleFor = (id: string, lead: string, mql?: string): LeadLifecycleInput => ({
    leadId: id,
    events: mql ? [leadEvent(id, lead), mqlEvent(id, mql)] : [leadEvent(id, lead)],
  });

  it('suppresses the efficiency delta across cohorts of unequal maturity, volumes still computed', () => {
    const q2 = acquisitionCohortReport(
      [lifecycleFor('a', '2026-04-01', '2026-05-01'), lifecycleFor('b', '2026-04-02')],
      Q2_2026,
      '2026-10-01',
    );
    const q3 = acquisitionCohortReport(
      [lifecycleFor('c', '2026-07-01')],
      Q3_2026,
      '2026-10-01',
    );
    // Same asOf, different period ends: unequal maturity.
    const cmp = compareAcquisitionCohorts(q3, q2);
    expect(cmp.maturityComparable).toBe(false);
    expect(cmp.suppressEfficiencyDelta).toBe(true);
    expect(cmp.suppressReasons).toContain('unequal_cohort_maturity');
    // Volume deltas remain calculable.
    expect(cmp.leadsDelta.kind).toBe('delta');
    expect(cmp.leadsDelta.absolute).toBe(-1);
  });

  it('an explicit compare_anyway rule lifts only the maturity suppression', () => {
    const q2 = acquisitionCohortReport([lifecycleFor('a', '2026-04-01', '2026-05-01')], Q2_2026, '2026-10-01');
    const q3 = acquisitionCohortReport([lifecycleFor('c', '2026-07-01', '2026-08-01')], Q3_2026, '2026-10-01');
    const cmp = compareAcquisitionCohorts(q3, q2, 'compare_anyway');
    expect(cmp.maturityComparable).toBe(false);
    expect(cmp.suppressReasons).not.toContain('unequal_cohort_maturity');
  });

  it('an asOf inside the period marks the cohort partial and suppresses deltas', () => {
    const r = acquisitionCohortReport([lifecycleFor('a', '2026-04-01')], Q2_2026, '2026-05-15');
    expect(r.maturity?.maturityDays).toBeLessThan(0);
    expect(r.issues.some((i) => i.kind === 'as_of_before_period_end')).toBe(true);
    expect(r.suppressDelta).toBe(true);
  });

  it('an empty cohort is missing, not zero-efficiency', () => {
    const r = acquisitionCohortReport([], Q2_2026, '2026-07-01');
    expect(r.state).toBe('missing');
    expect(r.efficiencyPercent).toBeNull();
  });
});

describe('deal uniqueness and stage progression', () => {
  it('one HPP > OPP > Pursuit deal: three stage memberships, one unique opportunity', () => {
    const rows: DealStageRow[] = [
      { dealId: 'deal-A', stage: 'hpp', stageEnteredAt: '2026-04-10' },
      { dealId: 'deal-A', stage: 'opp', stageEnteredAt: '2026-05-20' },
      { dealId: 'deal-A', stage: 'pursuit', stageEnteredAt: '2026-06-15' },
    ];
    const s = summarizeDealStages(rows, '2026-07-01');
    expect(s.stageCounts.hpp).toBe(1);
    expect(s.stageCounts.opp).toBe(1);
    expect(s.stageCounts.pursuit).toBe(1);
    // Never 3: stage rows are progression evidence for one deal.
    expect(s.uniqueDeals).toBe(1);
    expect(s.state).toBe('complete');
  });

  it('a Q2 HPP deal reaching OPP in Q3 stays attributed to the Q2 HPP cohort', () => {
    const rows: DealStageRow[] = [
      { dealId: 'deal-A', stage: 'hpp', stageEnteredAt: '2026-05-10' },
      { dealId: 'deal-A', stage: 'opp', stageEnteredAt: '2026-08-20' },
    ];
    const q2 = dealCohortReport(rows, Q2_2026, '2026-09-01');
    expect(q2.uniqueDeals).toBe(1);
    expect(q2.stageCounts.hpp).toBe(1);
    expect(q2.stageCounts.opp).toBe(1);
    // The deal does not migrate into a Q3 HPP cohort.
    const q3 = dealCohortReport(rows, Q3_2026, '2026-09-01');
    expect(q3.uniqueDeals).toBe(0);
    // Before the OPP entry, the Q2 cohort shows no OPP progression yet.
    const early = dealCohortReport(rows, Q2_2026, '2026-07-31');
    expect(early.stageCounts.opp).toBe(0);
  });

  it('two deals sourced from one lead count as two opportunities', () => {
    const rows: DealStageRow[] = [
      { dealId: 'deal-A', stage: 'hpp', stageEnteredAt: '2026-04-10', leadId: 'l1' },
      { dealId: 'deal-B', stage: 'hpp', stageEnteredAt: '2026-05-10', leadId: 'l1' },
    ];
    const s = summarizeDealStages(rows, '2026-07-01');
    expect(s.uniqueDeals).toBe(2);
    expect(s.dealCountByLead['l1']).toBe(2);
  });

  it('a missing deal_id is an explicit quality issue that breaks trust in the unique total', () => {
    const rows: DealStageRow[] = [
      { dealId: 'deal-A', stage: 'hpp', stageEnteredAt: '2026-04-10' },
      { dealId: null, stage: 'hpp', stageEnteredAt: '2026-04-12' },
      { dealId: '  ', stage: 'opp', stageEnteredAt: '2026-04-13' },
    ];
    const s = summarizeDealStages(rows, '2026-07-01');
    expect(s.state).toBe('incomplete');
    expect(s.uniqueTotalTrustworthy).toBe(false);
    expect(s.issues.find((i) => i.kind === 'missing_deal_id')?.count).toBe(2);
    // The blank rows are excluded, never guessed into a deal.
    expect(s.uniqueDeals).toBe(1);
  });

  it('duplicate rows for the same deal and stage are counted once and flagged', () => {
    const rows: DealStageRow[] = [
      { dealId: 'deal-A', stage: 'hpp', stageEnteredAt: '2026-04-10' },
      { dealId: 'deal-A', stage: 'hpp', stageEnteredAt: '2026-04-10' },
    ];
    const s = summarizeDealStages(rows, '2026-07-01');
    expect(s.stageCounts.hpp).toBe(1);
    expect(s.issues.some((i) => i.kind === 'duplicate_deal_stage')).toBe(true);
  });
});
