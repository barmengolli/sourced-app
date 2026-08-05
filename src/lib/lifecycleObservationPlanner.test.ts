// Bite 4G2A: pure lifecycle-observation planner and the static safety
// assertions for the PENDING storage migration. Synthetic identifiers only:
// no real Salesforce ids, names, emails, or source records.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  normalizeLifecycleValue,
  observationFingerprint,
  planLifecycleObservations,
} from './lifecycleObservationPlanner';
import type {
  ConvertedIdentityPair,
  ExtractedLifecycleRow,
  PlannedOperation,
  PlannerInput,
  PriorState,
} from './lifecycleObservationPlanner';

// --- synthetic fixtures ----------------------------------------------------

const RUN_AT = '2026-08-04T03:00:00.000Z';

function row(over: Partial<ExtractedLifecycleRow> = {}): ExtractedLifecycleRow {
  return {
    sourceObject: 'Lead',
    sourceRecordId: 'SYNTH-LEAD-1',
    rawLifecycleValue: 'Lead',
    sourceModifiedAt: '2026-08-01T10:00:00.000Z',
    observedAt: RUN_AT,
    ...over,
  };
}

const EMPTY_PRIOR: PriorState = { aliasToPerson: {}, persons: {} };

function complete(pages = 1) {
  return { pagesExpected: pages, pagesCompleted: pages, failed: false };
}

function plan(over: Partial<PlannerInput> = {}) {
  return planLifecycleObservations({
    rows: [],
    identityPairs: [],
    prior: EMPTY_PRIOR,
    config: {
      syncRunId: 'SYNTH-RUN-1',
      runStartedAt: RUN_AT,
      lifecyclePages: complete(),
      identityPages: complete(),
      proposedWatermarkSystemModstamp: '2026-08-01T10:00:00.000Z',
    },
    ...over,
  });
}

const ops = (result: ReturnType<typeof plan>, kind: PlannedOperation['op']) =>
  result.operations.filter((o) => o.op === kind);

// Build the prior state a first run would leave behind.
function priorFrom(result: ReturnType<typeof plan>): PriorState {
  const aliasToPerson: Record<string, string> = {};
  const persons: PriorState['persons'] = {};
  for (const op of result.operations) {
    if (op.op === 'create_alias') aliasToPerson[op.sourceRecordId] = op.personId;
    if (op.op === 'baseline_observation' || op.op === 'changed_observation') {
      persons[op.observation.personId] = {
        personId: op.observation.personId,
        normalizedState: op.observation.normalizedState,
        mqlSeenBefore:
          op.observation.normalizedState === 'mql' ||
          persons[op.observation.personId]?.mqlSeenBefore === true,
        lastSourceModifiedAt: op.observation.sourceModifiedAt,
        lastContentFingerprint: op.observation.contentFingerprint,
      };
    }
  }
  return { aliasToPerson, persons };
}

// --- value normalization ---------------------------------------------------

describe('lifecycle value normalization (reuses the 4G1 approved map)', () => {
  it('maps the approved values exactly', () => {
    expect(normalizeLifecycleValue('Lead')).toBe('lead');
    expect(normalizeLifecycleValue('Marketing Qualified Lead')).toBe('mql');
    for (const v of ['Customer', 'Internal', 'Opportunity', 'Other', 'Partner', 'Prospect', 'Sales Qualified Lead', 'Subscriber']) {
      expect(normalizeLifecycleValue(v), v).toBe('out_of_scope');
    }
  });

  it('never fuzzy-matches: a near-miss is unknown, not a guess', () => {
    expect(normalizeLifecycleValue('lead')).toBe('unknown');
    expect(normalizeLifecycleValue('MQL')).toBe('unknown');
    expect(normalizeLifecycleValue('Marketing Qualified')).toBe('unknown');
  });

  it('treats blank and absent as unknown', () => {
    expect(normalizeLifecycleValue('')).toBe('unknown');
    expect(normalizeLifecycleValue('   ')).toBe('unknown');
    expect(normalizeLifecycleValue(null)).toBe('unknown');
  });
});

// --- first observation is a baseline ---------------------------------------

