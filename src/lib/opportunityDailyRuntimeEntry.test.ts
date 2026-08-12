import { describe, expect, it } from 'vitest';
import { planOpportunityDailyRun } from './opportunityDailyRuntimeEntry';

const state = { snapshots: {}, eventContentByHistoryId: {}, reviews: {}, links: {} };

function record(over: Record<string, unknown> = {}) {
  return {
    Id: 'SYNTH-OPP-DAILY-1',
    Name: 'Synthetic Daily Opportunity',
    AccountId: '001000000000001AAA',
    RecordType: { DeveloperName: 'High_Potential_Prospect', Name: 'HPP' },
    StageName: 'Qualification',
    IsClosed: false,
    IsWon: false,
    CreatedDate: '2026-06-01T00:00:00.000Z',
    SystemModstamp: '2026-08-12T10:00:00.000Z',
    Existing_Customer_or_New_Business__c: 'New Project',
    Market__c: 'Synthetic Market',
    Commercial_Region__c: 'Synthetic Region',
    GTM_Cube__c: 'Synthetic Cube',
    Amount: 1,
    SaaS_Revenue__c: 2,
    SaaS_Revenue_USD__c: 3,
    CreatedBy: { Name: 'David Cummins' },
    ...over,
  };
}

function run(records = [record()]) {
  return planOpportunityDailyRun({
    opportunities: records,
    historyRecords: [],
    recordTypeRefs: [],
    existingState: state,
    runStartedAt: '2026-08-12T12:00:00.000Z',
    reportingYears: [2025, 2026],
    includedBusinessTypeApiValues: ['New Project'],
  });
}

describe('Opportunity daily runtime', () => {
  it('uses SaaS Revenue USD visibly while preserving all three revenue fields', () => {
    const result = run();
    expect(result.summary.primary_revenue_field).toBe('SaaS_Revenue_USD__c');
    expect(result.summary.stored_hidden_revenue_fields).toEqual(['Amount', 'SaaS_Revenue__c']);
    expect(result.payload.p_snapshots[0]).toMatchObject({
      amount: 1,
      saas_revenue: 2,
      saas_revenue_usd: 3,
      account_id: '001000000000001AAA',
      market: 'Synthetic Market',
      suggested_bdr_name: 'Dave Cummins',
    });
    expect(result.summary.suggested_bdrs).toEqual({
      dave_cummins: 1,
      garrett_mcnally: 0,
      none: 0,
    });
    expect(result.summary.source_attribution_requires_human_review).toBe(true);
  });

  it('counts BDR suggestions without turning them into attribution', () => {
    const result = run([
      record({ Id: 'SYNTH-OPP-BDR-A', CreatedBy: { Name: 'Dave Cummins' } }),
      record({ Id: 'SYNTH-OPP-BDR-B', CreatedBy: { Name: 'Garrett McNally' } }),
      record({ Id: 'SYNTH-OPP-BDR-C', CreatedBy: { Name: 'Synthetic Seller' } }),
    ]);
    expect(result.summary.suggested_bdrs).toEqual({
      dave_cummins: 1,
      garrett_mcnally: 1,
      none: 1,
    });
    expect(JSON.stringify(result.payload.p_reviews)).not.toContain('Marketing SDR');
    expect(result.summary.source_attribution_requires_human_review).toBe(true);
  });

  it('includes open and closed New Project records created in 2025 or 2026', () => {
    const result = run([
      record(),
      record({ Id: 'SYNTH-OPP-DAILY-2', IsClosed: true, CreatedDate: '2025-03-01T00:00:00Z' }),
    ]);
    expect(result.summary.open_current_pipeline).toBe(1);
    expect(result.summary.closed_staged_for_review).toBe(1);
    expect(result.payload.p_snapshots).toHaveLength(2);
  });

  it('plans real Opportunity history events and never fabricates them from snapshots', () => {
    const result = planOpportunityDailyRun({
      opportunities: [record()],
      historyRecords: [{
        Id: '0Hx000000000001AAA',
        OpportunityId: 'SYNTH-OPP-DAILY-1',
        Field: 'RecordType',
        OldValue: '012000000000001AAA',
        NewValue: '012000000000002AAA',
        CreatedDate: '2026-08-05T12:00:00.000Z',
      }],
      recordTypeRefs: [
        { Id: '012000000000001AAA', DeveloperName: 'High_Potential_Prospect', SobjectType: 'Opportunity' },
        { Id: '012000000000002AAA', DeveloperName: 'Leads', SobjectType: 'Opportunity' },
      ],
      existingState: state,
      runStartedAt: '2026-08-12T12:00:00.000Z',
      reportingYears: [2025, 2026],
      includedBusinessTypeApiValues: ['New Project'],
    });

    expect(result.summary.source_history_rows).toBe(1);
    expect(result.payload.p_events).toHaveLength(1);
    expect(result.payload.p_events[0]).toMatchObject({
      sf_history_id: '0Hx000000000001AAA',
      old_value: 'High_Potential_Prospect',
      new_value: 'Leads',
    });
  });

  it('excludes blank, non-New-Logo, and out-of-year records', () => {
    const result = run([
      record({ Id: 'SYNTH-OPP-DAILY-A', Existing_Customer_or_New_Business__c: null }),
      record({ Id: 'SYNTH-OPP-DAILY-B', Existing_Customer_or_New_Business__c: 'Renewal' }),
      record({ Id: 'SYNTH-OPP-DAILY-C', CreatedDate: '2024-01-01T00:00:00Z' }),
    ]);
    expect(result.payload.p_snapshots).toHaveLength(0);
    expect(result.summary.planner_diagnostics.eligibility).toMatchObject({
      excluded_missing_business_type: 1,
      excluded_non_new_logo: 1,
      excluded_outside_reporting_years: 1,
    });
  });

  it('refuses any guessed New Logo value', () => {
    expect(() => planOpportunityDailyRun({
      opportunities: [record()],
      historyRecords: [],
      recordTypeRefs: [],
      existingState: state,
      runStartedAt: '2026-08-12T12:00:00.000Z',
      reportingYears: [2025, 2026],
      includedBusinessTypeApiValues: ['New Logo'],
    })).toThrow(/exactly New Project/);
  });
});
