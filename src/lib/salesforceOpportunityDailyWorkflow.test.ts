import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = JSON.parse(readFileSync(
  resolve(process.cwd(), 'src/generated/salesforceOpportunityDaily.workflow.json'),
  'utf8',
)) as {
  active: boolean;
  settings: { timezone?: string };
  pinData: Record<string, unknown>;
  nodes: Array<{
    name: string;
    type: string;
    parameters: Record<string, unknown>;
    credentials?: unknown;
    executeOnce?: boolean;
    alwaysOutputData?: boolean;
  }>;
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
};

const byName = (name: string) => workflow.nodes.find((node) => node.name === name)!;

describe('Salesforce Opportunity daily workflow', () => {
  it('is disabled and uses the mandatory 11:50 PM America/Denver schedule', () => {
    expect(workflow.active).toBe(false);
    expect(workflow.settings.timezone).toBe('America/Denver');
    expect(workflow.pinData).toEqual({});
    expect(workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.manualTrigger')).toHaveLength(1);
    const schedule = byName('Daily 11:50 PM America/Denver');
    expect(schedule.parameters).toEqual({
      rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 23, triggerAtMinute: 50 }] },
    });
  });

  it('queries only the approved 2025-2026 New Project population', () => {
    const query = String(byName('READ: 2025-2026 New Project opportunities').parameters.query);
    expect(query).toContain('CreatedDate >= 2025-01-01T00:00:00Z');
    expect(query).toContain('CreatedDate < 2027-01-01T00:00:00Z');
    expect(query).toContain("RecordType.DeveloperName IN ('High_Potential_Prospect','Leads','Licensing')");
    expect(query).toContain("Existing_Customer_or_New_Business__c = 'New Project'");
    expect(query).toContain('CreatedById, CreatedBy.Name');
    expect(query).toContain('AccountId, Account.Name');
    for (const field of ['Market__c', 'Commercial_Region__c', 'GTM_Cube__c', 'Amount',
      'SaaS_Revenue__c', 'SaaS_Revenue_USD__c']) {
      expect(query).toContain(field);
    }
  });

  it('reads complete RecordType and Stage history once for the same approved population', () => {
    const refs = byName('READ: Opportunity RecordType references');
    const history = byName('READ: complete Opportunity movement history');
    expect(String(refs.parameters.query)).toContain("SobjectType = 'Opportunity'");
    expect(refs.executeOnce).toBe(true);
    const query = String(history.parameters.query);
    expect(query).toContain('FROM OpportunityFieldHistory');
    expect(query).toContain("Field IN ('RecordType','StageName')");
    expect(query).toContain("Opportunity.Existing_Customer_or_New_Business__c = 'New Project'");
    expect(history.executeOnce).toBe(true);
    expect(history.alwaysOutputData).toBe(true);
    const planner = String(byName('AUTHORITATIVE: plan staging and review').parameters.jsCode);
    expect(planner).toContain('historyRecords');
    expect(planner).toContain('recordTypeRefs');
  });

  it('uses the generated authoritative planner bundle instead of copying rules into n8n', () => {
    const code = String(byName('AUTHORITATIVE: plan staging and review').parameters.jsCode);
    expect(code).toContain('OpportunityDailyRuntime.planOpportunityDailyRun');
    expect(code).toContain('primary_revenue_field');
    expect(code).not.toContain("const newLogoBusinessTypes = new Set");
  });

  it('defaults to dry run and requires two exact apply confirmations', () => {
    const config = String(byName('CONFIG: closed by default').parameters.jsCode);
    const gate = String(byName('APPLY GATE: exact confirmation').parameters.jsCode);
    expect(config).toContain("const MODE = 'dry_run'");
    expect(config).toContain("const CONFIRM = ''");
    expect(config).toContain('APPLY 2025-2026 NEW PROJECT OPPORTUNITIES');
    expect(gate).toContain("cfg.mode !== 'apply'");
    expect(gate).toContain('cfg.confirm !== cfg.required_confirmation');
    expect(gate).toContain('planned.apply_authorized !== true');
    expect(gate).toContain('planned.reconciliation_complete !== true');
  });

  it('keeps dry run structurally separate from the apply RPC', () => {
    const route = workflow.connections['ROUTE: dry run or apply'].main;
    expect(route[0].map((edge) => edge.node)).toEqual(['APPLY GATE: exact confirmation']);
    expect(route[1].map((edge) => edge.node)).toEqual(['DRY RUN: aggregate summary']);
    expect(workflow.connections['DRY RUN: aggregate summary']).toBeUndefined();
    const dryCode = String(byName('DRY RUN: aggregate summary').parameters.jsCode);
    expect(dryCode).toContain('apply_executed: false');
    expect(dryCode).toContain('const { _private_apply_payload, ...summary }');
  });

  it('uses native credentialed nodes with no embedded credentials', () => {
    expect(byName('READ: 2025-2026 New Project opportunities').type).toBe('n8n-nodes-base.salesforce');
    expect(byName('READ: protected opportunity state').parameters.genericAuthType).toBe('httpHeaderAuth');
    expect(byName('APPLY: opportunity staging v5').parameters.genericAuthType).toBe('httpHeaderAuth');
    expect(workflow.nodes.every((node) => node.credentials === undefined)).toBe(true);
    const raw = JSON.stringify(workflow);
    expect(raw).toContain('https://rsyjxtuatrwtqajjkgvd.supabase.co');
    expect(raw).not.toMatch(/service_role|Bearer\s+[A-Za-z0-9]/i);
    const config = String(byName('CONFIG: closed by default').parameters.jsCode);
    expect(config).toContain('[a-z0-9-]+\\.supabase\\.co$');
    expect(JSON.stringify(workflow)).toContain('sf_apply_opportunity_ingestion_v5');
    expect(String(byName('VERIFY: staging apply').parameters.jsCode))
      .toContain('result.contract_version !== 5');
    expect(byName('REFRESH: approved Opportunity reporting').parameters.genericAuthType)
      .toBe('httpHeaderAuth');
    expect(String(byName('REFRESH: approved Opportunity reporting').parameters.url))
      .toContain('sf_refresh_all_approved_opportunity_reporting');
  });

  it('emits executable dry-run configuration with the known project URL', () => {
    const config = String(byName('CONFIG: closed by default').parameters.jsCode);
    expect(() => new Function('$now', config)).not.toThrow();
    const result = new Function('$now', config)({
      toISO: () => '2026-08-12T12:00:00.000Z',
    }) as Array<{ json: { mode: string; apply_authorized: boolean } }>;
    expect(result[0].json).toMatchObject({ mode: 'dry_run', apply_authorized: false });
  });

  it('has no Google Sheet or browser-facing database node', () => {
    expect(workflow.nodes.some((node) => node.type.toLowerCase().includes('googlesheet'))).toBe(false);
    expect(workflow.nodes.some((node) => node.type.toLowerCase().includes('supabase'))).toBe(false);
  });

  it('binds the applied v4 owner-label repair migration without weakening ordinary conflicts', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'migrations/2026-08-12_opportunity_owner_label_upgrade.sql'),
      'utf8',
    );
    expect(sql).toContain('sf_apply_opportunity_ingestion_v4');
    expect(sql).toContain('public.sf_apply_opportunity_ingestion_v3');
    expect(sql).toContain("opportunity_owner = v_item->>'legacy_owner_user_id'");
    expect(sql).toContain("content_hash = v_item->>'prior_content_hash'");
    expect(sql).toContain("sf_last_modified_at = (v_item->>'sf_last_modified_at')::TIMESTAMPTZ");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.sf_apply_opportunity_ingestion_v4");
    expect(sql).toContain('TO service_role');
    expect(sql).toContain('FROM PUBLIC');
    expect(sql).toContain('STATUS: Applied manually to production on 2026-08-12');
    expect(sql).toContain('this migration invoked no RPC');
    expect(sql).not.toContain('PENDING / NOT YET APPLIED');
  });

  it('binds the applied v5 snapshot-shape repair and its account preconditions', () => {
    const sql = readFileSync(
      resolve(process.cwd(), 'migrations/2026-08-12_opportunity_snapshot_shape_upgrade.sql'),
      'utf8',
    );
    expect(sql).toContain('sf_apply_opportunity_ingestion_v5');
    expect(sql).toContain('public.sf_apply_opportunity_ingestion_v3');
    expect(sql).toContain("v_repair_kind = 'owner_and_account_shape' AND account_id IS NULL");
    expect(sql).toContain('account_id IS NOT DISTINCT FROM v_account_id');
    expect(sql).toContain("content_hash = v_item->>'prior_content_hash'");
    expect(sql).toContain('TO service_role');
    expect(sql).toContain('FROM PUBLIC');
    expect(sql).toContain('STATUS: Applied manually to production on 2026-08-12');
    expect(sql).toContain('this migration invoked no RPC');
    expect(sql).not.toContain('PENDING / NOT YET APPLIED');
  });
});
