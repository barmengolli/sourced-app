// Tests for the pure Salesforce field-history adapter (Bite 4B). Fixtures are
// fully synthetic: no real Salesforce identifiers, emails, names, or customer
// data. The field API name used here is a synthetic placeholder; the real
// name is configuration pending Salesforce-admin confirmation.

import { describe, it, expect } from 'vitest';
import { adaptLifecycleHistory } from './salesforceLifecycleHistory';
import type {
  SalesforceHistoryRow,
  LifecycleHistoryConfig,
  LifecycleValueMapping,
  PersonIdentityMap,
} from './salesforceLifecycleHistory';
import { assessLeadLifecycle, acquisitionCohortReport } from './funnelCohorts';

const FIELD = 'Synthetic_Lifecycle_Field__c';

const config: LifecycleHistoryConfig = {
  lifecycleFieldApiName: FIELD,
  stageValueMap: {
    Lead: 'lead',
    Subscriber: 'lead',
    'Marketing Qualified Lead': 'mql',
    'Sales Qualified Lead': 'out_of_scope',
    Opportunity: 'out_of_scope',
    Customer: 'out_of_scope',
  },
  historyAvailableSince: '2026-01-01',
};

const identity: PersonIdentityMap = {
  byLeadId: { 'syn-lead-1': 'person-1', 'syn-lead-2': 'person-2' },
  byContactId: { 'syn-contact-1': 'person-1' },
};

let seq = 0;
function row(over: Partial<SalesforceHistoryRow>): SalesforceHistoryRow {
  seq += 1;
  return {
    historyId: `h-${String(seq).padStart(3, '0')}`,
    parentId: 'syn-lead-1',
    parentObject: 'Lead',
    field: FIELD,
    oldValue: null,
    newValue: 'Lead',
    changedAt: '2026-02-01T09:00:00Z',
    ...over,
  };
}

// The canonical synthetic round trip on the Lead object.
function roundTrip(): SalesforceHistoryRow[] {
  return [
    row({ historyId: 'h-a1', oldValue: null, newValue: 'Lead', changedAt: '2026-02-01T09:00:00Z' }),
    row({ historyId: 'h-a2', oldValue: 'Lead', newValue: 'Marketing Qualified Lead', changedAt: '2026-03-01T09:00:00Z' }),
    row({ historyId: 'h-a3', oldValue: 'Marketing Qualified Lead', newValue: 'Lead', changedAt: '2026-04-01T09:00:00Z' }),
    row({ historyId: 'h-a4', oldValue: 'Lead', newValue: 'Marketing Qualified Lead', changedAt: '2026-05-01T09:00:00Z' }),
  ];
}

describe('lifecycle transitions from history rows', () => {
  it('first Lead to MQL transition becomes a confirmed lifecycle event', () => {
    const r = adaptLifecycleHistory(roundTrip().slice(0, 2), config, identity);
    expect(r.persons).toHaveLength(1);
    const events = r.persons[0].events;
    expect(events).toHaveLength(2);
    expect(events[1].fromStage).toBe('lead');
    expect(events[1].toStage).toBe('mql');
    expect(events[1].effectiveDate).toBe('2026-03-01');
    expect(events[1].dateSource).toBe('salesforce_confirmed');
    const a = assessLeadLifecycle('person-1', events, '2026-12-31');
    expect(a.firstMql).toEqual({ date: '2026-03-01', source: 'salesforce_confirmed' });
  });

  it('MQL to Lead becomes a return event the calculator counts', () => {
    const r = adaptLifecycleHistory(roundTrip().slice(0, 3), config, identity);
    const a = assessLeadLifecycle('person-1', r.persons[0].events, '2026-12-31');
    expect(a.returnsToLead).toBe(1);
    expect(a.currentStage).toBe('lead');
  });

  it('a later Lead to MQL counts as a requalification, not the original MQL', () => {
    const r = adaptLifecycleHistory(roundTrip(), config, identity);
    const a = assessLeadLifecycle('person-1', r.persons[0].events, '2026-12-31');
    expect(a.firstMql?.date).toBe('2026-03-01');
    expect(a.requalifications).toBe(1);
    expect(a.currentStage).toBe('mql');
  });

  it('two org values mapping to the same stage are a relabel, not a transition', () => {
    const r = adaptLifecycleHistory(
      [
        row({ historyId: 'h-r1', oldValue: null, newValue: 'Subscriber', changedAt: '2026-02-01T09:00:00Z' }),
        row({ historyId: 'h-r2', oldValue: 'Subscriber', newValue: 'Lead', changedAt: '2026-02-02T09:00:00Z' }),
      ],
      config,
      identity,
    );
    expect(r.persons[0].events).toHaveLength(1);
    expect(r.unchangedRowsIgnored).toBe(1);
  });

  it('progression beyond MQL is out of scope for lead lifecycle, counted not errored', () => {
    const r = adaptLifecycleHistory(
      [
        ...roundTrip().slice(0, 2),
        row({ historyId: 'h-o1', oldValue: 'Marketing Qualified Lead', newValue: 'Sales Qualified Lead', changedAt: '2026-06-01T09:00:00Z' }),
      ],
      config,
      identity,
    );
    expect(r.persons[0].events).toHaveLength(2);
    expect(r.outOfScopeRowsIgnored).toBe(1);
    expect(r.review).toHaveLength(0);
  });
});

