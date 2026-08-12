// Tests for the Bite 5C2A staging-ingestion planner. Synthetic records only;
// no real Salesforce identifiers, names, or customer data. Also carries the
// static safety assertions for the applied apply-function migrations and the
// staging workflow template.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  planStagingIngestion,
  classifyCandidateEligibility,
  buildSnapshotPayload,
  snapshotFingerprint,
  serializeApplyPayload,
  suggestedBdrName,
  summarizeDryRunPlan,
  PROTECTED_STAGING_TABLES,
} from './opportunityIngestionPlanner';
import type { ExistingStagingState, IngestionConfig } from './opportunityIngestionPlanner';
import type {
  SalesforceOpportunityRecord,
  SalesforceOpportunityHistoryRecord,
} from './salesforceOpportunitySync';

const CONFIG: IngestionConfig = {
  reportingYears: [2025, 2026],
  includedBusinessTypeApiValues: ['New Project'],
  runStartedAt: '2026-07-27T12:00:00Z',
};

const EMPTY: ExistingStagingState = {
  snapshots: {},
  eventContentByHistoryId: {},
  reviews: {},
  links: {},
};

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
    Existing_Customer_or_New_Business__c: 'New Project',
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

function plan(
  records: SalesforceOpportunityRecord[],
  history: SalesforceOpportunityHistoryRecord[] = [],
  existing: ExistingStagingState = EMPTY,
) {
  return planStagingIngestion(records, history, [], existing, CONFIG);
}

describe('candidate eligibility', () => {
  it('open HPP, Opportunity, and Pursuit records enter the pending candidate plan', () => {
    for (const dev of ['High_Potential_Prospect', 'Leads', 'Licensing']) {
      const p = plan([opp({ RecordType: { DeveloperName: dev, Name: dev }, IsClosed: false })]);
      expect(p.diagnostics.eligibility.eligible_new_candidate).toBe(1);
      expect(p.diagnostics.reviewsCreated).toBe(1);
    }
  });

  it('a closed record created in the configured cohort year enters', () => {
    const p = plan([opp({ IsClosed: true, CreatedDate: '2026-03-01T09:00:00.000+0000' })]);
    expect(p.diagnostics.eligibility.eligible_new_candidate).toBe(1);
  });

  it('a record outside the configured years is excluded and NOT staged: no snapshot, event, or review', () => {
    const p = plan(
      [opp({ Id: 'SYNTH-OPP-OLD', IsClosed: true, CreatedDate: '2024-03-01T09:00:00.000+0000' })],
      [hist({ OpportunityId: 'SYNTH-OPP-OLD' })],
    );
    expect(p.diagnostics.eligibility.excluded_outside_reporting_years).toBe(1);
    expect(p.diagnostics.reviewsCreated).toBe(0);
    expect(p.diagnostics.snapshotsPlanned).toBe(0);
    expect(p.diagnostics.eventsPlanned).toBe(0);
    expect(p.diagnostics.excludedNotStaged).toBe(1);
    // Only aggregate diagnostics remain; no identifier survives anywhere.
    expect(JSON.stringify(p.operations)).not.toContain('SYNTH-OPP-OLD');
  });

  it('the reporting years are configuration, not hardcoded', () => {
    const rec = opp({ IsClosed: true, CreatedDate: '2027-03-01T09:00:00.000+0000' });
    const p2027 = planStagingIngestion([rec], [], [], EMPTY, { ...CONFIG, reportingYears: [2027] });
    expect(p2027.diagnostics.eligibility.eligible_new_candidate).toBe(1);
    expect(classifyCandidateEligibility(rec, EMPTY, CONFIG)).toBe('excluded_outside_reporting_years');
  });

  it('requires the confirmed New Logo API value and excludes blank or other business types', () => {
    const eligible = plan([opp({ Existing_Customer_or_New_Business__c: 'New Project' })]);
    const blank = plan([opp({ Existing_Customer_or_New_Business__c: null })]);
    const expansion = plan([opp({ Existing_Customer_or_New_Business__c: 'Upsell/Cross-sell' })]);
    expect(eligible.diagnostics.eligibility.eligible_new_candidate).toBe(1);
    expect(blank.diagnostics.eligibility.excluded_missing_business_type).toBe(1);
    expect(expansion.diagnostics.eligibility.excluded_non_new_logo).toBe(1);
    expect(blank.diagnostics.snapshotsPlanned).toBe(0);
    expect(expansion.diagnostics.reviewsCreated).toBe(0);
  });

  it('an unlinked current Service opportunity is excluded and NOT staged at all', () => {
    const p = plan(
      [opp({ Id: 'SYNTH-OPP-SVC', RecordType: { DeveloperName: 'Service', Name: 'Service' }, IsClosed: false })],
      [hist({ OpportunityId: 'SYNTH-OPP-SVC', OldValue: null, NewValue: 'Service' })],
    );
    expect(p.diagnostics.eligibility.excluded_out_of_scope).toBe(1);
    expect(p.diagnostics.reviewsCreated).toBe(0);
    expect(p.diagnostics.snapshotsPlanned).toBe(0);
    expect(p.diagnostics.eventsPlanned).toBe(0);
    expect(p.diagnostics.excludedNotStaged).toBe(1);
  });

  it('an out-of-scope record WITH an existing review keeps its protected history without queueing', () => {
    const existing: ExistingStagingState = {
      ...EMPTY,
      snapshots: { 'SYNTH-OPP-SVC2': { contentHash: 'stale', recordTypeDeveloperName: 'Licensing', sfLastModifiedAt: '2026-05-01T09:00:00.000+0000' } },
      reviews: { 'SYNTH-OPP-SVC2': { reviewState: 'pending', issueCodes: ['missing_channel'], channelId: null } },
    };
    const p = plan(
      [opp({ Id: 'SYNTH-OPP-SVC2', RecordType: { DeveloperName: 'Service', Name: 'Service' } })],
      [],
      existing,
    );
    // Staged (snapshot syncs, history preserved) but never a queue candidate.
    expect(p.diagnostics.snapshotsPlanned).toBe(1);
    expect(p.diagnostics.reviewsCreated).toBe(0);
    expect(p.diagnostics.eligibility.excluded_out_of_scope).toBe(1);
  });

  it('an unknown record type is excluded from the queue, never an approvable candidate', () => {
    const p = plan([opp({ RecordType: { DeveloperName: 'Synthetic_Mystery', Name: 'Mystery' } })]);
    expect(p.diagnostics.eligibility.excluded_unknown_record_type).toBe(1);
    expect(p.diagnostics.reviewsCreated).toBe(0);
    expect(p.diagnostics.snapshotsPlanned).toBe(0);
  });

  it('a historical Service visit is preserved for a currently eligible record', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'High Potential Prospect', NewValue: 'Service', CreatedDate: '2026-02-01T09:00:00.000+0000' }),
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: 'Service', NewValue: 'High Potential Prospect', CreatedDate: '2026-03-01T09:00:00.000+0000' }),
    ];
    const p = plan([opp({ Id: 'SYNTH-OPP-A' })], rows);
    // All three movements stage into the append-only ledger.
    expect(p.diagnostics.eventsPlanned).toBe(3);
    expect(p.diagnostics.reviewsCreated).toBe(1);
  });

  it('evidence fields never include, exclude, attribute, or invent values', () => {
    const p = plan([
      opp({
        CampaignId: null,
        Sales_Development_Rep__c: null,
        Existing_Customer_or_New_Business__c: 'New Project',
        CreatedById: 'SYNTH-USER-BDR1',
      }),
    ]);
    expect(p.diagnostics.reviewsCreated).toBe(1);
    const create = p.operations.find((o) => o.op === 'create_review');
    expect(create && create.op === 'create_review' && create.seed.issue_codes).toContain('missing_channel');
    expect(create && create.op === 'create_review' && create.seed.channel_id).toBeNull();
    expect(create && create.op === 'create_review' && create.seed.lead_id).toBeNull();
  });
});