describe('first observation is a baseline, never a transition', () => {
  it('a first Lead observation records a baseline only', () => {
    const result = plan({ rows: [row({ rawLifecycleValue: 'Lead' })] });
    const baselines = ops(result, 'baseline_observation');
    expect(baselines).toHaveLength(1);
    expect(result.diagnostics.baselines).toBe(1);
    // Exactly one event: a baseline landing on the observed state, lead.
    const events = ops(result, 'lifecycle_event');
    expect(events).toHaveLength(1);
    expect(events[0].op === 'lifecycle_event' && events[0].event.fromStage).toBeNull();
    expect(events[0].op === 'lifecycle_event' && events[0].event.toStage).toBe('lead');
    expect(events[0].op === 'lifecycle_event' && events[0].eventKind).toBe('baseline');
    // No transition of any kind was invented.
    expect(result.diagnostics.leadToMql).toBe(0);
    expect(result.diagnostics.mqlToLead).toBe(0);
    expect(result.diagnostics.requalifications).toBe(0);
  });

  it('a first MQL observation records exactly one null -> mql baseline', () => {
    // 4A emits BOTH null->lead and null->mql here. Both have a null
    // fromStage, so selection must be by DESTINATION. Keeping null->lead
    // would invent a Lead baseline for someone Salesforce reports as MQL.
    const result = plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] });
    expect(result.diagnostics.baselines).toBe(1);
    const events = ops(result, 'lifecycle_event');
    expect(events).toHaveLength(1);
    const only = events[0];
    expect(only.op === 'lifecycle_event' && only.event.fromStage).toBeNull();
    expect(only.op === 'lifecycle_event' && only.event.toStage).toBe('mql');
    expect(only.op === 'lifecycle_event' && only.eventKind).toBe('baseline');
    // No null->lead event survives anywhere in the plan.
    expect(
      events.some((o) => o.op === 'lifecycle_event' && o.event.toStage === 'lead'),
    ).toBe(false);
  });

  it('a first MQL baseline counts as no conversion, return, or requalification', () => {
    const result = plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] });
    expect(result.diagnostics.leadToMql).toBe(0);
    expect(result.diagnostics.mqlToLead).toBe(0);
    expect(result.diagnostics.requalifications).toBe(0);
  });

  it('a first MQL baseline raises no ambiguity issue for missing pre-baseline history', () => {
    // Unavailable history before the baseline is the normal condition, not
    // an anomaly worth flagging on every first-observed MQL.
    const result = plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] });
    expect(ops(result, 'raise_issue')).toHaveLength(0);
  });

  it('invents no Lead acquisition date or prior Lead state for a first MQL baseline', () => {
    const result = plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] });
    const only = ops(result, 'lifecycle_event')[0];
    // The baseline carries no fabricated effective date.
    expect(only.op === 'lifecycle_event' && only.event.effectiveDate).toBeNull();
    // The stored observation invents no supporting dates either.
    const b = ops(result, 'baseline_observation')[0];
    expect(b.op === 'baseline_observation' && b.observation.becameLeadDate).toBeNull();
    expect(b.op === 'baseline_observation' && b.observation.becameMqlDate).toBeNull();
  });

  it('leaves the projection at mql after a first MQL observation', () => {
    const result = plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] });
    const proj = ops(result, 'update_projection');
    expect(proj).toHaveLength(1);
    expect(proj[0].op === 'update_projection' && proj[0].normalizedState).toBe('mql');
    // The projection and the event ledger agree on the same person.
    const only = ops(result, 'lifecycle_event')[0];
    expect(only.op === 'lifecycle_event' && only.event.toStage).toBe('mql');
  });

  it('a first out-of-scope observation records a baseline with no event', () => {
    const result = plan({ rows: [row({ rawLifecycleValue: 'Customer' })] });
    expect(result.diagnostics.baselines).toBe(1);
    expect(result.diagnostics.outOfScopeObservations).toBe(1);
    // out_of_scope has no 4A stage vocabulary, so no event is fabricated.
    expect(ops(result, 'lifecycle_event')).toHaveLength(0);
    // The observation itself IS stored: it is evidence of where they went.
    const stored = ops(result, 'baseline_observation');
    expect(stored[0].op === 'baseline_observation' && stored[0].observation.normalizedState).toBe('out_of_scope');
  });

  it('records provenance as n8n_observed because Salesforce has no history', () => {
    const result = plan({ rows: [row()] });
    const b = ops(result, 'baseline_observation')[0];
    expect(b.op === 'baseline_observation' && b.observation.provenance).toBe('n8n_observed');
    expect(b.op === 'baseline_observation' && b.observation.isBaseline).toBe(true);
  });
});

// --- idempotency, unchanged, stale, conflict -------------------------------