describe('idempotency and ordering', () => {
  it('an exact duplicate history row is informational and never degrades the result', () => {
    const rows = roundTrip();
    const twice = adaptLifecycleHistory([...rows, { ...rows[1] }], config, identity);
    const once = adaptLifecycleHistory(rows, config, identity);
    expect(twice.persons[0].events).toEqual(once.persons[0].events);
    expect(twice.duplicatesIgnored).toBe(1);
    // An exact repeat cannot change the result: no issue, state stays
    // complete, nothing is presented as unreliable.
    expect(twice.issues).toEqual([]);
    expect(twice.state).toBe('complete');
  });

  it('rows sharing a historyId with different content are a conflict routed to review', () => {
    const rows = roundTrip();
    const conflicting = { ...rows[1], newValue: 'Lead', oldValue: 'Marketing Qualified Lead' };
    const r = adaptLifecycleHistory([...rows, conflicting], config, identity);
    expect(r.review).toContainEqual({ reason: 'conflicting_duplicate_history_id', historyId: rows[1].historyId });
    expect(r.state).toBe('incomplete');
    // Neither version of the conflicted row is silently chosen: the round
    // trip loses that transition entirely until a human resolves it.
    expect(r.persons[0].events.map((e) => e.effectiveDate)).toEqual([
      '2026-02-01',
      '2026-04-01',
      '2026-05-01',
    ]);
  });

  it('same-timestamp changes order deterministically by history Id', () => {
    const sameInstant = [
      row({ historyId: 'h-t2', oldValue: 'Lead', newValue: 'Marketing Qualified Lead', changedAt: '2026-02-01T09:00:00Z' }),
      row({ historyId: 'h-t1', oldValue: null, newValue: 'Lead', changedAt: '2026-02-01T09:00:00Z' }),
    ];
    const forward = adaptLifecycleHistory(sameInstant, config, identity);
    const reversed = adaptLifecycleHistory([...sameInstant].reverse(), config, identity);
    // h-t1 (baseline) sorts before h-t2 (conversion) regardless of input order.
    expect(forward.persons[0].events.map((e) => e.toStage)).toEqual(['lead', 'mql']);
    expect(reversed.persons[0].events).toEqual(forward.persons[0].events);
  });

  it('a late-arriving older row lands in logical order, not as a current-day transition', () => {
    const later = roundTrip().slice(1); // first sync missed the baseline row
    const withLate = adaptLifecycleHistory([...later, roundTrip()[0]], config, identity);
    expect(withLate.persons[0].events.map((e) => e.effectiveDate)).toEqual([
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
    ]);
    // The late row keeps its own source date.
    expect(withLate.persons[0].events[0].effectiveDate).toBe('2026-02-01');
  });

  it('rows for other tracked fields are counted and ignored', () => {
    const r = adaptLifecycleHistory(
      [roundTrip()[0], row({ historyId: 'h-x1', field: 'Synthetic_Other_Field__c', oldValue: 'a', newValue: 'b' })],
      config,
      identity,
    );
    expect(r.otherFieldRowsIgnored).toBe(1);
    expect(r.persons[0].events).toHaveLength(1);
  });
});

