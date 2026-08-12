// Tests for the read-only Salesforce Opportunity dry-run layer (Bite 5C1).
// Synthetic wire records only: no real Salesforce IDs, names, accounts,
// owners, or campaigns. Includes static safety assertions over the sanitized
// n8n template embedded in docs/salesforce-opportunity-sync.md.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  INCLUDED_DEVELOPER_NAMES,
  DRY_RUN_STAGE_CONFIG,
  LEGACY_TERMINAL_STAGE_ALIASES,
  LEGACY_OPEN_STAGE_ALIASES,
  CONFIRMED_CUSTOM_FIELDS,
  INDUSTRY_VERTICAL_CANDIDATES,
  normalizeSourceValue,
  resolveApprovedBdrUsers,
  mapHistoryRecord,
  mapBaselineObservation,
  chunkOpportunityIds,
  classifyScope,
  buildDryRunSummary,
} from './salesforceOpportunitySync';
import type {
  SalesforceOpportunityRecord,
  SalesforceOpportunityHistoryRecord,
} from './salesforceOpportunitySync';
import { adaptOpportunityHistory } from './opportunityStageHistory';

const RUN = { executedAt: '2026-07-27T12:00:00Z', year: 2026 };

let seq = 0;
function opp(over: Partial<SalesforceOpportunityRecord> = {}): SalesforceOpportunityRecord {
  seq += 1;
  return {
    Id: `SYNTH-OPP-${seq}`,
    Name: 'Synthetic Deal Name',
    AccountId: 'SYNTH-ACC-1',
    Account: { Name: 'Synthetic Account Co' },
    RecordType: { DeveloperName: 'High_Potential_Prospect', Name: 'High Potential Prospect' },
    StageName: '3) Qualification',
    IsClosed: false,
    IsWon: false,
    CreatedDate: '2026-02-01T09:00:00.000+0000',
    LastModifiedDate: '2026-06-01T09:00:00.000+0000',
    SystemModstamp: '2026-06-01T09:00:00.000+0000',
    Amount: 1000,
    CloseDate: '2026-12-31',
    OwnerId: 'SYNTH-USER-1',
    Owner: { Name: 'Synthetic Owner' },
    CampaignId: null,
    ...over,
  };
}

function hist(over: Partial<SalesforceOpportunityHistoryRecord>): SalesforceOpportunityHistoryRecord {
  seq += 1;
  return {
    Id: `SYNTH-HIST-${seq}`,
    OpportunityId: 'SYNTH-OPP-A',
    Field: 'RecordType',
    OldValue: null,
    NewValue: 'High Potential Prospect',
    CreatedDate: '2026-01-01T09:00:00.000+0000',
    ...over,
  };
}

describe('record-type classification', () => {
  it('maps each included DeveloperName to its funnel stage as a baseline', () => {
    for (const [dev, stage] of Object.entries(INCLUDED_DEVELOPER_NAMES)) {
      const record = opp({ RecordType: { DeveloperName: dev, Name: dev } });
      const summary = buildDryRunSummary([record], [], [], RUN);
      expect(summary.countsByNormalizedCurrentStage[stage]).toBe(1);
    }
  });

  it('an excluded record type never lands in a visible stage', () => {
    const summary = buildDryRunSummary(
      [opp({ RecordType: { DeveloperName: 'Nurture', Name: 'Nurture' } })],
      [],
      [],
      RUN,
    );
    expect(summary.countsByNormalizedCurrentStage.out_of_scope).toBe(1);
    expect(summary.countsByNormalizedCurrentStage.hpp).toBe(0);
  });

  it('an unknown record type is counted and routed to review, never guessed', () => {
    const summary = buildDryRunSummary(
      [opp({ RecordType: { DeveloperName: 'Synthetic_Future_Type', Name: 'Future' } })],
      [],
      [],
      RUN,
    );
    expect(summary.countsByNormalizedCurrentStage.unknown).toBe(1);
    expect(summary.review.countsByIssue.unknown_record_type).toBe(1);
  });

  it('Service is out of scope: excluded from the funnel, retained in the ledger, never reviewed as unknown', () => {
    // A current Service opportunity never enters the visible funnel or the
    // future review queue population.
    const current = buildDryRunSummary(
      [opp({ RecordType: { DeveloperName: 'Service', Name: 'Service' } })],
      [],
      [],
      RUN,
    );
    expect(current.countsByNormalizedCurrentStage.out_of_scope).toBe(1);
    expect(current.countsByNormalizedCurrentStage.unknown).toBe(0);
    expect(current.review.countsByIssue.unknown_record_type).toBeUndefined();
    // Historical Service movements stay in the append-only ledger without
    // unknown-record-type review noise.
    const record = opp({ Id: 'SYNTH-OPP-A' });
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'High Potential Prospect', NewValue: 'Service', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const historical = buildDryRunSummary([record], rows, [], RUN);
    expect(historical.history.recordTypeValues.unmappedNonblankLabel).toBe(0);
    expect(historical.review.countsByIssue.unknown_record_type).toBeUndefined();
    expect(historical.countsByNormalizedCurrentStage.out_of_scope).toBe(1);
    const result = adaptOpportunityHistory(rows.map(mapHistoryRecord), DRY_RUN_STAGE_CONFIG);
    expect(result.ledger).toHaveLength(2);
    expect(result.ledger[1].toState).toBe('out_of_scope');
  });

  it('historical label aliases in history rows classify identically', () => {
    const record = opp({ Id: 'SYNTH-OPP-A', RecordType: { DeveloperName: 'Licensing', Name: 'Pursuit' } });
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'Sales Accepted Opportunity', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Sales Accepted Opportunity', NewValue: 'Sales Qualified Opportunity', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.movement.forwardMoves).toBe(1);
    expect(summary.countsByNormalizedCurrentStage.pursuit).toBe(1);
  });
});

describe('initial-sync scope counts', () => {
  it('separates older-open, created, modified, and closed groups', () => {
    const records = [
      // Older open: a CreatedDate-only backfill would drop this one.
      opp({ CreatedDate: '2024-03-01T09:00:00.000+0000', SystemModstamp: '2025-11-01T09:00:00.000+0000', IsClosed: false }),
      // Created in 2026.
      opp({ CreatedDate: '2026-03-01T09:00:00.000+0000', IsClosed: false }),
      // Closed in 2026.
      opp({ CreatedDate: '2025-01-01T09:00:00.000+0000', IsClosed: true, CloseDate: '2026-04-15' }),
    ];
    const scope = classifyScope(records, 2026);
    expect(scope.discovered).toBe(3);
    expect(scope.openNow).toBe(2);
    expect(scope.closedNow).toBe(1);
    expect(scope.createdInYear).toBe(1);
    expect(scope.modifiedInYear).toBe(2);
    expect(scope.closedWithCloseDateInYear).toBe(1);
    expect(scope.olderOpen).toBe(1);
  });

  it('a direct-created Pursuit with no history is a baseline with unknown dates', () => {
    const record = opp({ Id: 'SYNTH-OPP-P', RecordType: { DeveloperName: 'Licensing', Name: 'Pursuit' } });
    const baseline = mapBaselineObservation(record, RUN.executedAt);
    expect(baseline.recordTypeValue).toBe('Licensing');
    expect(baseline.sourceId).toBe('baseline:SYNTH-OPP-P');
    const result = adaptOpportunityHistory([], DRY_RUN_STAGE_CONFIG, [baseline]);
    expect(result.opportunities[0].currentStage).toBe('pursuit');
    expect(result.opportunities[0].activeDates).toEqual({ hpp: null, opp: null, pursuit: null });
    expect(result.opportunities[0].incompleteBaseline).toBe(true);
  });
});

