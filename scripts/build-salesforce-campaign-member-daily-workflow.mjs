import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(
  root,
  'src/generated/salesforceCampaignMemberDaily.workflow.json',
);

export const APPROVED_PARENT_CAMPAIGNS = [
  '2026 - Content Syndication',
  '2026 - Email',
  '2026 - Events',
  '2026 - Marketing SDR',
  '2026 - Website',
];

export const CONFIRMATION_PHRASE =
  'APPLY APPROVED SALESFORCE CAMPAIGN MEMBERS TO SOURCED';

export const APPLY_BATCH_SIZE = 100;

const CONFIG_CODE = `// This is the only node whose values are edited before activation.
// Keep MODE at dry_run until the migration is applied and the aggregate
// reconciliation has been reviewed. Never paste a Supabase key into this node.
const MODE = 'dry_run';
const CONFIRM = '';
const SUPABASE_PROJECT_URL = 'https://PASTE_SUPABASE_PROJECT_REF_HERE.supabase.co';
const APPROVED_PARENT_CAMPAIGNS = ${JSON.stringify(APPROVED_PARENT_CAMPAIGNS, null, 2)};
const REQUIRED_CONFIRMATION = ${JSON.stringify(CONFIRMATION_PHRASE)};

if (!['dry_run', 'apply'].includes(MODE)) {
  throw new Error('CONFIG FAILED: MODE must be dry_run or apply.');
}
if (!Array.isArray(APPROVED_PARENT_CAMPAIGNS) || APPROVED_PARENT_CAMPAIGNS.length === 0) {
  throw new Error('CONFIG FAILED: approved parent campaigns are required.');
}
if (new Set(APPROVED_PARENT_CAMPAIGNS).size !== APPROVED_PARENT_CAMPAIGNS.length) {
  throw new Error('CONFIG FAILED: approved parent campaign names must be unique.');
}
if (MODE === 'apply') {
  if (CONFIRM !== REQUIRED_CONFIRMATION) {
    throw new Error('CONFIG FAILED: apply mode requires the exact confirmation phrase.');
  }
  if (!/^https:\\/\\/[a-z0-9-]+\\.supabase\\.co$/.test(SUPABASE_PROJECT_URL)) {
    throw new Error('CONFIG FAILED: enter the Supabase project URL without a path or trailing slash.');
  }
}

const quote = (value) => "'" + String(value).replaceAll("'", "\\\\'") + "'";
const parentQuery =
  'SELECT Id, Name FROM Campaign WHERE Name IN (' +
  APPROVED_PARENT_CAMPAIGNS.map(quote).join(',') +
  ') ORDER BY Name ASC';

return [{ json: {
  mode: MODE,
  confirmation: CONFIRM,
  required_confirmation: REQUIRED_CONFIRMATION,
  supabase_project_url: SUPABASE_PROJECT_URL,
  timezone: 'America/Denver',
  approved_parent_campaigns: APPROVED_PARENT_CAMPAIGNS,
  parent_query: parentQuery,
  writes_attempted: 0
} }];`;

export const MEMBER_QUERY_CODE = `const cfg = $('CONFIG: scope and closed apply gate').first().json;
const expected = cfg.approved_parent_campaigns;
const rows = $input.all().map((item) => item.json);

const get = (obj, key) => {
  if (obj && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  return key.split('.').reduce((cur, part) =>
    cur && typeof cur === 'object' ? cur[part] : undefined, obj);
};
const byName = new Map();
for (const row of rows) {
  const id = String(get(row, 'Id') || '').trim();
  const name = String(get(row, 'Name') || '').trim();
  if (id && name) byName.set(name, id);
}
const missing = expected.filter((name) => !byName.has(name));
if (missing.length > 0) {
  throw new Error('SCOPE FAILED: approved parent campaign(s) not found: ' + missing.join(', '));
}
const parentById = Object.fromEntries(expected.map((name) => [byName.get(name), name]));
const quote = (value) => "'" + String(value).replaceAll("'", "\\\\'") + "'";
const ids = Object.keys(parentById).sort();
const query = [
  'SELECT Id, CreatedDate, SystemModstamp, CampaignId, Campaign.Name, Campaign.ParentId,',
  'ContactId, LeadId, Contact.Email, Contact.FirstName, Contact.LastName,',
  'Contact.Title, Contact.AccountId, Contact.Account.Name, Contact.LeadSource, Contact.MailingCountry,',
  'Contact.Hubspot_lead_lifecycle__c, Lead.Email, Lead.FirstName, Lead.LastName,',
  'Lead.Title, Lead.Company, Lead.ConvertedAccountId, Lead.LeadSource, Lead.Country,',
  'Lead.Hubspot_lead_lifecycle__c',

  'FROM CampaignMember',
  'WHERE Campaign.ParentId IN (' + ids.map(quote).join(',') + ')',
  'ORDER BY CampaignId ASC, Id ASC'
].join(' ');

return [{ json: { ...cfg, parent_by_id: parentById, member_query: query } }];`;