describe('quality routing instead of guessing', () => {
  it('a blank new value is a cleared field routed to review, not a regression', () => {
    const r = adaptLifecycleHistory(
      [roundTrip()[0], row({ historyId: 'h-b1', oldValue: 'Lead', newValue: null, changedAt: '2026-03-01T09:00:00Z' })],
      config,
      identity,
    );
    expect(r.persons[0].events).toHaveLength(1);
    expect(r.review).toEqual([
      { reason: 'blank_lifecycle_value', historyId: 'h-b1', personKey: 'person-1' },
    ]);
  });

  it('an unknown lifecycle value routes the row to review', () => {
    const r = adaptLifecycleHistory(
      [row({ historyId: 'h-u1', oldValue: null, newValue: 'Synthetic Unknown Value' })],
      config,
      identity,
    );
    expect(r.persons[0].events).toHaveLength(0);
    expect(r.review[0].reason).toBe('unknown_lifecycle_value');
    expect(r.state).toBe('incomplete');
  });

  it('a move from a deal-side value back into lifecycle space is reviewed', () => {
    const r = adaptLifecycleHistory(
      [row({ historyId: 'h-d1', oldValue: 'Opportunity', newValue: 'Lead' })],
      config,
      identity,
    );
    expect(r.persons[0].events).toHaveLength(0);
    expect(r.review[0].reason).toBe('out_of_scope_transition');
  });

  it('contradictory supporting dates are flagged for review, never swapped', () => {
    const r = adaptLifecycleHistory(roundTrip().slice(0, 2), config, identity, {
      'person-1': { becameLeadDate: '2026-03-05', becameMqlDate: '2026-03-01' },
    });
    expect(r.review.some((x) => x.reason === 'supporting_dates_reversed' && x.personKey === 'person-1')).toBe(true);
  });

  it('a supporting MQL date with covered history but no MQL row is a contradiction', () => {
    const r = adaptLifecycleHistory([roundTrip()[0]], config, identity, {
      'person-1': { becameMqlDate: '2026-02-15' },
    });
    expect(r.review.some((x) => x.reason === 'supporting_mql_date_without_history')).toBe(true);
    // Supporting evidence never invents the missing transition.
    expect(r.persons[0].events.every((e) => e.toStage !== 'mql')).toBe(true);
  });

  it('a continuity gap between rows is flagged but the rows are not rewritten', () => {
    const r = adaptLifecycleHistory(
      [
        roundTrip()[0],
        // Old value claims MQL, but we last knew Lead: rows are missing.
        row({ historyId: 'h-g1', oldValue: 'Marketing Qualified Lead', newValue: 'Lead', changedAt: '2026-03-01T09:00:00Z' }),
      ],
      config,
      identity,
    );
    expect(r.persons[0].issues.some((i) => i.kind === 'history_continuity_gap')).toBe(true);
    expect(r.persons[0].events[1].fromStage).toBe('mql');
  });

  it('a blank lifecycle field API name is an invalid configuration', () => {
    const r = adaptLifecycleHistory(roundTrip(), { ...config, lifecycleFieldApiName: '  ' }, identity);
    expect(r.state).toBe('invalid');
    expect(r.issues[0].kind).toBe('invalid_config');
  });
});

describe('incomplete historical baseline', () => {
  it('a first row with a pre-existing value means lifecycle predates history', () => {
    const r = adaptLifecycleHistory(
      [row({ historyId: 'h-p1', oldValue: 'Lead', newValue: 'Marketing Qualified Lead', changedAt: '2026-02-01T09:00:00Z' })],
      config,
      identity,
    );
    expect(r.persons[0].incompleteHistoricalBaseline).toBe(true);
    expect(r.persons[0].issues.some((i) => i.kind === 'incomplete_historical_baseline')).toBe(true);
    // The event itself is still emitted with its own values.
    expect(r.persons[0].events).toHaveLength(1);
  });

  it('an acquisition older than the history window marks the baseline incomplete', () => {
    const r = adaptLifecycleHistory(roundTrip(), config, identity, {
      'person-1': { becameLeadDate: '2025-06-01' },
    });
    expect(r.persons[0].incompleteHistoricalBaseline).toBe(true);
  });

  it('a supporting MQL date before the history window is incompleteness, not contradiction', () => {
    const r = adaptLifecycleHistory([roundTrip()[0]], config, identity, {
      'person-1': { becameMqlDate: '2025-11-01' },
    });
    expect(r.persons[0].incompleteHistoricalBaseline).toBe(true);
    expect(r.review.some((x) => x.reason === 'supporting_mql_date_without_history')).toBe(false);
  });
});

