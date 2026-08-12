import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  APPLY_BATCH_SIZE,
  APPROVED_PARENT_CAMPAIGNS,
  BUILD_APPLY_BATCHES_CODE,
  CONFIRMATION_PHRASE,
  MEMBER_QUERY_CODE,
  NORMALIZE_CODE,
  VERIFY_CODE,
  buildWorkflow,
} from '../../scripts/build-salesforce-campaign-member-daily-workflow.mjs';

type JsonItem = { json: Record<string, unknown> };

function executeNormalize(sourceRows: Record<string, unknown>[]): JsonItem[] {
  const cfg = {
    mode: 'dry_run',
    confirmation: '',
    required_confirmation: CONFIRMATION_PHRASE,
    timezone: 'America/Denver',
    supabase_project_url: 'https://PASTE_SUPABASE_PROJECT_REF_HERE.supabase.co',
    parent_by_id: {
      '701000000000002AAA': '2026 - Content Syndication',
      '701000000000004AAA': '2026 - Website',
    },
  };
  const dollar = (name: string) => {
    if (name !== 'Build complete CampaignMember query') throw new Error(`unexpected node ${name}`);
    return { first: () => ({ json: cfg }) };
  };
  const fn = new Function('$input', '$', NORMALIZE_CODE) as (
    input: { all: () => JsonItem[] },
    lookup: typeof dollar,
  ) => JsonItem[];
  return fn(
    { all: () => sourceRows.map((json) => ({ json })) },
    dollar,
  );
}

function sourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: '00v000000000001AAA',
    CreatedDate: '2026-08-11T01:02:03.000Z',
    SystemModstamp: '2026-08-11T02:03:04.000Z',
    CampaignId: '701000000000001AAA',
    'Campaign.Name': '2026 - Content Syndication - P&C',
    'Campaign.ParentId': '701000000000002AAA',
    ContactId: '003000000000001AAA',
    LeadId: null,
    'Contact.Email': 'FAST.MQL@EXAMPLE.TEST',
    'Contact.FirstName': 'Synthetic',
    'Contact.LastName': 'Fixture',
    'Contact.Title': 'Tester',
    'Contact.AccountId': '001000000000001AAA',
    'Contact.Account.Name': 'Example Test',
    'Contact.LeadSource': 'Content Syndication',
    'Contact.MailingCountry': 'United States',
    'Contact.Hubspot_lead_lifecycle__c': 'Marketing Qualified Lead',
    ...overrides,
  };
}