describe('linked opportunities', () => {
  const linkedState = (priorDev: string | null = 'Licensing'): ExistingStagingState => ({
    ...EMPTY,
    snapshots: { 'SYNTH-OPP-L': { contentHash: 'stale', recordTypeDeveloperName: priorDev, sfLastModifiedAt: '2026-05-01T09:00:00.000+0000' } },
    links: { 'SYNTH-OPP-L': { dealId: 'deal-1', linkState: 'active' } },
    reviews: { 'SYNTH-OPP-L': { reviewState: 'linked', issueCodes: [], channelId: 'syn-channel-1' } },
  });

  it('an existing active exact link syncs without another review', () => {
    const p = plan([opp({ Id: 'SYNTH-OPP-L' })], [], linkedState('Licensing'));
    expect(p.diagnostics.eligibility.linked_active).toBe(1);
    expect(p.diagnostics.reviewsCreated).toBe(0);
    expect(p.operations.some((o) => o.op === 'create_review' || o.op === 'update_review_issues')).toBe(false);
    expect(p.diagnostics.snapshotsPlanned).toBe(1);
  });

  it('a linked deal moving to Service keeps its link and stages out of the active funnel', () => {
    const p = plan(
      [opp({ Id: 'SYNTH-OPP-L', RecordType: { DeveloperName: 'Service', Name: 'Service' } })],
      [],
      linkedState('Licensing'),
    );
    expect(p.diagnostics.linked.nowUnavailableService).toBe(1);
    // No link operation exists in the plan's type space at all: the link is
    // untouched and never deleted.
    expect(p.operations.every((o) => String(o.table) !== 'sf_opportunity_deal_links')).toBe(true);
    expect(p.diagnostics.reviewsCreated).toBe(0);
  });

  it('a linked Service deal returning to the funnel restores without a new review', () => {
    const p = plan(
      [opp({ Id: 'SYNTH-OPP-L', RecordType: { DeveloperName: 'Licensing', Name: 'Pursuit' } })],
      [],
      linkedState('Service'),
    );
    expect(p.diagnostics.linked.restoredToFunnel).toBe(1);
    expect(p.diagnostics.reviewsCreated).toBe(0);
    expect(p.diagnostics.eligibility.linked_active).toBe(1);
  });

  it('a retired link is never silently reactivated or re-queued', () => {
    const retired: ExistingStagingState = {
      ...EMPTY,
      links: { 'SYNTH-OPP-R': { dealId: 'deal-2', linkState: 'retired' } },
    };
    const p = plan([opp({ Id: 'SYNTH-OPP-R' })], [], retired);
    expect(p.diagnostics.eligibility.linked_retired).toBe(1);
    expect(p.diagnostics.linked.retiredNoAction).toBe(1);
    expect(p.diagnostics.reviewsCreated).toBe(0);
    expect(p.operations.every((o) => String(o.table) !== 'sf_opportunity_deal_links')).toBe(true);
  });
});

describe('idempotency and duplicates', () => {
  it('rerunning identical input against the resulting state plans no duplicate work', () => {
    const records = [opp({ Id: 'SYNTH-OPP-A' })];
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', OldValue: null, NewValue: 'High Potential Prospect', CreatedDate: '2026-01-01T09:00:00.000+0000' }),
    ];
    const first = plan(records, rows);
    expect(first.diagnostics.snapshotsPlanned).toBe(1);
    expect(first.diagnostics.eventsPlanned).toBe(1);
    expect(first.diagnostics.reviewsCreated).toBe(1);

    // Simulate the state after a successful apply of the first plan.
    const firstCreate = first.operations.find((o) => o.op === 'create_review');
    const afterApply: ExistingStagingState = {
      snapshots: {
        'SYNTH-OPP-A': {
          contentHash: buildSnapshotPayload(records[0]).content_hash,
          recordTypeDeveloperName: 'High_Potential_Prospect',
          sfLastModifiedAt: '2026-06-01T09:00:00.000+0000',
        },
      },
      eventContentByHistoryId: {
        [rows[0].Id]: {
          sfOpportunityId: 'SYNTH-OPP-A',
          sourceField: 'RecordType',
          oldValue: null,
          newValue: 'High Potential Prospect',
          changedAt: rows[0].CreatedDate,
        },
      },
      reviews: {
        'SYNTH-OPP-A': {
          reviewState: 'pending',
          issueCodes: firstCreate && firstCreate.op === 'create_review' ? firstCreate.seed.issue_codes : [],
          channelId: null,
          leadId: null,
        },
      },
      links: {},
    };
    const second = plan(records, rows, afterApply);
    expect(second.diagnostics.snapshotsPlanned).toBe(0);
    expect(second.diagnostics.snapshotNoops).toBe(1);
    expect(second.diagnostics.eventsPlanned).toBe(0);
    expect(second.diagnostics.exactDuplicateEvents).toBe(1);
    expect(second.diagnostics.reviewsCreated).toBe(0);
    expect(second.diagnostics.reviewIssueUpdates).toBe(0);
  });

  it('an exact duplicate History Id is an informational no-op', () => {
    const rows = [hist({ OpportunityId: 'SYNTH-OPP-A', Id: 'SYNTH-HIST-X' })];
    const existing: ExistingStagingState = {
      ...EMPTY,
      eventContentByHistoryId: {
        'SYNTH-HIST-X': {
          sfOpportunityId: 'SYNTH-OPP-A',
          sourceField: 'RecordType',
          oldValue: null,
          newValue: 'High Potential Prospect',
          changedAt: rows[0].CreatedDate,
        },
      },
    };
    const p = plan([opp({ Id: 'SYNTH-OPP-A' })], rows, existing);
    expect(p.diagnostics.exactDuplicateEvents).toBe(1);
    expect(p.diagnostics.eventsPlanned).toBe(0);
  });

  it('a conflicting duplicate History Id blocks and routes to review, choosing no version', () => {
    const rows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', Id: 'SYNTH-HIST-X', NewValue: 'Opportunity', OldValue: 'High Potential Prospect' }),
    ];
    const existing: ExistingStagingState = {
      ...EMPTY,
      eventContentByHistoryId: {
        'SYNTH-HIST-X': {
          sfOpportunityId: 'SYNTH-OPP-A',
          sourceField: 'RecordType',
          oldValue: null,
          newValue: 'High Potential Prospect',
          changedAt: rows[0].CreatedDate,
        },
      },
    };
    const p = plan([opp({ Id: 'SYNTH-OPP-A' })], rows, existing);
    expect(p.diagnostics.conflictingEvents).toBe(1);
    expect(p.diagnostics.eventsPlanned).toBe(0);
    const create = p.operations.find((o) => o.op === 'create_review');
    expect(create && create.op === 'create_review' && create.seed.issue_codes).toContain('conflicting_history_id');
  });

  it('an existing pending review only receives an issues update when codes change, with a coupled audit event', () => {
    const records = [opp({ Id: 'SYNTH-OPP-A', Commercial_Region__c: 'NA' })];
    const existing: ExistingStagingState = {
      ...EMPTY,
      reviews: {
        'SYNTH-OPP-A': {
          reviewState: 'pending',
          issueCodes: ['missing_channel', 'missing_region', 'incomplete_history'],
          channelId: null,
        },
      },
    };
    const p = plan(records, [], existing);
    expect(p.diagnostics.reviewIssueUpdates).toBe(1);
    const update = p.operations.find((o) => o.op === 'update_review_issues');
    expect(update && update.op === 'update_review_issues' && update.auditEvents[0].event_type).toBe('issues_updated');
    expect(update && update.op === 'update_review_issues' && update.auditEvents[0].dedupe_key).toContain('issues:SYNTH-OPP-A');
    // Region evidence arrived, so missing_region is gone from the new codes.
    expect(update && update.op === 'update_review_issues' && update.projection.issueCodes).not.toContain('missing_region');
  });

  it('ignored and resolved reviews obey the state machine: no automatic reopen', () => {
    for (const state of ['ignored', 'resolved', 'blocked', 'approved', 'linked'] as const) {
      const existing: ExistingStagingState = {
        ...EMPTY,
        reviews: { 'SYNTH-OPP-A': { reviewState: state, issueCodes: [], channelId: null } },
      };
      const p = plan([opp({ Id: 'SYNTH-OPP-A' })], [], existing);
      expect(p.diagnostics.eligibility.blocked_by_review_state).toBe(1);
      expect(p.diagnostics.reviewsCreated).toBe(0);
      expect(p.diagnostics.reviewIssueUpdates).toBe(0);
    }
  });
});