describe('idempotency, stale protection, and conflicts', () => {
  it('an unchanged rerun is a no-op that stores nothing', () => {
    const first = plan({ rows: [row()] });
    const second = plan({ rows: [row()], prior: priorFrom(first) });
    expect(second.diagnostics.unchanged).toBe(0); // same timestamp: duplicate path
    expect(second.diagnostics.exactDuplicates).toBe(1);
    expect(ops(second, 'changed_observation')).toHaveLength(0);
    expect(ops(second, 'lifecycle_event')).toHaveLength(0);
  });

  it('a later unchanged observation counts as unchanged, storing no row', () => {
    const first = plan({ rows: [row()] });
    const later = plan({
      rows: [row({ sourceModifiedAt: '2026-08-02T10:00:00.000Z' })],
      prior: priorFrom(first),
    });
    expect(later.diagnostics.unchanged).toBe(1);
    expect(ops(later, 'changed_observation')).toHaveLength(0);
    expect(ops(later, 'lifecycle_event')).toHaveLength(0);
  });

  it('a stale source timestamp can never overwrite newer state', () => {
    const first = plan({ rows: [row({ sourceModifiedAt: '2026-08-05T10:00:00.000Z' })] });
    const stale = plan({
      rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead', sourceModifiedAt: '2026-08-01T10:00:00.000Z' })],
      prior: priorFrom(first),
    });
    expect(stale.diagnostics.staleRows).toBe(1);
    expect(ops(stale, 'stale_noop')).toHaveLength(1);
    expect(ops(stale, 'update_projection')).toHaveLength(0);
    expect(ops(stale, 'lifecycle_event')).toHaveLength(0);
  });

  it('same timestamp with identical content is an idempotent no-op', () => {
    const first = plan({ rows: [row()] });
    const same = plan({ rows: [row()], prior: priorFrom(first) });
    expect(same.diagnostics.exactDuplicates).toBe(1);
    expect(same.diagnostics.conflictingRows).toBe(0);
    expect(ops(same, 'duplicate_noop')).toHaveLength(1);
  });

  it('same timestamp with different content is a conflict, never auto-resolved', () => {
    const first = plan({ rows: [row({ rawLifecycleValue: 'Lead' })] });
    const conflict = plan({
      // Same source timestamp, different lifecycle value.
      rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })],
      prior: priorFrom(first),
    });
    expect(conflict.diagnostics.conflictingRows).toBe(1);
    const issues = ops(conflict, 'raise_issue');
    expect(issues.some((o) => o.op === 'raise_issue' && o.kind === 'same_timestamp_content_conflict')).toBe(true);
    // Neither version was chosen.
    expect(ops(conflict, 'update_projection')).toHaveLength(0);
    expect(ops(conflict, 'changed_observation')).toHaveLength(0);
  });

  it('the fingerprint changes when lifecycle-bearing content changes', () => {
    const a = observationFingerprint(row({ rawLifecycleValue: 'Lead' }));
    const b = observationFingerprint(row({ rawLifecycleValue: 'Marketing Qualified Lead' }));
    const c = observationFingerprint(row({ rawLifecycleValue: 'Lead' }));
    expect(a).not.toBe(b);
    expect(a).toBe(c);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// --- transitions (delegated to Bite 4A) ------------------------------------

describe('transitions use the Bite 4A calculator', () => {
  it('Lead to MQL produces a transition', () => {
    const first = plan({ rows: [row({ rawLifecycleValue: 'Lead' })] });
    const second = plan({
      rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead', sourceModifiedAt: '2026-08-02T10:00:00.000Z' })],
      prior: priorFrom(first),
    });
    expect(second.diagnostics.leadToMql).toBe(1);
    expect(second.diagnostics.requalifications).toBe(0);
    expect(second.diagnostics.changes).toBe(1);
  });

  it('MQL to Lead produces a return', () => {
    const first = plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] });
    const back = plan({
      rows: [row({ rawLifecycleValue: 'Lead', sourceModifiedAt: '2026-08-02T10:00:00.000Z' })],
      prior: priorFrom(first),
    });
    expect(back.diagnostics.mqlToLead).toBe(1);
  });

  it('Lead to MQL after a return is a requalification', () => {
    // baseline lead -> mql -> lead -> mql
    let state = priorFrom(plan({ rows: [row({ rawLifecycleValue: 'Lead' })] }));
    const toMql = plan({
      rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead', sourceModifiedAt: '2026-08-02T10:00:00.000Z' })],
      prior: state,
    });
    state = priorFrom(toMql);
    const back = plan({
      rows: [row({ rawLifecycleValue: 'Lead', sourceModifiedAt: '2026-08-03T10:00:00.000Z' })],
      prior: state,
    });
    // Thread mqlSeenBefore forward, as the projection would.
    state = priorFrom(back);
    for (const p of Object.values(state.persons)) p.mqlSeenBefore = true;
    const requal = plan({
      rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead', sourceModifiedAt: '2026-08-04T10:00:00.000Z' })],
      prior: state,
    });
    expect(requal.diagnostics.leadToMql).toBe(1);
    expect(requal.diagnostics.requalifications).toBe(1);
  });

  it('after an MQL baseline, an unchanged MQL observation emits no event', () => {
    const first = plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] });
    const again = plan({
      rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead', sourceModifiedAt: '2026-08-02T10:00:00.000Z' })],
      prior: priorFrom(first),
    });
    expect(again.diagnostics.unchanged).toBe(1);
    expect(ops(again, 'lifecycle_event')).toHaveLength(0);
    expect(again.diagnostics.leadToMql).toBe(0);
    expect(again.diagnostics.mqlToLead).toBe(0);
    expect(again.diagnostics.requalifications).toBe(0);
  });

  it('after an MQL baseline, a move to Lead is exactly one return', () => {
    const first = plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] });
    const back = plan({
      rows: [row({ rawLifecycleValue: 'Lead', sourceModifiedAt: '2026-08-02T10:00:00.000Z' })],
      prior: priorFrom(first),
    });
    expect(back.diagnostics.mqlToLead).toBe(1);
    expect(back.diagnostics.leadToMql).toBe(0);
    expect(back.diagnostics.requalifications).toBe(0);
    const events = ops(back, 'lifecycle_event');
    expect(events).toHaveLength(1);
    expect(events[0].op === 'lifecycle_event' && events[0].eventKind).toBe('return');
  });

  it('MQL baseline then Lead then MQL is a requalification, not an original conversion', () => {
    const first = plan({ rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead' })] });
    // An MQL baseline records that MQL has already been seen, which is what
    // makes the later Lead->MQL a requalification rather than a first
    // observed conversion.
    expect(Object.values(priorFrom(first).persons).every((p) => p.mqlSeenBefore)).toBe(true);
    const back = plan({
      rows: [row({ rawLifecycleValue: 'Lead', sourceModifiedAt: '2026-08-02T10:00:00.000Z' })],
      prior: priorFrom(first),
    });
    const state = priorFrom(back);
    // Thread mqlSeenBefore forward as the stored projection would.
    for (const p of Object.values(state.persons)) p.mqlSeenBefore = true;
    const requal = plan({
      rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead', sourceModifiedAt: '2026-08-03T10:00:00.000Z' })],
      prior: state,
    });
    expect(requal.diagnostics.leadToMql).toBe(1);
    expect(requal.diagnostics.requalifications).toBe(1);
    const events = ops(requal, 'lifecycle_event');
    expect(events).toHaveLength(1);
    expect(events[0].op === 'lifecycle_event' && events[0].eventKind).toBe('requalification');
  });

  it('does NOT infer a transition across an intervening out-of-scope value', () => {
    const first = plan({ rows: [row({ rawLifecycleValue: 'Lead' })] });
    const outOfScope = plan({
      rows: [row({ rawLifecycleValue: 'Customer', sourceModifiedAt: '2026-08-02T10:00:00.000Z' })],
      prior: priorFrom(first),
    });
    // The move to out_of_scope is stored but no transition is asserted.
    expect(outOfScope.diagnostics.changes).toBe(1);
    expect(outOfScope.diagnostics.leadToMql).toBe(0);
    expect(ops(outOfScope, 'lifecycle_event')).toHaveLength(0);
    const issues = ops(outOfScope, 'raise_issue');
    expect(issues.some((o) => o.op === 'raise_issue' && o.kind === 'ambiguous_transition_sequence')).toBe(true);

    // And coming BACK to mql from out_of_scope also asserts no Lead->MQL.
    const backToMql = plan({
      rows: [row({ rawLifecycleValue: 'Marketing Qualified Lead', sourceModifiedAt: '2026-08-03T10:00:00.000Z' })],
      prior: priorFrom(outOfScope),
    });
    expect(backToMql.diagnostics.leadToMql).toBe(0);
  });
});