describe('Salesforce CampaignMember daily workflow', () => {
  it('keeps the approved scope explicit and excludes deal-only Sales', () => {
    expect(APPROVED_PARENT_CAMPAIGNS).toEqual([
      '2026 - Content Syndication',
      '2026 - Email',
      '2026 - Events',
      '2026 - Marketing SDR',
      '2026 - Website',
    ]);
    expect(APPROVED_PARENT_CAMPAIGNS.some((name) => /sales generated|new logo/i.test(name))).toBe(false);
  });

  it('counts a person first observed as MQL as both one Lead and one MQL membership', () => {
    const [item] = executeNormalize([sourceRow()]);
    expect(item.json.lead_memberships).toBe(1);
    expect(item.json.mql_memberships).toBe(1);
    expect(item.json.eligible_memberships).toBe(1);
    expect((item.json._private_rows as Record<string, unknown>[])[0]).toMatchObject({
      current_stage: 'mql',
      campaign_member_id: '00v000000000001AAA',
      touch_date: '2026-08-11',
      sfdc_account_id: '001000000000001AAA',
    });
  });

  it('keeps one person in multiple child campaigns, including across parent families', () => {
    const [item] = executeNormalize([
      sourceRow(),
      sourceRow({
        Id: '00v000000000002AAA',
        CampaignId: '701000000000003AAA',
        'Campaign.Name': '2026 - Website - Book a Call',
        'Campaign.ParentId': '701000000000004AAA',
      }),
    ]);
    expect(item.json.lead_memberships).toBe(2);
    expect(item.json.mql_memberships).toBe(2);
    expect(item.json.distinct_people).toBe(1);
    expect(item.json._private_rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        parent_campaign: '2026 - Content Syndication',
        sub_campaign: '2026 - Content Syndication - P&C',
      }),
      expect.objectContaining({
        parent_campaign: '2026 - Website',
        sub_campaign: '2026 - Website - Book a Call',
      }),
    ]));
  });

  it('surfaces rows without email instead of inventing an identity', () => {
    const [item] = executeNormalize([sourceRow(), sourceRow({
      Id: '00v000000000002AAA',
      'Contact.Email': '',
    })]);
    expect(item.json.source_memberships).toBe(2);
    expect(item.json.eligible_memberships).toBe(1);
    expect(item.json.skipped_memberships).toBe(1);
    expect(item.json.skipped_by_reason).toMatchObject({ missing_email: 1 });
  });

  it('fails closed on duplicate CampaignMember identities', () => {
    expect(() => executeNormalize([sourceRow(), sourceRow()])).toThrow(
      'duplicate CampaignMember Id',
    );
  });

  it('is disabled, credential-free, unpinned, and scheduled in Denver', () => {
    const workflow = buildWorkflow();
    expect(workflow.active).toBe(false);
    expect(workflow.pinData).toEqual({});
    expect(workflow.settings.timezone).toBe('America/Denver');
    const schedule = workflow.nodes.find((node) => node.type === 'n8n-nodes-base.scheduleTrigger');
    expect(schedule?.name).toBe('Daily 11:50 PM America/Denver');
    expect(schedule?.parameters).toMatchObject({
      rule: { interval: [{ triggerAtHour: 23, triggerAtMinute: 50 }] },
    });
    expect(workflow.nodes.every((node) => !('credentials' in node))).toBe(true);
    const serialized = JSON.stringify(workflow);
    expect(serialized).not.toMatch(/service[_-]?role|eyJ[A-Za-z0-9_-]+\./i);
  });

  it('does a full approved-scope read with the confirmed lifecycle field', () => {
    const workflow = buildWorkflow();
    const queryBuilder = workflow.nodes.find((node) => node.name === 'Build complete CampaignMember query');
    const code = String(queryBuilder?.parameters.jsCode ?? '');
    expect(code).toContain('Contact.Hubspot_lead_lifecycle__c');
    expect(code).toContain('Lead.Hubspot_lead_lifecycle__c');
    expect(code).toContain('Contact.AccountId');
    expect(code).toContain('Lead.ConvertedAccountId');
    expect(code).not.toContain('Hubspot_Lifecycle_Stage__c');
    expect(code).not.toContain('LIMIT 5000');
    expect(code).not.toContain('minus({days: 2})');
    expect(code).toContain('Campaign.ParentId IN');
  });

  it('builds executable SOQL from every approved parent without a hard limit', () => {
    const cfg = {
      approved_parent_campaigns: APPROVED_PARENT_CAMPAIGNS,
    };
    const parentRows = APPROVED_PARENT_CAMPAIGNS.map((Name, index) => ({
      json: { Id: `7010000000000${String(index + 1).padStart(2, '0')}AAA`, Name },
    }));
    const lookup = () => ({ first: () => ({ json: cfg }) });
    const fn = new Function('$input', '$', MEMBER_QUERY_CODE) as (
      input: { all: () => JsonItem[] },
      dollar: typeof lookup,
    ) => JsonItem[];
    const [result] = fn({ all: () => parentRows }, lookup);
    const query = String(result.json.member_query);
    expect(query).toContain('FROM CampaignMember WHERE Campaign.ParentId IN');
    expect(query).toContain('Contact.Hubspot_lead_lifecycle__c');
    expect(query).toContain('Contact.AccountId');
    expect(query).toContain('Lead.ConvertedAccountId');
    expect(query).not.toContain('LIMIT');
    expect(Object.keys(result.json.parent_by_id as object)).toHaveLength(5);
  });

  it('keeps the write node behind an exact two-part apply gate', () => {
    const workflow = buildWorkflow();
    const config = workflow.nodes.find((node) => node.name === 'CONFIG: scope and closed apply gate');
    const code = String(config?.parameters.jsCode ?? '');
    expect(code).toContain("const MODE = 'dry_run'");
    expect(code).toContain("const CONFIRM = ''");
    expect(code).toContain(CONFIRMATION_PHRASE);
    expect(workflow.connections['IF: exact apply authorization'].main[0][0].node).toBe(
      'Build 100-row apply batches',
    );
    expect(workflow.connections['IF: exact apply authorization'].main[1][0].node).toBe(
      'DRY RUN: aggregate reconciliation',
    );
    const apply = workflow.nodes.find((node) => node.name === 'APPLY: campaign members to Sourced');
    expect(String(apply?.parameters.url)).toContain('sourced_apply_sfdc_campaign_members_v2');
  });

  it('plans finite 100-row batches that reconcile to the authorized payload', () => {
    expect(APPLY_BATCH_SIZE).toBe(100);
    const rows = Array.from({ length: 2618 }, (_, index) => ({
      current_stage: index < 541 ? 'mql' : 'lead',
      campaign_member_id: `synthetic-${index}`,
    }));
    const fn = new Function('$input', BUILD_APPLY_BATCHES_CODE) as (
      input: { first: () => JsonItem },
    ) => JsonItem[];
    const batches = fn({ first: () => ({ json: { apply_authorized: true, _private_rows: rows } }) });
    expect(batches).toHaveLength(27);
    expect(batches.slice(0, 26).every((item) => item.json.batch_size === 100)).toBe(true);
    expect(batches[26].json.batch_size).toBe(18);
    expect(batches.reduce((sum, item) => sum + Number(item.json.batch_size), 0)).toBe(2618);
    expect(batches.reduce((sum, item) => sum + Number(item.json.batch_mql_memberships), 0)).toBe(541);
  });

  it('fails batching closed without both authorization and a payload', () => {
    const fn = new Function('$input', BUILD_APPLY_BATCHES_CODE) as (
      input: { first: () => JsonItem },
    ) => JsonItem[];
    expect(() => fn({ first: () => ({ json: { apply_authorized: false, _private_rows: [{}] } }) }))
      .toThrow('authorized non-empty payload');
    expect(() => fn({ first: () => ({ json: { apply_authorized: true, _private_rows: [] } }) }))
      .toThrow('authorized non-empty payload');
  });

  it('serializes apply batches through the loop output and aggregates every v2 response', () => {
    const workflow = buildWorkflow();
    expect(workflow.connections['Loop apply batches sequentially'].main[0][0].node).toBe(
      'VERIFY: applied counts',
    );
    expect(workflow.connections['Loop apply batches sequentially'].main[1][0].node).toBe(
      'APPLY: campaign members to Sourced',
    );
    expect(workflow.connections['APPLY: campaign members to Sourced'].main[0][0].node).toBe(
      'Loop apply batches sequentially',
    );
    const apply = workflow.nodes.find((node) => node.name === 'APPLY: campaign members to Sourced');
    expect(String(apply?.parameters.jsonBody)).toContain('$json._private_rows');

    const request = {
      source_memberships: 2634,
      eligible_memberships: 2618,
      skipped_memberships: 16,
      skipped_by_reason: { missing_email: 16 },
      mql_memberships: 541,
      lead_memberships: 2618,
      distinct_people: 2573,
      by_parent_campaign: {},
    };
    const responses = Array.from({ length: 27 }, (_, index) => {
      const processed = index === 26 ? 18 : 100;
      const mql = index === 26 ? 0 : index < 5 ? 100 : index === 5 ? 41 : 0;
      return { json: {
        status: 'applied', contract_version: 2,
        processed_memberships: processed, mql_memberships: mql,
        inserted_leads: 0, updated_leads: processed,
        inserted_touches: 0, updated_touches: processed,
        backfill_seeds_superseded: 0,
      } };
    });
    const dollar = (name: string) => {
      if (name !== 'Normalize, validate, and reconcile') throw new Error(`unexpected node ${name}`);
      return { first: () => ({ json: request }) };
    };
    const fn = new Function('$input', '$', VERIFY_CODE) as (
      input: { all: () => JsonItem[] },
      lookup: typeof dollar,
    ) => JsonItem[];
    const [verified] = fn({ all: () => responses }, dollar);
    expect(verified.json.status).toBe('APPLY_COMPLETE');
    expect(verified.json.database_result).toMatchObject({
      contract_version: 2,
      batches_completed: 27,
      processed_memberships: 2618,
      mql_memberships: 541,
    });
  });

  it('has a generated artifact identical to the builder output', () => {
    const generated = JSON.parse(
      readFileSync(resolve('src/generated/salesforceCampaignMemberDaily.workflow.json'), 'utf8'),
    );
    expect(generated).toEqual(buildWorkflow());
  });
});