describe('plan safety invariants', () => {
  it('every planned operation targets a protected sf_opportunity_* table only', () => {
    const p = plan(
      [opp(), opp({ RecordType: { DeveloperName: 'Service', Name: 'Service' } })],
      [hist({ OpportunityId: 'SYNTH-OPP-A' })],
    );
    for (const operation of p.operations) {
      expect(PROTECTED_STAGING_TABLES.has(operation.table)).toBe(true);
    }
    // No approval, link, deal, or attribution operation kind exists.
    const kinds = new Set(p.operations.map((o) => o.op));
    for (const forbidden of ['approve', 'link', 'create_deal', 'insert_attribution', 'update_deal']) {
      expect([...kinds].some((k) => k.includes(forbidden))).toBe(false);
    }
  });

  it('watermarks are proposed from the batch and complete batches advance them once', () => {
    const p = plan(
      [
        opp({ SystemModstamp: '2026-06-01T09:00:00.000+0000' }),
        opp({ SystemModstamp: '2026-07-15T09:00:00.000+0000' }),
      ],
      [hist({ OpportunityId: 'SYNTH-OPP-A', CreatedDate: '2026-05-05T09:00:00.000+0000' })],
    );
    expect(p.diagnostics.proposedWatermarkSystemModstamp).toBe('2026-07-15T09:00:00.000+0000');
    expect(p.diagnostics.proposedWatermarkHistoryCreatedAt).toBe('2026-05-05T09:00:00.000+0000');
    // Exactly one sync-run operation per plan; failure semantics (failed
    // runs never persist the proposed watermark) live in the apply function
    // and are asserted against its SQL below.
    expect(p.operations.filter((o) => o.op === 'record_sync_run')).toHaveLength(1);
  });

  it('no names, ids, or customer data leak into the aggregate diagnostics', () => {
    const p = plan([
      opp({ Name: 'Synthetic Secret Deal', Account: { Name: 'Synthetic Secret Account' }, Owner: { Name: 'Synthetic Owner' } }),
    ]);
    const serialized = JSON.stringify(p.diagnostics);
    for (const marker of ['Synthetic Secret Deal', 'Synthetic Secret Account', 'Synthetic Owner', 'SYNTH-OPP']) {
      expect(serialized).not.toContain(marker);
    }
  });
});