describe('converted Lead and Contact identity', () => {
  it('a supplied conversion mapping merges Lead and Contact history into one person', () => {
    const rows = [
      row({ historyId: 'h-c1', parentObject: 'Lead', parentId: 'syn-lead-1', oldValue: null, newValue: 'Lead', changedAt: '2026-02-01T09:00:00Z' }),
      row({ historyId: 'h-c2', parentObject: 'Lead', parentId: 'syn-lead-1', oldValue: 'Lead', newValue: 'Marketing Qualified Lead', changedAt: '2026-03-01T09:00:00Z' }),
      row({ historyId: 'h-c3', parentObject: 'Contact', parentId: 'syn-contact-1', oldValue: 'Marketing Qualified Lead', newValue: 'Lead', changedAt: '2026-04-01T09:00:00Z' }),
      row({ historyId: 'h-c4', parentObject: 'Contact', parentId: 'syn-contact-1', oldValue: 'Lead', newValue: 'Marketing Qualified Lead', changedAt: '2026-05-01T09:00:00Z' }),
    ];
    const r = adaptLifecycleHistory(rows, config, identity);
    expect(r.persons).toHaveLength(1);
    expect(r.persons[0].personKey).toBe('person-1');
    expect(r.persons[0].events).toHaveLength(4);
    const a = assessLeadLifecycle('person-1', r.persons[0].events, '2026-12-31');
    expect(a.requalifications).toBe(1);
    expect(a.returnsToLead).toBe(1);
  });

  it('a row without a verified identity mapping is reviewed, never merged heuristically', () => {
    const r = adaptLifecycleHistory(
      [row({ historyId: 'h-m1', parentObject: 'Contact', parentId: 'syn-contact-unmapped' })],
      config,
      identity,
    );
    expect(r.persons).toHaveLength(0);
    expect(r.review).toEqual([{ reason: 'unmapped_person_identity', historyId: 'h-m1' }]);
    expect(r.issues.some((i) => i.kind === 'unmapped_person_identity')).toBe(true);
  });

  it('one person stays one original Lead cohort through the full cross-object round trip', () => {
    const rows = [
      row({ historyId: 'h-k1', parentObject: 'Lead', parentId: 'syn-lead-1', oldValue: null, newValue: 'Lead', changedAt: '2026-02-01T09:00:00Z' }),
      row({ historyId: 'h-k2', parentObject: 'Lead', parentId: 'syn-lead-1', oldValue: 'Lead', newValue: 'Marketing Qualified Lead', changedAt: '2026-03-01T09:00:00Z' }),
      row({ historyId: 'h-k3', parentObject: 'Contact', parentId: 'syn-contact-1', oldValue: 'Marketing Qualified Lead', newValue: 'Lead', changedAt: '2026-08-10T09:00:00Z' }),
      row({ historyId: 'h-k4', parentObject: 'Contact', parentId: 'syn-contact-1', oldValue: 'Lead', newValue: 'Marketing Qualified Lead', changedAt: '2026-09-10T09:00:00Z' }),
    ];
    const r = adaptLifecycleHistory(rows, config, identity);
    const q1 = acquisitionCohortReport(r.lifecycles, { grain: 'quarter', year: 2026, quarter: 1 }, '2026-12-31');
    expect(q1.uniqueLeads).toBe(1);
    expect(q1.mqls).toBe(1);
    expect(q1.requalifications).toBe(1);
    // The Q3 requalification does not create a Q3 acquisition-cohort member.
    const q3 = acquisitionCohortReport(r.lifecycles, { grain: 'quarter', year: 2026, quarter: 3 }, '2026-12-31');
    expect(q3.uniqueLeads).toBe(0);
  });
});