describe('history mapping and movement', () => {
  const record = opp({ Id: 'SYNTH-OPP-A' });

  it('preserves the full Salesforce timestamp exactly', () => {
    const row = mapHistoryRecord(hist({ CreatedDate: '2026-02-01T09:00:00.000+0000' }));
    expect(row.changedAt).toBe('2026-02-01T09:00:00.000+0000');
    expect(row.historyId).toMatch(/^SYNTH-HIST-/);
  });

  it('counts forward, backward, and skipped moves through the real Bite 5A derivation', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'High Potential Prospect', NewValue: 'Pursuit', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Pursuit', NewValue: 'Opportunity', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.movement.forwardMoves).toBe(1);
    expect(summary.movement.forwardSkips).toBe(1);
    expect(summary.movement.backwardMoves).toBe(1);
    expect(summary.history.recordTypeRows).toBe(3);
  });

  it('close and reopening flow through StageName rows without touching the funnel level', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: '7) Proposal', NewValue: '100) Closed-Won', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: '100) Closed-Won', NewValue: '4) Discovery', CreatedDate: '2026-04-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.history.stageRows).toBe(2);
    expect(summary.countsByNormalizedCurrentStage.hpp).toBe(1);
    expect(summary.history.stageValues.unknownNonblank).toBe(0);
  });

  it('exact duplicates are informational; conflicting duplicate IDs are counted', () => {
    const base = hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect' });
    const exact = buildDryRunSummary([record], [base, { ...base }], [], RUN);
    expect(exact.history.exactDuplicates).toBe(1);
    expect(exact.history.conflictingDuplicateHistoryIds).toBe(0);
    const conflict = buildDryRunSummary([record], [base, { ...base, NewValue: 'Pursuit' }], [], RUN);
    expect(conflict.history.conflictingDuplicateHistoryIds).toBe(1);
    expect(conflict.review.countsByIssue.conflicting_history_id).toBe(1);
  });

  it('unknown Stage values and invalid timestamps are counted for review', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: '3) Qualification', NewValue: '99) Synthetic Mystery', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', CreatedDate: '2026-02-30T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.history.stageValues.unknownNonblank).toBe(1);
    expect(summary.history.invalidTimestamps).toBe(1);
  });

  it('same-timestamp ambiguities surface in the summary', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'Opportunity', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'High Potential Prospect', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'Pursuit', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.movement.sameTimestamp.materiallyAmbiguous).toBe(1);
    expect(summary.review.countsByIssue.ambiguous_same_timestamp).toBe(1);
  });
});

describe('runtime RecordType resolution (hardening)', () => {
  // Fake Salesforce-SHAPED RecordType ids (15 and 18 characters), never real.
  const RT_HPP_15 = '012AAAA0000SYN1';
  const RT_OPP_18 = '012AAAA0000SYN2XYZ';
  const refs = [
    { Id: RT_HPP_15, Name: 'High Potential Prospect', DeveloperName: 'High_Potential_Prospect', SobjectType: 'Opportunity' },
    { Id: RT_OPP_18, Name: 'Opportunity', DeveloperName: 'Leads', SobjectType: 'Opportunity' },
  ];
  const record = opp({ Id: 'SYNTH-OPP-A' });

  it('resolves RecordTypeId history values through the runtime map', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: RT_HPP_15, CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: RT_HPP_15, NewValue: RT_OPP_18, CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, refs, RUN);
    expect(summary.movement.forwardMoves).toBe(1);
    expect(summary.countsByNormalizedCurrentStage.opp).toBe(1);
    expect(summary.history.recordTypeValues.resolvedViaIdMap).toBe(3);
    expect(summary.history.recordTypeValues.blankBaseline).toBe(1);
    expect(summary.history.recordTypeValues.affectedRows).toBe(0);
    expect(summary.review.countsByIssue.unknown_record_type).toBeUndefined();
  });

  it('indexes the 15-character prefix of an 18-character id', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: RT_OPP_18.slice(0, 15), CreatedDate: '2026-01-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, refs, RUN);
    expect(summary.history.recordTypeValues.resolvedViaIdMap).toBe(1);
    expect(summary.countsByNormalizedCurrentStage.opp).toBe(1);
  });

  it('an unresolved Salesforce-ID-shaped value stays unknown and requires review', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: '012AAAA0000SYN9', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, refs, RUN);
    expect(summary.history.recordTypeValues.unresolvedIdShaped).toBe(1);
    expect(summary.history.recordTypeValues.affectedRows).toBe(1);
    expect(summary.review.countsByIssue.unknown_record_type).toBe(1);
    expect(summary.countsByNormalizedCurrentStage.unknown).toBe(1);
  });

  it('never exposes RecordType ids in the aggregate summary', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: RT_HPP_15, NewValue: RT_OPP_18, CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: '012AAAA0000SYN9', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
    ];
    const serialized = JSON.stringify(buildDryRunSummary([record], rows, refs, RUN));
    for (const id of [RT_HPP_15, RT_OPP_18, '012AAAA0000SYN9']) {
      expect(serialized).not.toContain(id);
    }
  });

  it('a blank baseline OldValue is not an unknown value in either unit', () => {
    const rows = [hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect' })];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.history.recordTypeValues.blankBaseline).toBe(1);
    expect(summary.history.recordTypeValues.unmappedNonblankLabel).toBe(0);
    expect(summary.history.recordTypeValues.unresolvedIdShaped).toBe(0);
    expect(summary.history.recordTypeValues.affectedRows).toBe(0);
  });

  it('reports occurrences and affected rows as separate units', () => {
    const rows = [
      // One row, BOTH sides unmapped labels: two occurrences, one row.
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Synthetic Legacy A', NewValue: 'Synthetic Legacy B', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.history.recordTypeValues.unmappedNonblankLabel).toBe(2);
    expect(summary.history.recordTypeValues.affectedRows).toBe(1);
  });
});