describe('fingerprints and stale protection (hardening)', () => {
  it('stores the human-readable Salesforce owner name instead of the user id', () => {
    const payload = buildSnapshotPayload(opp({
      OwnerId: 'SYNTH-USER-OWNER-ID',
      Owner: { Name: 'Synthetic Opportunity Owner' },
    }));
    expect(payload.opportunity_owner).toBe('Synthetic Opportunity Owner');
    expect(payload.opportunity_owner).not.toContain('SYNTH-USER-OWNER-ID');
  });

  it('SHA-256 fingerprint covers every staged field and ignores key order', () => {
    const a = buildSnapshotPayload(opp({ Id: 'SYNTH-OPP-F1' }));
    expect(a.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // A single field change alters the fingerprint.
    const b = buildSnapshotPayload(opp({ Id: 'SYNTH-OPP-F1', StageName: '4) Discovery' }));
    expect(b.content_hash).not.toBe(a.content_hash);
    // Reordered object keys do not: the canonical form is field-sorted.
    const { content_hash, ...fields } = a;
    void content_hash;
    const reversed = Object.fromEntries(Object.entries(fields).reverse()) as typeof fields;
    expect(snapshotFingerprint(reversed)).toBe(snapshotFingerprint(fields));
  });

  it('a missing source modification timestamp fails validation', () => {
    expect(() =>
      buildSnapshotPayload(opp({ SystemModstamp: null, LastModifiedDate: null })),
    ).toThrow(/missing or unparseable source SystemModstamp/);
  });

  it('an older source timestamp is a stale no-op and cannot overwrite', () => {
    const rec = opp({ Id: 'SYNTH-OPP-S1', SystemModstamp: '2026-05-01T09:00:00.000+0000' });
    const existing: ExistingStagingState = {
      ...EMPTY,
      snapshots: {
        'SYNTH-OPP-S1': {
          contentHash: 'sha256:newerhash',
          recordTypeDeveloperName: 'High_Potential_Prospect',
          sfLastModifiedAt: '2026-06-01T09:00:00.000+0000',
        },
      },
      reviews: { 'SYNTH-OPP-S1': { reviewState: 'pending', issueCodes: [], channelId: null } },
    };
    const p = plan([rec], [], existing);
    expect(p.diagnostics.staleSnapshotsSkipped).toBe(1);
    expect(p.diagnostics.snapshotsPlanned).toBe(0);
  });

  it('an identical timestamp with different content is a blocked conflict, never chosen', () => {
    const rec = opp({ Id: 'SYNTH-OPP-S2', SystemModstamp: '2026-06-01T09:00:00.000+0000' });
    const existing: ExistingStagingState = {
      ...EMPTY,
      snapshots: {
        'SYNTH-OPP-S2': {
          contentHash: 'sha256:differenthash',
          recordTypeDeveloperName: 'High_Potential_Prospect',
          sfLastModifiedAt: '2026-06-01T09:00:00.000+0000',
        },
      },
      reviews: { 'SYNTH-OPP-S2': { reviewState: 'pending', issueCodes: [], channelId: null } },
    };
    const p = plan([rec], [], existing);
    expect(p.diagnostics.snapshotConflicts).toBe(1);
    expect(p.diagnostics.snapshotsPlanned).toBe(0);
    // The disputed snapshot is withheld while the rest of the batch stays
    // appliable; the database race-guard (SF002) covers apply-time races.
    const payload = serializeApplyPayload(p);
    expect(payload.p_snapshots).toHaveLength(0);
  });

  it('repairs only the proven legacy OwnerId-to-Owner.Name representation', () => {
    const rec = opp({
      Id: 'SYNTH-OPP-OWNER',
      OwnerId: '005000000000001AAA',
      Owner: { Name: 'Synthetic Owner Name' },
      SystemModstamp: '2026-06-01T09:00:00.000+0000',
    });
    const incoming = buildSnapshotPayload(rec);
    const { content_hash, ...incomingFields } = incoming;
    void content_hash;
    const legacyHash = snapshotFingerprint({
      ...incomingFields,
      opportunity_owner: rec.OwnerId!,
    });
    const existing: ExistingStagingState = {
      ...EMPTY,
      snapshots: {
        'SYNTH-OPP-OWNER': {
          contentHash: legacyHash,
          recordTypeDeveloperName: 'High_Potential_Prospect',
          sfLastModifiedAt: '2026-06-01T09:00:00.000Z',
        },
      },
      reviews: {
        'SYNTH-OPP-OWNER': { reviewState: 'pending', issueCodes: [], channelId: null },
      },
    };

    const planned = plan([rec], [], existing);
    const payload = serializeApplyPayload(planned);

    expect(planned.diagnostics.ownerLabelRepairs).toBe(1);
    expect(planned.diagnostics.snapshotConflicts).toBe(0);
    expect(planned.diagnostics.snapshotsPlanned).toBe(0);
    expect(payload.p_owner_repairs).toEqual([{
      sf_opportunity_id: 'SYNTH-OPP-OWNER',
      repair_kind: 'owner_label_only',
      legacy_owner_user_id: '005000000000001AAA',
      owner_name: 'Synthetic Owner Name',
      account_id: 'SYNTH-ACC-1',
      sf_last_modified_at: '2026-06-01T09:00:00.000Z',
      prior_content_hash: legacyHash,
      content_hash: incoming.content_hash,
    }]);
  });

  it('repairs the exact initial-production shape that omitted account_id and stored OwnerId', () => {
    const rec = opp({
      Id: 'SYNTH-OPP-PRE-ACCOUNT',
      AccountId: '001000000000001AAA',
      OwnerId: '005000000000001AAA',
      Owner: { Name: 'Synthetic Owner Name' },
      SystemModstamp: '2026-06-01T09:00:00.000+0000',
    });
    const incoming = buildSnapshotPayload(rec);
    const { content_hash, account_id, ...legacyFields } = incoming;
    void content_hash;
    void account_id;
    const legacyHash = snapshotFingerprint({
      ...legacyFields,
      opportunity_owner: rec.OwnerId!,
    });
    const existing: ExistingStagingState = {
      ...EMPTY,
      snapshots: {
        'SYNTH-OPP-PRE-ACCOUNT': {
          contentHash: legacyHash,
          recordTypeDeveloperName: 'High_Potential_Prospect',
          sfLastModifiedAt: '2026-06-01T09:00:00.000Z',
        },
      },
      reviews: {
        'SYNTH-OPP-PRE-ACCOUNT': { reviewState: 'pending', issueCodes: [], channelId: null },
      },
    };

    const planned = plan([rec], [], existing);
    const payload = serializeApplyPayload(planned);

    expect(planned.diagnostics.ownerLabelRepairs).toBe(1);
    expect(planned.diagnostics.snapshotConflicts).toBe(0);
    expect(payload.p_owner_repairs).toEqual([expect.objectContaining({
      sf_opportunity_id: 'SYNTH-OPP-PRE-ACCOUNT',
      repair_kind: 'owner_and_account_shape',
      account_id: '001000000000001AAA',
      prior_content_hash: legacyHash,
      content_hash: incoming.content_hash,
    })]);
  });

  it('does not treat an arbitrary same-timestamp difference as an owner-label repair', () => {
    const rec = opp({
      Id: 'SYNTH-OPP-OWNER-CONFLICT',
      OwnerId: '005000000000001AAA',
      Owner: { Name: 'Synthetic Owner Name' },
      StageName: '4) Discovery',
      SystemModstamp: '2026-06-01T09:00:00.000+0000',
    });
    const oldRecord = { ...rec, StageName: '3) Qualification' };
    const oldPayload = buildSnapshotPayload(oldRecord);
    const { content_hash, ...oldFields } = oldPayload;
    void content_hash;
    const priorHash = snapshotFingerprint({
      ...oldFields,
      opportunity_owner: rec.OwnerId!,
    });
    const existing: ExistingStagingState = {
      ...EMPTY,
      snapshots: {
        'SYNTH-OPP-OWNER-CONFLICT': {
          contentHash: priorHash,
          recordTypeDeveloperName: 'High_Potential_Prospect',
          sfLastModifiedAt: '2026-06-01T09:00:00.000Z',
        },
      },
      reviews: {
        'SYNTH-OPP-OWNER-CONFLICT': { reviewState: 'pending', issueCodes: [], channelId: null },
      },
    };

    const planned = plan([rec], [], existing);
    expect(planned.diagnostics.ownerLabelRepairs).toBe(0);
    expect(planned.diagnostics.snapshotConflicts).toBe(1);
    expect(serializeApplyPayload(planned).p_owner_repairs).toHaveLength(0);
  });

  it('does not hide a stage change inside the pre-account-id compatibility path', () => {
    const rec = opp({
      Id: 'SYNTH-OPP-PRE-ACCOUNT-CONFLICT',
      AccountId: '001000000000001AAA',
      OwnerId: '005000000000001AAA',
      Owner: { Name: 'Synthetic Owner Name' },
      StageName: '4) Discovery',
      SystemModstamp: '2026-06-01T09:00:00.000+0000',
    });
    const oldPayload = buildSnapshotPayload({ ...rec, StageName: '3) Qualification' });
    const { content_hash, account_id, ...legacyFields } = oldPayload;
    void content_hash;
    void account_id;
    const priorHash = snapshotFingerprint({
      ...legacyFields,
      opportunity_owner: rec.OwnerId!,
    });
    const existing: ExistingStagingState = {
      ...EMPTY,
      snapshots: {
        'SYNTH-OPP-PRE-ACCOUNT-CONFLICT': {
          contentHash: priorHash,
          recordTypeDeveloperName: 'High_Potential_Prospect',
          sfLastModifiedAt: '2026-06-01T09:00:00.000Z',
        },
      },
      reviews: {
        'SYNTH-OPP-PRE-ACCOUNT-CONFLICT': {
          reviewState: 'pending', issueCodes: [], channelId: null,
        },
      },
    };

    const planned = plan([rec], [], existing);
    expect(planned.diagnostics.ownerLabelRepairs).toBe(0);
    expect(planned.diagnostics.snapshotConflicts).toBe(1);
    expect(serializeApplyPayload(planned).p_owner_repairs).toHaveLength(0);
  });
});

describe('review preservation (hardening)', () => {
  it('a populated channel means ingestion never re-adds missing_channel', () => {
    const existing: ExistingStagingState = {
      ...EMPTY,
      reviews: {
        'SYNTH-OPP-C1': {
          reviewState: 'pending',
          issueCodes: ['missing_region', 'incomplete_history'],
          channelId: 'syn-channel-uuid-1',
        },
      },
    };
    const p = plan([opp({ Id: 'SYNTH-OPP-C1' })], [], existing);
    const update = p.operations.find((o) => o.op === 'update_review_issues');
    if (update && update.op === 'update_review_issues') {
      expect(update.projection.issueCodes).not.toContain('missing_channel');
      // Reviewer-controlled fields survive untouched.
      expect(update.projection.channelId).toBe('syn-channel-uuid-1');
    }
    // Every planned code set excludes missing_channel for this review.
    for (const o of p.operations) {
      if (o.op === 'update_review_issues') {
        expect(o.projection.issueCodes).not.toContain('missing_channel');
      }
    }
  });
});

describe('serialization boundary (hardening)', () => {
  it('round-trips a synthetic record into the full RPC payload without loss or leakage of excluded records', () => {
    const included = opp({
      Id: 'SYNTH-OPP-RT1',
      AccountId: '001000000000001AAA',
      Existing_Customer_or_New_Business__c: 'New Project',
      Sales_Development_Rep__c: 'SYNTH-USER-SDR1',
      CreatedById: 'SYNTH-USER-CREATOR',
      CreatedBy: { Name: 'David Cummins' },
      Commercial_Region__c: 'NA',
      Industry_Vertical__c: 'Synthetic Vertical A',
      Pursuit_Industry_Vertical__c: 'Synthetic Vertical B',
      Insurance_vertical__c: 'Synthetic Vertical C',
      GTM_Cube__c: 'Synthetic Cube',
      Market__c: 'Synthetic Market',
      Business_Units__c: 'Synthetic LOB',
      SaaS_Revenue__c: 111,
      SaaS_Revenue_USD__c: 222,
    });
    const excluded = opp({ Id: 'SYNTH-OPP-RT2', IsClosed: true, CreatedDate: '2023-01-01T09:00:00.000+0000' });
    const rows = [hist({ OpportunityId: 'SYNTH-OPP-RT1', OldValue: null, NewValue: 'High Potential Prospect' })];
    const p = plan([included, excluded], rows);
    const payload = serializeApplyPayload(p);
    // The staged snapshot carries every approved evidence field.
    expect(payload.p_snapshots).toHaveLength(1);
    const snap = payload.p_snapshots[0];
    expect(snap.sf_opportunity_id).toBe('SYNTH-OPP-RT1');
    expect(snap.account_id).toBe('001000000000001AAA');
    expect(snap.normalized_record_type_state).toBe('hpp');
    expect(snap.is_closed).toBe(false);
    expect(snap.is_won).toBe(false);
    expect(snap.customer_expansion_raw).toBe('New Project');
    expect(snap.sales_development_rep_user_id).toBe('SYNTH-USER-SDR1');
    expect(snap.created_by_user_id).toBe('SYNTH-USER-CREATOR');
    expect(snap.suggested_bdr_name).toBe('Dave Cummins');
    expect(snap.commercial_region).toBe('NA');
    expect(snap.market).toBe('Synthetic Market');
    expect(snap.industry_vertical_raw).toBe('Synthetic Vertical A');
    expect(snap.pursuit_industry_vertical_raw).toBe('Synthetic Vertical B');
    expect(snap.insurance_vertical_raw).toBe('Synthetic Vertical C');
    expect(snap.gtm_cube).toBe('Synthetic Cube');
    expect(snap.business_units).toBe('Synthetic LOB');
    expect(snap.saas_revenue).toBe(111);
    expect(snap.saas_revenue_usd).toBe(222);
    expect(snap.sf_last_modified_at).toBe('2026-06-01T09:00:00.000Z');
    expect(snap.content_hash).toMatch(/^sha256:/);
    // Events carry their canonical content hash; reviews carry their audit.
    expect(payload.p_events).toHaveLength(1);
    expect(payload.p_events[0].content_hash).toMatch(/^sha256:/);
    expect(payload.p_reviews).toHaveLength(1);
    expect(payload.p_reviews[0].kind).toBe('create');
    expect(payload.p_reviews[0].audits[0].event_type).toBe('review_created');
    // The excluded record enters NOTHING.
    expect(JSON.stringify(payload)).not.toContain('SYNTH-OPP-RT2');
    // Watermarks ride in p_run.
    expect(payload.p_run.watermark_system_modstamp).toBe('2026-06-01T09:00:00.000+0000');
  });

  it('dry-run serialization reports counts and attempts zero writes', () => {
    const p = plan([opp()], []);
    const dry = summarizeDryRunPlan(p);
    expect(dry.dry_run).toBe(true);
    expect(dry.writes_attempted).toBe(0);
    expect(dry.wouldApply.snapshots).toBe(1);
    expect(dry.wouldApply.reviewCreates).toBe(1);
  });

  it('unknown operation kinds fail closed', () => {
    const p = plan([opp()], []);
    const forged = {
      ...p,
      operations: [...p.operations, { op: 'update_deal', table: 'sf_opportunities' } as never],
    };
    expect(() => serializeApplyPayload(forged)).toThrow(/unknown operation kind/);
  });
});

describe('apply-function migration safety (static SQL)', () => {
  const MIGRATION = readFileSync(
    resolve(process.cwd(), 'migrations/2026-07-27_opportunity_ingestion_apply_fn.sql'),
    'utf8',
  );

  it('is a hardened SECURITY DEFINER function revoked from public roles', () => {
    expect(MIGRATION).toContain('SECURITY DEFINER');
    expect(MIGRATION).toContain('SET search_path = pg_catalog');
    // Every table reference is schema-qualified.
    expect(MIGRATION).toContain('public.sf_opportunities');
    expect(MIGRATION).toContain('public.sf_opportunity_events');
    expect(MIGRATION).toContain('public.sf_opportunity_reviews');
    expect(MIGRATION).toContain('public.sf_opportunity_review_events');
    expect(MIGRATION).toContain('public.sf_opportunity_sync_runs');
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION .* FROM PUBLIC/);
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION .* FROM anon/);
    expect(MIGRATION).toMatch(/REVOKE ALL ON FUNCTION .* FROM authenticated/);
    expect(MIGRATION).toMatch(/GRANT EXECUTE ON FUNCTION .* TO service_role/);
    expect(MIGRATION).toContain('NOT YET APPLIED');
  });

  it('verifies event content instead of silently ignoring same-id conflicts', () => {
    // The weak ON CONFLICT DO NOTHING on the History Id is gone: an
    // existing id with identical content no-ops, different content FAILS.
    expect(MIGRATION).not.toContain('ON CONFLICT (sf_history_id) DO NOTHING');
    expect(MIGRATION).toContain("ERRCODE = 'SF003'");
    expect(MIGRATION).toContain('history event content differs for an existing history id');
    // Audit dedupe collisions with different content also fail.
    expect(MIGRATION).toContain("ERRCODE = 'SF004'");
    // Never an UPDATE against either append-only table.
    expect(MIGRATION).not.toMatch(/UPDATE\s+(public\.)?sf_opportunity_events/i);
    expect(MIGRATION).not.toMatch(/UPDATE\s+(public\.)?sf_opportunity_review_events/i);
    // No writes outside the six protected tables.
    expect(MIGRATION).not.toMatch(/INSERT INTO\s+(?!public\.sf_opportunit)/i);
    expect(MIGRATION).not.toMatch(/\b(attributions|leads|channels|funnel_actuals|campaign_)/i);
  });

  it('guards snapshots against stale and same-timestamp-conflicting writes', () => {
    expect(MIGRATION).toContain("ERRCODE = 'SF002'");
    expect(MIGRATION).toContain('snapshot content differs at an identical source timestamp');
    expect(MIGRATION).toContain("ERRCODE = 'SF006'");
    expect(MIGRATION).toContain('stale data can never overwrite newer staged data');
  });

  it('couples reviews with their audit events and preserves human state', () => {
    // Raced creates skip both the insert and the review_created event.
    expect(MIGRATION).toContain('a false');
    expect(MIGRATION).toContain("ERRCODE = 'SF005'");
    expect(MIGRATION).toContain('issues update expected a pending review');
    // Only issue_codes is ever touched on the review projection.
    const updateBlock = /UPDATE public\.sf_opportunity_reviews SET\s+issue_codes =/.exec(MIGRATION);
    expect(updateBlock).toBeTruthy();
    expect(MIGRATION).not.toMatch(/UPDATE public\.sf_opportunity_reviews SET[\s\S]{0,200}channel_id/);
  });

  it('creates the run row first, tags events with it, and sanitizes failures', () => {
    expect(MIGRATION).toContain("'running'");
    expect(MIGRATION).toContain('RETURNING id INTO v_run_id');
    expect(MIGRATION).toContain('sync_run_id');
    expect(MIGRATION).toContain("status: completed only when every operation succeeded");
    expect(MIGRATION).toContain('GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE');
    // SQLERRM is never persisted or returned (comments may explain the ban).
    const codeOnly = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(codeOnly).not.toMatch(/SQLERRM/);
    expect(MIGRATION).toContain("'sqlstate=' || v_sqlstate || ' category=' || v_category");
  });

  it('adds the review-evidence columns without names or rules', () => {
    for (const col of [
      'normalized_record_type_state',
      'is_closed',
      'is_won',
      'customer_expansion_raw',
      'sales_development_rep_user_id',
      'created_by_user_id',
      'insurance_vertical_raw',
      'industry_vertical_raw',
      'pursuit_industry_vertical_raw',
      'gtm_cube',
      'business_units',
      'saas_revenue',
    ]) {
      expect(MIGRATION).toContain(col);
    }
    // The applied v1 migration predates and therefore does not store the
    // normalized BDR suggestion added by the pending v2 contract.
    expect(MIGRATION.toLowerCase()).not.toContain('bdr_name');
  });
});