export const NORMALIZE_CODE = `const cfg = $('Build complete CampaignMember query').first().json;
const sourceItems = $input.all();

const COUNTRY_TO_REGION = {
  'united states':'NA','usa':'NA','us':'NA','canada':'NA','mexico':'NA','bermuda':'NA',
  'france':'EMEA cont & LATAM','germany':'EMEA cont & LATAM','switzerland':'EMEA cont & LATAM',
  'belgium':'EMEA cont & LATAM','netherlands':'EMEA cont & LATAM','italy':'EMEA cont & LATAM',
  'spain':'EMEA cont & LATAM','finland':'EMEA cont & LATAM','sweden':'EMEA cont & LATAM',
  'norway':'EMEA cont & LATAM','denmark':'EMEA cont & LATAM','portugal':'EMEA cont & LATAM',
  'poland':'EMEA cont & LATAM','south africa':'EMEA cont & LATAM','brazil':'EMEA cont & LATAM',
  'argentina':'EMEA cont & LATAM','chile':'EMEA cont & LATAM','colombia':'EMEA cont & LATAM',
  'united kingdom':'UK&IRE, ME, Japan','uk':'UK&IRE, ME, Japan','ireland':'UK&IRE, ME, Japan',
  'united arab emirates':'UK&IRE, ME, Japan','uae':'UK&IRE, ME, Japan',
  'saudi arabia':'UK&IRE, ME, Japan','japan':'UK&IRE, ME, Japan','india':'UK&IRE, ME, Japan',
  'china':'UK&IRE, ME, Japan','australia':'UK&IRE, ME, Japan','new zealand':'UK&IRE, ME, Japan',
  'singapore':'UK&IRE, ME, Japan','malaysia':'UK&IRE, ME, Japan','fiji':'UK&IRE, ME, Japan'
};
const KNOWN_LIFECYCLE = new Set([
  '', 'Lead', 'Marketing Qualified Lead', 'Prospect', 'Customer',
  'Opportunity', 'Sales Qualified Lead', 'Subscriber'
]);
const get = (obj, ...keys) => {
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key];
      if (value !== null && value !== undefined && value !== '') return value;
    }
    const nested = key.split('.').reduce((cur, part) =>
      cur && typeof cur === 'object' ? cur[part] : undefined, obj);
    if (nested !== null && nested !== undefined && nested !== '') return nested;
  }
  return null;
};
const clean = (value) => value === null || value === undefined ? '' : String(value).trim();
const sfid = (value) => /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(clean(value));
const dateOnly = (value) => {
  const match = /^(\\d{4}-\\d{2}-\\d{2})/.exec(clean(value));
  return match ? match[1] : null;
};
const regionFor = (country) => {
  const key = clean(country).toLowerCase();
  return key ? (COUNTRY_TO_REGION[key] || 'Other') : null;
};
const mqlStage = (label) => label === 'Marketing Qualified Lead' || label === 'Opportunity';

const seenMembers = new Set();
const rows = [];
const skipped = { missing_email:0, missing_identity:0, missing_member_id:0, missing_campaign_id:0, missing_touch_date:0, malformed_id:0 };
const unknownLifecycle = {};
const byParent = {};

for (const item of sourceItems) {
  const source = item.json;
  const memberId = clean(get(source, 'Id'));
  const campaignId = clean(get(source, 'CampaignId'));
  const parentId = clean(get(source, 'Campaign.ParentId'));
  const parentCampaign = clean(cfg.parent_by_id[parentId]);
  const subCampaign = clean(get(source, 'Campaign.Name'));
  const contactId = clean(get(source, 'ContactId')) || null;
  const leadId = clean(get(source, 'LeadId')) || null;
  const accountId = clean(get(source, 'Contact.AccountId', 'Lead.ConvertedAccountId')) || null;
  const email = clean(get(source, 'Contact.Email', 'Lead.Email')).toLowerCase();
  const touchDate = dateOnly(get(source, 'CreatedDate'));

  if (!memberId) { skipped.missing_member_id += 1; continue; }
  if (!campaignId || !parentCampaign || !subCampaign) { skipped.missing_campaign_id += 1; continue; }
  if (!touchDate) { skipped.missing_touch_date += 1; continue; }
  if (!contactId && !leadId) { skipped.missing_identity += 1; continue; }
  if (!sfid(memberId) || !sfid(campaignId) || (contactId && !sfid(contactId)) || (leadId && !sfid(leadId)) || (accountId && !sfid(accountId))) {
    skipped.malformed_id += 1; continue;
  }
  if (!email) { skipped.missing_email += 1; continue; }
  if (seenMembers.has(memberId)) {
    throw new Error('RECONCILIATION FAILED: duplicate CampaignMember Id in Salesforce response.');
  }
  seenMembers.add(memberId);

  const country = clean(get(source, 'Contact.MailingCountry', 'Lead.Country'));
  const lifecycle = clean(get(
    source,
    'Contact.Hubspot_lead_lifecycle__c',
    'Lead.Hubspot_lead_lifecycle__c'
  ));
  if (!KNOWN_LIFECYCLE.has(lifecycle)) {
    unknownLifecycle[lifecycle || '(blank)'] = (unknownLifecycle[lifecycle || '(blank)'] || 0) + 1;
  }
  const currentStage = mqlStage(lifecycle) ? 'mql' : 'lead';
  const parentStats = byParent[parentCampaign] || { source_memberships:0, eligible_memberships:0, mql_memberships:0 };
  parentStats.eligible_memberships += 1;
  if (currentStage === 'mql') parentStats.mql_memberships += 1;
  byParent[parentCampaign] = parentStats;

  rows.push({
    campaign_member_id: memberId,
    campaign_id: campaignId,
    parent_campaign: parentCampaign,
    sub_campaign: subCampaign,
    touch_date: touchDate,
    observed_at: new Date().toISOString(),
    source_modified_at: clean(get(source, 'SystemModstamp')) || null,
    email,
    first_name: clean(get(source, 'Contact.FirstName', 'Lead.FirstName')),
    last_name: clean(get(source, 'Contact.LastName', 'Lead.LastName')),
    account: clean(get(source, 'Contact.Account.Name', 'Lead.Company')),
    title: clean(get(source, 'Contact.Title', 'Lead.Title')),
    country,
    region: regionFor(country),
    lead_source: clean(get(source, 'Contact.LeadSource', 'Lead.LeadSource')),
    lifecycle_label: lifecycle,
    current_stage: currentStage,
    sfdc_contact_id: contactId,
    sfdc_lead_id: leadId,
    sfdc_account_id: accountId
  });
}

for (const item of sourceItems) {
  const parentId = clean(get(item.json, 'Campaign.ParentId'));
  const parent = clean(cfg.parent_by_id[parentId]);
  if (!parent) continue;
  const stats = byParent[parent] || { source_memberships:0, eligible_memberships:0, mql_memberships:0 };
  stats.source_memberships += 1;
  byParent[parent] = stats;
}

rows.sort((a,b) => a.touch_date.localeCompare(b.touch_date) || a.campaign_member_id.localeCompare(b.campaign_member_id));
const skippedTotal = Object.values(skipped).reduce((sum, value) => sum + value, 0);
const mqlMemberships = rows.filter((row) => row.current_stage === 'mql').length;
if (rows.length + skippedTotal !== sourceItems.length) {
  throw new Error('RECONCILIATION FAILED: eligible plus skipped does not equal the Salesforce response.');
}
if (mqlMemberships > rows.length) {
  throw new Error('RECONCILIATION FAILED: MQL memberships exceed Lead memberships.');
}
if (rows.length === 0) {
  throw new Error('RECONCILIATION FAILED: the approved campaign scope returned no eligible memberships.');
}

const applyAuthorized = cfg.mode === 'apply' && cfg.confirmation === cfg.required_confirmation;
return [{ json: {
  mode: cfg.mode,
  apply_authorized: applyAuthorized,
  writes_attempted: 0,
  timezone: cfg.timezone,
  source_memberships: sourceItems.length,
  eligible_memberships: rows.length,
  skipped_memberships: skippedTotal,
  skipped_by_reason: skipped,
  mql_memberships: mqlMemberships,
  lead_memberships: rows.length,
  distinct_people: new Set(rows.map((row) => row.sfdc_contact_id || row.sfdc_lead_id)).size,
  unknown_lifecycle_values: unknownLifecycle,
  by_parent_campaign: byParent,
  reconciliation_complete: true,
  cohort_rule: 'Every eligible CampaignMember counts as Lead; current or previously stored MQL evidence makes the same membership count as MQL too.',
  _private_rows: rows,
  _private_supabase_url: cfg.supabase_project_url
} }];`;