describe('source validation (hardening)', () => {
  it('rejects a deal-stage lifecycle mapping at compile time and at runtime', () => {
    // Compile time: a deal stage is not assignable to the mapping type.
    // @ts-expect-error deal stages are not legal lead-lifecycle mappings
    const illegalMapping: LifecycleValueMapping = 'hpp';
    void illegalMapping;
    // Runtime: untyped (JSON-loaded) configuration carrying the same illegal
    // value is rejected before any record is processed.
    const untyped = JSON.parse('{"Lead":"lead","Sales Qualified Lead":"hpp"}') as Record<
      string,
      LifecycleValueMapping
    >;
    const r = adaptLifecycleHistory(roundTrip(), { ...config, stageValueMap: untyped }, identity);
    expect(r.state).toBe('invalid');
    expect(r.issues).toEqual([{ kind: 'invalid_config', count: 1 }]);
    expect(r.persons).toHaveLength(0);
  });

  it('an unparseable changedAt is reviewed, never a confirmed event', () => {
    const r = adaptLifecycleHistory(
      [row({ historyId: 'h-v1', changedAt: 'not-a-timestamp' })],
      config,
      identity,
    );
    expect(r.persons).toHaveLength(0);
    expect(r.review).toEqual([{ reason: 'invalid_history_timestamp', historyId: 'h-v1' }]);
  });

  it('an impossible calendar timestamp is reviewed, not current-dated', () => {
    const bad = ['2026-02-30T09:00:00Z', '2026-13-01T09:00:00Z', '2026-02-01T25:00:00Z'];
    for (const changedAt of bad) {
      const r = adaptLifecycleHistory([row({ historyId: 'h-v2', changedAt })], config, identity);
      expect(r.persons).toHaveLength(0);
      expect(r.review[0].reason).toBe('invalid_history_timestamp');
    }
    // No emitted event may ever pair salesforce_confirmed with a null date.
    const ok = adaptLifecycleHistory(roundTrip(), config, identity);
    for (const e of ok.persons[0].events) {
      expect(e.effectiveDate).not.toBeNull();
    }
  });

  it('a blank historyId is an invalid source row', () => {
    const r = adaptLifecycleHistory([row({ historyId: '  ' })], config, identity);
    expect(r.persons).toHaveLength(0);
    expect(r.review).toEqual([{ reason: 'invalid_source_row', historyId: undefined }]);
  });

  it('a blank parentId is an invalid source row, not an unmapped identity', () => {
    const r = adaptLifecycleHistory([row({ historyId: 'h-v3', parentId: '' })], config, identity);
    expect(r.persons).toHaveLength(0);
    expect(r.review).toEqual([{ reason: 'invalid_source_row', historyId: 'h-v3' }]);
    expect(r.issues.some((i) => i.kind === 'unmapped_person_identity')).toBe(false);
  });

  it('an invalid became-a-lead date routes the person to review and joins no comparison', () => {
    const r = adaptLifecycleHistory(roundTrip(), config, identity, {
      'person-1': { becameLeadDate: '2026-13-40', becameMqlDate: '2026-03-01' },
    });
    expect(r.review).toContainEqual({ reason: 'invalid_supporting_date', personKey: 'person-1' });
    // The garbage date participates in no reversed-date or coverage check.
    expect(r.review.some((x) => x.reason === 'supporting_dates_reversed')).toBe(false);
    expect(r.persons[0].incompleteHistoricalBaseline).toBe(false);
  });

  it('an invalid became-MQL date routes the person to review', () => {
    const r = adaptLifecycleHistory([roundTrip()[0]], config, identity, {
      'person-1': { becameMqlDate: 'sometime soon' },
    });
    expect(r.review).toContainEqual({ reason: 'invalid_supporting_date', personKey: 'person-1' });
    expect(r.review.some((x) => x.reason === 'supporting_mql_date_without_history')).toBe(false);
  });

  it('an invalid historyAvailableSince is an invalid configuration', () => {
    const r = adaptLifecycleHistory(roundTrip(), { ...config, historyAvailableSince: 'soon' }, identity);
    expect(r.state).toBe('invalid');
    expect(r.issues).toEqual([{ kind: 'invalid_config', count: 1 }]);
  });

  it('valid Salesforce timestamps continue to process exactly as before', () => {
    // The actual Salesforce wire format: milliseconds plus a colonless offset.
    const withOffset = adaptLifecycleHistory(
      [row({ historyId: 'h-v4', changedAt: '2026-02-01T09:00:00.000+0000' })],
      config,
      identity,
    );
    expect(withOffset.persons[0].events).toHaveLength(1);
    expect(withOffset.persons[0].events[0].effectiveDate).toBe('2026-02-01');
    const full = adaptLifecycleHistory(roundTrip(), config, identity);
    expect(full.state).toBe('complete');
    expect(full.persons[0].events).toHaveLength(4);
  });
});

describe('fixture hygiene', () => {
  it('no fixture identifier looks like a real Salesforce Id', () => {
    const all = [...roundTrip(), row({})];
    for (const r of all) {
      // Real SFDC Ids are 15 or 18 alphanumerics with known key prefixes;
      // every fixture id must use an obviously synthetic prefix instead.
      expect(r.historyId).toMatch(/^h-/);
      expect(r.parentId).toMatch(/^syn-/);
      expect(/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(r.parentId)).toBe(false);
    }
  });
});