describe('approved BDR suggestion', () => {
  it.each([
    ['Dave Cummins', 'Dave Cummins'],
    ['David Cummins', 'Dave Cummins'],
    ['Garrett McNally', 'Garrett McNally'],
    ['Synthetic Other Creator', null],
    [null, null],
  ])('maps %s without assigning attribution', (creator, expected) => {
    expect(suggestedBdrName(opp({ CreatedBy: creator === null ? null : { Name: creator } })))
      .toBe(expected);
  });
});

describe('daily-ingestion contract migration (applied)', () => {
  const MIGRATION = readFileSync(
    resolve(process.cwd(), 'migrations/2026-08-12_opportunity_daily_ingestion_contract.sql'),
    'utf8',
  );
  const SCHEMA = readFileSync(resolve(process.cwd(), 'SCHEMA.sql'), 'utf8');
  const LEDGER = readFileSync(resolve(process.cwd(), 'migrations/README.md'), 'utf8');
  const DOC = readFileSync(
    resolve(process.cwd(), 'docs/salesforce-opportunity-daily-ingestion.md'),
    'utf8',
  );

  it('adds source Market, normalized BDR evidence, and reviewer-owned overrides', () => {
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS market TEXT');
    expect(MIGRATION).toContain('ADD COLUMN IF NOT EXISTS suggested_bdr_name TEXT');
    expect(MIGRATION).toContain("suggested_bdr_name IN ('Dave Cummins', 'Garrett McNally')");
    expect(SCHEMA).toContain('suggested_bdr_name TEXT');
    for (const field of [
      'market_override',
      'commercial_region_override',
      'gtm_cube_override',
    ]) {
      expect(MIGRATION).toContain(`ADD COLUMN IF NOT EXISTS ${field} TEXT`);
      expect(SCHEMA).toContain(`${field} TEXT`);
    }
    expect(SCHEMA).toContain('market TEXT');
  });

  it('never lets ingestion overwrite any manual override', () => {
    const codeOnly = MIGRATION.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    expect(codeOnly).not.toMatch(/UPDATE public\.sf_opportunity_reviews/);
    expect(codeOnly).not.toMatch(/SET\s+(market_override|commercial_region_override|gtm_cube_override)/);
    expect(codeOnly).not.toMatch(/SET\s+channel_id/);
  });

  it('persists source evidence only for the exact accepted snapshot and keeps the hardened v1 authority', () => {
    expect(MIGRATION).toContain('public.sf_apply_opportunity_ingestion(');
    expect(MIGRATION).toContain("SET market = v_item->>'market'");
    expect(MIGRATION).toContain("suggested_bdr_name = v_item->>'suggested_bdr_name'");
    expect(MIGRATION).toContain("sf_last_modified_at = NULLIF(v_item->>'sf_last_modified_at', '')::TIMESTAMPTZ");
    expect(MIGRATION).toContain("content_hash IS NOT DISTINCT FROM v_item->>'content_hash'");
  });

  it('keeps both RPCs restricted to service_role with a pinned search path', () => {
    for (const fn of ['sf_apply_opportunity_ingestion_v2', 'sf_read_opportunity_ingestion_state']) {
      expect(MIGRATION).toContain(`FUNCTION public.${fn}`);
      expect(MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[^;]* FROM PUBLIC`));
      expect(MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[^;]* FROM anon`));
      expect(MIGRATION).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[^;]* FROM authenticated`));
      expect(MIGRATION).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}[^;]* TO service_role`));
    }
    expect(MIGRATION.match(/SET search_path = pg_catalog/g)).toHaveLength(2);
  });

  it('records the verified production application consistently', () => {
    expect(MIGRATION).toContain('Applied manually to production on 2026-08-12');
    expect(MIGRATION).not.toContain('PENDING / NOT APPLIED');

    const schemaStatus = SCHEMA.slice(SCHEMA.indexOf('-- Opportunity daily-ingestion v2 contract'));
    expect(schemaStatus).toContain('Applied manually to production on 2026-08-12');
    expect(schemaStatus).not.toContain('PENDING / NOT APPLIED');

    const ledgerRow = LEDGER.split('\n').find((line) =>
      line.includes('2026-08-12_opportunity_daily_ingestion_contract.sql')) ?? '';
    expect(ledgerRow).toContain('| APPLIED |');
    expect(ledgerRow).toContain('service_role');
    expect(ledgerRow).not.toContain('NOT APPLIED');

    expect(DOC).toContain('migration **APPLIED on 2026-08-12**');
    expect(DOC).not.toContain('migration **PENDING / NOT APPLIED**');
    expect(DOC).toContain('initial production staging apply completed on 2026-08-12');
    expect(DOC).toContain('stored 71 snapshots and created 71 pending reviews');
    expect(DOC).toContain('exact retry applied 0 snapshots and created 0 reviews');
    expect(DOC).toContain('All 71 records remain pending human review');
  });
});

