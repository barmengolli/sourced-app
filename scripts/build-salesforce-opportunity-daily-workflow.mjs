import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'src/generated/salesforceOpportunityDaily.workflow.json');
const bundle = await readFile(path.join(root, 'src/generated/opportunityDailyRuntime.bundle.js'), 'utf8');
const check = process.argv.includes('--check');

const CONFIRM = 'APPLY 2025-2026 NEW PROJECT OPPORTUNITIES';
const SOQL = [
  'SELECT Id, Name, AccountId, Account.Name, RecordType.DeveloperName, RecordType.Name,',
  'StageName, IsClosed, IsWon, CreatedDate, LastModifiedDate, SystemModstamp,',
  'Amount, CurrencyIsoCode, CloseDate, OwnerId, CampaignId, CreatedById, CreatedBy.Name,',
  'Market__c, Commercial_Region__c, GTM_Cube__c,',
  'Existing_Customer_or_New_Business__c, SaaS_Revenue__c, SaaS_Revenue_USD__c',
  'FROM Opportunity',
  "WHERE CreatedDate >= 2025-01-01T00:00:00Z AND CreatedDate < 2027-01-01T00:00:00Z",
  "AND RecordType.DeveloperName IN ('High_Potential_Prospect','Leads','Licensing')",
  "AND Existing_Customer_or_New_Business__c = 'New Project'",
  'ORDER BY CreatedDate ASC, Id ASC',
].join(' ');

const configCode = `// This is the only ordinary configuration node.
const MODE = 'dry_run';
const CONFIRM = '';
const SUPABASE_PROJECT_URL = 'https://PASTE_PROJECT_REF_HERE.supabase.co';
const REQUIRED_CONFIRMATION = ${JSON.stringify(CONFIRM)};
if (!['dry_run','apply'].includes(MODE)) throw new Error('CONFIG FAILED: invalid mode.');
const VALID_PROJECT_URL = SUPABASE_PROJECT_URL.startsWith('https://')
  && /^[a-z0-9-]+\\.supabase\\.co$/.test(SUPABASE_PROJECT_URL.slice('https://'.length));
if (!VALID_PROJECT_URL || SUPABASE_PROJECT_URL.includes('PASTE_PROJECT_REF_HERE')) {
  throw new Error('CONFIG FAILED: replace the Supabase project URL placeholder; never paste a key here.');
}
return [{ json: {
  mode: MODE,
  confirm: CONFIRM,
  required_confirmation: REQUIRED_CONFIRMATION,
  apply_authorized: MODE === 'apply' && CONFIRM === REQUIRED_CONFIRMATION,
  timezone: 'America/Denver',
  run_started_at: $now.toISO(),
  reporting_years: [2025, 2026],
  included_business_type_api_values: ['New Project'],
  supabase_project_url: SUPABASE_PROJECT_URL
} }];`;

const plannerCode = `${bundle}
const cfg = $('CONFIG: closed by default').first().json;
const state = $('READ: protected opportunity state').first().json;
const opportunities = $input.all().map((item) => item.json);
const result = OpportunityDailyRuntime.planOpportunityDailyRun({
  opportunities,
  existingState: state,
  runStartedAt: cfg.run_started_at,
  reportingYears: cfg.reporting_years,
  includedBusinessTypeApiValues: cfg.included_business_type_api_values
});
if (result.summary.reconciliation_complete !== true) {
  throw new Error('PLANNER FAILED: source rows did not reconcile.');
}
return [{ json: {
  ...result.summary,
  mode: cfg.mode,
  apply_authorized: cfg.apply_authorized,
  _private_apply_payload: result.payload
} }];`;

const dryCode = `const planned = $input.first().json;
const { _private_apply_payload, ...summary } = planned;
if (summary.mode !== 'dry_run' || summary.apply_authorized !== false) {
  throw new Error('DRY RUN FAILED: apply authorization was not closed.');
}
return [{ json: {
  ...summary,
  status: 'DRY_RUN_COMPLETE',
  dry_run: true,
  writes_attempted: 0,
  apply_payload_created: true,
  apply_executed: false
} }];`;

const prepareCode = `const planned = $input.first().json;
const cfg = $('CONFIG: closed by default').first().json;
if (cfg.mode !== 'apply' || cfg.confirm !== cfg.required_confirmation
    || planned.apply_authorized !== true || planned.reconciliation_complete !== true) {
  throw new Error('APPLY GATE CLOSED: two exact confirmations and complete reconciliation are required.');
}
if (!planned._private_apply_payload) throw new Error('APPLY GATE CLOSED: payload missing.');
return [{ json: planned._private_apply_payload }];`;