describe('stage label diagnostics (hardening)', () => {
  const record = opp({ Id: 'SYNTH-OPP-A' });

  it('collects distinct unknown nonblank labels with occurrences and where seen', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: 'Synthetic Legacy Stage', NewValue: '4) Discovery', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: '4) Discovery', NewValue: 'Synthetic Legacy Stage', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: null, NewValue: '1) Suspect', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.history.stageValues.blankBaseline).toBe(1);
    expect(summary.history.stageValues.unknownNonblank).toBe(2);
    expect(summary.history.stageValues.affectedRows).toBe(2);
    expect(summary.history.stageValues.unknownLabels).toEqual([
      { label: 'Synthetic Legacy Stage', occurrences: 2, seenAs: 'both' },
    ]);
  });

  it('a blank Stage OldValue is a baseline, not an unknown', () => {
    const rows = [hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: null, NewValue: '1) Suspect' })];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.history.stageValues.blankBaseline).toBe(1);
    expect(summary.history.stageValues.unknownNonblank).toBe(0);
    expect(summary.history.stageValues.unknownLabels).toEqual([]);
  });
});

describe('same-timestamp classification (hardening)', () => {
  const record = opp({ Id: 'SYNTH-OPP-A' });

  it('a chained same-timestamp pair is a candidate but provable, not materially ambiguous', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'High Potential Prospect', NewValue: 'Opportunity', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.movement.sameTimestamp.candidateGroups).toBe(1);
    expect(summary.movement.sameTimestamp.materiallyAmbiguous).toBe(0);
    expect(summary.movement.sameTimestamp.uniquelyProvableOrOrderIndependent).toBe(1);
    expect(summary.review.countsByIssue.ambiguous_same_timestamp).toBeUndefined();
  });

  it('cross-ledger co-timing is a harmless candidate, never material', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: '1) Suspect', NewValue: '3) Qualification', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.movement.sameTimestamp.candidateGroups).toBe(1);
    expect(summary.movement.sameTimestamp.harmlessCrossLedgerGroups).toBe(1);
    expect(summary.movement.sameTimestamp.uniquelyProvableOrOrderIndependent).toBe(0);
    expect(summary.movement.sameTimestamp.materiallyAmbiguous).toBe(0);
  });

  it('the categories are mutually exclusive and satisfy the equation', () => {
    const rows = [
      // Group 1: cross-ledger (one RT row + one stage row): harmless.
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'Opportunity', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: '1) Suspect', NewValue: '3) Qualification', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      // Group 2: chained RT pair: provable.
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'High Potential Prospect', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'High Potential Prospect', NewValue: 'Opportunity', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      // Group 3: conflicting RT pair (both leave Opportunity): material.
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'High Potential Prospect', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'Pursuit', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
    ];
    const s = buildDryRunSummary([record], rows, [], RUN).movement.sameTimestamp;
    expect(s.candidateGroups).toBe(3);
    expect(s.harmlessCrossLedgerGroups).toBe(1);
    expect(s.uniquelyProvableOrOrderIndependent).toBe(1);
    expect(s.materiallyAmbiguous).toBe(1);
    expect(s.candidateGroups).toBe(
      s.harmlessCrossLedgerGroups + s.uniquelyProvableOrOrderIndependent + s.materiallyAmbiguous,
    );
  });
});

describe('legacy stage aliases and normalization (final hardening)', () => {
  const record = opp({ Id: 'SYNTH-OPP-A' });

  it('normalizes zero-width characters and surrounding whitespace before exact matching', () => {
    expect(normalizeSourceValue('​ 4) Discovery ﻿')).toBe('4) Discovery');
    expect(normalizeSourceValue('‌‍')).toBeNull();
    expect(normalizeSourceValue(null)).toBeNull();
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: ' ​1) Suspect', NewValue: '﻿Closed-Won ', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.history.stageValues.unknownNonblank).toBe(0);
    expect(summary.history.stageValues.resolved).toBe(2);
  });

  it('maps every legacy terminal alias to its status', () => {
    for (const [label, status] of Object.entries(LEGACY_TERMINAL_STAGE_ALIASES)) {
      const result = adaptOpportunityHistory(
        [
          {
            historyId: `SYNTH-T-${label}`,
            opportunityId: 'SYNTH-OPP-A',
            field: 'StageName',
            oldValue: '1) Suspect',
            newValue: label,
            changedAt: '2026-02-01T09:00:00.000+0000',
          },
        ],
        DRY_RUN_STAGE_CONFIG,
      );
      expect(result.opportunities[0].terminalStatus).toBe(status);
      expect(result.review).toEqual([]);
    }
  });

  it('treats every legacy open alias as open, reopening a prior closure', () => {
    for (const label of LEGACY_OPEN_STAGE_ALIASES) {
      const result = adaptOpportunityHistory(
        [
          {
            historyId: 'SYNTH-O-1',
            opportunityId: 'SYNTH-OPP-A',
            field: 'StageName',
            oldValue: '1) Suspect',
            newValue: '100) Closed-Won',
            changedAt: '2026-02-01T09:00:00.000+0000',
          },
          {
            historyId: 'SYNTH-O-2',
            opportunityId: 'SYNTH-OPP-A',
            field: 'StageName',
            oldValue: '100) Closed-Won',
            newValue: label,
            changedAt: '2026-03-01T09:00:00.000+0000',
          },
        ],
        DRY_RUN_STAGE_CONFIG,
      );
      expect(result.opportunities[0].terminalStatus).toBe('open');
      expect(result.review).toEqual([]);
    }
  });

  it('preserves genuinely unknown Stage labels after alias mapping', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: 'Recycle / Nurture', NewValue: 'Totally Unknown Synthetic Stage', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.history.stageValues.unknownNonblank).toBe(1);
    expect(summary.history.stageValues.unknownLabels).toEqual([
      { label: 'Totally Unknown Synthetic Stage', occurrences: 1, seenAs: 'new' },
    ]);
  });
});

