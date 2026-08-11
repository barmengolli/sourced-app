import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AGGREGATE_CODE,
  BDR_IDENTITIES,
  GUARD_CODE,
  INCLUDED_RECORD_TYPES,
  REPORTING_YEARS,
  RESOLVE_FIELDS_CODE,
  VALIDATE_BDR_CODE,
  buildWorkflow,
} from '../../scripts/build-salesforce-opportunity-scope-audit-workflow.mjs';

type JsonItem = { json: Record<string, unknown> };

const items = (rows: Record<string, unknown>[]): JsonItem[] => rows.map((json) => ({ json }));

const baseConfig = {
  dry_run: true,
  writes_attempted: 0,
  timezone: 'America/Denver',
  reporting_years: REPORTING_YEARS,
  included_record_types: INCLUDED_RECORD_TYPES,
  bdr_identities: BDR_IDENTITIES,
};

function executeBdrValidation(rows: Record<string, unknown>[]): JsonItem[] {
  const lookup = (name: string) => {
    if (name !== 'CONFIG: 2025-2026 scope') throw new Error(`unexpected node ${name}`);
    return { first: () => ({ json: baseConfig }) };
  };
  const fn = new Function('$input', '$', VALIDATE_BDR_CODE) as (
    input: { all: () => JsonItem[] },
    dollar: typeof lookup,
  ) => JsonItem[];
  return fn({ all: () => items(rows) }, lookup);
}

const requiredOpportunityFields = [
  'Id', 'Name', 'AccountId', 'RecordTypeId', 'StageName', 'IsClosed', 'IsWon',
  'CreatedDate', 'SystemModstamp', 'Amount', 'CurrencyIsoCode', 'CloseDate',
  'OwnerId', 'CampaignId', 'CreatedById', 'Commercial_Region__c', 'GTM_Cube__c',
  'Existing_Customer_or_New_Business__c', 'SaaS_Revenue__c', 'SaaS_Revenue_USD__c',
];

function fieldRows(marketApiName = 'Market__c'): Record<string, unknown>[] {
  return [
    ...requiredOpportunityFields.map((QualifiedApiName) => ({
      QualifiedApiName,
      Label: QualifiedApiName,
      DataType: 'Text',
    })),
    { QualifiedApiName: marketApiName, Label: 'Market', DataType: 'Picklist' },
  ];
}

const resolvedConfig = {
  ...baseConfig,
  approved_bdr_user_ids: {
    dave_cummins: '005000000000001AAA',
    garrett_mcnally: '005000000000002AAA',
  },
  market_field_api_name: 'Market__c',
  query_start_utc: '2025-01-01T00:00:00Z',
  query_end_utc_exclusive: '2027-01-01T00:00:00Z',
};

function executeFieldResolution(rows = fieldRows(), marketFieldOverride = ''): JsonItem[] {
  const config = {
    ...resolvedConfig,
    market_field_api_name_override: marketFieldOverride,
  };
  const lookup = (name: string) => {
    if (name !== 'VALIDATE: exact BDR users') throw new Error(`unexpected node ${name}`);
    return { first: () => ({ json: config }) };
  };
  const fn = new Function('$input', '$', RESOLVE_FIELDS_CODE) as (
    input: { all: () => JsonItem[] },
    dollar: typeof lookup,
  ) => JsonItem[];
  return fn({ all: () => items(rows) }, lookup);
}

function opportunity(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: `00600000000000${index}AAA`,
    Name: `Synthetic Opportunity ${index}`,
    AccountId: `00100000000000${index}AAA`,
    Account: { Name: `Synthetic Account ${index}` },
    RecordType: { DeveloperName: 'High_Potential_Prospect', Name: 'High Potential Prospect' },
    StageName: '1) Suspect',
    IsClosed: false,
    IsWon: false,
    CreatedDate: '2025-04-15T12:00:00.000Z',
    SystemModstamp: '2026-08-11T12:00:00.000Z',
    Amount: 100,
    CurrencyIsoCode: 'USD',
    CloseDate: '2026-12-31',
    OwnerId: '005000000000099AAA',
    CampaignId: null,
    CreatedById: '005000000000001',
    Existing_Customer_or_New_Business__c: 'New Logo',
    Commercial_Region__c: 'NA',
    GTM_Cube__c: 'Synthetic Cube',
    Market__c: 'North America',
    SaaS_Revenue__c: 80,
    SaaS_Revenue_USD__c: 80,
    ...overrides,
  };
}

function executeAggregate(rows: Record<string, unknown>[]): JsonItem[] {
  const lookup = (name: string) => {
    if (name !== 'RESOLVE: Market field and build query') throw new Error(`unexpected node ${name}`);
    return { first: () => ({ json: resolvedConfig }) };
  };
  const fn = new Function('$input', '$', AGGREGATE_CODE) as (
    input: { all: () => JsonItem[] },
    dollar: typeof lookup,
  ) => JsonItem[];
  return fn({ all: () => items(rows) }, lookup);
}

