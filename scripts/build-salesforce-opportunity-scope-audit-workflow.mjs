import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(
  root,
  'src/generated/salesforceOpportunityScopeAudit.workflow.json',
);

export const REPORTING_YEARS = [2025, 2026];
export const INCLUDED_RECORD_TYPES = [
  'High_Potential_Prospect',
  'Leads',
  'Licensing',
];
export const BDR_IDENTITIES = [
  {
    key: 'dave_cummins',
    acceptedNames: ['David Cummins', 'Dave Cummins'],
  },
  {
    key: 'garrett_mcnally',
    acceptedNames: ['Garrett McNally'],
  },
];

export const CONFIG_CODE = `// Disabled, read-only Opportunity scope audit.
// Edit nothing except the BDR aliases if Salesforce uses a different exact
// display name. This workflow has no write node and no schedule.
const REPORTING_YEARS = ${JSON.stringify(REPORTING_YEARS)};
const INCLUDED_RECORD_TYPES = ${JSON.stringify(INCLUDED_RECORD_TYPES)};
const BDR_IDENTITIES = ${JSON.stringify(BDR_IDENTITIES, null, 2)};

if (!Array.isArray(REPORTING_YEARS) || REPORTING_YEARS.length !== 2 ||
    REPORTING_YEARS.some((year) => !Number.isInteger(year))) {
  throw new Error('CONFIG FAILED: exactly two integer reporting years are required.');
}
if (new Set(REPORTING_YEARS).size !== REPORTING_YEARS.length) {
  throw new Error('CONFIG FAILED: reporting years must be unique.');
}
if (!Array.isArray(INCLUDED_RECORD_TYPES) || INCLUDED_RECORD_TYPES.length !== 3) {
  throw new Error('CONFIG FAILED: the three approved Opportunity record types are required.');
}
if (!Array.isArray(BDR_IDENTITIES) || BDR_IDENTITIES.length !== 2) {
  throw new Error('CONFIG FAILED: exactly two approved BDR identities are required.');
}
for (const identity of BDR_IDENTITIES) {
  if (!identity.key || !Array.isArray(identity.acceptedNames) || identity.acceptedNames.length === 0) {
    throw new Error('CONFIG FAILED: every BDR identity needs a key and at least one exact name.');
  }
}

const quote = (value) => "'" + String(value).replaceAll("'", "\\\\'") + "'";
const names = [...new Set(BDR_IDENTITIES.flatMap((identity) => identity.acceptedNames))];
const userQuery = [
  'SELECT Id, Name, IsActive FROM User',
  'WHERE IsActive = true AND Name IN (' + names.map(quote).join(',') + ')',
  'ORDER BY Name ASC'
].join(' ');

return [{ json: {
  dry_run: true,
  writes_attempted: 0,
  timezone: 'America/Denver',
  reporting_years: REPORTING_YEARS,
  included_record_types: INCLUDED_RECORD_TYPES,
  bdr_identities: BDR_IDENTITIES,
  user_query: userQuery
} }];`;

export const VALIDATE_BDR_CODE = `const cfg = $('CONFIG: 2025-2026 scope').first().json;
const rows = $input.all().map((item) => item.json).filter((row) => row && row.Id);
const clean = (value) => String(value == null ? '' : value).replace(/[\\u200b\\u200c\\u200d\\ufeff]/g, '').trim();
const sfid = (value) => /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(clean(value));
const resolved = {};
const claimedIds = new Set();

for (const identity of cfg.bdr_identities) {
  const accepted = new Set(identity.acceptedNames.map(clean));
  const matches = rows.filter((row) => row.IsActive !== false && accepted.has(clean(row.Name)));
  if (matches.length !== 1) {
    throw new Error('BDR RESOLUTION FAILED: ' + identity.key + ' resolved to ' + matches.length + ' active Salesforce users.');
  }
  const id = clean(matches[0].Id);
  if (!sfid(id)) throw new Error('BDR RESOLUTION FAILED: Salesforce returned a malformed User Id.');
  const canonical = id.length === 18 ? id.slice(0, 15) : id;
  if (claimedIds.has(canonical)) throw new Error('BDR RESOLUTION FAILED: two configured BDRs resolved to the same User.');
  claimedIds.add(canonical);
  resolved[identity.key] = id;
}

return [{ json: { ...cfg, approved_bdr_user_ids: resolved } }];`;