describe('record-type diagnostics and custom fields (final hardening)', () => {
  const record = opp({ Id: 'SYNTH-OPP-A' });

  it('names an id-resolved record type outside the funnel mapping, without the id', () => {
    const LEGACY_RT_ID = '012AAAA0000SYN7XYZ';
    const refs = [
      { Id: LEGACY_RT_ID, Name: 'Synthetic Legacy Type', DeveloperName: 'Synthetic_Legacy_Type', SobjectType: 'Opportunity' },
    ];
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: LEGACY_RT_ID, NewValue: 'High Potential Prospect', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, refs, RUN);
    expect(summary.history.recordTypeDiagnostics).toEqual([
      {
        name: 'Synthetic Legacy Type',
        developerName: 'Synthetic_Legacy_Type',
        occurrences: 1,
        seenAs: 'old',
        confirmedOpportunityType: true,
      },
    ]);
    // The id itself never appears anywhere in the summary.
    expect(JSON.stringify(summary)).not.toContain(LEGACY_RT_ID);
  });

  it('marks a non-Opportunity record type as unconfirmed for Opportunity', () => {
    const OTHER_RT_ID = '012AAAA0000SYN8XYZ';
    const refs = [
      { Id: OTHER_RT_ID, Name: 'Synthetic Case Type', DeveloperName: 'Synthetic_Case_Type', SobjectType: 'Case' },
    ];
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: OTHER_RT_ID, CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, refs, RUN);
    expect(summary.history.recordTypeDiagnostics[0].confirmedOpportunityType).toBe(false);
    expect(summary.history.recordTypeDiagnostics[0].seenAs).toBe('new');
  });

  it('records the confirmed custom-field API names exactly', () => {
    expect(CONFIRMED_CUSTOM_FIELDS['Commercial Region']).toBe('Commercial_Region__c');
    expect(CONFIRMED_CUSTOM_FIELDS['HPP Date']).toBe('HPP_Date__c');
    expect(CONFIRMED_CUSTOM_FIELDS['Opportunity Date']).toBe('Opportunity_Date__c');
    expect(CONFIRMED_CUSTOM_FIELDS['Pursuit Date']).toBe('Pursuit_Date__c');
    expect(CONFIRMED_CUSTOM_FIELDS['Sales Development Rep / BDR']).toBe('Sales_Development_Rep__c');
    expect(CONFIRMED_CUSTOM_FIELDS['SaaS Revenue']).toBe('SaaS_Revenue__c');
    expect(CONFIRMED_CUSTOM_FIELDS['SaaS Revenue USD']).toBe('SaaS_Revenue_USD__c');
    expect(CONFIRMED_CUSTOM_FIELDS.Currency).toBe('CurrencyIsoCode');
    expect(CONFIRMED_CUSTOM_FIELDS['GTM - Cube']).toBe('GTM_Cube__c');
    expect(CONFIRMED_CUSTOM_FIELDS['Customer Expansion']).toBe('Existing_Customer_or_New_Business__c');
    expect(CONFIRMED_CUSTOM_FIELDS['Line of Business (LOB)']).toBe('Business_Units__c');
    expect(CONFIRMED_CUSTOM_FIELDS['Primary Campaign Source']).toBe('CampaignId');
  });

  it('keeps Industry Vertical unresolved across all three candidates with overlap and disagreement', () => {
    expect(Object.keys(CONFIRMED_CUSTOM_FIELDS)).not.toContain('Industry Vertical');
    expect(INDUSTRY_VERTICAL_CANDIDATES).toEqual([
      'Insurance_vertical__c',
      'Industry_Vertical__c',
      'Pursuit_Industry_Vertical__c',
    ]);
    const records = [
      // Both directly-named fields populated and AGREEING.
      opp({ Id: 'SYNTH-OPP-V1', Industry_Vertical__c: 'Synthetic Vertical A', Pursuit_Industry_Vertical__c: 'Synthetic Vertical A' }),
      // Both populated and DISAGREEING.
      opp({ Id: 'SYNTH-OPP-V2', Industry_Vertical__c: 'Synthetic Vertical A', Pursuit_Industry_Vertical__c: 'Synthetic Vertical B' }),
      // Only the insurance candidate populated.
      opp({ Id: 'SYNTH-OPP-V3', Insurance_vertical__c: 'Synthetic Vertical C' }),
      opp({ Id: 'SYNTH-OPP-V4' }),
    ];
    const iv = buildDryRunSummary(records, [], [], RUN).industryVertical;
    expect(iv.perField.Industry_Vertical__c).toEqual({ nonblank: 2, distinctValues: 1 });
    expect(iv.perField.Pursuit_Industry_Vertical__c).toEqual({ nonblank: 2, distinctValues: 2 });
    expect(iv.perField.Insurance_vertical__c).toEqual({ nonblank: 1, distinctValues: 1 });
    const pair = iv.pairwise.find(
      (p) => p.fields[0] === 'Industry_Vertical__c' && p.fields[1] === 'Pursuit_Industry_Vertical__c',
    );
    expect(pair).toEqual({
      fields: ['Industry_Vertical__c', 'Pursuit_Industry_Vertical__c'],
      bothPopulated: 2,
      disagreements: 1,
    });
    // Three candidates yield three pairwise comparisons.
    expect(iv.pairwise).toHaveLength(3);
  });
});