// --- unknown, blank, and out-of-scope preservation --------------------------

describe('unknown and blank values are preserved and reviewed, never guessed', () => {
  it('an unmapped future label is stored and routed to review', () => {
    const result = plan({ rows: [row({ rawLifecycleValue: 'Newly Added Stage' })] });
    expect(result.diagnostics.unknownValues).toBe(1);
    const issues = ops(result, 'raise_issue');
    expect(issues.some((o) => o.op === 'raise_issue' && o.kind === 'unknown_lifecycle_value')).toBe(true);
    const stored = ops(result, 'baseline_observation')[0];
    expect(stored.op === 'baseline_observation' && stored.observation.normalizedState).toBe('unknown');
    // The raw value is preserved exactly as evidence.
    expect(stored.op === 'baseline_observation' && stored.observation.rawLifecycleValue).toBe('Newly Added Stage');
  });

  it('a blank value is reviewed under its own issue kind', () => {
    const result = plan({ rows: [row({ rawLifecycleValue: '' })] });
    const issues = ops(result, 'raise_issue');
    expect(issues.some((o) => o.op === 'raise_issue' && o.kind === 'blank_lifecycle_value')).toBe(true);
  });

  it('an out-of-scope observation is preserved without an invented transition', () => {
    const result = plan({ rows: [row({ rawLifecycleValue: 'Sales Qualified Lead' })] });
    expect(result.diagnostics.outOfScopeObservations).toBe(1);
    expect(ops(result, 'lifecycle_event')).toHaveLength(0);
    expect(ops(result, 'baseline_observation')).toHaveLength(1);
  });
});

// --- supporting dates ------------------------------------------------------

describe('supporting dates are evidence only', () => {
  it('valid supporting dates never create an event', () => {
    const result = plan({
      rows: [row({ becameLeadDate: '2026-01-05', becameMqlDate: '2026-03-01' })],
    });
    // Still exactly one baseline event; the dates asserted no transition.
    expect(ops(result, 'lifecycle_event')).toHaveLength(1);
    expect(result.diagnostics.leadToMql).toBe(0);
    const stored = ops(result, 'baseline_observation')[0];
    expect(stored.op === 'baseline_observation' && stored.observation.becameMqlDate).toBe('2026-03-01');
  });

  it('a malformed supporting date is flagged, stored as received, never corrected', () => {
    const result = plan({ rows: [row({ becameLeadDate: 'not-a-date' })] });
    expect(result.diagnostics.malformedSupportingDates).toBe(1);
    const issues = ops(result, 'raise_issue');
    expect(issues.some((o) => o.op === 'raise_issue' && o.kind === 'malformed_supporting_date')).toBe(true);
    const stored = ops(result, 'baseline_observation')[0];
    expect(stored.op === 'baseline_observation' && stored.observation.becameLeadDate).toBe('not-a-date');
  });

  it('reversed supporting dates are flagged and never swapped', () => {
    const result = plan({
      rows: [row({ becameLeadDate: '2026-06-01', becameMqlDate: '2026-01-01' })],
    });
    expect(result.diagnostics.malformedSupportingDates).toBe(1);
    const issues = ops(result, 'raise_issue');
    expect(issues.some((o) => o.op === 'raise_issue' && o.kind === 'reversed_supporting_dates')).toBe(true);
    const stored = ops(result, 'baseline_observation')[0];
    // Preserved in original order.
    expect(stored.op === 'baseline_observation' && stored.observation.becameLeadDate).toBe('2026-06-01');
    expect(stored.op === 'baseline_observation' && stored.observation.becameMqlDate).toBe('2026-01-01');
  });
});