const DRY_RUN_CODE = `const value = $input.first().json;
const { _private_rows, _private_supabase_url, ...summary } = value;
return [{ json: {
  status: 'DRY_RUN_COMPLETE',
  dry_run: true,
  apply_payload_created: false,
  ...summary
} }];`;

export const BUILD_APPLY_BATCHES_CODE = `const request = $input.first().json;
const rows = request._private_rows;
const BATCH_SIZE = ${APPLY_BATCH_SIZE};
if (request.apply_authorized !== true || !Array.isArray(rows) || rows.length === 0) {
  throw new Error('APPLY BATCHING FAILED: an authorized non-empty payload is required.');
}
const batches = [];
for (let start = 0; start < rows.length; start += BATCH_SIZE) {
  const batchRows = rows.slice(start, start + BATCH_SIZE);
  batches.push({
    batch_index: batches.length,
    batch_size: batchRows.length,
    batch_mql_memberships: batchRows.filter((row) => row.current_stage === 'mql').length,
    batches_expected: Math.ceil(rows.length / BATCH_SIZE),
    _private_rows: batchRows
  });
}
if (batches.reduce((sum, batch) => sum + batch.batch_size, 0) !== rows.length) {
  throw new Error('APPLY BATCHING FAILED: planned rows do not reconcile.');
}
return batches.map((batch) => ({ json: batch }));`;