describe('business-scope diagnostic (diagnostic groups only)', () => {
  const users = [
    { Id: 'SYNTH-USER-BDR1', Name: 'Synthetic Bdr One', IsActive: true },
    { Id: 'SYNTH-USER-BDR2', Name: 'Synthetic Bdr Two', IsActive: true },
    { Id: 'SYNTH-USER-SELLER', Name: 'Synthetic Seller', IsActive: true },
  ];
  const approved = ['Synthetic Bdr One', 'Synthetic Bdr Two'];

  function scoped(records: SalesforceOpportunityRecord[]) {
    return buildDryRunSummary(records, [], [], RUN, { approvedBdrNames: approved, users }).businessScope;
  }

  it('classifies every Customer Expansion category', () => {
    const scope = scoped([
      opp({ Existing_Customer_or_New_Business__c: 'New Project' }),
      opp({ Existing_Customer_or_New_Business__c: 'Upsell/Cross-sell' }),
      opp({ Existing_Customer_or_New_Business__c: 'Renewal' }),
      opp({ Existing_Customer_or_New_Business__c: 'Synthetic Mystery Segment' }),
      opp({ Existing_Customer_or_New_Business__c: null }),
    ]);
    expect(scope.customerExpansion).toEqual({
      new_logo: 1,
      existing_customer_or_expansion: 2,
      other: 1,
      missing: 1,
    });
    expect(scope.note).toContain('Diagnostic groups only');
  });

  it('classifies approved, other, and missing SDR plus creator categories', () => {
    const scope = scoped([
      opp({ Sales_Development_Rep__c: 'SYNTH-USER-BDR1', CreatedById: 'SYNTH-USER-BDR1' }),
      opp({ Sales_Development_Rep__c: 'SYNTH-USER-SELLER', CreatedById: 'SYNTH-USER-SELLER' }),
      opp({ Sales_Development_Rep__c: null, CreatedById: null }),
    ]);
    expect(scope.sdr).toEqual({ approved_bdr: 1, other_sdr: 1, missing: 1 });
    expect(scope.creator).toEqual({ approved_bdr: 1, other_creator: 1, missing: 1 });
    expect(scope.bdrConfigured).toBe(true);
    expect(scope.bdrResolutionErrors).toEqual([]);
  });

  it('classifies campaign presence and produces every requested cross-tab', () => {
    const scope = scoped([
      opp({
        Existing_Customer_or_New_Business__c: 'New Project',
        Sales_Development_Rep__c: 'SYNTH-USER-BDR1',
        CreatedById: 'SYNTH-USER-BDR1',
        CampaignId: 'SYNTH-CAMP-1',
        RecordType: { DeveloperName: 'High_Potential_Prospect', Name: 'High Potential Prospect' },
      }),
      opp({
        Existing_Customer_or_New_Business__c: 'New Project',
        Sales_Development_Rep__c: null,
        CreatedById: 'SYNTH-USER-SELLER',
        CampaignId: null,
        RecordType: { DeveloperName: 'Licensing', Name: 'Pursuit' },
      }),
      opp({
        Existing_Customer_or_New_Business__c: 'Upsell/Cross-sell',
        Sales_Development_Rep__c: 'SYNTH-USER-SELLER',
        CreatedById: null,
        CampaignId: null,
        RecordType: { DeveloperName: 'Leads', Name: 'Opportunity' },
      }),
    ]);
    expect(scope.campaign).toEqual({ primary_campaign_present: 1, primary_campaign_missing: 2 });
    expect(scope.crossTabs.newLogoBySdr).toEqual({ approved_bdr: 1, other_sdr: 0, missing: 1 });
    expect(scope.crossTabs.newLogoByCampaign).toEqual({ primary_campaign_present: 1, primary_campaign_missing: 1 });
    expect(scope.crossTabs.sdrByCreator.approved_bdr.approved_bdr).toBe(1);
    expect(scope.crossTabs.sdrByCreator.missing.other_creator).toBe(1);
    expect(scope.crossTabs.recordTypeByExpansion.hpp.new_logo).toBe(1);
    expect(scope.crossTabs.recordTypeByExpansion.opp.existing_customer_or_expansion).toBe(1);
    expect(scope.crossTabs.recordTypeBySdr.pursuit.missing).toBe(1);
    expect(scope.crossTabs.recordTypeBySdr.hpp.approved_bdr).toBe(1);
  });

  it('fails safely when a configured BDR name is ambiguous or unknown', () => {
    const dupUsers = [
      ...users,
      { Id: 'SYNTH-USER-BDR1B', Name: 'Synthetic Bdr One', IsActive: true },
    ];
    const ambiguous = resolveApprovedBdrUsers(['Synthetic Bdr One'], dupUsers);
    expect(ambiguous.errors).toHaveLength(1);
    expect(ambiguous.errors[0]).toContain('2 active users');
    expect(Object.keys(ambiguous.userIdByName)).toHaveLength(0);
    const unknown = resolveApprovedBdrUsers(['Synthetic Nobody'], users);
    expect(unknown.errors[0]).toContain('0 active users');
    // One valid and one missing name still errors (the run must not proceed
    // half-configured); two unique matches produce no errors.
    const mixed = resolveApprovedBdrUsers(['Synthetic Bdr One', 'Synthetic Nobody'], users);
    expect(mixed.errors).toHaveLength(1);
    expect(Object.keys(mixed.userIdByName)).toEqual(['Synthetic Bdr One']);
    const both = resolveApprovedBdrUsers(['Synthetic Bdr One', 'Synthetic Bdr Two'], users);
    expect(both.errors).toEqual([]);
    expect(Object.keys(both.userIdByName)).toHaveLength(2);
    // Inactive users never match.
    const inactive = resolveApprovedBdrUsers(['Synthetic Bdr One'], [
      { Id: 'SYNTH-USER-BDR1', Name: 'Synthetic Bdr One', IsActive: false },
    ]);
    expect(inactive.errors[0]).toContain('0 active users');
    // Placeholders are skipped, not errors.
    expect(resolveApprovedBdrUsers(['REPLACE_WITH_BDR_NAME_1'], users).errors).toEqual([]);
  });

  it('classifies the SDR lookup by USER ID, and a name string can never match', () => {
    // 18-character resolved id: the 15-character lookup form still matches.
    const longUsers = [{ Id: 'SYNTHUSERBDR100XYZ', Name: 'Synthetic Bdr Long', IsActive: true }];
    const scope18 = buildDryRunSummary(
      [
        opp({ Sales_Development_Rep__c: 'SYNTHUSERBDR100XYZ' }),
        opp({ Sales_Development_Rep__c: 'SYNTHUSERBDR100' }),
        // The BDR's NAME in the lookup field is not an id: other_sdr.
        opp({ Sales_Development_Rep__c: 'Synthetic Bdr Long' }),
        opp({ Sales_Development_Rep__c: null }),
      ],
      [],
      [],
      RUN,
      { approvedBdrNames: ['Synthetic Bdr Long'], users: longUsers },
    ).businessScope;
    expect(scope18.sdr).toEqual({ approved_bdr: 2, other_sdr: 1, missing: 1 });
  });

  it('emits no employee identifiers in the committed aggregate output', () => {
    const serialized = JSON.stringify(
      buildDryRunSummary(
        [opp({ Sales_Development_Rep__c: 'SYNTH-USER-BDR1', CreatedById: 'SYNTH-USER-BDR1', CreatedBy: { Name: 'Synthetic Bdr One' } })],
        [],
        [],
        RUN,
        { approvedBdrNames: approved, users },
      ),
    );
    for (const marker of ['Synthetic Bdr One', 'Synthetic Bdr Two', 'SYNTH-USER-BDR1', 'SYNTH-USER-SELLER', 'Synthetic Seller']) {
      expect(serialized).not.toContain(marker);
    }
  });
});

describe('batching', () => {
  it('batches ids without omission or duplication, deduplicating input', () => {
    const ids = ['SYNTH-1', 'SYNTH-2', 'SYNTH-1', ' SYNTH-3 ', '', 'SYNTH-4', 'SYNTH-5'];
    const batches = chunkOpportunityIds(ids, 2);
    expect(batches).toEqual([
      ['SYNTH-1', 'SYNTH-2'],
      ['SYNTH-3', 'SYNTH-4'],
      ['SYNTH-5'],
    ]);
    const flat = batches.flat();
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat).toHaveLength(5);
    expect(chunkOpportunityIds([], 200)).toEqual([]);
  });
});

describe('sanitized dry-run output', () => {
  const records = [
    opp({ Id: 'SYNTH-OPP-A' }),
    opp({ Id: 'SYNTH-OPP-B', RecordType: { DeveloperName: 'Leads', Name: 'Opportunity' } }),
  ];
  const rows = [
    hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect' }),
  ];

  it('emits aggregates only, with dry_run true and zero writes attempted', () => {
    const summary = buildDryRunSummary(records, rows, [], RUN);
    expect(summary.dry_run).toBe(true);
    expect(summary.writes_attempted).toBe(0);
    expect(summary.executedAt).toBe(RUN.executedAt);
    expect(summary.scope.discovered).toBe(2);
    expect(summary.review.opportunitiesRequiringReview).toBe(2);
    // Every imported record needs a reviewed channel: no default exists.
    expect(summary.review.countsByIssue.missing_channel).toBe(2);
  });

  it('no raw IDs, names, accounts, or owners appear anywhere in the summary', () => {
    const serialized = JSON.stringify(buildDryRunSummary(records, rows, [], RUN));
    for (const marker of ['SYNTH-OPP', 'SYNTH-HIST', 'SYNTH-ACC', 'SYNTH-USER', 'Synthetic Deal Name', 'Synthetic Account Co', 'Synthetic Owner']) {
      expect(serialized).not.toContain(marker);
    }
  });
});