describe('staging workflow template safety (static)', () => {
  const doc = readFileSync(resolve(process.cwd(), 'docs/opportunity-staging-ingestion.md'), 'utf8');
  const match = /```json\n([\s\S]*?)\n```/.exec(doc);
  const template = JSON.parse(match![1]) as {
    active: boolean;
    nodes: Array<{ name: string; type: string; parameters: Record<string, unknown> }>;
  };

  it('is inactive, manual-trigger-only, and defaults to dry_run', () => {
    expect(template.active).toBe(false);
    expect(template.nodes.filter((n) => n.type === 'n8n-nodes-base.manualTrigger')).toHaveLength(1);
    expect(template.nodes.some((n) => n.type.toLowerCase().includes('schedule'))).toBe(false);
    const config = template.nodes.find((n) => n.name.includes('run mode'));
    expect(config).toBeTruthy();
    expect(String(config!.parameters.jsCode)).toContain("mode: 'dry_run'");
  });

  it('cannot enter apply mode accidentally: the gate fails closed', () => {
    const gate = template.nodes.find((n) => n.name.startsWith('APPLY GATE'));
    expect(gate).toBeTruthy();
    const code = String(gate!.parameters.jsCode);
    expect(code).toContain("mode !== 'apply'");
    expect(code).toContain('CONFIRM_APPLY');
    expect(code).toContain('throw new Error');
    // The apply path carries NO write node in 5C2A: it terminates in the
    // gate until the server-side planner execution environment exists.
    const raw = JSON.stringify(template).toLowerCase();
    for (const forbidden of ['supabase', 'postgres', 'googlesheets', 'httprequest', 'webhook']) {
      expect(template.nodes.some((n) => n.type.toLowerCase().includes(forbidden))).toBe(false);
    }
    expect(raw).not.toMatch(/service_role|bearer |apikey/);
  });
});