export const VERIFY_CODE = `const request = $('Normalize, validate, and reconcile').first().json;
const responses = $input.all().map((item) => {
  const value = item.json;
  return Array.isArray(value) ? value[0] : value;
});
const expectedBatches = Math.ceil(Number(request.eligible_memberships) / ${APPLY_BATCH_SIZE});
if (responses.length !== expectedBatches) {
  throw new Error('APPLY VERIFICATION FAILED: completed batch count does not match the plan.');
}
const totals = {
  processed_memberships: 0,
  mql_memberships: 0,
  inserted_leads: 0,
  updated_leads: 0,
  inserted_touches: 0,
  updated_touches: 0,
  backfill_seeds_superseded: 0
};
for (const result of responses) {
  if (!result || result.status !== 'applied' || Number(result.contract_version) !== 2) {
    throw new Error('APPLY VERIFICATION FAILED: a batch did not confirm the v2 contract.');
  }
  for (const key of Object.keys(totals)) {
    const value = Number(result[key]);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('APPLY VERIFICATION FAILED: a batch returned an invalid ' + key + '.');
    }
    totals[key] += value;
  }
}
if (totals.processed_memberships !== Number(request.eligible_memberships)) {
  throw new Error('APPLY VERIFICATION FAILED: processed membership count does not match the reconciled payload.');
}
if (totals.mql_memberships !== Number(request.mql_memberships)) {
  throw new Error('APPLY VERIFICATION FAILED: MQL membership count does not match the reconciled payload.');
}
return [{ json: {
  status: 'APPLY_COMPLETE',
  dry_run: false,
  source_memberships: request.source_memberships,
  eligible_memberships: request.eligible_memberships,
  skipped_memberships: request.skipped_memberships,
  skipped_by_reason: request.skipped_by_reason,
  mql_memberships: request.mql_memberships,
  lead_memberships: request.lead_memberships,
  distinct_people: request.distinct_people,
  by_parent_campaign: request.by_parent_campaign,
  reconciliation_complete: true,
  database_result: {
    status: 'applied',
    contract_version: 2,
    batches_completed: responses.length,
    ...totals
  }
} }];`;

const node = (id, name, type, typeVersion, position, parameters) => ({
  id,
  name,
  type,
  typeVersion,
  position,
  parameters,
});

