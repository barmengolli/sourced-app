// Tests for the Opportunity movement and velocity contract (Bite 5A). All
// fixtures are synthetic: no real Salesforce identifiers, opportunity names,
// accounts, owners, or campaign names appear anywhere here.

import { describe, it, expect } from 'vitest';
import {
  adaptOpportunityHistory,
  currentFunnelSnapshot,
  movementSummary,
  DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP,
  DEFAULT_OPPORTUNITY_TERMINAL_STAGE_MAP,
  DEFAULT_OPPORTUNITY_OPEN_STAGE_VALUES,
} from './opportunityStageHistory';
import type {
  OpportunityHistoryRow,
  OpportunityStageConfig,
} from './opportunityStageHistory';

const config: OpportunityStageConfig = {
  recordTypeFieldName: 'Opportunity Record Type',
  recordTypeMap: DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP,
  stageFieldName: 'Stage',
  terminalStageMap: DEFAULT_OPPORTUNITY_TERMINAL_STAGE_MAP,
  openStageValues: DEFAULT_OPPORTUNITY_OPEN_STAGE_VALUES,
};

let seq = 0;
function row(over: Partial<OpportunityHistoryRow>): OpportunityHistoryRow {
  seq += 1;
  return {
    historyId: `oh-${String(seq).padStart(3, '0')}`,
    opportunityId: 'syn-opp-1',
    field: 'Opportunity Record Type',
    oldValue: null,
    newValue: 'High Potential Prospect',
    changedAt: '2026-01-01T09:00:00Z',
    ...over,
  };
}