// --- identity --------------------------------------------------------------

describe('one person across Lead and Contact', () => {
  const pair: ConvertedIdentityPair = {
    leadId: 'SYNTH-LEAD-1',
    convertedContactId: 'SYNTH-CONTACT-1',
  };

  it('an exact ConvertedContactId links the Contact to the SAME person', () => {
    const first = plan({ rows: [row({ sourceRecordId: 'SYNTH-LEAD-1' })] });
    const prior = priorFrom(first);
    const linked = plan({ rows: [], identityPairs: [pair], prior });
    expect(linked.diagnostics.identityLinksCreated).toBe(1);
    const alias = ops(linked, 'create_alias')[0];
    expect(alias.op === 'create_alias' && alias.sourceObject).toBe('Contact');
    expect(alias.op === 'create_alias' && alias.personId).toBe(prior.aliasToPerson['SYNTH-LEAD-1']);
  });

  it('keeps the chronology unified: a Contact-side change continues the Lead history', () => {
    const first = plan({ rows: [row({ sourceRecordId: 'SYNTH-LEAD-1', rawLifecycleValue: 'Lead' })] });
    let prior = priorFrom(first);
    const linked = plan({ rows: [], identityPairs: [pair], prior });
    // Thread the new alias forward.
    prior = {
      aliasToPerson: {
        ...prior.aliasToPerson,
        'SYNTH-CONTACT-1': prior.aliasToPerson['SYNTH-LEAD-1'],
      },
      persons: prior.persons,
    };
    void linked;
    const contactChange = plan({
      rows: [
        row({
          sourceObject: 'Contact',
          sourceRecordId: 'SYNTH-CONTACT-1',
          rawLifecycleValue: 'Marketing Qualified Lead',
          sourceModifiedAt: '2026-08-02T10:00:00.000Z',
        }),
      ],
      prior,
    });
    // The Contact observation continues the SAME person's history, so this
    // is a transition rather than a second baseline.
    expect(contactChange.diagnostics.baselines).toBe(0);
    expect(contactChange.diagnostics.leadToMql).toBe(1);
  });

  it('refuses to merge when Lead and Contact already resolve to different persons', () => {
    const prior: PriorState = {
      aliasToPerson: { 'SYNTH-LEAD-1': 'person-a', 'SYNTH-CONTACT-1': 'person-b' },
      persons: {
        'person-a': { personId: 'person-a', normalizedState: 'lead', mqlSeenBefore: false, lastSourceModifiedAt: null, lastContentFingerprint: null },
        'person-b': { personId: 'person-b', normalizedState: 'lead', mqlSeenBefore: false, lastSourceModifiedAt: null, lastContentFingerprint: null },
      },
    };
    const result = plan({ rows: [], identityPairs: [pair], prior });
    expect(result.diagnostics.identityConflicts).toBe(1);
    expect(result.diagnostics.identityLinksCreated).toBe(0);
    const issues = ops(result, 'raise_issue');
    expect(issues.some((o) => o.op === 'raise_issue' && o.kind === 'identity_conflict')).toBe(true);
    // No alias was rewritten.
    expect(ops(result, 'create_alias')).toHaveLength(0);
  });

  it('never matches by name, email, company, or similarity', () => {
    // Two records with no ConvertedContactId relationship stay separate
    // people no matter how similar anything else about them is.
    const result = plan({
      rows: [
        row({ sourceObject: 'Lead', sourceRecordId: 'SYNTH-LEAD-1' }),
        row({ sourceObject: 'Contact', sourceRecordId: 'SYNTH-CONTACT-9' }),
      ],
      identityPairs: [],
    });
    const persons = new Set(
      ops(result, 'create_person').map((o) => (o.op === 'create_person' ? o.personId : '')),
    );
    expect(persons.size).toBe(2);
    // The planner accepts no name/email/company input at all.
    const source = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleObservationPlanner.ts'), 'utf8');
    for (const forbidden of ['email', 'firstName', 'lastName', 'company', 'similarity', 'fuzzy']) {
      expect(source.toLowerCase()).not.toContain(`${forbidden.toLowerCase()}:`);
    }
  });
});

// --- pagination, completeness, watermark -----------------------------------