export const RESOLVE_FIELDS_CODE = `const cfg = $('VALIDATE: exact BDR users').first().json;
const rows = $input.all().map((item) => item.json).filter((row) => row && row.QualifiedApiName);
const clean = (value) => String(value == null ? '' : value).replace(/[\\u200b\\u200c\\u200d\\ufeff]/g, '').trim();
const byApiName = new Map(rows.map((row) => [clean(row.QualifiedApiName), row]));
const marketMatches = rows.filter((row) => clean(row.Label).toLowerCase() === 'market');
if (marketMatches.length !== 1) {
  throw new Error('FIELD DISCOVERY FAILED: Opportunity label Market resolved to ' + marketMatches.length + ' fields; never guessing an API name.');
}
const marketField = clean(marketMatches[0].QualifiedApiName);
if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(marketField)) {
  throw new Error('FIELD DISCOVERY FAILED: Market API name has an unsafe shape.');
}
const required = [
  'Id','Name','AccountId','RecordTypeId','StageName','IsClosed','IsWon',
  'CreatedDate','SystemModstamp','Amount','CurrencyIsoCode','CloseDate',
  'OwnerId','CampaignId','CreatedById','Commercial_Region__c','GTM_Cube__c',
  'Existing_Customer_or_New_Business__c','SaaS_Revenue__c','SaaS_Revenue_USD__c'
];
const missing = required.filter((field) => !byApiName.has(field));
if (missing.length > 0) {
  throw new Error('FIELD DISCOVERY FAILED: required Opportunity fields absent: ' + missing.join(', '));
}

const years = [...cfg.reporting_years].sort((a, b) => a - b);
const start = years[0] + '-01-01T00:00:00Z';
const end = (years[years.length - 1] + 1) + '-01-01T00:00:00Z';
const quote = (value) => "'" + String(value).replaceAll("'", "\\\\'") + "'";
const query = [
  'SELECT Id, Name, AccountId, Account.Name, RecordType.DeveloperName, RecordType.Name,',
  'StageName, IsClosed, IsWon, CreatedDate, LastModifiedDate, SystemModstamp,',
  'Amount, CurrencyIsoCode, CloseDate, OwnerId, Owner.Name, CampaignId, Campaign.Name,',
  'CreatedById, CreatedBy.Name, Commercial_Region__c, GTM_Cube__c,',
  'Existing_Customer_or_New_Business__c, SaaS_Revenue__c, SaaS_Revenue_USD__c,',
  marketField,
  'FROM Opportunity',
  'WHERE CreatedDate >= ' + start,
  'AND CreatedDate < ' + end,
  'AND RecordType.DeveloperName IN (' + cfg.included_record_types.map(quote).join(',') + ')',
  'ORDER BY CreatedDate ASC, Id ASC'
].join(' ');

return [{ json: {
  ...cfg,
  market_field_api_name: marketField,
  opportunity_query: query,
  query_start_utc: start,
  query_end_utc_exclusive: end
} }];`;