describe('n8n workflow template safety (static)', () => {
  const doc = readFileSync(resolve(process.cwd(), 'docs/salesforce-opportunity-sync.md'), 'utf8');
  const match = /```json\n([\s\S]*?)\n```/.exec(doc);
  const template = JSON.parse(match![1]) as {
    name: string;
    active: boolean;
    pinData?: unknown;
    nodes: Array<{ name: string; type: string; parameters: Record<string, unknown>; credentials?: Record<string, { id: string; name: string }> }>;
  };

  it('is disabled, manual-trigger-only, and contains no write-capable nodes', () => {
    expect(template.active).toBe(false);
    expect(template.pinData).toBeUndefined();
    const allowed = new Set(['n8n-nodes-base.manualTrigger', 'n8n-nodes-base.salesforce', 'n8n-nodes-base.code']);
    for (const node of template.nodes) {
      expect(allowed.has(node.type)).toBe(true);
    }
    expect(template.nodes.filter((n) => n.type === 'n8n-nodes-base.manualTrigger')).toHaveLength(1);
    expect(template.nodes.some((n) => n.type.includes('scheduleTrigger'))).toBe(false);
    // Every Salesforce node is a read-only SOQL search.
    for (const node of template.nodes.filter((n) => n.type === 'n8n-nodes-base.salesforce')) {
      expect(node.parameters.resource).toBe('search');
      expect(String(node.parameters.query)).toMatch(/^=?SELECT /);
    }
    // No write-capable destination node TYPES of any kind.
    const types = template.nodes.map((n) => n.type.toLowerCase());
    for (const forbidden of ['supabase', 'postgres', 'googlesheets', 'httprequest', 'webhook', 'emailsend', 'mysql', 'redis']) {
      expect(types.some((t) => t.includes(forbidden))).toBe(false);
    }
    // And no DML anywhere in any query.
    const raw = JSON.stringify(template).toLowerCase();
    for (const dml of ['insert into', 'delete from', 'upsert']) {
      expect(raw).not.toContain(dml);
    }
  });

  it('embeds no credentials, pinned data, or static Salesforce IDs', () => {
    for (const node of template.nodes) {
      for (const cred of Object.values(node.credentials ?? {})) {
        expect(cred.id).toBe('REPLACE_WITH_CREDENTIAL_ID');
        expect(cred.name).toBe('REPLACE_WITH_SFDC_CREDENTIAL_NAME');
      }
    }
    const raw = JSON.stringify(template);
    // No 15/18-character Salesforce ID shapes with known prefixes.
    expect(/\b(006|00D|005|0Q0)[a-zA-Z0-9]{12,15}\b/.test(raw)).toBe(false);
    expect(raw).not.toMatch(/supabase\.co|Bearer |apikey|service_role/i);
  });

  it('carries only BDR placeholders and a read-only active-user resolution', () => {
    const config = template.nodes.find((n) => n.name.startsWith('CONFIG (PRIVATE)'));
    expect(config).toBeTruthy();
    const code = String(config!.parameters.jsCode);
    expect(code).toContain('REPLACE_WITH_BDR_NAME_1');
    expect(code).toContain('REPLACE_WITH_BDR_NAME_2');
    expect(code).toContain('NEVER export, commit, or share');
    const userQuery = template.nodes.find((n) => n.name.includes('Resolve approved BDR users'));
    expect(userQuery).toBeTruthy();
    expect(String(userQuery!.parameters.query)).toContain('FROM User WHERE IsActive = true');
    // The dedicated validator fails safely on ambiguous or unknown names.
    const validator = template.nodes.find((n) => n.name === 'VALIDATE: approved BDR resolution');
    expect(validator).toBeTruthy();
    expect(String(validator!.parameters.jsCode)).toContain('verify the exact Salesforce User display name');
    // The private creator diagnostic is clearly labeled and never feeds the guard.
    const privateNode = template.nodes.find((n) => n.name.startsWith('PRIVATE (n8n only)'));
    expect(privateNode).toBeTruthy();
    expect(privateNode!.name).toContain('DO NOT SHARE');
  });

  it('the mirror maps Service out of scope for history and current classification', () => {
    const aggregate = template.nodes.find((n) => n.name.startsWith('DRY RUN: Aggregate summary'))!;
    const js = String(aggregate.parameters.jsCode);
    expect(js).toContain("Service: 'out_of_scope'");
    expect(js).toContain("RT_MAP[dn] === 'out_of_scope' ? 'out_of_scope' : 'unknown'");
  });

  it('every node the Aggregate references is an executed ancestor (serial graph)', () => {
    // Build the reverse graph: node -> its direct predecessors.
    const predecessors = new Map<string, string[]>();
    const connections = (
      JSON.parse(match![1]) as { connections: Record<string, { main: Array<Array<{ node: string }>> }> }
    ).connections;
    for (const [from, out] of Object.entries(connections)) {
      for (const branch of out.main) {
        for (const target of branch) {
          const list = predecessors.get(target.node) ?? [];
          list.push(from);
          predecessors.set(target.node, list);
        }
      }
    }
    const ancestorsOf = (node: string): Set<string> => {
      const seen = new Set<string>();
      const stack = [...(predecessors.get(node) ?? [])];
      while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        stack.push(...(predecessors.get(cur) ?? []));
      }
      return seen;
    };
    const aggregate = template.nodes.find((n) => n.name.startsWith('DRY RUN: Aggregate summary'))!;
    const ancestors = ancestorsOf(aggregate.name);
    // Every cross-node reference in the Aggregate code must be an ancestor,
    // so no dependency relies on parallel execution timing.
    const referenced = [...String(aggregate.parameters.jsCode).matchAll(/\$\('([^']+)'\)/g)].map((x) => x[1]);
    expect(referenced.length).toBeGreaterThanOrEqual(5);
    for (const name of referenced) {
      expect(ancestors.has(name)).toBe(true);
    }
    // The specific required ancestry.
    for (const name of [
      'CONFIG (PRIVATE): approved BDR names',
      'READ ONLY: Resolve approved BDR users',
      'READ ONLY: Fetch Opportunity RecordTypes',
      'READ ONLY: Fetch included Opportunities',
      'READ ONLY: Fetch OpportunityFieldHistory',
    ]) {
      expect(ancestors.has(name)).toBe(true);
    }
  });

  it('global queries execute once; the per-batch history query does not', () => {
    const byName = (name: string) =>
      template.nodes.find((n) => n.name.includes(name)) as { executeOnce?: boolean } & (typeof template.nodes)[0];
    // 341 Describe items cannot cause repeated RecordType queries, and many
    // RecordType items cannot cause repeated Opportunity queries: both are
    // global queries pinned to exactly one execution per run.
    expect(byName('Fetch Opportunity RecordTypes').executeOnce).toBe(true);
    expect(byName('Fetch included Opportunities').executeOnce).toBe(true);
    // FieldHistory intentionally executes once per 200-id batch item.
    expect(byName('Fetch OpportunityFieldHistory').executeOnce).not.toBe(true);
    // Runtime guards FAIL on duplicate ids instead of silently deduplicating:
    // the batch node for Opportunities, the Aggregate for both globals.
    const batch = byName('Batch Opportunity IDs');
    expect(String(batch.parameters.jsCode)).toContain('QUERY AMPLIFICATION: duplicate Opportunity Id');
    const aggregate = byName('Aggregate summary');
    expect(String(aggregate.parameters.jsCode)).toContain("dupCheck(rts, 'RecordType')");
    expect(String(aggregate.parameters.jsCode)).toContain("dupCheck(opps, 'Opportunity')");
    // Batching itself remains complete and unique (200 per IN clause).
    expect(String(batch.parameters.jsCode)).toContain('i += 200');
  });

  it('no critical read node can silently terminate the workflow', () => {
    // Every Salesforce read node always outputs data, so a zero-item result
    // can never end the run as a false success before GUARD.
    const sfNodes = template.nodes.filter((n) => n.type === 'n8n-nodes-base.salesforce');
    expect(sfNodes).toHaveLength(5);
    for (const node of sfNodes) {
      expect((node as { alwaysOutputData?: boolean }).alwaysOutputData).toBe(true);
    }
    // The Aggregate filters the always-output sentinel before counting and
    // fails fast on empty or broken source data; only zero HISTORY rows may
    // legitimately continue.
    const aggregate = template.nodes.find((n) => n.name.startsWith('DRY RUN: Aggregate summary'))!;
    const js = String(aggregate.parameters.jsCode);
    expect(js).toContain('never counted as records');
    expect(js).toContain('required Opportunity fields absent');
    expect(js).toContain('included DeveloperName absent');
    expect(js).toContain('refusing to report an empty dry run as success');
    // The validator's approved ids are consumed, never re-derived and never
    // emitted in the shared output.
    expect(js).toContain("$('VALIDATE: approved BDR resolution')");
    expect(js).not.toContain('approvedUserIds:');
  });

  it('the validator sits between Resolve and Describe on the serial chain', () => {
    const connections = (
      JSON.parse(match![1]) as { connections: Record<string, { main: Array<Array<{ node: string }>> }> }
    ).connections;
    expect(connections['READ ONLY: Resolve approved BDR users'].main[0]).toEqual([
      { node: 'VALIDATE: approved BDR resolution', type: 'main', index: 0 },
    ]);
    expect(connections['VALIDATE: approved BDR resolution'].main[0]).toEqual([
      { node: 'READ ONLY: Describe Opportunity fields', type: 'main', index: 0 },
    ]);
  });

  it('every successful shared workflow path terminates at GUARD', () => {
    const connections = (
      JSON.parse(match![1]) as { connections: Record<string, { main: Array<Array<{ node: string }>> }> }
    ).connections;
    const PRIVATE = 'PRIVATE (n8n only): creators by name - DO NOT SHARE';
    // Walk the shared path from the trigger; every shared node must have a
    // successor until GUARD, which must be terminal.
    let current = 'Manual Trigger - DRY RUN ONLY';
    const visited = new Set<string>();
    while (current !== 'GUARD: fail unless dry run with zero writes') {
      expect(visited.has(current)).toBe(false);
      visited.add(current);
      const successors = (connections[current]?.main[0] ?? [])
        .map((t) => t.node)
        .filter((n) => n !== PRIVATE);
      // Exactly one shared successor: a serial chain with no dead ends.
      expect(successors).toHaveLength(1);
      current = successors[0];
    }
    expect(connections['GUARD: fail unless dry run with zero writes']).toBeUndefined();
  });

  it('ends in a guard that fails unless the run proves dry_run with zero writes', () => {
    const guard = template.nodes.find((n) => n.name.startsWith('GUARD'));
    expect(guard).toBeTruthy();
    const code = String(guard!.parameters.jsCode);
    expect(code).toContain("dry_run !== true");
    expect(code).toContain('writes_attempted !== 0');
    expect(code).toContain('throw new Error');
  });
});