describe('sourced_apply_sfdc_campaign_members migration', () => {
  const sql = readFileSync(
    resolve('migrations/2026-08-11_sfdc_campaign_member_daily_apply.sql'),
    'utf8',
  );

  it('records the verified applied status and creates no business rows when merely applied', () => {
    expect(sql).toContain('Applied manually to production on 2026-08-11');
    expect(sql).toContain('processed 2,614 eligible memberships');
    expect(sql).toContain('excluded 16 missing-email rows');
    expect(sql).not.toContain('PENDING / NOT YET APPLIED');
    expect(sql).not.toMatch(/INSERT INTO public\.(leads|lead_campaign_touches)\s*SELECT/i);
  });

  it('atomically writes both people and membership touches', () => {
    expect(sql).toContain('INSERT INTO public.leads');
    expect(sql).toContain('INSERT INTO public.lead_campaign_touches');
    expect(sql).toContain('ON CONFLICT (campaign_member_id)');
    expect(sql).toContain('channel_id, touch_date');
    expect(sql).toContain('v_campaign_id, v_channel_id, v_touch_date');
    expect(sql).toContain('AND c.parent_channel_id = v_parent_channel_id');
    expect(sql).toContain("source = 'backfill'");
  });

  it('preserves MQL evidence for a fast conversion', () => {
    expect(sql).toContain("WHEN v_current_stage = 'mql'");
    expect(sql).toContain("'stage', 'mql'");
    expect(sql).toContain("h->>'stage' = 'mql'");
  });

  it('uses a restricted server identity', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = pg_catalog');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members(JSONB) FROM PUBLIC');
    expect(sql).toContain('FROM anon');
    expect(sql).toContain('FROM authenticated');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sourced_apply_sfdc_campaign_members(JSONB) TO service_role');
  });
});