const verifyCode = `const result = $input.first().json;
if (result.ok !== true || result.contract_version !== 3) {
  throw new Error('APPLY FAILED: database did not confirm the v3 contract.');
}
return [{ json: {
  status: 'APPLY_COMPLETE',
  dry_run: false,
  writes_attempted: 1,
  snapshots_applied: result.snapshots_applied,
  snapshots_stale_skipped: result.snapshots_stale_skipped,
  reviews_created: result.reviews_created,
  reviews_reconciled: result.reviews_reconciled,
  contract_version: result.contract_version
} }];`;

const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({
  id, name, type, typeVersion, position, parameters, ...extra,
});

const nodes = [
  node('manual', 'Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, [0, -80], {}),
  node('schedule', 'Daily 11:50 PM America/Denver', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 100], {
    rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 23, triggerAtMinute: 50 }] },
  }),
  node('config', 'CONFIG: closed by default', 'n8n-nodes-base.code', 2, [240, 0], {
    mode: 'runOnceForAllItems', jsCode: configCode,
  }),
  node('read-state', 'READ: protected opportunity state', 'n8n-nodes-base.httpRequest', 4.4, [500, 0], {
    method: 'POST',
    url: "={{ $('CONFIG: closed by default').first().json.supabase_project_url + '/rest/v1/rpc/sf_read_opportunity_ingestion_state' }}",
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({}) }}', options: {},
  }),
  node('query-opps', 'READ: 2025-2026 New Project opportunities', 'n8n-nodes-base.salesforce', 1, [780, 0], {
    resource: 'search', query: SOQL,
  }),
  node('planner', 'AUTHORITATIVE: plan staging and review', 'n8n-nodes-base.code', 2, [1060, 0], {
    mode: 'runOnceForAllItems', jsCode: plannerCode,
  }),
  node('if-apply', 'ROUTE: dry run or apply', 'n8n-nodes-base.if', 2.2, [1340, 0], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'apply-authorized', leftValue: '={{ $json.apply_authorized }}', rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      combinator: 'and',
    }, options: {},
  }),
  node('dry', 'DRY RUN: aggregate summary', 'n8n-nodes-base.code', 2, [1620, 120], {
    mode: 'runOnceForAllItems', jsCode: dryCode,
  }),
  node('prepare', 'APPLY GATE: exact confirmation', 'n8n-nodes-base.code', 2, [1620, -120], {
    mode: 'runOnceForAllItems', jsCode: prepareCode,
  }),
  node('apply', 'APPLY: opportunity staging v3', 'n8n-nodes-base.httpRequest', 4.4, [1900, -120], {
    method: 'POST',
    url: "={{ $('CONFIG: closed by default').first().json.supabase_project_url + '/rest/v1/rpc/sf_apply_opportunity_ingestion_v3' }}",
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json) }}', options: {},
  }),
  node('verify', 'VERIFY: apply result', 'n8n-nodes-base.code', 2, [2180, -120], {
    mode: 'runOnceForAllItems', jsCode: verifyCode,
  }),
];

const workflow = {
  name: '[Sourced] - Salesforce Opportunity Daily Staging - DISABLED',
  nodes,
  connections: {
    'Manual Trigger': { main: [[{ node: 'CONFIG: closed by default', type: 'main', index: 0 }]] },
    'Daily 11:50 PM America/Denver': { main: [[{ node: 'CONFIG: closed by default', type: 'main', index: 0 }]] },
    'CONFIG: closed by default': { main: [[{ node: 'READ: protected opportunity state', type: 'main', index: 0 }]] },
    'READ: protected opportunity state': { main: [[{ node: 'READ: 2025-2026 New Project opportunities', type: 'main', index: 0 }]] },
    'READ: 2025-2026 New Project opportunities': { main: [[{ node: 'AUTHORITATIVE: plan staging and review', type: 'main', index: 0 }]] },
    'AUTHORITATIVE: plan staging and review': { main: [[{ node: 'ROUTE: dry run or apply', type: 'main', index: 0 }]] },
    'ROUTE: dry run or apply': { main: [
      [{ node: 'APPLY GATE: exact confirmation', type: 'main', index: 0 }],
      [{ node: 'DRY RUN: aggregate summary', type: 'main', index: 0 }],
    ] },
    'APPLY GATE: exact confirmation': { main: [[{ node: 'APPLY: opportunity staging v3', type: 'main', index: 0 }]] },
    'APPLY: opportunity staging v3': { main: [[{ node: 'VERIFY: apply result', type: 'main', index: 0 }]] },
  },
  pinData: {},
  active: false,
  settings: { executionOrder: 'v1', timezone: 'America/Denver' },
  versionId: '00000000-0000-4000-8000-000000000812',
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

const rendered = `${JSON.stringify(workflow, null, 2)}\n`;
if (check) {
  const committed = await readFile(output, 'utf8').catch(() => '');
  if (committed !== rendered) throw new Error('Opportunity daily workflow drifted; rebuild it.');
} else {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, rendered);
}
