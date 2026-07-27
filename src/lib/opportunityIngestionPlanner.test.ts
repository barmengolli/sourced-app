// Tests for the Bite 5C2A staging-ingestion planner. Synthetic records only;
// no real Salesforce identifiers, names, or customer data. Also carries the
// static safety assertions for the PENDING apply-function migration and the
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
  summarizeDryRunPlan,
  PROTECTED_STAGING_TABLES,
} from './opportunityIngestionPlanner';
import type { ExistingStagingState, IngestionConfig } from './opportunityIngestionPlanner';
import type {
  SalesforceOpportunityRecord,
  SalesforceOpportunityHistoryRecord,
} from './salesforceOpportunitySync';

const CONFIG: IngestionConfig = { initialCohortYear: 2026, runStartedAt: '2026-07-27T12:00:00Z' };

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

  it('an older closed unlinked record is excluded and NOT staged: no snapshot, event, or review', () => {
    const p = plan(
      [opp({ Id: 'SYNTH-OPP-OLD', IsClosed: true, CreatedDate: '2024-03-01T09:00:00.000+0000' })],
      [hist({ OpportunityId: 'SYNTH-OPP-OLD' })],
    );
    expect(p.diagnostics.eligibility.excluded_older_closed).toBe(1);
    expect(p.diagnostics.reviewsCreated).toBe(0);
    expect(p.diagnostics.snapshotsPlanned).toBe(0);
    expect(p.diagnostics.eventsPlanned).toBe(0);
    expect(p.diagnostics.excludedNotStaged).toBe(1);
    // Only aggregate diagnostics remain; no identifier survives anywhere.
    expect(JSON.stringify(p.operations)).not.toContain('SYNTH-OPP-OLD');
  });

  it('the cohort year is configuration, not a hardcoded 2026', () => {
    const rec = opp({ IsClosed: true, CreatedDate: '2027-03-01T09:00:00.000+0000' });
    const p2027 = planStagingIngestion([rec], [], [], EMPTY, { ...CONFIG, initialCohortYear: 2027 });
    expect(p2027.diagnostics.eligibility.eligible_new_candidate).toBe(1);
    expect(classifyCandidateEligibility(rec, EMPTY, CONFIG)).toBe('excluded_older_closed');
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
        Existing_Customer_or_New_Business__c: null,
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
    expect(update && update.op === 'update_review_issues' && update.auditEvent.event_type).toBe('issues_updated');
    expect(update && update.op === 'update_review_issues' && update.auditEvent.dedupe_key).toContain('issues:SYNTH-OPP-A');
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
    ).toThrow(/missing source SystemModstamp/);
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
    // A conflicted batch is not appliable: serialization fails closed.
    expect(() => serializeApplyPayload(p)).toThrow(/not appliable/);
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
      Existing_Customer_or_New_Business__c: 'Synthetic Segment',
      Sales_Development_Rep__c: 'SYNTH-USER-SDR1',
      CreatedById: 'SYNTH-USER-CREATOR',
      Commercial_Region__c: 'NA',
      Industry_Vertical__c: 'Synthetic Vertical A',
      Pursuit_Industry_Vertical__c: 'Synthetic Vertical B',
      Insurance_vertical__c: 'Synthetic Vertical C',
      GTM_Cube__c: 'Synthetic Cube',
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
    expect(snap.normalized_record_type_state).toBe('hpp');
    expect(snap.is_closed).toBe(false);
    expect(snap.is_won).toBe(false);
    expect(snap.customer_expansion_raw).toBe('Synthetic Segment');
    expect(snap.sales_development_rep_user_id).toBe('SYNTH-USER-SDR1');
    expect(snap.created_by_user_id).toBe('SYNTH-USER-CREATOR');
    expect(snap.commercial_region).toBe('NA');
    expect(snap.industry_vertical_raw).toBe('Synthetic Vertical A');
    expect(snap.pursuit_industry_vertical_raw).toBe('Synthetic Vertical B');
    expect(snap.insurance_vertical_raw).toBe('Synthetic Vertical C');
    expect(snap.gtm_cube).toBe('Synthetic Cube');
    expect(snap.business_units).toBe('Synthetic LOB');
    expect(snap.saas_revenue).toBe(111);
    expect(snap.saas_revenue_usd).toBe(222);
    expect(snap.sf_last_modified_at).toBe('2026-06-01T09:00:00.000+0000');
    expect(snap.content_hash).toMatch(/^sha256:/);
    // Events carry their canonical content hash; reviews carry their audit.
    expect(payload.p_events).toHaveLength(1);
    expect(payload.p_events[0].content_hash).toMatch(/^sha256:/);
    expect(payload.p_reviews).toHaveLength(1);
    expect(payload.p_reviews[0].kind).toBe('create');
    expect(payload.p_reviews[0].audit.event_type).toBe('review_created');
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
    // Names never enter storage; only user ids as evidence.
    expect(MIGRATION.toLowerCase()).not.toContain('bdr_name');
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