describe('paired record-type representations (one transition, one movement)', () => {
  const RT_HPP = '012AAAA0000SYN1';
  const RT_OPP = '012AAAA0000SYN2';
  const refs = [
    { Id: RT_HPP, Name: 'High Potential Prospect', DeveloperName: 'High_Potential_Prospect', SobjectType: 'Opportunity' },
    { Id: RT_OPP, Name: 'Opportunity', DeveloperName: 'Leads', SobjectType: 'Opportunity' },
  ];
  const record = opp({ Id: 'SYNTH-OPP-A' });

  it('collapses the label row and the id row of one transition into one movement', () => {
    const rows = [
      // Salesforce writes BOTH rows for one change: labels and ids, distinct
      // History IDs, identical timestamp.
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'High Potential Prospect', NewValue: 'Opportunity', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: RT_HPP, NewValue: RT_OPP, CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, refs, RUN);
    // One movement, not two; the pair is not a same-timestamp candidate.
    expect(summary.movement.forwardMoves).toBe(1);
    expect(summary.history.pairedRecordTypeRepresentationRows).toBe(1);
    expect(summary.history.recordTypeMovementRows).toBe(1);
    expect(summary.history.recordTypeRows).toBe(2);
    expect(summary.movement.sameTimestamp.candidateGroups).toBe(0);
    expect(summary.movement.sameTimestamp.materiallyAmbiguous).toBe(0);
  });

  it('counts each unpaired history row exactly once', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'High Potential Prospect', NewValue: 'Opportunity', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'Pursuit', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, refs, RUN);
    expect(summary.movement.forwardMoves).toBe(2);
    expect(summary.history.pairedRecordTypeRepresentationRows).toBe(0);
    expect(summary.history.recordTypeMovementRows).toBe(3);
  });

  it('two genuinely different transitions at one instant remain distinct', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'Opportunity', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'High Potential Prospect', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'Pursuit', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, [], RUN);
    expect(summary.history.pairedRecordTypeRepresentationRows).toBe(0);
    expect(summary.movement.sameTimestamp.materiallyAmbiguous).toBe(1);
  });
});

describe('customer expansion value diagnostics', () => {
  it('lists each distinct nonblank normalized value with its count, labels only', () => {
    const scope = buildDryRunSummary(
      [
        opp({ Existing_Customer_or_New_Business__c: 'Synthetic Segment A' }),
        opp({ Existing_Customer_or_New_Business__c: ' Synthetic Segment A ' }),
        opp({ Existing_Customer_or_New_Business__c: 'Synthetic Segment B' }),
        opp({ Existing_Customer_or_New_Business__c: null }),
      ],
      [],
      [],
      RUN,
    ).businessScope;
    expect(scope.customerExpansionValues).toEqual([
      { value: 'Synthetic Segment A', occurrences: 2 },
      { value: 'Synthetic Segment B', occurrences: 1 },
    ]);
    // The groups and the no-decision statement are unchanged.
    expect(scope.customerExpansion.other).toBe(3);
    expect(scope.customerExpansion.missing).toBe(1);
    expect(scope.note).toContain('No inclusion or exclusion decision');
  });
});