describe('conflict_observed audit coupling (final hardening)', () => {
  const conflictRows = () => [
    hist({
      OpportunityId: 'SYNTH-OPP-A',
      Id: 'SYNTH-HIST-X',
      NewValue: 'Opportunity',
      OldValue: 'High Potential Prospect',
    }),
  ];
  const storedContent = (rows: SalesforceOpportunityHistoryRecord[]): ExistingStagingState => ({
    ...EMPTY,
    eventContentByHistoryId: {
      'SYNTH-HIST-X': {
        sfOpportunityId: 'SYNTH-OPP-A',
        sourceField: 'RecordType',
        oldValue: null,
        newValue: 'High Potential Prospect',
        changedAt: rows[0].CreatedDate,
      },
    },
  });

  it('a new review couples review_created with conflict_observed evidence', () => {
    const rows = conflictRows();
    const p = plan([opp({ Id: 'SYNTH-OPP-A' })], rows, storedContent(rows));
    const create = p.operations.find((o) => o.op === 'create_review');
    expect(create).toBeTruthy();
    if (!create || create.op !== 'create_review') throw new Error('unreachable');
    expect(create.auditEvents[0].event_type).toBe('review_created');
    const conflict = create.auditEvents.find((e) => e.event_type === 'conflict_observed');
    expect(conflict).toBeTruthy();
    // Evidence: both content hashes and the History Id, no competing row.
    expect(conflict!.sf_history_id).toBe('SYNTH-HIST-X');
    expect(conflict!.accepted_content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(conflict!.conflicting_content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(conflict!.accepted_content_hash).not.toBe(conflict!.conflicting_content_hash);
    expect(conflict!.dedupe_key).toMatch(/^conflict:SYNTH-HIST-X:sha256:/);
  });

  it('an existing pending review couples issues_updated with conflict_observed', () => {
    const rows = conflictRows();
    const existing: ExistingStagingState = {
      ...storedContent(rows),
      reviews: { 'SYNTH-OPP-A': { reviewState: 'pending', issueCodes: [], channelId: null } },
    };
    const p = plan([opp({ Id: 'SYNTH-OPP-A' })], rows, existing);
    const update = p.operations.find((o) => o.op === 'update_review_issues');
    expect(update).toBeTruthy();
    if (!update || update.op !== 'update_review_issues') throw new Error('unreachable');
    expect(update.auditEvents[0].event_type).toBe('issues_updated');
    expect(update.auditEvents.some((e) => e.event_type === 'conflict_observed')).toBe(true);
    expect(update.projection.issueCodes).toContain('conflicting_history_id');
  });

  it('unchanged issue codes still record the evidence via an audit-only operation', () => {
    const rows = conflictRows();
    const base = storedContent(rows);
    const first = plan(
      [opp({ Id: 'SYNTH-OPP-A' })],
      rows,
      { ...base, reviews: { 'SYNTH-OPP-A': { reviewState: 'pending', issueCodes: [], channelId: null } } },
    );
    const update = first.operations.find((o) => o.op === 'update_review_issues');
    if (!update || update.op !== 'update_review_issues') throw new Error('expected an issues update');
    // Rerun with the settled codes: no projection change, evidence still travels.
    const second = plan(
      [opp({ Id: 'SYNTH-OPP-A' })],
      rows,
      {
        ...base,
        reviews: {
          'SYNTH-OPP-A': {
            reviewState: 'pending',
            issueCodes: update.projection.issueCodes,
            channelId: null,
          },
        },
      },
    );
    expect(second.diagnostics.reviewIssueUpdates).toBe(0);
    const auditOnly = second.operations.find((o) => o.op === 'append_review_audit');
    expect(auditOnly).toBeTruthy();
    if (!auditOnly || auditOnly.op !== 'append_review_audit') throw new Error('unreachable');
    expect(auditOnly.auditEvents.length).toBeGreaterThan(0);
    expect(auditOnly.auditEvents.every((e) => e.event_type === 'conflict_observed')).toBe(true);
    // Serialized as an audit_only item that never touches the review row.
    const payload = serializeApplyPayload(second);
    const item = payload.p_reviews.find((r) => r.kind === 'audit_only');
    expect(item).toBeTruthy();
    expect(item!.issue_codes).toEqual([]);
  });

  it('identical reobservation keeps the dedupe key; different content gets a new one', () => {
    const rows = conflictRows();
    const base = storedContent(rows);
    const keyOf = (p: ReturnType<typeof plan>) => {
      const create = p.operations.find((o) => o.op === 'create_review');
      if (!create || create.op !== 'create_review') throw new Error('expected create');
      return create.auditEvents.find((e) => e.event_type === 'conflict_observed')!.dedupe_key;
    };
    const keyA = keyOf(plan([opp({ Id: 'SYNTH-OPP-A' })], rows, base));
    const keyAgain = keyOf(plan([opp({ Id: 'SYNTH-OPP-A' })], rows, base));
    expect(keyAgain).toBe(keyA);
    // A DIFFERENT conflicting version of the same History Id is separately
    // auditable: new conflicting hash, new dedupe key.
    const differentRows = [
      hist({ OpportunityId: 'SYNTH-OPP-A', Id: 'SYNTH-HIST-X', NewValue: 'Pursuit', OldValue: 'High Potential Prospect' }),
    ];
    const keyB = keyOf(plan([opp({ Id: 'SYNTH-OPP-A' })], differentRows, {
      ...base,
      eventContentByHistoryId: {
        'SYNTH-HIST-X': { ...base.eventContentByHistoryId['SYNTH-HIST-X'], changedAt: differentRows[0].CreatedDate },
      },
    }));
    expect(keyB).not.toBe(keyA);
  });

  it('no content hashes or History Ids leak into aggregate diagnostics', () => {
    const rows = conflictRows();
    const p = plan([opp({ Id: 'SYNTH-OPP-A' })], rows, storedContent(rows));
    const serialized = JSON.stringify(p.diagnostics);
    expect(serialized).not.toContain('sha256:');
    expect(serialized).not.toContain('SYNTH-HIST');
  });
});

describe('timestamp instants and deterministic serialization (final hardening)', () => {
  it('representation differences at the same instant are not changes', () => {
    // +0000 and Z are the same instant: with an identical fingerprint this
    // is an idempotent no-op, never a stale skip or a conflict.
    const rec = opp({ Id: 'SYNTH-OPP-T1', SystemModstamp: '2026-06-01T09:00:00.000+0000' });
    const existing: ExistingStagingState = {
      ...EMPTY,
      snapshots: {
        'SYNTH-OPP-T1': {
          contentHash: buildSnapshotPayload(rec).content_hash,
          recordTypeDeveloperName: 'High_Potential_Prospect',
          sfLastModifiedAt: '2026-06-01T09:00:00.000Z',
        },
      },
      reviews: { 'SYNTH-OPP-T1': { reviewState: 'pending', issueCodes: [], channelId: null } },
    };
    const p = plan([rec], [], existing);
    expect(p.diagnostics.snapshotsPlanned).toBe(0);
    expect(p.diagnostics.staleSnapshotsSkipped).toBe(0);
    expect(p.diagnostics.snapshotConflicts).toBe(0);
    expect(p.diagnostics.snapshotNoops).toBe(1);
  });

  it('an unparseable source timestamp fails validation', () => {
    expect(() =>
      buildSnapshotPayload(opp({ SystemModstamp: 'not-a-timestamp', LastModifiedDate: null })),
    ).toThrow(/unparseable source SystemModstamp/);
  });

  it('the snapshot payload carries the normalized ISO instant', () => {
    const payload = buildSnapshotPayload(opp({ SystemModstamp: '2026-06-01T09:00:00.000+0000' }));
    expect(payload.sf_last_modified_at).toBe('2026-06-01T09:00:00.000Z');
  });

  it('apply payload arrays are deterministically ordered for deadlock avoidance', () => {
    const p = plan([
      opp({ Id: 'SYNTH-OPP-Z' }),
      opp({ Id: 'SYNTH-OPP-B' }),
      opp({ Id: 'SYNTH-OPP-M' }),
    ]);
    const payload = serializeApplyPayload(p);
    const snapshotIds = payload.p_snapshots.map((x) => x.sf_opportunity_id);
    expect(snapshotIds).toEqual([...snapshotIds].sort());
    const reviewIds = payload.p_reviews.map((x) => x.sf_opportunity_id);
    expect(reviewIds).toEqual([...reviewIds].sort());
  });
});

describe('apply-function migration final hardening (static SQL)', () => {
  const MIGRATION = readFileSync(
    resolve(process.cwd(), 'migrations/2026-07-27_opportunity_ingestion_apply_fn.sql'),
    'utf8',
  );

  it('snapshot upsert is one concurrency-safe guarded statement', () => {
    expect(MIGRATION).toContain('ON CONFLICT (sf_opportunity_id) DO UPDATE SET');
    // The guard: updates apply only when the incoming stamp is strictly newer.
    expect(MIGRATION).toContain('WHERE public.sf_opportunities.sf_last_modified_at IS NULL');
    expect(MIGRATION).toContain('OR public.sf_opportunities.sf_last_modified_at < EXCLUDED.sf_last_modified_at');
    // The post-inspection classifies via the conflict-locked row, not an
    // unlocked pre-check before the write.
    expect(MIGRATION).toContain('no unlocked pre-check');
    const upsertAt = MIGRATION.indexOf('ON CONFLICT (sf_opportunity_id) DO UPDATE SET');
    const inspectAt = MIGRATION.indexOf('SELECT sf_last_modified_at, content_hash INTO v_existing_stamp');
    expect(inspectAt).toBeGreaterThan(upsertAt);
  });

  it('the run row is created from server-generated values only', () => {
    expect(MIGRATION).toContain("VALUES ('salesforce', pg_catalog.now(), 'running')");
    // Caller-provided run metadata is cast only INSIDE the protected block,
    // after the run row already exists.
    const runRowAt = MIGRATION.indexOf("VALUES ('salesforce', pg_catalog.now(), 'running')");
    const callerCastAt = MIGRATION.indexOf("p_run->>'started_at'");
    expect(runRowAt).toBeGreaterThan(-1);
    expect(callerCastAt).toBeGreaterThan(runRowAt);
  });

  it('audit dedupe compares the complete canonical identity, null-safe', () => {
    for (const field of [
      'event_type',
      'previous_state',
      'new_state',
      'issue_codes_snapshot',
      'actor_type',
      'actor_id',
      'sf_history_id',
      'accepted_content_hash',
      'conflicting_content_hash',
      'note',
    ]) {
      expect(MIGRATION).toContain(`e.${field} IS NOT DISTINCT FROM`);
    }
    // occurred_at is observation metadata: excluded, first observation wins.
    const codeOnly = MIGRATION.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(codeOnly).not.toContain('e.occurred_at IS NOT DISTINCT FROM');
    expect(MIGRATION).toContain('first observation wins');
  });

  it('review items carry coupled audit arrays including audit_only evidence', () => {
    expect(MIGRATION).toContain("v_item->'audits'");
    expect(MIGRATION).toContain("'audit_only'");
    expect(MIGRATION).toContain('audit-only item expected an existing review');
    // The audit_only path never modifies the review projection.
    expect(MIGRATION).not.toMatch(/audit_only'[\s\S]{0,400}UPDATE public\.sf_opportunity_reviews/);
  });
});