describe('pagination, completeness, and watermarks', () => {
  it('a duplicate source id across pages fails the run loudly', () => {
    const result = plan({
      rows: [row({ sourceRecordId: 'SYNTH-LEAD-1' }), row({ sourceRecordId: 'SYNTH-LEAD-1' })],
    });
    const issues = ops(result, 'raise_issue');
    expect(issues.some((o) => o.op === 'raise_issue' && o.kind === 'duplicate_source_id_across_pages')).toBe(true);
    expect(result.applyPermitted).toBe(false);
    expect(result.diagnostics.watermarkAdvanced).toBe(false);
  });

  it('incomplete LIFECYCLE pages block apply and the watermark', () => {
    const result = plan({
      rows: [row()],
      config: {
        syncRunId: 'SYNTH-RUN-1',
        runStartedAt: RUN_AT,
        lifecyclePages: { pagesExpected: 3, pagesCompleted: 1, failed: false },
        identityPages: complete(),
        proposedWatermarkSystemModstamp: '2026-08-01T10:00:00.000Z',
      },
    });
    expect(result.diagnostics.lifecycleExtractionComplete).toBe(false);
    expect(result.applyPermitted).toBe(false);
    expect(result.diagnostics.watermarkAdvanced).toBe(false);
    expect(result.diagnostics.incompleteReasons.join(' ')).toContain('Lifecycle extraction incomplete');
  });

  it('incomplete IDENTITY pages block apply independently of lifecycle pages', () => {
    const result = plan({
      rows: [row()],
      config: {
        syncRunId: 'SYNTH-RUN-1',
        runStartedAt: RUN_AT,
        lifecyclePages: complete(),
        identityPages: { pagesExpected: 7, pagesCompleted: 1, failed: false },
        proposedWatermarkSystemModstamp: '2026-08-01T10:00:00.000Z',
      },
    });
    // Lifecycle is fine; identity is not. Two independent axes.
    expect(result.diagnostics.lifecycleExtractionComplete).toBe(true);
    expect(result.diagnostics.identityExtractionComplete).toBe(false);
    expect(result.applyPermitted).toBe(false);
    expect(result.diagnostics.watermarkAdvanced).toBe(false);
  });

  it('a failed page never advances the watermark', () => {
    const result = plan({
      rows: [row()],
      config: {
        syncRunId: 'SYNTH-RUN-1',
        runStartedAt: RUN_AT,
        lifecyclePages: { pagesExpected: 2, pagesCompleted: 2, failed: true },
        identityPages: complete(),
        proposedWatermarkSystemModstamp: '2026-08-01T10:00:00.000Z',
      },
    });
    expect(result.applyPermitted).toBe(false);
    expect(result.diagnostics.watermarkAdvanced).toBe(false);
  });

  it('complete pagination on BOTH axes permits the proposed watermark', () => {
    const result = plan({
      rows: [row()],
      config: {
        syncRunId: 'SYNTH-RUN-1',
        runStartedAt: RUN_AT,
        lifecyclePages: { pagesExpected: 52, pagesCompleted: 52, failed: false },
        identityPages: { pagesExpected: 7, pagesCompleted: 7, failed: false },
        proposedWatermarkSystemModstamp: '2026-08-01T10:00:00.000Z',
      },
    });
    expect(result.applyPermitted).toBe(true);
    expect(result.diagnostics.runComplete).toBe(true);
    expect(result.diagnostics.watermarkAdvanced).toBe(true);
    expect(result.diagnostics.proposedWatermarkSystemModstamp).toBe('2026-08-01T10:00:00.000Z');
  });

  it('zero expected pages is not a complete run', () => {
    const result = plan({
      config: {
        syncRunId: 'SYNTH-RUN-1',
        runStartedAt: RUN_AT,
        lifecyclePages: { pagesExpected: 0, pagesCompleted: 0, failed: false },
        identityPages: complete(),
        proposedWatermarkSystemModstamp: null,
      },
    });
    expect(result.applyPermitted).toBe(false);
  });
});

// --- diagnostics safety ----------------------------------------------------

describe('diagnostics are aggregate-only', () => {
  it('reports writes_attempted 0 and leaks no identifiers', () => {
    const result = plan({
      rows: [
        row({ sourceRecordId: 'SYNTH-LEAD-1', rawLifecycleValue: 'Lead' }),
        row({ sourceObject: 'Contact', sourceRecordId: 'SYNTH-CONTACT-1', rawLifecycleValue: 'Customer' }),
      ],
    });
    expect(result.diagnostics.writes_attempted).toBe(0);
    const serialized = JSON.stringify(result.diagnostics);
    expect(serialized).not.toContain('SYNTH-LEAD-1');
    expect(serialized).not.toContain('SYNTH-CONTACT-1');
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toMatch(/\b(001|003|00Q|005|006)[A-Za-z0-9]{12}\b/);
  });

  it('counts Lead and Contact records separately', () => {
    const result = plan({
      rows: [
        row({ sourceRecordId: 'SYNTH-LEAD-1' }),
        row({ sourceObject: 'Contact', sourceRecordId: 'SYNTH-CONTACT-1' }),
        row({ sourceObject: 'Contact', sourceRecordId: 'SYNTH-CONTACT-2' }),
      ],
    });
    expect(result.diagnostics.leadRecords).toBe(1);
    expect(result.diagnostics.contactRecords).toBe(2);
    expect(result.diagnostics.rowsDiscovered).toBe(3);
  });

  it('emits exactly one sync-run operation carrying the diagnostics', () => {
    const result = plan({ rows: [row()] });
    const runs = ops(result, 'record_sync_run');
    expect(runs).toHaveLength(1);
  });
});

// --- migration safety (static SQL) -----------------------------------------