export function buildWorkflow() {
  const nodes = [
    node('manual-trigger', 'Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, [0, 80], {}),
    node('schedule-trigger', 'Daily 11:50 PM America/Denver', 'n8n-nodes-base.scheduleTrigger', 1.3, [0, -80], {
      rule: { interval: [{ triggerAtHour: 23, triggerAtMinute: 50 }] },
    }),
    node('config', 'CONFIG: scope and closed apply gate', 'n8n-nodes-base.code', 2, [240, 0], {
      mode: 'runOnceForAllItems',
      jsCode: CONFIG_CODE,
    }),
    node('query-parents', 'Query approved parent campaigns', 'n8n-nodes-base.salesforce', 1, [500, 0], {
      resource: 'search',
      query: "={{ $('CONFIG: scope and closed apply gate').first().json.parent_query }}",
    }),
    node('build-member-query', 'Build complete CampaignMember query', 'n8n-nodes-base.code', 2, [760, 0], {
      mode: 'runOnceForAllItems',
      jsCode: MEMBER_QUERY_CODE,
    }),
    node('query-members', 'Query all approved CampaignMembers', 'n8n-nodes-base.salesforce', 1, [1020, 0], {
      resource: 'search',
      query: "={{ $json.member_query }}",
    }),
    node('normalize', 'Normalize, validate, and reconcile', 'n8n-nodes-base.code', 2, [1280, 0], {
      mode: 'runOnceForAllItems',
      jsCode: NORMALIZE_CODE,
    }),
    node('apply-if', 'IF: exact apply authorization', 'n8n-nodes-base.if', 2.2, [1540, 0], {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          id: 'apply-authorized',
          leftValue: '={{ $json.apply_authorized }}',
          rightValue: true,
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
        combinator: 'and',
      },
      options: {},
    }),
    node('build-apply-batches', 'Build 100-row apply batches', 'n8n-nodes-base.code', 2, [1800, -100], {
      mode: 'runOnceForAllItems',
      jsCode: BUILD_APPLY_BATCHES_CODE,
    }),
    node('loop-apply-batches', 'Loop apply batches sequentially', 'n8n-nodes-base.splitInBatches', 3, [2060, -100], {
      batchSize: 1,
      options: {},
    }),
    node('apply-rpc', 'APPLY: campaign members to Sourced', 'n8n-nodes-base.httpRequest', 4.4, [2320, -100], {
      method: 'POST',
      url: "={{ $('Normalize, validate, and reconcile').first().json._private_supabase_url + '/rest/v1/rpc/sourced_apply_sfdc_campaign_members_v2' }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ p_rows: $json._private_rows }) }}",
      options: {},
    }),
    node('verify', 'VERIFY: applied counts', 'n8n-nodes-base.code', 2, [2320, -260], {
      mode: 'runOnceForAllItems',
      jsCode: VERIFY_CODE,
    }),
    node('dry-run', 'DRY RUN: aggregate reconciliation', 'n8n-nodes-base.code', 2, [1800, 100], {
      mode: 'runOnceForAllItems',
      jsCode: DRY_RUN_CODE,
    }),
  ];

  return {
    name: '[Sourced] - Salesforce Campaign Members Daily Sync - DISABLED',
    nodes,
    pinData: {},
    connections: {
      'Manual Trigger': { main: [[{ node: 'CONFIG: scope and closed apply gate', type: 'main', index: 0 }]] },
      'Daily 11:50 PM America/Denver': { main: [[{ node: 'CONFIG: scope and closed apply gate', type: 'main', index: 0 }]] },
      'CONFIG: scope and closed apply gate': { main: [[{ node: 'Query approved parent campaigns', type: 'main', index: 0 }]] },
      'Query approved parent campaigns': { main: [[{ node: 'Build complete CampaignMember query', type: 'main', index: 0 }]] },
      'Build complete CampaignMember query': { main: [[{ node: 'Query all approved CampaignMembers', type: 'main', index: 0 }]] },
      'Query all approved CampaignMembers': { main: [[{ node: 'Normalize, validate, and reconcile', type: 'main', index: 0 }]] },
      'Normalize, validate, and reconcile': { main: [[{ node: 'IF: exact apply authorization', type: 'main', index: 0 }]] },
      'IF: exact apply authorization': { main: [
        [{ node: 'Build 100-row apply batches', type: 'main', index: 0 }],
        [{ node: 'DRY RUN: aggregate reconciliation', type: 'main', index: 0 }],
      ] },
      'Build 100-row apply batches': { main: [[{ node: 'Loop apply batches sequentially', type: 'main', index: 0 }]] },
      'Loop apply batches sequentially': { main: [
        [{ node: 'VERIFY: applied counts', type: 'main', index: 0 }],
        [{ node: 'APPLY: campaign members to Sourced', type: 'main', index: 0 }],
      ] },
      'APPLY: campaign members to Sourced': { main: [[{ node: 'Loop apply batches sequentially', type: 'main', index: 0 }]] },
    },
    active: false,
    settings: {
      executionOrder: 'v1',
      timezone: 'America/Denver',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
    },
    versionId: '5e6c0c21-4df7-4dc0-8b62-e56e23015a31',
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

export async function writeWorkflow() {
  const workflow = buildWorkflow();
  const serialized = `${JSON.stringify(workflow, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const existing = await readFile(outputPath, 'utf8').catch(() => '');
    if (existing !== serialized) {
      throw new Error('Generated Salesforce daily workflow is stale. Run npm run build:salesforce-daily-workflow.');
    }
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  await writeWorkflow();
}
