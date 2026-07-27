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
      const summary = buildDryRunSummary([record], [], RUN);
      expect(summary.countsByNormalizedCurrentStage[stage]).toBe(1);
    }
  });

  it('an excluded record type never lands in a visible stage', () => {
    const summary = buildDryRunSummary(
      [opp({ RecordType: { DeveloperName: 'Nurture', Name: 'Nurture' } })],
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
      RUN,
    );
    expect(summary.countsByNormalizedCurrentStage.unknown).toBe(1);
    expect(summary.history.unknownRecordTypeValues).toBeGreaterThan(0);
    expect(summary.review.countsByIssue.unknown_record_type).toBe(1);
  });

  it('historical label aliases in history rows classify identically', () => {
    const record = opp({ Id: 'SYNTH-OPP-A', RecordType: { DeveloperName: 'Licensing', Name: 'Pursuit' } });
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'Sales Accepted Opportunity', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Sales Accepted Opportunity', NewValue: 'Sales Qualified Opportunity', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, RUN);
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
    expect(scope.closedInYear).toBe(1);
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
    const summary = buildDryRunSummary([record], rows, RUN);
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
    const summary = buildDryRunSummary([record], rows, RUN);
    expect(summary.history.stageRows).toBe(2);
    expect(summary.countsByNormalizedCurrentStage.hpp).toBe(1);
    expect(summary.history.unknownStageValues).toBe(0);
  });

  it('exact duplicates are informational; conflicting duplicate IDs are counted', () => {
    const base = hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect' });
    const exact = buildDryRunSummary([record], [base, { ...base }], RUN);
    expect(exact.history.exactDuplicates).toBe(1);
    expect(exact.history.conflictingDuplicateHistoryIds).toBe(0);
    const conflict = buildDryRunSummary([record], [base, { ...base, NewValue: 'Pursuit' }], RUN);
    expect(conflict.history.conflictingDuplicateHistoryIds).toBe(1);
    expect(conflict.review.countsByIssue.conflicting_history_id).toBe(1);
  });

  it('unknown Stage values and invalid timestamps are counted for review', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', Field: 'StageName', OldValue: '3) Qualification', NewValue: '99) Synthetic Mystery', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', CreatedDate: '2026-02-30T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, RUN);
    expect(summary.history.unknownStageValues).toBe(1);
    expect(summary.history.invalidTimestamps).toBe(1);
  });

  it('same-timestamp ambiguities surface in the summary', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'Opportunity', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'High Potential Prospect', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Opportunity', NewValue: 'Pursuit', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
    ];
    const summary = buildDryRunSummary([record], rows, RUN);
    expect(summary.movement.sameTimestampAmbiguities).toBe(1);
    expect(summary.review.countsByIssue.ambiguous_same_timestamp).toBe(1);
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
    const summary = buildDryRunSummary(records, rows, RUN);
    expect(summary.dry_run).toBe(true);
    expect(summary.writes_attempted).toBe(0);
    expect(summary.executedAt).toBe(RUN.executedAt);
    expect(summary.scope.discovered).toBe(2);
    expect(summary.review.opportunitiesRequiringReview).toBe(2);
    // Every imported record needs a reviewed channel: no default exists.
    expect(summary.review.countsByIssue.missing_channel).toBe(2);
  });

  it('no raw IDs, names, accounts, or owners appear anywhere in the summary', () => {
    const serialized = JSON.stringify(buildDryRunSummary(records, rows, RUN));
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

  it('ends in a guard that fails unless the run proves dry_run with zero writes', () => {
    const guard = template.nodes.find((n) => n.name.startsWith('GUARD'));
    expect(guard).toBeTruthy();
    const code = String(guard!.parameters.jsCode);
    expect(code).toContain("dry_run !== true");
    expect(code).toContain('writes_attempted !== 0');
    expect(code).toContain('throw new Error');
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