// A witnessed forward path: created as HPP (blank old value), then advancing.
function forwardPath(): OpportunityHistoryRow[] {
  return [
    row({ historyId: 'oh-f1', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-01T09:00:00Z' }),
    row({ historyId: 'oh-f2', oldValue: 'High Potential Prospect', newValue: 'Opportunity', changedAt: '2026-02-01T09:00:00Z' }),
    row({ historyId: 'oh-f3', oldValue: 'Opportunity', newValue: 'Pursuit', changedAt: '2026-03-01T09:00:00Z' }),
  ];
}

function one(result: ReturnType<typeof adaptOpportunityHistory>) {
  expect(result.opportunities).toHaveLength(1);
  return result.opportunities[0];
}

describe('forward movement and skips', () => {
  it('HPP to Opportunity to Pursuit produces a full current path with velocity', () => {
    const o = one(adaptOpportunityHistory(forwardPath(), config));
    expect(o.currentStage).toBe('pursuit');
    expect(o.activeDates).toEqual({ hpp: '2026-01-01', opp: '2026-02-01', pursuit: '2026-03-01' });
    expect(o.forwardMoves).toBe(2);
    expect(o.backwardMoves).toBe(0);
    expect(o.velocity.hppToOppDays).toBe(31);
    expect(o.velocity.oppToPursuitDays).toBe(28);
    expect(o.incompleteBaseline).toBe(false);
  });

  it('HPP to Pursuit skip leaves Opportunity null and never invents its date', () => {
    const o = one(
      adaptOpportunityHistory(
        [
          row({ historyId: 'oh-s1', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-01T09:00:00Z' }),
          row({ historyId: 'oh-s2', oldValue: 'High Potential Prospect', newValue: 'Pursuit', changedAt: '2026-02-01T09:00:00Z' }),
        ],
        config,
      ),
    );
    expect(o.currentStage).toBe('pursuit');
    expect(o.activeDates).toEqual({ hpp: '2026-01-01', opp: null, pursuit: '2026-02-01' });
    expect(o.skips.forward).toBe(1);
    // The skipped interval is unavailable, not zero; the direct interval is.
    expect(o.velocity.hppToOppDays).toBeNull();
    expect(o.velocity.oppToPursuitDays).toBeNull();
    expect(o.velocity.hppToPursuitDays).toBe(31);
  });

  it('a deal first observed as Pursuit is a baseline with unknown earlier history', () => {
    const r = adaptOpportunityHistory([], config, [
      { opportunityId: 'syn-opp-b', recordTypeValue: 'Pursuit', observedAt: '2026-07-01T00:00:00Z', sourceId: 'syn-obs-1' },
    ]);
    const o = one(r);
    expect(o.currentStage).toBe('pursuit');
    // Entry dates unknown: never invented from the observation time.
    expect(o.activeDates).toEqual({ hpp: null, opp: null, pursuit: null });
    expect(o.incompleteBaseline).toBe(true);
    expect(o.velocity).toEqual({ hppToOppDays: null, oppToPursuitDays: null, hppToPursuitDays: null });
    expect(r.ledger[0].baselineObservation).toBe(true);
    expect(r.ledger[0].historyKnownBefore).toBe(false);
  });
});

describe('regressions, re-entries, and the append-only ledger', () => {
  it('HPP to Opportunity to HPP clears the higher stage from the path but keeps the ledger', () => {
    const rows = [
      row({ historyId: 'oh-r1', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-01T09:00:00Z' }),
      row({ historyId: 'oh-r2', oldValue: 'High Potential Prospect', newValue: 'Opportunity', changedAt: '2026-02-01T09:00:00Z' }),
      row({ historyId: 'oh-r3', oldValue: 'Opportunity', newValue: 'High Potential Prospect', changedAt: '2026-03-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const o = one(r);
    expect(o.currentStage).toBe('hpp');
    expect(o.activeDates).toEqual({ hpp: '2026-03-01', opp: null, pursuit: null });
    expect(o.backwardMoves).toBe(1);
    expect(o.reEntries.hpp).toBe(1);
    // Regression suppresses the downstream interval until re-reached.
    expect(o.velocity.hppToOppDays).toBeNull();
    // All three movements remain in the append-only ledger.
    expect(r.ledger).toHaveLength(3);
    expect(r.ledger.map((e) => e.sourceHistoryId)).toEqual(['oh-r1', 'oh-r2', 'oh-r3']);
  });

  it('Pursuit to HPP is a backward skip', () => {
    const o = one(
      adaptOpportunityHistory(
        [
          row({ historyId: 'oh-b1', oldValue: null, newValue: 'Pursuit', changedAt: '2026-01-01T09:00:00Z' }),
          row({ historyId: 'oh-b2', oldValue: 'Pursuit', newValue: 'High Potential Prospect', changedAt: '2026-02-01T09:00:00Z' }),
        ],
        config,
      ),
    );
    expect(o.skips.backward).toBe(1);
    expect(o.currentStage).toBe('hpp');
    expect(o.activeDates.pursuit).toBeNull();
  });

  it('Pursuit to Opportunity to Pursuit re-enters with the new date and restores velocity', () => {
    const o = one(
      adaptOpportunityHistory(
        [
          row({ historyId: 'oh-p1', oldValue: null, newValue: 'Pursuit', changedAt: '2026-02-01T09:00:00Z' }),
          row({ historyId: 'oh-p2', oldValue: 'Pursuit', newValue: 'Opportunity', changedAt: '2026-03-01T09:00:00Z' }),
          row({ historyId: 'oh-p3', oldValue: 'Opportunity', newValue: 'Pursuit', changedAt: '2026-04-01T09:00:00Z' }),
        ],
        config,
      ),
    );
    expect(o.currentStage).toBe('pursuit');
    // The current Pursuit entry is April; the February visit stays in history.
    expect(o.activeDates.pursuit).toBe('2026-04-01');
    expect(o.activeDates.opp).toBe('2026-03-01');
    expect(o.reEntries.pursuit).toBe(1);
    // Velocity uses the re-entry dates of the current path.
    expect(o.velocity.oppToPursuitDays).toBe(31);
  });

  it('multiple returns and re-entries are all counted and retained', () => {
    const rows = [
      row({ historyId: 'oh-m1', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-01T09:00:00Z' }),
      row({ historyId: 'oh-m2', oldValue: 'High Potential Prospect', newValue: 'Opportunity', changedAt: '2026-01-10T09:00:00Z' }),
      row({ historyId: 'oh-m3', oldValue: 'Opportunity', newValue: 'High Potential Prospect', changedAt: '2026-01-20T09:00:00Z' }),
      row({ historyId: 'oh-m4', oldValue: 'High Potential Prospect', newValue: 'Opportunity', changedAt: '2026-02-01T09:00:00Z' }),
      row({ historyId: 'oh-m5', oldValue: 'Opportunity', newValue: 'High Potential Prospect', changedAt: '2026-02-10T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const o = one(r);
    expect(o.forwardMoves).toBe(2);
    expect(o.backwardMoves).toBe(2);
    expect(o.reEntries.hpp).toBe(2);
    expect(o.reEntries.opp).toBe(1);
    expect(o.activeDates.hpp).toBe('2026-02-10');
    expect(r.ledger).toHaveLength(5);
    expect(movementSummary(r).reEntries).toBe(3);
  });
});

describe('excluded states and unknown values', () => {
  it('a Nurture visit suspends the visible stage and stays in the ledger', () => {
    const rows = [
      row({ historyId: 'oh-n1', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-01T09:00:00Z' }),
      row({ historyId: 'oh-n2', oldValue: 'High Potential Prospect', newValue: 'Nurture', changedAt: '2026-02-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const o = one(r);
    expect(o.currentStage).toBeNull();
    expect(o.currentState).toBe('out_of_scope');
    // Known entry dates are not erased by the suspension.
    expect(o.activeDates.hpp).toBe('2026-01-01');
    expect(r.ledger).toHaveLength(2);
    expect(movementSummary(r).excludedVisits).toBe(1);
  });

  it('returning from Nurture re-enters the funnel with the return date', () => {
    const o = one(
      adaptOpportunityHistory(
        [
          row({ historyId: 'oh-n3', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-01T09:00:00Z' }),
          row({ historyId: 'oh-n4', oldValue: 'High Potential Prospect', newValue: 'Nurture', changedAt: '2026-02-01T09:00:00Z' }),
          row({ historyId: 'oh-n5', oldValue: 'Nurture', newValue: 'High Potential Prospect', changedAt: '2026-04-01T09:00:00Z' }),
        ],
        config,
      ),
    );
    expect(o.currentStage).toBe('hpp');
    expect(o.activeDates.hpp).toBe('2026-04-01');
    expect(o.reEntries.hpp).toBe(1);
  });

  it('an unknown record-type value is flagged for review and never a visible stage', () => {
    const r = adaptOpportunityHistory(
      [
        row({ historyId: 'oh-u1', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-01T09:00:00Z' }),
        row({ historyId: 'oh-u2', oldValue: 'High Potential Prospect', newValue: 'Synthetic Future Type', changedAt: '2026-02-01T09:00:00Z' }),
      ],
      config,
    );
    const o = one(r);
    expect(o.currentStage).toBeNull();
    expect(o.currentState).toBe('unknown');
    expect(o.reportable).toBe(false);
    expect(r.review.some((x) => x.reason === 'unknown_record_type' && x.historyId === 'oh-u2')).toBe(true);
    // The evidence is retained in the ledger.
    expect(r.ledger[1].toState).toBe('unknown');
    expect(r.state).toBe('incomplete');
  });

  it('legacy label and developer-name aliases classify identically', () => {
    const aliases: Array<[string, string, string]> = [
      ['High_Potential_Prospect', 'Leads', 'Sales Qualified Opportunity'],
      ['High Potential Prospect', 'Sales Accepted Opportunity', 'Licensing'],
    ];
    for (const [hppVal, oppVal, pursuitVal] of aliases) {
      const o = one(
        adaptOpportunityHistory(
          [
            row({ historyId: `oh-l1-${hppVal}`, oldValue: null, newValue: hppVal, changedAt: '2026-01-01T09:00:00Z' }),
            row({ historyId: `oh-l2-${hppVal}`, oldValue: hppVal, newValue: oppVal, changedAt: '2026-02-01T09:00:00Z' }),
            row({ historyId: `oh-l3-${hppVal}`, oldValue: oppVal, newValue: pursuitVal, changedAt: '2026-03-01T09:00:00Z' }),
          ],
          config,
        ),
      );
      expect(o.currentStage).toBe('pursuit');
      expect(o.forwardMoves).toBe(2);
    }
  });
});

describe('validation and deduplication', () => {
  it('an exact duplicate history row is informational and keeps the result complete', () => {
    const rows = forwardPath();
    const r = adaptOpportunityHistory([...rows, { ...rows[1] }], config);
    expect(r.duplicatesIgnored).toBe(1);
    expect(r.state).toBe('complete');
    expect(r.ledger).toHaveLength(3);
  });

  it('conflicting content under one History ID emits no event and requires review', () => {
    const rows = forwardPath();
    const conflict = { ...rows[1], newValue: 'Pursuit' };
    const r = adaptOpportunityHistory([...rows, conflict], config);
    expect(r.review).toContainEqual({ reason: 'conflicting_duplicate_history_id', historyId: 'oh-f2', opportunityId: 'syn-opp-1' });
    expect(r.state).toBe('incomplete');
    expect(r.ledger.map((e) => e.sourceHistoryId)).toEqual(['oh-f1', 'oh-f3']);
  });

  it('invalid or impossible timestamps are reviewed, never today-dated', () => {
    for (const changedAt of ['not-a-time', '2026-02-30T09:00:00Z', '2026-01-01T25:00:00Z']) {
      const r = adaptOpportunityHistory([row({ historyId: 'oh-t1', changedAt })], config);
      expect(r.opportunities).toHaveLength(0);
      expect(r.review[0].reason).toBe('invalid_history_timestamp');
    }
  });

  it('blank History ID or Opportunity ID is an invalid source row', () => {
    const a = adaptOpportunityHistory([row({ historyId: '  ' })], config);
    expect(a.review).toEqual([{ reason: 'invalid_source_row', historyId: undefined }]);
    const b = adaptOpportunityHistory([row({ historyId: 'oh-i1', opportunityId: '' })], config);
    expect(b.review).toEqual([{ reason: 'invalid_source_row', historyId: 'oh-i1' }]);
    expect(a.opportunities).toHaveLength(0);
    expect(b.opportunities).toHaveLength(0);
  });

  it('invalid configuration processes zero records', () => {
    const bad: OpportunityStageConfig = {
      recordTypeFieldName: 'Opportunity Record Type',
      recordTypeMap: JSON.parse('{"Nurture":"hpp","Mystery":"funnel_top"}') as Record<string, never>,
    };
    const r = adaptOpportunityHistory(forwardPath(), bad, []);
    expect(r.state).toBe('invalid');
    expect(r.issues).toEqual([{ kind: 'invalid_config', count: 1 }]);
    expect(r.opportunities).toHaveLength(0);
  });

  it('multiple transitions at one timestamp order deterministically by History ID', () => {
    const sameInstant = [
      row({ historyId: 'oh-z2', oldValue: 'High Potential Prospect', newValue: 'Opportunity', changedAt: '2026-01-01T09:00:00Z' }),
      row({ historyId: 'oh-z1', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-01T09:00:00Z' }),
    ];
    const forward = adaptOpportunityHistory(sameInstant, config);
    const reversed = adaptOpportunityHistory([...sameInstant].reverse(), config);
    expect(forward.ledger.map((e) => e.sourceHistoryId)).toEqual(['oh-z1', 'oh-z2']);
    expect(reversed.ledger).toEqual(forward.ledger);
    expect(forward.opportunities[0].currentStage).toBe('opp');
  });

  it('missing earlier history marks an incomplete baseline without inventing dates', () => {
    // First witnessed row already transitions OUT of HPP: the HPP entry
    // predates retained history.
    const o = one(
      adaptOpportunityHistory(
        [row({ historyId: 'oh-h1', oldValue: 'High Potential Prospect', newValue: 'Opportunity', changedAt: '2026-02-01T09:00:00Z' })],
        config,
      ),
    );
    expect(o.incompleteBaseline).toBe(true);
    expect(o.activeDates).toEqual({ hpp: null, opp: '2026-02-01', pursuit: null });
    // The unavailable upstream interval is null, never zero.
    expect(o.velocity.hppToOppDays).toBeNull();
  });
});

describe('terminal status is separate from funnel level', () => {
  it('close-won arrives through the Stage field while the record type keeps the level', () => {
    const rows = [
      ...forwardPath(),
      row({ historyId: 'oh-w1', field: 'Stage', oldValue: '7) Proposal', newValue: '100) Closed-Won', changedAt: '2026-04-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const o = one(r);
    expect(o.currentStage).toBe('pursuit');
    expect(o.terminalStatus).toBe('won');
    expect(r.terminalLedger).toHaveLength(1);
    expect(r.terminalLedger[0].toStatus).toBe('won');
  });

  it('every observed closed Stage label maps to its terminal status', () => {
    const expected: Array<[string, string]> = [
      ['100) Closed-Won', 'won'],
      ['Closed-Lost-Competitor', 'lost'],
      ['Closed-Lost-InHouse', 'lost'],
      ['Closed-Disqualified', 'disqualified'],
      ['Closed-Nurture', 'nurture'],
    ];
    for (const [label, status] of expected) {
      const r = adaptOpportunityHistory(
        [
          row({ historyId: `oh-c-${label}`, field: 'Stage', oldValue: '3) Qualification', newValue: label, changedAt: '2026-04-01T09:00:00Z' }),
        ],
        config,
      );
      expect(one(r).terminalStatus).toBe(status);
      expect(r.review).toEqual([]);
    }
  });

  it('every observed open Stage label keeps the deal open or reopens it', () => {
    for (const label of DEFAULT_OPPORTUNITY_OPEN_STAGE_VALUES) {
      const r = adaptOpportunityHistory(
        [
          row({ historyId: 'oh-o1', field: 'Stage', oldValue: '1) Suspect', newValue: '100) Closed-Won', changedAt: '2026-04-01T09:00:00Z' }),
          row({ historyId: 'oh-o2', field: 'Stage', oldValue: '100) Closed-Won', newValue: label, changedAt: '2026-05-01T09:00:00Z' }),
        ],
        config,
      );
      expect(one(r).terminalStatus).toBe('open');
      expect(r.review).toEqual([]);
    }
  });

  it("the org's own 'Opportunity Assesment' spelling is matched as-is", () => {
    const r = adaptOpportunityHistory(
      [row({ historyId: 'oh-sp1', field: 'Stage', oldValue: '1) Suspect', newValue: '2) Opportunity Assesment', changedAt: '2026-02-01T09:00:00Z' })],
      config,
    );
    expect(one(r).terminalStatus).toBe('open');
    expect(r.review).toEqual([]);
  });

  it('detail-stage moves between open values are not terminal changes', () => {
    const rows = [
      ...forwardPath(),
      row({ historyId: 'oh-d1', field: 'Stage', oldValue: '4) Discovery', newValue: '7) Proposal', changedAt: '2026-03-15T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    expect(r.terminalLedger).toHaveLength(0);
    expect(one(r).terminalStatus).toBe('open');
  });

  it('reopening after closure is supported when history proves it', () => {
    const rows = [
      ...forwardPath(),
      row({ historyId: 'oh-w2', field: 'Stage', oldValue: '7) Proposal', newValue: 'Closed-Lost-Competitor', changedAt: '2026-04-01T09:00:00Z' }),
      row({ historyId: 'oh-w3', field: 'Stage', oldValue: 'Closed-Lost-Competitor', newValue: '4) Discovery', changedAt: '2026-05-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const o = one(r);
    expect(o.terminalStatus).toBe('open');
    // Both the closure and the reopening remain in the terminal ledger.
    expect(r.terminalLedger.map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(['open>lost', 'lost>open']);
  });

  it('an unknown Stage value is reviewed and never closes or reopens the deal', () => {
    const rows = [
      row({ historyId: 'oh-uq1', field: 'Stage', oldValue: '3) Qualification', newValue: '100) Closed-Won', changedAt: '2026-04-01T09:00:00Z' }),
      row({ historyId: 'oh-uq2', field: 'Stage', oldValue: '100) Closed-Won', newValue: '99) Synthetic Mystery Stage', changedAt: '2026-05-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const o = one(r);
    // The unknown value did not reopen the closed deal.
    expect(o.terminalStatus).toBe('won');
    expect(r.terminalLedger).toHaveLength(1);
    expect(r.review).toContainEqual({ reason: 'unknown_stage_value', historyId: 'oh-uq2', opportunityId: 'syn-opp-1' });
    expect(r.state).toBe('incomplete');
  });
});

describe('same-timestamp ambiguity', () => {
  it('two conflicting record-type transitions at one timestamp are flagged, not ordered by History ID', () => {
    const rows = [
      row({ historyId: 'oh-a1', oldValue: null, newValue: 'Opportunity', changedAt: '2026-01-01T09:00:00Z' }),
      // Both claim to leave Opportunity at the same instant, to different
      // destinations: no order is provable and outcomes differ.
      row({ historyId: 'oh-a2', oldValue: 'Opportunity', newValue: 'High Potential Prospect', changedAt: '2026-02-01T09:00:00Z' }),
      row({ historyId: 'oh-a3', oldValue: 'Opportunity', newValue: 'Pursuit', changedAt: '2026-02-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const o = one(r);
    expect(r.review.some((x) => x.reason === 'ambiguous_same_timestamp')).toBe(true);
    // The resulting stage depends on unprovable ordering: unknown, velocity
    // fully suppressed, not reportable.
    expect(o.currentStage).toBeNull();
    expect(o.currentState).toBe('unknown');
    expect(o.velocity).toEqual({ hppToOppDays: null, oppToPursuitDays: null, hppToPursuitDays: null });
    expect(o.reportable).toBe(false);
    // Every source event is preserved for audit.
    expect(r.ledger).toHaveLength(3);
    expect(r.state).toBe('incomplete');
  });

  it('a same-timestamp group whose order is proven by old-value chaining is not ambiguous', () => {
    const rows = [
      row({ historyId: 'oh-ch1', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-01T09:00:00Z' }),
      row({ historyId: 'oh-ch2', oldValue: 'High Potential Prospect', newValue: 'Opportunity', changedAt: '2026-01-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const o = one(r);
    expect(r.review).toEqual([]);
    expect(o.currentStage).toBe('opp');
    expect(o.activeDates).toEqual({ hpp: '2026-01-01', opp: '2026-01-01', pursuit: null });
  });

  it('same-timestamp terminal and record-type events stay independently interpretable', () => {
    const rows = [
      ...forwardPath(),
      row({ historyId: 'oh-tt1', field: 'Stage', oldValue: '7) Proposal', newValue: '100) Closed-Won', changedAt: '2026-03-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const o = one(r);
    // The Stage closure and the record-type move share a timestamp but live
    // in separate ledgers: no ambiguity between them.
    expect(r.review).toEqual([]);
    expect(o.currentStage).toBe('pursuit');
    expect(o.terminalStatus).toBe('won');
  });

  it('harmless unrelated same-timestamp events create no ambiguity', () => {
    const rows = [
      ...forwardPath(),
      row({ historyId: 'oh-hf1', field: 'Synthetic Other Field', oldValue: 'a', newValue: 'b', changedAt: '2026-03-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    expect(r.review).toEqual([]);
    expect(r.otherFieldRowsIgnored).toBe(1);
    expect(one(r).currentStage).toBe('pursuit');
  });

  it('normal sequential timestamps keep full path and velocity behavior', () => {
    const r = adaptOpportunityHistory(forwardPath(), config);
    const o = one(r);
    expect(r.review).toEqual([]);
    expect(o.velocity.hppToOppDays).toBe(31);
    expect(o.velocity.oppToPursuitDays).toBe(28);
  });
});

describe('reporting lenses', () => {
  it('the current funnel counts each Opportunity exactly once', () => {
    const rows = [
      // syn-opp-1 travelled through all three stages; currently pursuit.
      ...forwardPath(),
      // syn-opp-2 is currently HPP after a regression.
      row({ historyId: 'oh-x1', opportunityId: 'syn-opp-2', oldValue: null, newValue: 'Opportunity', changedAt: '2026-01-05T09:00:00Z' }),
      row({ historyId: 'oh-x2', opportunityId: 'syn-opp-2', oldValue: 'Opportunity', newValue: 'High Potential Prospect', changedAt: '2026-02-05T09:00:00Z' }),
      // syn-opp-3 is parked in Nurture.
      row({ historyId: 'oh-x3', opportunityId: 'syn-opp-3', oldValue: null, newValue: 'High Potential Prospect', changedAt: '2026-01-06T09:00:00Z' }),
      row({ historyId: 'oh-x4', opportunityId: 'syn-opp-3', oldValue: 'High Potential Prospect', newValue: 'Nurture', changedAt: '2026-02-06T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const snap = currentFunnelSnapshot(r.opportunities);
    // A deal that occupied several stages historically appears once, at its
    // current stage only.
    expect(snap.counts).toEqual({ hpp: 1, opp: 0, pursuit: 1 });
    expect(snap.outOfScope).toBe(1);
    expect(snap.totalUnique).toBe(3);
    expect(snap.counts.hpp + snap.counts.opp + snap.counts.pursuit + snap.outOfScope + snap.unknown).toBe(3);
  });

  it('the historical movement lens retains every recorded movement', () => {
    const rows = [
      ...forwardPath(),
      row({ historyId: 'oh-y1', oldValue: 'Pursuit', newValue: 'High Potential Prospect', changedAt: '2026-04-01T09:00:00Z' }),
    ];
    const r = adaptOpportunityHistory(rows, config);
    const summary = movementSummary(r);
    expect(summary.totalMovements).toBe(4);
    expect(summary.forwardMoves).toBe(2);
    expect(summary.backwardMoves).toBe(1);
    expect(summary.backwardSkips).toBe(1);
    // Nothing was collapsed away even though the current path shows HPP only.
    expect(r.opportunities[0].activeDates).toEqual({ hpp: '2026-04-01', opp: null, pursuit: null });
  });
});

describe('fixture hygiene', () => {
  it('no fixture identifier looks like a real Salesforce Id', () => {
    const all = [...forwardPath(), row({})];
    for (const r of all) {
      expect(r.historyId).toMatch(/^oh-/);
      expect(r.opportunityId).toMatch(/^syn-/);
      expect(/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(r.opportunityId)).toBe(false);
    }
  });
});