describe('query amplification guards (pure layer)', () => {
  it('duplicate Opportunity Ids fail instead of being silently deduplicated', () => {
    const dup = opp({ Id: 'SYNTH-OPP-DUP' });
    expect(() => buildDryRunSummary([dup, { ...dup }], [], [], RUN)).toThrow(/amplification.*Opportunity/);
  });

  it('duplicate RecordType Ids fail instead of being silently deduplicated', () => {
    const refs = [
      { Id: '012AAAA0000SYN1', Name: 'A', DeveloperName: 'High_Potential_Prospect', SobjectType: 'Opportunity' },
      { Id: '012AAAA0000SYN1', Name: 'A', DeveloperName: 'High_Potential_Prospect', SobjectType: 'Opportunity' },
    ];
    expect(() => buildDryRunSummary([opp()], [], refs, RUN)).toThrow(/amplification.*RecordType/);
  });

  it('unique inputs continue to a full summary', () => {
    const summary = buildDryRunSummary([opp(), opp()], [], [], RUN);
    expect(summary.dry_run).toBe(true);
    expect(summary.scope.discovered).toBe(2);
  });
});

describe('template end-to-end execution (stubbed n8n)', () => {
  const doc2 = readFileSync(resolve(process.cwd(), 'docs/salesforce-opportunity-sync.md'), 'utf8');
  const tpl = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(doc2)![1]) as {
    nodes: Array<{ name: string; parameters: Record<string, unknown> }>;
  };
  const nodeCode = (name: string): string =>
    String(tpl.nodes.find((n) => n.name.startsWith(name))!.parameters.jsCode);

  // Execute a Code node's body with stubbed n8n globals and a frozen Date so
  // the test stays deterministic.
  class FrozenDate {
    toISOString(): string {
      return '2026-07-27T00:00:00.000Z';
    }
  }
  function runNode(js: string, nodes: Record<string, unknown[]>, input: unknown[] = []): Array<{ json: Record<string, unknown> }> {
    const dollar = (name: string) => ({
      all: () => (nodes[name] ?? []).map((json) => ({ json })),
      first: () => ({ json: (nodes[name] ?? [{}])[0] }),
    });
    const inputStub = { all: () => input.map((json) => ({ json })), first: () => ({ json: input[0] }) };
    const fn = new Function('$', '$input', 'Date', js) as (
      d: typeof dollar,
      i: typeof inputStub,
      dateCls: typeof FrozenDate,
    ) => Array<{ json: Record<string, unknown> }>;
    return fn(dollar, inputStub, FrozenDate);
  }

  it('two resolved users flow from validator to Aggregate classification without leaking', () => {
    const users = [
      { Id: 'SYNTHUSERBDR100XYZ', Name: 'Synthetic Bdr One', IsActive: true },
      { Id: 'SYNTHUSERBDR200XYZ', Name: 'Synthetic Bdr Two', IsActive: true },
    ];
    const config = [{ approvedBdrNames: ['Synthetic Bdr One', 'Synthetic Bdr Two'] }];
    const validatorOut = runNode(nodeCode('VALIDATE: approved BDR resolution'), {
      'CONFIG (PRIVATE): approved BDR names': config,
    }, users);
    expect(validatorOut[0].json.bdrConfigured).toBe(true);
    expect(validatorOut[0].json.approvedUserIds).toContain('SYNTHUSERBDR100XYZ');
    expect(validatorOut[0].json.approvedUserIds).toContain('SYNTHUSERBDR100XYZ'.slice(0, 15));

    const opps = [
      { Id: 'SYNTH-OPP-1', RecordType: { DeveloperName: 'High_Potential_Prospect' }, IsClosed: false, CreatedDate: '2026-02-01T09:00:00.000+0000', SystemModstamp: '2026-06-01T09:00:00.000+0000', Sales_Development_Rep__c: 'SYNTHUSERBDR100XYZ', CreatedById: 'SYNTHUSERBDR200XYZ', Existing_Customer_or_New_Business__c: 'Synthetic Segment A' },
      { Id: 'SYNTH-OPP-2', RecordType: { DeveloperName: 'Leads' }, IsClosed: false, CreatedDate: '2026-02-01T09:00:00.000+0000', SystemModstamp: '2026-06-01T09:00:00.000+0000', Sales_Development_Rep__c: 'SYNTHUSEROTHERXYZ0', CreatedById: null },
    ];
    const describeRows = ['StageName', 'IsClosed', 'IsWon', 'CreatedDate', 'SystemModstamp', 'CloseDate', 'CampaignId', 'Sales_Development_Rep__c', 'Existing_Customer_or_New_Business__c', 'Commercial_Region__c'].map((f) => ({ QualifiedApiName: f }));
    const rts = [
      { Id: '012AAAA0000SYN1', Name: 'High Potential Prospect', DeveloperName: 'High_Potential_Prospect', SobjectType: 'Opportunity' },
      { Id: '012AAAA0000SYN2', Name: 'Opportunity', DeveloperName: 'Leads', SobjectType: 'Opportunity' },
      { Id: '012AAAA0000SYN3', Name: 'Pursuit', DeveloperName: 'Licensing', SobjectType: 'Opportunity' },
    ];
    const aggregateOut = runNode(nodeCode('DRY RUN: Aggregate summary'), {
      'VALIDATE: approved BDR resolution': validatorOut.map((x) => x.json),
      'READ ONLY: Describe Opportunity fields': describeRows,
      'READ ONLY: Fetch Opportunity RecordTypes': rts,
      'READ ONLY: Fetch included Opportunities': opps,
      'READ ONLY: Fetch OpportunityFieldHistory': [],
    });
    const summary = aggregateOut[0].json as {
      dry_run: boolean;
      writes_attempted: number;
      businessScope: { bdrConfigured: boolean; sdr: Record<string, number>; creator: Record<string, number> };
    };
    expect(summary.dry_run).toBe(true);
    expect(summary.writes_attempted).toBe(0);
    // The validated ids reached classification: bdrConfigured true, the
    // approved lookup id classified, the other id separated.
    expect(summary.businessScope.bdrConfigured).toBe(true);
    expect(summary.businessScope.sdr).toEqual({ approved_bdr: 1, other_sdr: 1, missing: 0 });
    expect(summary.businessScope.creator.approved_bdr).toBe(1);
    // No identifier leaks into the shared output.
    const serialized = JSON.stringify(summary);
    for (const marker of ['Synthetic Bdr One', 'Synthetic Bdr Two', 'SYNTHUSERBDR100XYZ', 'SYNTHUSERBDR200XYZ', 'SYNTH-OPP-1']) {
      expect(serialized).not.toContain(marker);
    }
  });

  it('the validator throws when placeholders remain instead of passing silently', () => {
    expect(() =>
      runNode(nodeCode('VALIDATE: approved BDR resolution'), {
        'CONFIG (PRIVATE): approved BDR names': [{ approvedBdrNames: ['REPLACE_WITH_BDR_NAME_1', 'REPLACE_WITH_BDR_NAME_2'] }],
      }, []),
    ).toThrow(/expected 2 configured BDR names, found 0/);
  });
});

describe('fixture hygiene', () => {
  it('no fixture resembles a real Salesforce ID', () => {
    const sample = [opp(), hist({})];
    for (const rec of sample) {
      const id = String((rec as { Id: string }).Id);
      expect(id.startsWith('SYNTH-')).toBe(true);
      expect(/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(id)).toBe(false);
    }
  });
});