describe('Salesforce Opportunity scope-audit workflow', () => {
  it('locks the requested years and exact funnel record types', () => {
    expect(REPORTING_YEARS).toEqual([2025, 2026]);
    expect(INCLUDED_RECORD_TYPES).toEqual([
      'High_Potential_Prospect',
      'Leads',
      'Licensing',
    ]);
  });

  it('resolves Dave or David and Garrett to exactly two Salesforce User IDs', () => {
    const [result] = executeBdrValidation([
      { Id: '005000000000001AAA', Name: 'Dave Cummins', IsActive: true },
      { Id: '005000000000002AAA', Name: 'Garrett McNally', IsActive: true },
    ]);
    expect(result.json.approved_bdr_user_ids).toEqual({
      dave_cummins: '005000000000001AAA',
      garrett_mcnally: '005000000000002AAA',
    });
  });

  it('fails rather than guessing when one BDR is absent or ambiguous', () => {
    expect(() => executeBdrValidation([
      { Id: '005000000000001AAA', Name: 'Dave Cummins', IsActive: true },
    ])).toThrow('garrett_mcnally resolved to 0');
    expect(() => executeBdrValidation([
      { Id: '005000000000001AAA', Name: 'Dave Cummins', IsActive: true },
      { Id: '005000000000003AAA', Name: 'David Cummins', IsActive: true },
      { Id: '005000000000002AAA', Name: 'Garrett McNally', IsActive: true },
    ])).toThrow('dave_cummins resolved to 2');
  });

  it('discovers the Market API name and never hardcodes or guesses it', () => {
    const [result] = executeFieldResolution();
    expect(result.json.market_field_api_name).toBe('Market__c');
    const query = String(result.json.opportunity_query);
    expect(query).toContain('Market__c FROM Opportunity');
    expect(query).toContain('CreatedDate >= 2025-01-01T00:00:00Z');
    expect(query).toContain('CreatedDate < 2027-01-01T00:00:00Z');
    expect(query).toContain("RecordType.DeveloperName IN ('High_Potential_Prospect','Leads','Licensing')");
  });

  it('returns an actionable candidate list when Market is missing or ambiguous', () => {
    expect(() => executeFieldResolution(fieldRows().filter((row) => row.Label !== 'Market')))
      .toThrow('Market resolved to 0 fields. Candidates: (none)');
    expect(() => executeFieldResolution([
      ...fieldRows(),
      { QualifiedApiName: 'Alternate_Market__c', Label: 'Market', DataType: 'Text' },
    ])).toThrow('Candidates: Alternate_Market__c [Text], Market__c [Picklist]');
  });

  it('uses only an exact configured Market candidate and refuses an unknown override', () => {
    const ambiguous = [
      ...fieldRows(),
      { QualifiedApiName: 'Alternate_Market__c', Label: 'Market', DataType: 'Text' },
      { QualifiedApiName: 'Third_Market__c', Label: 'Market', DataType: 'Picklist' },
    ];
    const [result] = executeFieldResolution(ambiguous, 'Alternate_Market__c');
    expect(result.json.market_field_api_name).toBe('Alternate_Market__c');
    expect(result.json.market_field_candidates).toEqual([
      { apiName: 'Alternate_Market__c', dataType: 'Text' },
      { apiName: 'Market__c', dataType: 'Picklist' },
      { apiName: 'Third_Market__c', dataType: 'Picklist' },
    ]);
    expect(String(result.json.opportunity_query)).toContain('Alternate_Market__c FROM Opportunity');
    expect(() => executeFieldResolution(ambiguous, 'Guessed_Market__c'))
      .toThrow('configured MARKET_FIELD_API_NAME Guessed_Market__c is not exactly one');
  });

  it('reconciles New Logo scope, current pipeline, closed history, BDR creators, and field coverage', () => {
    const [result] = executeAggregate([
      opportunity(1),
      opportunity(2, {
        RecordType: { DeveloperName: 'Licensing', Name: 'Pursuit' },
        CreatedDate: '2026-03-10T09:00:00.000Z',
        CreatedById: '005000000000002AAA',
        Existing_Customer_or_New_Business__c: 'New Business',
        IsClosed: true,
        IsWon: true,
        CampaignId: '701000000000001AAA',
      }),
      opportunity(3, {
        RecordType: { DeveloperName: 'Leads', Name: 'Opportunity' },
        CreatedDate: '2026-05-01T09:00:00.000Z',
        CreatedById: '005000000000099AAA',
        Market__c: '',
        GTM_Cube__c: '',
        SaaS_Revenue_USD__c: null,
      }),
      opportunity(4, { Existing_Customer_or_New_Business__c: 'Existing Customer' }),
      opportunity(5, { Existing_Customer_or_New_Business__c: '' }),
      opportunity(6, { CreatedDate: '2024-01-01T09:00:00.000Z' }),
    ]);

    expect(result.json).toMatchObject({
      status: 'SCOPE_AUDIT_COMPLETE',
      dry_run: true,
      writes_attempted: 0,
      source_opportunities: 6,
      eligible_new_logo_opportunities: 3,
      excluded_opportunities: 3,
      excluded_by_reason: {
        missing_new_logo_value: 1,
        existing_customer_or_expansion: 1,
        outside_configured_years: 1,
      },
      current_pipeline: {
        open_opportunities: 2,
        by_current_record_type: { hpp: 1, opp: 1, pursuit: 0 },
      },
      closed_history: {
        closed_opportunities: 1,
        won_opportunities: 1,
        closed_not_won_opportunities: 0,
      },
      by_created_year: { '2025': 1, '2026': 2 },
      all_eligible_by_current_record_type: { hpp: 1, opp: 1, pursuit: 1 },
      by_creator: {
        dave_cummins: 1,
        garrett_mcnally: 1,
        other_creator: 1,
        missing_creator: 0,
      },
      bdr_generated_opportunities: 2,
      review_queue: {
        candidates_requiring_source_review: 3,
        marketing_sdr_preselected_pending_approval: 2,
        source_unassigned_pending_review: 1,
        primary_campaign_evidence_present: 1,
        primary_campaign_evidence_missing: 2,
      },
      field_coverage: {
        market: { populated: 2, missing: 1 },
        commercial_region: { populated: 3, missing: 0 },
        gtm_cube: { populated: 2, missing: 1 },
        amount: { populated: 3, missing: 0 },
        saas_revenue: { populated: 3, missing: 0 },
        saas_revenue_usd: { populated: 2, missing: 1 },
      },
      reporting_lens: 'current_pipeline_only',
      reconciliation_complete: true,
    });
  });

  it('matches 15- and 18-character creator IDs without case folding', () => {
    const [result] = executeAggregate([
      opportunity(1, { CreatedById: '005000000000001' }),
      opportunity(2, { CreatedById: '005000000000002AAA' }),
    ]);
    expect(result.json.bdr_generated_opportunities).toBe(2);
  });

  it('fails closed on duplicate Opportunity IDs', () => {
    expect(() => executeAggregate([opportunity(1), opportunity(1)]))
      .toThrow('duplicate Opportunity Id');
  });

  it('keeps manual corrections authoritative over refreshed Salesforce evidence', () => {
    const [result] = executeAggregate([opportunity(1)]);
    expect(result.json.overwrite_policy).toEqual({
      rule: 'manual_override_wins',
      overrideable_fields: ['market', 'commercial_region', 'gtm_cube', 'source_channel'],
      source_values_refresh_without_clearing_manual_overrides: true,
    });
    expect(result.json.revenue_policy).toEqual({
      primary_visible_field: 'Amount',
      stored_hidden_fields: ['SaaS_Revenue__c', 'SaaS_Revenue_USD__c'],
    });
  });

  it('produces an aggregate terminal with no source identifiers', () => {
    const [summary] = executeAggregate([opportunity(1)]);
    const fn = new Function('$input', GUARD_CODE) as (
      input: { first: () => JsonItem },
    ) => JsonItem[];
    const [guarded] = fn({ first: () => summary });
    const serialized = JSON.stringify(guarded.json);
    expect(serialized).not.toContain('006000000000001AAA');
    expect(serialized).not.toContain('Synthetic Opportunity');
    expect(serialized).not.toContain('Synthetic Account');
  });

  it('is disabled, manual-only, credential-free, unpinned, and write-free', () => {
    const workflow = buildWorkflow();
    expect(workflow.active).toBe(false);
    expect(workflow.pinData).toEqual({});
    expect(workflow.settings.timezone).toBe('America/Denver');
    expect(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.manualTrigger')).toHaveLength(1);
    expect(workflow.nodes.some((node) => /scheduleTrigger|webhook/i.test(node.type))).toBe(false);
    expect(workflow.nodes.every((node) => !('credentials' in node))).toBe(true);
    expect(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.salesforce')).toHaveLength(3);
    expect(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.salesforce')
      .every((node) => node.parameters.resource === 'search')).toBe(true);
    expect(workflow.nodes.some((node) => /httpRequest|googleSheets|postgres|supabase/i.test(node.type))).toBe(false);
  });

  it('makes GUARD the only terminal and keeps every node reachable', () => {
    const workflow = buildWorkflow();
    const outgoing = new Map<string, string[]>();
    for (const [name, connection] of Object.entries(workflow.connections)) {
      outgoing.set(name, connection.main.flat().map((edge) => edge.node));
    }
    const reached = new Set<string>();
    const queue = ['Manual Trigger'];
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (reached.has(name)) continue;
      reached.add(name);
      for (const next of outgoing.get(name) ?? []) queue.push(next);
    }
    expect(reached.size).toBe(workflow.nodes.length);
    const terminals = workflow.nodes.map((node) => node.name).filter((name) => !outgoing.has(name));
    expect(terminals).toEqual(['GUARD: aggregate-only scope audit']);
  });

  it('keeps the committed generated artifact byte-equivalent to the builder', () => {
    const generated = JSON.parse(
      readFileSync(resolve('src/generated/salesforceOpportunityScopeAudit.workflow.json'), 'utf8'),
    );
    expect(generated).toEqual(buildWorkflow());
  });
});