export const AGGREGATE_CODE = `const cfg = $('RESOLVE: Market field and build query').first().json;
const sourceItems = $input.all();
const clean = (value) => String(value == null ? '' : value).replace(/[\\u200b\\u200c\\u200d\\ufeff]/g, '').trim();
const get = (obj, key) => {
  if (obj && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  return key.split('.').reduce((cur, part) => cur && typeof cur === 'object' ? cur[part] : undefined, obj);
};
const sfid = (value) => /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/.test(clean(value));
const canonicalId = (value) => {
  const id = clean(value);
  return id.length === 18 ? id.slice(0, 15) : id;
};
const present = (value) => value !== null && value !== undefined && clean(value) !== '';
const dateYear = (value) => {
  const match = /^(\\d{4})-\\d{2}-\\d{2}T/.exec(clean(value));
  return match ? Number(match[1]) : null;
};

const approvedByCanonicalId = new Map();
for (const [key, id] of Object.entries(cfg.approved_bdr_user_ids)) {
  const canonical = canonicalId(id);
  if (!sfid(id) || !canonical) throw new Error('RECONCILIATION FAILED: invalid approved BDR User Id.');
  if (approvedByCanonicalId.has(canonical)) throw new Error('RECONCILIATION FAILED: duplicate approved BDR User Id.');
  approvedByCanonicalId.set(canonical, key);
}

const stageByRecordType = {
  High_Potential_Prospect: 'hpp',
  Leads: 'opp',
  Licensing: 'pursuit'
};
const configuredYears = new Set(cfg.reporting_years);
const seen = new Set();
const excluded = {
  missing_new_logo_value: 0,
  existing_customer_or_expansion: 0,
  unrecognized_business_type: 0,
  outside_configured_years: 0,
  invalid_source_row: 0
};
const byYear = Object.fromEntries(cfg.reporting_years.map((year) => [String(year), 0]));
const byEligibleStage = { hpp: 0, opp: 0, pursuit: 0 };
const byOpenStage = { hpp: 0, opp: 0, pursuit: 0 };
const byCreator = Object.fromEntries([
  ...cfg.bdr_identities.map((identity) => identity.key),
  'other_creator',
  'missing_creator'
].map((key) => [key, 0]));
const coverage = {
  market: { populated: 0, missing: 0 },
  commercial_region: { populated: 0, missing: 0 },
  gtm_cube: { populated: 0, missing: 0 },
  amount: { populated: 0, missing: 0 },
  saas_revenue: { populated: 0, missing: 0 },
  saas_revenue_usd: { populated: 0, missing: 0 }
};
let eligible = 0;
let open = 0;
let closed = 0;
let won = 0;
let closedNotWon = 0;
let bdrGenerated = 0;
let campaignEvidencePresent = 0;

for (const item of sourceItems) {
  const row = item.json || {};
  const id = clean(get(row, 'Id'));
  if (!sfid(id)) { excluded.invalid_source_row += 1; continue; }
  const canonicalOppId = canonicalId(id);
  if (seen.has(canonicalOppId)) throw new Error('RECONCILIATION FAILED: duplicate Opportunity Id in Salesforce response.');
  seen.add(canonicalOppId);

  const year = dateYear(get(row, 'CreatedDate'));
  if (year === null || !configuredYears.has(year)) { excluded.outside_configured_years += 1; continue; }
  const devName = clean(get(row, 'RecordType.DeveloperName'));
  const stage = stageByRecordType[devName];
  if (!stage) { excluded.invalid_source_row += 1; continue; }

  const businessType = clean(get(row, 'Existing_Customer_or_New_Business__c'));
  if (!businessType) { excluded.missing_new_logo_value += 1; continue; }
  if (['Existing Customer','Expansion','Existing Customer or Expansion','Customer Expansion'].includes(businessType)) {
    excluded.existing_customer_or_expansion += 1; continue;
  }
  if (!['New Logo','New Business'].includes(businessType)) {
    excluded.unrecognized_business_type += 1; continue;
  }

  eligible += 1;
  byYear[String(year)] += 1;
  byEligibleStage[stage] += 1;
  const isClosed = get(row, 'IsClosed') === true;
  const isWon = get(row, 'IsWon') === true;
  if (isClosed) {
    closed += 1;
    if (isWon) won += 1; else closedNotWon += 1;
  } else {
    open += 1;
    byOpenStage[stage] += 1;
  }

  const creatorRaw = clean(get(row, 'CreatedById'));
  const creatorKey = creatorRaw
    ? (approvedByCanonicalId.get(canonicalId(creatorRaw)) || 'other_creator')
    : 'missing_creator';
  byCreator[creatorKey] += 1;
  if (creatorKey !== 'other_creator' && creatorKey !== 'missing_creator') bdrGenerated += 1;
  if (present(get(row, 'CampaignId'))) campaignEvidencePresent += 1;

  const values = {
    market: get(row, cfg.market_field_api_name),
    commercial_region: get(row, 'Commercial_Region__c'),
    gtm_cube: get(row, 'GTM_Cube__c'),
    amount: get(row, 'Amount'),
    saas_revenue: get(row, 'SaaS_Revenue__c'),
    saas_revenue_usd: get(row, 'SaaS_Revenue_USD__c')
  };
  for (const [field, value] of Object.entries(values)) {
    coverage[field][present(value) ? 'populated' : 'missing'] += 1;
  }
}

const skipped = Object.values(excluded).reduce((sum, value) => sum + value, 0);
if (eligible + skipped !== sourceItems.length) {
  throw new Error('RECONCILIATION FAILED: eligible plus excluded does not equal the Salesforce response.');
}
if (open + closed !== eligible || won + closedNotWon !== closed) {
  throw new Error('RECONCILIATION FAILED: current-pipeline and terminal counts do not reconcile.');
}
if (Object.values(byYear).reduce((sum, value) => sum + value, 0) !== eligible) {
  throw new Error('RECONCILIATION FAILED: year totals do not reconcile.');
}
if (Object.values(byEligibleStage).reduce((sum, value) => sum + value, 0) !== eligible) {
  throw new Error('RECONCILIATION FAILED: record-type totals do not reconcile.');
}
if (Object.values(byOpenStage).reduce((sum, value) => sum + value, 0) !== open) {
  throw new Error('RECONCILIATION FAILED: open-pipeline record-type totals do not reconcile.');
}
for (const value of Object.values(coverage)) {
  if (value.populated + value.missing !== eligible) {
    throw new Error('RECONCILIATION FAILED: field coverage does not reconcile.');
  }
}

return [{ json: {
  status: 'SCOPE_AUDIT_COMPLETE',
  dry_run: true,
  writes_attempted: 0,
  workflow_active: false,
  timezone: cfg.timezone,
  reporting_years: cfg.reporting_years,
  query_start_utc: cfg.query_start_utc,
  query_end_utc_exclusive: cfg.query_end_utc_exclusive,
  market_field_api_name: cfg.market_field_api_name,
  source_opportunities: sourceItems.length,
  eligible_new_logo_opportunities: eligible,
  excluded_opportunities: skipped,
  excluded_by_reason: excluded,
  current_pipeline: {
    open_opportunities: open,
    by_current_record_type: byOpenStage
  },
  closed_history: {
    closed_opportunities: closed,
    won_opportunities: won,
    closed_not_won_opportunities: closedNotWon
  },
  by_created_year: byYear,
  all_eligible_by_current_record_type: byEligibleStage,
  by_creator: byCreator,
  bdr_generated_opportunities: bdrGenerated,
  review_queue: {
    candidates_requiring_source_review: eligible,
    marketing_sdr_preselected_pending_approval: bdrGenerated,
    source_unassigned_pending_review: eligible - bdrGenerated,
    primary_campaign_evidence_present: campaignEvidencePresent,
    primary_campaign_evidence_missing: eligible - campaignEvidencePresent
  },
  field_coverage: coverage,
  revenue_policy: {
    primary_visible_field: 'Amount',
    stored_hidden_fields: ['SaaS_Revenue__c','SaaS_Revenue_USD__c']
  },
  overwrite_policy: {
    rule: 'manual_override_wins',
    overrideable_fields: ['market','commercial_region','gtm_cube','source_channel'],
    source_values_refresh_without_clearing_manual_overrides: true
  },
  reporting_lens: 'current_pipeline_only',
  reconciliation_complete: true
} }];`;