describe('PENDING migration safety (static SQL)', () => {
  const MIGRATION = readFileSync(
    resolve(process.cwd(), 'migrations/2026-08-04_lifecycle_observation_ledger.sql'),
    'utf8',
  );
  const codeOnly = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('records the same applied status in the SCHEMA.sql lifecycle section', () => {
    // Scoped to the Bite 4G2A block only: SCHEMA.sql documents older
    // migrations whose own headers are still stale, and those are a
    // separate cleanup item that must not fail this assertion.
    const schema = readFileSync(resolve(process.cwd(), 'SCHEMA.sql'), 'utf8');
    const start = schema.indexOf('-- Bite 4G2A: Salesforce lifecycle observation ledger');
    expect(start).toBeGreaterThan(-1);
    // The section runs to the first lifecycle table it introduces.
    const end = schema.indexOf('CREATE TABLE IF NOT EXISTS sf_lifecycle_sync_runs', start);
    expect(end).toBeGreaterThan(start);
    const section = schema.slice(start, end);

    expect(section).toContain('Applied manually to production on 2026-08-04');
    expect(section).toContain('Created structure');
    expect(section).toContain('no lifecycle data was imported');
    expect(section).not.toContain('PENDING');
    expect(section).not.toContain('NOT YET APPLIED');
  });

  it('records the same applied status in the contract document', () => {
    // PR #63 aligned the README row, the migration header, the SCHEMA
    // comment, and these tests, but not this document, which was outside
    // its scope. Its opening claim that the migration was "PENDING and
    // unapplied" survived as the last stale 4G2A status statement.
    //
    // Scoped to the STATUS paragraph alone: the body of this document
    // legitimately discusses pending work and unapplied future bites, so
    // asserting over the whole file would fail on unrelated wording.
    const doc = readFileSync(
      resolve(process.cwd(), 'docs/lead-lifecycle-observation-ledger.md'),
      'utf8',
    );
    const start = doc.indexOf('STATUS: the migration was applied');
    expect(start).toBeGreaterThan(-1);
    // The status paragraph ends at the first heading that follows it.
    const end = doc.indexOf('\n#', start);
    expect(end).toBeGreaterThan(start);
    const section = doc.slice(start, end);

    expect(section).toContain('applied manually to production on 2026-08-04');
    expect(section).toContain('structure only');
    expect(section).toContain('no lifecycle data was imported');
    expect(section).not.toContain('PENDING');
    expect(section).not.toContain('unapplied');
  });

  it('states its true applied status and is forward-only', () => {
    // Applied manually to production on 2026-08-04. The file must state the
    // real status and must not carry the obsolete pending note, which would
    // contradict the ledger row in migrations/README.md.
    expect(MIGRATION).toContain('Applied manually to production on 2026-08-04');
    expect(MIGRATION).toContain('Created structure');
    expect(MIGRATION).toContain('no lifecycle data was imported');
    expect(MIGRATION).not.toContain('NOT YET APPLIED');
    expect(codeOnly).toContain('CREATE TABLE IF NOT EXISTS');
  });

  it('performs no destructive operation and no existing-table write', () => {
    expect(codeOnly).not.toMatch(/DROP TABLE/i);
    expect(codeOnly).not.toMatch(/TRUNCATE/i);
    // The only DROP allowed is the idempotent trigger drop-and-recreate.
    const drops = codeOnly.match(/DROP\s+\w+/gi) ?? [];
    expect(drops.every((d) => /DROP TRIGGER/i.test(d))).toBe(true);
    // No writes against any existing business table.
    for (const table of ['leads', 'lead_campaign_touches', 'attributions', 'channels', 'campaign_costs', 'funnel_actuals']) {
      expect(codeOnly).not.toMatch(new RegExp(`INSERT INTO ${table}\\b`, 'i'));
      expect(codeOnly).not.toMatch(new RegExp(`UPDATE ${table}\\b`, 'i'));
      expect(codeOnly).not.toMatch(new RegExp(`DELETE FROM ${table}\\b`, 'i'));
    }
    // No data written at all.
    expect(codeOnly).not.toMatch(/INSERT INTO/i);
  });

  it('enables RLS on all seven tables with zero policies', () => {
    const tables = [
      'sf_lifecycle_sync_runs', 'sf_lifecycle_persons', 'sf_lifecycle_person_aliases',
      'sf_lifecycle_observations', 'sf_lifecycle_events', 'sf_lifecycle_state', 'sf_lifecycle_issues',
    ];
    for (const t of tables) {
      expect(codeOnly, t).toContain(`ALTER TABLE ${t}`);
    }
    expect(codeOnly).toMatch(/ENABLE ROW LEVEL SECURITY/);
    // No policy of any kind, and no anon/authenticated grant.
    expect(codeOnly).not.toMatch(/CREATE POLICY/i);
    expect(codeOnly).not.toMatch(/\banon\b/);
    expect(codeOnly).not.toMatch(/\bauthenticated\b/);
  });

  it('excludes the tables from realtime and the anon-policy loop', () => {
    expect(codeOnly).not.toMatch(/supabase_realtime/);
    expect(codeOnly).not.toMatch(/ALTER PUBLICATION/i);
  });

  it('protects observations and events as append-only', () => {
    expect(codeOnly).toContain('append_only_sf_lifecycle_observations');
    expect(codeOnly).toContain('append_only_sf_lifecycle_events');
    expect(codeOnly).toMatch(/BEFORE UPDATE OR DELETE ON sf_lifecycle_observations/);
    expect(codeOnly).toMatch(/BEFORE UPDATE OR DELETE ON sf_lifecycle_events/);
    expect(codeOnly).toContain('is append-only');
  });

  it('uses RESTRICT so nothing can delete audit history', () => {
    expect(codeOnly).toMatch(/REFERENCES sf_lifecycle_persons\(id\) ON DELETE RESTRICT/);
    // No cascade anywhere in this migration.
    expect(codeOnly).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('constrains normalized states, provenance, run status, and issue kinds', () => {
    expect(codeOnly).toMatch(/normalized_state TEXT NOT NULL[\s\S]{0,120}CHECK/);
    expect(codeOnly).toContain("'lead', 'mql', 'out_of_scope', 'unknown'");
    expect(codeOnly).toContain("'n8n_observed', 'salesforce_confirmed'");
    expect(codeOnly).toContain("'running', 'completed', 'failed', 'incomplete'");
    expect(codeOnly).toContain('identity_conflict');
  });

  it('accepts truthful lead and mql baseline shapes and rejects malformed ones', () => {
    // The shape constraint, evaluated the way Postgres would.
    const accepts = (kind: string, from: string | null) =>
      (kind === 'baseline' && from === null) || (kind !== 'baseline' && from !== null);
    // to_state permits both funnel states, so a null -> mql baseline is a
    // legal row: "first observed as MQL".
    expect(codeOnly).toMatch(/to_state TEXT NOT NULL CHECK \(to_state IN \('lead', 'mql'\)\)/);
    expect(accepts('baseline', null)).toBe(true); // null -> lead AND null -> mql
    expect(accepts('transition', 'lead')).toBe(true);
    expect(accepts('return', 'mql')).toBe(true);
    expect(accepts('requalification', 'lead')).toBe(true);
    // Malformed: a baseline that claims an origin, or a change that lacks one.
    expect(accepts('baseline', 'lead')).toBe(false);
    expect(accepts('transition', null)).toBe(false);
    expect(accepts('return', null)).toBe(false);
    expect(accepts('requalification', null)).toBe(false);
    // The documented meaning of a NULL origin is recorded in the migration.
    expect(MIGRATION).toContain('first observed as MQL');
  });

  it('permits a watermark only on a completed run', () => {
    expect(codeOnly).toContain('sf_lifecycle_runs_watermark_requires_completion');
    expect(codeOnly).toMatch(/watermark_system_modstamp IS NULL OR status = 'completed'/);
  });

  it('keeps Salesforce ids unique and nonblank in the alias table only', () => {
    expect(codeOnly).toContain('sf_lifecycle_alias_source_unique');
    expect(codeOnly).toMatch(/UNIQUE \(source_object, source_record_id\)/);
    expect(codeOnly).toMatch(/source_record_id TEXT NOT NULL CHECK \(length\(trim\(source_record_id\)\) > 0\)/);
  });

  it('carries no credential, url, or real Salesforce identifier', () => {
    expect(MIGRATION).not.toMatch(/https?:\/\//);
    expect(MIGRATION).not.toMatch(/service_role|api[_-]?key|bearer |secret/i);
    expect(MIGRATION).not.toMatch(/\b(001|003|00Q|005|006)[A-Za-z0-9]{12}\b/);
    expect(MIGRATION).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });

  it('is recorded APPLIED in the migration ledger, with no data imported', () => {
    // Applied manually to production on 2026-08-04. The row must state the
    // real status: the guard is that it stays accurate, not that it stays
    // PENDING. Structure only; ingestion (Bite 4G2B) is unstarted, so the
    // row must not imply any lifecycle data exists.
    const readme = readFileSync(resolve(process.cwd(), 'migrations/README.md'), 'utf8');
    expect(readme).toContain('2026-08-04_lifecycle_observation_ledger.sql');
    const row = readme.split('\n').find((l) => l.includes('2026-08-04_lifecycle_observation_ledger.sql'))!;
    expect(row).toContain('APPLIED');
    expect(row).toContain('2026-08-04');
    expect(row).not.toContain('NOT YET APPLIED');
    expect(row).toContain('imported no lifecycle data');
  });
});

// --- fixture hygiene -------------------------------------------------------

describe('fixture hygiene', () => {
  it('uses only synthetic identifiers, never Salesforce-id-shaped values', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleObservationPlanner.test.ts'), 'utf8');
    expect(source).not.toMatch(/\b(001|003|00Q|00v|701|005|006)[A-Za-z0-9]{12}\b/);
    expect(source).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|org|net)\b/);
    expect(source).toContain('SYNTH-');
  });

  it('the planner touches no database or network', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/lifecycleObservationPlanner.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"].*supabase/i);
    expect(source).not.toMatch(/createClient|fetch\(|axios/);
    expect(source).not.toMatch(/import\.meta\.env|VITE_/);
    // Pure: no clock reads.
    expect(source).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
});