describe('account identity and lifecycle provenance migration', () => {
  const sql = readFileSync(
    resolve('migrations/2026-08-12_funnel_account_identity_and_lifecycle_provenance.sql'),
    'utf8',
  );

  it('records its true applied status and adds exact account identities', () => {
    expect(sql).toContain('Applied manually to production on 2026-08-12');
    expect(sql).toContain('26');
    expect(sql).toContain('zero left unclassified');
    expect(sql).not.toContain('PENDING / NOT YET APPLIED');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS sfdc_account_id TEXT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS account_id TEXT');
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it('records baseline and transition provenance without replacing the proven apply', () => {
    expect(sql).toContain('public.sourced_apply_sfdc_campaign_members(p_rows)');
    expect(sql).toContain("THEN 'transition' ELSE 'baseline'");
    expect(sql).toContain("'event_kind', 'baseline'");
    expect(sql).toContain("AT TIME ZONE 'America/Denver'");
    expect(sql).toContain('existing person carries a different Salesforce Account identity');
  });

  it('keeps both versioned boundaries service-role only', () => {
    for (const fn of [
      'sourced_apply_sfdc_campaign_members_v2(JSONB)',
      'sf_apply_opportunity_ingestion_v3(JSONB, JSONB, JSONB, JSONB)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role`);
    }
  });
});

describe('CampaignMember v2 set-based timeout hardening', () => {
  const sql = readFileSync(
    resolve('migrations/2026-08-12_campaign_member_v2_set_based_hardening.sql'),
    'utf8',
  );
  const functionBody = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.sourced_apply_sfdc_campaign_members_v2'),
    sql.indexOf('REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2'),
  );

  it('records the applied status and replaces only the v2 wrapper', () => {
    expect(sql).toContain('STATUS: Applied manually to production on 2026-08-12');
    expect(sql).not.toContain('PENDING / NOT YET APPLIED');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sourced_apply_sfdc_campaign_members_v2');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.sourced_apply_sfdc_campaign_members(');
    expect(sql).not.toMatch(/ALTER TABLE|INSERT INTO public\.(leads|lead_campaign_touches)/i);
  });

  it('keeps v1 authoritative and performs no per-membership PL/pgSQL loop', () => {
    expect(functionBody).toContain('public.sourced_apply_sfdc_campaign_members(p_rows)');
    expect(functionBody).toContain('DROP TABLE IF EXISTS pg_temp._sourced_cm_v2_people');
    expect(functionBody).toContain('CREATE TEMP TABLE _sourced_cm_v2_people');
    expect(functionBody).toContain('UPDATE public.leads AS l');
    expect(functionBody).not.toMatch(/FOR\s+v_rec\s+IN/i);
  });

  it('preserves identity refusal and lifecycle provenance', () => {
    expect(functionBody).toContain('one email carries conflicting Salesforce Account identities');
    expect(functionBody).toContain('existing person carries a different Salesforce Account identity');
    expect(functionBody).toContain("WHEN incoming.prior_state = 'lead' THEN 'transition'");
    expect(functionBody).toContain("ELSE 'baseline'");
    expect(functionBody).toContain("AT TIME ZONE 'America/Denver'");
  });

  it('remains service-role only', () => {
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) FROM PUBLIC');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) FROM anon');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) FROM authenticated');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.sourced_apply_sfdc_campaign_members_v2(JSONB) TO service_role');
  });
});