export const GUARD_CODE = `const summary = $input.first().json;
if (summary.status !== 'SCOPE_AUDIT_COMPLETE' || summary.dry_run !== true || summary.writes_attempted !== 0) {
  throw new Error('GUARD FAILED: the scope audit did not finish in read-only mode.');
}
if (summary.reconciliation_complete !== true) {
  throw new Error('GUARD FAILED: reconciliation is incomplete.');
}
if (summary.review_queue.candidates_requiring_source_review !== summary.eligible_new_logo_opportunities) {
  throw new Error('GUARD FAILED: every eligible Opportunity must enter source review.');
}
const serialized = JSON.stringify(summary);
if (/[A-Za-z0-9]{15}([A-Za-z0-9]{3})?/.test(serialized) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i.test(serialized)) {
  throw new Error('GUARD FAILED: an identifier or email leaked into the aggregate terminal.');
}
return [{ json: summary }];`;

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
    node('manual-trigger', 'Manual Trigger', 'n8n-nodes-base.manualTrigger', 1, [0, 0], {}),
    node('config', 'CONFIG: 2025-2026 scope', 'n8n-nodes-base.code', 2, [240, 0], {
      mode: 'runOnceForAllItems',
      jsCode: CONFIG_CODE,
    }),
    node('query-users', 'READ ONLY: Resolve approved BDR users', 'n8n-nodes-base.salesforce', 1, [500, 0], {
      resource: 'search',
      query: "={{ $json.user_query }}",
    }),
    node('validate-users', 'VALIDATE: exact BDR users', 'n8n-nodes-base.code', 2, [760, 0], {
      mode: 'runOnceForAllItems',
      jsCode: VALIDATE_BDR_CODE,
    }),
    node('describe-fields', 'READ ONLY: Describe Opportunity fields', 'n8n-nodes-base.salesforce', 1, [1020, 0], {
      resource: 'search',
      query: "SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Opportunity' ORDER BY QualifiedApiName ASC",
    }),
    node('resolve-fields', 'RESOLVE: Market field and build query', 'n8n-nodes-base.code', 2, [1280, 0], {
      mode: 'runOnceForAllItems',
      jsCode: RESOLVE_FIELDS_CODE,
    }),
    node('query-opportunities', 'PRIVATE: Read candidate Opportunities - DO NOT SHARE', 'n8n-nodes-base.salesforce', 1, [1540, 0], {
      resource: 'search',
      query: '={{ $json.opportunity_query }}',
    }),
    node('aggregate', 'Aggregate and reconcile scope', 'n8n-nodes-base.code', 2, [1800, 0], {
      mode: 'runOnceForAllItems',
      jsCode: AGGREGATE_CODE,
    }),
    node('guard', 'GUARD: aggregate-only scope audit', 'n8n-nodes-base.code', 2, [2060, 0], {
      mode: 'runOnceForAllItems',
      jsCode: GUARD_CODE,
    }),
  ];

  return {
    name: '[Sourced] - Salesforce Opportunity Scope Audit - READ ONLY - DISABLED',
    nodes,
    pinData: {},
    connections: {
      'Manual Trigger': { main: [[{ node: 'CONFIG: 2025-2026 scope', type: 'main', index: 0 }]] },
      'CONFIG: 2025-2026 scope': { main: [[{ node: 'READ ONLY: Resolve approved BDR users', type: 'main', index: 0 }]] },
      'READ ONLY: Resolve approved BDR users': { main: [[{ node: 'VALIDATE: exact BDR users', type: 'main', index: 0 }]] },
      'VALIDATE: exact BDR users': { main: [[{ node: 'READ ONLY: Describe Opportunity fields', type: 'main', index: 0 }]] },
      'READ ONLY: Describe Opportunity fields': { main: [[{ node: 'RESOLVE: Market field and build query', type: 'main', index: 0 }]] },
      'RESOLVE: Market field and build query': { main: [[{ node: 'PRIVATE: Read candidate Opportunities - DO NOT SHARE', type: 'main', index: 0 }]] },
      'PRIVATE: Read candidate Opportunities - DO NOT SHARE': { main: [[{ node: 'Aggregate and reconcile scope', type: 'main', index: 0 }]] },
      'Aggregate and reconcile scope': { main: [[{ node: 'GUARD: aggregate-only scope audit', type: 'main', index: 0 }]] },
    },
    active: false,
    settings: {
      executionOrder: 'v1',
      timezone: 'America/Denver',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
    },
    versionId: '6d3046c0-565f-4fe8-ae66-58f5f05d6294',
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
      throw new Error('Generated Opportunity scope workflow is stale. Run npm run build:opportunity-scope-workflow.');
    }
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  await writeWorkflow();
}
