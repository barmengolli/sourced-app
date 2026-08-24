import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const outputPath = resolve(
  'artifacts/[Sourced] - Outreach Daily Activity Ingestion v3 - DISABLED.json',
);

const googleSheetId = '1OT2q0JF0mfvOFkSfHWyBUJKTt68fDzHlrSew2IWzvEo';
const googleSheetTab = 'Daily Sequence Activity v3';

const qaColumns = [
  'snapshot_key', 'snapshot_date', 'activity_basis', 'timezone',
  'window_start_utc', 'window_end_utc', 'collected_at', 'source_name',
  'sequence_id', 'sequence_name', 'sequence_created_at', 'sequence_created_date',
  'enabled', 'step_count', 'duration_days', 'prospects_enrolled',
  'prospects_active', 'total_sent', 'delivered', 'bounced', 'failed',
  'opened', 'clicked', 'replied', 'positive_replies', 'neutral_replies',
  'negative_replies', 'opted_out', 'outbound_calls',
  'linkedin_tasks_completed', 'expected_sequence_count',
  'pagination_complete', 'natural_keys_unique',
];

const prepareWindowCode = String.raw`// CLOSED DAILY WINDOW.
// Leave TARGET_DATE blank for the prior America/Denver calendar day.
// Set YYYY-MM-DD only for a controlled manual backfill.
const TARGET_DATE = '';
const TIMEZONE = 'America/Denver';

const partsInZone = (instant) => Object.fromEntries(
  new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, Number(part.value)]),
);

const zonedMidnightUtc = (year, month, day) => {
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  let candidate = desired;
  for (let pass = 0; pass < 2; pass += 1) {
    const seen = partsInZone(new Date(candidate));
    const seenAsUtc = Date.UTC(
      seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second,
    );
    candidate = desired - (seenAsUtc - candidate);
  }
  return new Date(candidate);
};

let targetDate = TARGET_DATE;
if (!targetDate) {
  const localNow = partsInZone(new Date());
  const previous = new Date(
    Date.UTC(localNow.year, localNow.month - 1, localNow.day) - 86400000,
  );
  targetDate = [
    previous.getUTCFullYear(),
    String(previous.getUTCMonth() + 1).padStart(2, '0'),
    String(previous.getUTCDate()).padStart(2, '0'),
  ].join('-');
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
  throw new Error('CONFIG FAILED: TARGET_DATE must be blank or YYYY-MM-DD.');
}

const [year, month, day] = targetDate.split('-').map(Number);
const start = zonedMidnightUtc(year, month, day);
const nextMarker = new Date(Date.UTC(year, month - 1, day) + 86400000);
const next = zonedMidnightUtc(
  nextMarker.getUTCFullYear(),
  nextMarker.getUTCMonth() + 1,
  nextMarker.getUTCDate(),
);

return [{ json: {
  dry_run: true,
  writes_attempted: 0,
  activity_basis: 'daily_event',
  timezone: TIMEZONE,
  snapshot_date: targetDate,
  window_start_utc: start.toISOString(),
  window_end_utc: new Date(next.getTime() - 1).toISOString(),
  collected_at: new Date().toISOString(),
} }];`;

const commonCollectorPrelude = String.raw`const parsePage = (input) => {
  let page = input;
  if (typeof page === 'string') page = JSON.parse(page);
  if (page && page.data && !Array.isArray(page.data) && Array.isArray(page.data.data)) {
    page = page.data;
  }
  return page || {};
};
const pages = $input.all().map((item) => parsePage(item.json));
const records = pages.flatMap((page) => Array.isArray(page.data) ? page.data : []);
const firstMeta = pages.find((page) => page.meta)?.meta;
if (!firstMeta || !Number.isInteger(Number(firstMeta.count)) || firstMeta.count_truncated === true) {
  throw new Error('EXTRACTION FAILED: exact untruncated source count is unavailable.');
}
if (records.length !== Number(firstMeta.count)) {
  throw new Error('EXTRACTION FAILED: expected ' + firstMeta.count + ' records, received ' + records.length + '.');
}
const ids = records.map((record) => String(record.id));
if (new Set(ids).size !== ids.length) {
  throw new Error('EXTRACTION FAILED: duplicate source id across pages.');
}
const sequenceId = (record) => {
  const data = record && record.relationships && record.relationships.sequence
    ? record.relationships.sequence.data
    : null;
  return data && data.id !== undefined && data.id !== null ? String(data.id) : null;
};`;

const normalizeSequencesCode = String.raw`${commonCollectorPrelude}
const config = $('Prepare closed daily window').first().json;
const numberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const denverDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: config.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return parts.year + '-' + parts.month + '-' + parts.day;
};
const rows = records.map((record) => {
  const attributes = record.attributes || {};
  return {
    ...config,
    expected_sequence_count: Number(firstMeta.count),
    sequence_id: Number(record.id),
    sequence_name: attributes.name || '',
    sequence_created_at: attributes.createdAt || null,
    sequence_created_date: denverDate(attributes.createdAt),
    enabled: Boolean(attributes.enabled),
    step_count: numberOrNull(attributes.sequenceStepCount),
    duration_days: numberOrNull(attributes.durationInDays),
  };
});
return [{ json: {
  ...config,
  _private_rows: rows,
  _private_source_counts: { sequences: records.length },
} }];`;

const collectEnrollmentsCode = String.raw`${commonCollectorPrelude}
const prior = $('Normalize complete sequences').first().json;
const counts = new Map();
for (const record of records) {
  const id = sequenceId(record);
  if (id) counts.set(id, (counts.get(id) || 0) + 1);
}
const rows = prior._private_rows.map((row) => ({
  ...row,
  prospects_enrolled: counts.get(String(row.sequence_id)) || 0,
}));
return [{ json: {
  ...prior,
  _private_rows: rows,
  _private_source_counts: {
    ...prior._private_source_counts,
    daily_sequence_states: records.length,
  },
} }];`;

const collectActiveCode = String.raw`${commonCollectorPrelude}
const prior = $('Collect daily enrollments').first().json;
const counts = new Map();
for (const record of records) {
  const id = sequenceId(record);
  if (id) counts.set(id, (counts.get(id) || 0) + 1);
}
const rows = prior._private_rows.map((row) => ({
  ...row,
  prospects_active: counts.get(String(row.sequence_id)) || 0,
}));
return [{ json: {
  ...prior,
  _private_rows: rows,
  _private_source_counts: {
    ...prior._private_source_counts,
    active_sequence_states: records.length,
  },
} }];`;

const collectMailingsCode = String.raw`${commonCollectorPrelude}
const prior = $('Collect active prospect snapshot').first().json;
const start = Date.parse(prior.window_start_utc);
const end = Date.parse(prior.window_end_utc);
const inWindow = (value) => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
};
const empty = () => ({
  total_sent: 0, delivered: 0, bounced: 0, failed: 0,
  opened: 0, clicked: 0, replied: 0, opted_out: 0,
});
const counts = new Map();
for (const record of records) {
  const id = sequenceId(record);
  if (!id) continue;
  const attributes = record.attributes || {};
  const row = counts.get(id) || empty();
  const delivered = inWindow(attributes.deliveredAt);
  const bounced = inWindow(attributes.bouncedAt);
  const failed = String(attributes.state || '').toLowerCase().includes('fail')
    && inWindow(attributes.stateChangedAt || attributes.updatedAt);
  if (delivered || bounced || failed) row.total_sent += 1;
  if (delivered) row.delivered += 1;
  if (bounced) row.bounced += 1;
  if (failed) row.failed += 1;
  if (inWindow(attributes.openedAt)) row.opened += 1;
  if (inWindow(attributes.clickedAt)) row.clicked += 1;
  if (inWindow(attributes.repliedAt)) row.replied += 1;
  if (inWindow(attributes.unsubscribedAt)) row.opted_out += 1;
  counts.set(id, row);
}
const rows = prior._private_rows.map((row) => ({
  ...row,
  ...(counts.get(String(row.sequence_id)) || empty()),
  positive_replies: null,
  neutral_replies: null,
  negative_replies: null,
}));
return [{ json: {
  ...prior,
  _private_rows: rows,
  _private_source_counts: {
    ...prior._private_source_counts,
    mailings_updated_in_window: records.length,
  },
} }];`;

const collectCallsCode = String.raw`${commonCollectorPrelude}
const prior = $('Collect daily mailing activity').first().json;
const start = Date.parse(prior.window_start_utc);
const end = Date.parse(prior.window_end_utc);
const inWindow = (value) => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
};
const counts = new Map();
for (const record of records) {
  const attributes = record.attributes || {};
  if (!inWindow(attributes.completedAt)) continue;
  if (String(attributes.direction || '').toLowerCase() !== 'outbound') continue;
  const id = sequenceId(record);
  if (id) counts.set(id, (counts.get(id) || 0) + 1);
}
const rows = prior._private_rows.map((row) => ({
  ...row,
  outbound_calls: counts.get(String(row.sequence_id)) || 0,
}));
return [{ json: {
  ...prior,
  _private_rows: rows,
  _private_source_counts: {
    ...prior._private_source_counts,
    calls_completed_in_window: records.length,
  },
} }];`;

const collectTasksCode = String.raw`${commonCollectorPrelude}
const prior = $('Collect daily outbound calls').first().json;
const start = Date.parse(prior.window_start_utc);
const end = Date.parse(prior.window_end_utc);
const linkedInTypes = new Set([
  'sequence_step_linkedin_interact_with_post',
  'sequence_step_linkedin_other',
  'sequence_step_linkedin_send_connection_request',
  'sequence_step_linkedin_send_message',
  'sequence_step_linkedin_view_profile',
]);
const inWindow = (value) => {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
};
const counts = new Map();
for (const record of records) {
  const attributes = record.attributes || {};
  const complete = attributes.completed === true
    || ['complete', 'completed'].includes(String(attributes.state || '').toLowerCase());
  if (!complete || !inWindow(attributes.completedAt) || !linkedInTypes.has(attributes.taskType)) {
    continue;
  }
  const id = sequenceId(record);
  if (id) counts.set(id, (counts.get(id) || 0) + 1);
}
const rows = prior._private_rows.map((row) => ({
  ...row,
  linkedin_tasks_completed: counts.get(String(row.sequence_id)) || 0,
}));
return [{ json: {
  ...prior,
  _private_rows: rows,
  _private_source_counts: {
    ...prior._private_source_counts,
    tasks_completed_in_window: records.length,
  },
} }];`;

const assembleRowsCode = String.raw`const collected = $input.first().json;
const rows = collected._private_rows;
if (!Array.isArray(rows) || rows.length === 0) {
  throw new Error('DAILY EXTRACTION FAILED: zero sequence rows.');
}
const expected = rows[0].expected_sequence_count;
if (!Number.isInteger(expected) || rows.length !== expected) {
  throw new Error('DAILY EXTRACTION FAILED: expected ' + expected + ' rows, assembled ' + rows.length + '.');
}
const keys = rows.map((row) => row.snapshot_date + '|' + row.sequence_id);
if (new Set(keys).size !== rows.length) {
  throw new Error('DAILY EXTRACTION FAILED: duplicate snapshot_date + sequence_id key.');
}
const required = [
  'prospects_enrolled', 'prospects_active', 'total_sent', 'delivered', 'bounced',
  'failed', 'opened', 'clicked', 'replied', 'opted_out', 'outbound_calls',
  'linkedin_tasks_completed',
];
for (const row of rows) {
  if (row.activity_basis !== 'daily_event') {
    throw new Error('DAILY EXTRACTION FAILED: row is not daily_event activity.');
  }
  for (const metric of required) {
    if (!Number.isInteger(row[metric]) || row[metric] < 0) {
      throw new Error('DAILY EXTRACTION FAILED: invalid ' + metric + ' for sequence ' + row.sequence_id + '.');
    }
  }
}
return rows.map((row) => ({ json: {
  ...row,
  _private_source_counts: collected._private_source_counts,
} }));`;

const prepareQaRowsCode = String.raw`const rows = $input.all().map((item) => item.json);
const blankIfMissing = (value) => value === null || value === undefined ? '' : value;
return rows.map((row) => ({ json: {
  snapshot_key: row.snapshot_date + '|' + row.sequence_id,
  snapshot_date: row.snapshot_date,
  activity_basis: row.activity_basis,
  timezone: row.timezone,
  window_start_utc: row.window_start_utc,
  window_end_utc: row.window_end_utc,
  collected_at: row.collected_at,
  source_name: 'outreach',
  sequence_id: row.sequence_id,
  sequence_name: row.sequence_name,
  sequence_created_at: blankIfMissing(row.sequence_created_at),
  sequence_created_date: blankIfMissing(row.sequence_created_date),
  enabled: row.enabled,
  step_count: blankIfMissing(row.step_count),
  duration_days: blankIfMissing(row.duration_days),
  prospects_enrolled: row.prospects_enrolled,
  prospects_active: row.prospects_active,
  total_sent: row.total_sent,
  delivered: row.delivered,
  bounced: row.bounced,
  failed: row.failed,
  opened: row.opened,
  clicked: row.clicked,
  replied: row.replied,
  positive_replies: blankIfMissing(row.positive_replies),
  neutral_replies: blankIfMissing(row.neutral_replies),
  negative_replies: blankIfMissing(row.negative_replies),
  opted_out: row.opted_out,
  outbound_calls: row.outbound_calls,
  linkedin_tasks_completed: row.linkedin_tasks_completed,
  expected_sequence_count: row.expected_sequence_count,
  pagination_complete: true,
  natural_keys_unique: true,
} }));`;

const packageAndGateCode = String.raw`// ONLY ORDINARY CONFIGURATION NODE.
const MODE = 'dry_run';
const CONFIRM = '';
const REQUIRED_CONFIRMATION = 'APPLY APPROVED OUTREACH DAILY ACTIVITY TO SOURCED';
const SUPABASE_PROJECT_URL = 'https://rsyjxtuatrwtqajjkgvd.supabase.co';

if (!['dry_run', 'apply'].includes(MODE)) {
  throw new Error('CONFIG FAILED: MODE must be dry_run or apply.');
}
const validProjectUrl = SUPABASE_PROJECT_URL.startsWith('https://')
  && /^[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_PROJECT_URL.slice('https://'.length));
if (!validProjectUrl) {
  throw new Error('CONFIG FAILED: invalid Supabase project URL; never paste a key here.');
}

const rows = $('PRIVATE: daily activity rows - DO NOT SHARE').all().map((item) => item.json);
const sheetResults = $input.all();
if (sheetResults.length !== rows.length) {
  throw new Error('QA WRITE FAILED: Google Sheets returned ' + sheetResults.length + ' row(s) for ' + rows.length + ' submitted row(s).');
}
const first = rows[0];
const paginationComplete = rows.length === first.expected_sequence_count;
const naturalKeysUnique = new Set(
  rows.map((row) => row.snapshot_date + '|' + row.sequence_id),
).size === rows.length;
if (!paginationComplete || !naturalKeysUnique) {
  throw new Error('PACKAGE FAILED: extraction completeness or natural-key validation failed.');
}
const sourceCounts = first._private_source_counts;
if (!sourceCounts || typeof sourceCounts !== 'object' || Array.isArray(sourceCounts)) {
  throw new Error('PACKAGE FAILED: source counts are unavailable.');
}
const nullableCounters = ['positive_replies', 'neutral_replies', 'negative_replies'];
const missingByMetric = Object.fromEntries(nullableCounters.map((metric) => [
  metric,
  rows.filter((row) => row[metric] === null || row[metric] === undefined).length,
]));
const privateRows = rows.map(({ _private_source_counts, ...row }) => ({
  ...row,
  source_name: 'outreach',
  pagination_complete: true,
  natural_keys_unique: true,
}));
const privateRun = {
  status: 'complete',
  activity_basis: 'daily_event',
  snapshot_date: first.snapshot_date,
  timezone: first.timezone,
  window_start_utc: first.window_start_utc,
  window_end_utc: first.window_end_utc,
  collected_at: first.collected_at,
  expected_sequences: first.expected_sequence_count,
  observed_sequences: rows.length,
  enrollments_observed: rows.reduce((sum, row) => sum + row.prospects_enrolled, 0),
  active_sequence_states_observed: rows.reduce((sum, row) => sum + row.prospects_active, 0),
  missing_measurements_by_metric: missingByMetric,
  source_counts: sourceCounts,
  pagination_complete: paginationComplete,
  natural_keys_unique: naturalKeysUnique,
};
const applyAuthorized = MODE === 'apply' && CONFIRM === REQUIRED_CONFIRMATION;
return [{ json: {
  status: 'QA_SHEET_COMPLETE',
  dry_run: MODE === 'dry_run',
  mode: MODE,
  apply_authorized: applyAuthorized,
  production_writes_attempted: 0,
  google_sheet_rows_written_or_updated: rows.length,
  google_sheet_tab: 'Daily Sequence Activity v3',
  dedupe_key: 'snapshot_date + sequence_id',
  activity_basis: 'daily_event',
  timezone: first.timezone,
  snapshot_date: first.snapshot_date,
  window_start_utc: first.window_start_utc,
  window_end_utc: first.window_end_utc,
  sequences_expected: first.expected_sequence_count,
  sequences_observed: rows.length,
  enrollments_observed: privateRun.enrollments_observed,
  active_sequence_states_observed: privateRun.active_sequence_states_observed,
  missing_measurements_by_metric: missingByMetric,
  source_counts: sourceCounts,
  pagination_complete: paginationComplete,
  natural_keys_unique: naturalKeysUnique,
  _private_supabase_url: SUPABASE_PROJECT_URL,
  _private_confirmation: CONFIRM,
  _private_required_confirmation: REQUIRED_CONFIRMATION,
  _private_rows: privateRows,
  _private_run: privateRun,
} }];`;

const dryRunCode = String.raw`const packaged = $input.first().json;
if (packaged.mode !== 'dry_run' || packaged.apply_authorized !== false) {
  throw new Error('DRY RUN FAILED: apply authorization was not closed.');
}
const {
  _private_supabase_url, _private_confirmation, _private_required_confirmation,
  _private_rows, _private_run, ...summary
} = packaged;
return [{ json: {
  ...summary,
  status: 'DRY_RUN_COMPLETE',
  dry_run: true,
  apply_payload_created: false,
  production_writes_attempted: 0,
} }];`;

const prepareApplyCode = String.raw`const packaged = $input.first().json;
if (packaged.mode !== 'apply'
    || packaged.apply_authorized !== true
    || packaged._private_confirmation !== packaged._private_required_confirmation
    || packaged.activity_basis !== 'daily_event'
    || packaged.pagination_complete !== true
    || packaged.natural_keys_unique !== true
    || packaged.sequences_expected !== packaged.sequences_observed
    || !Array.isArray(packaged._private_rows)
    || packaged._private_rows.length !== packaged.sequences_expected
    || !packaged._private_rows.every((row) => row.activity_basis === 'daily_event')
    || !packaged._private_run
    || packaged._private_run.activity_basis !== 'daily_event') {
  throw new Error('APPLY GATE CLOSED: exact confirmation and complete daily-event extraction are required.');
}
return [{ json: {
  p_rows: packaged._private_rows,
  p_run: packaged._private_run,
  _private_supabase_url: packaged._private_supabase_url,
} }];`;

const verifyApplyCode = String.raw`const result = $input.first().json;
const request = $('APPLY GATE: exact confirmation').first().json;
if (result.status !== 'applied'
    || result.activity_basis !== 'daily_event'
    || result.snapshot_date !== request.p_run.snapshot_date
    || Number(result.sequences_applied) !== request.p_run.observed_sequences) {
  throw new Error('APPLY FAILED: database result did not reconcile to the packaged daily activity.');
}
return [{ json: {
  status: 'APPLY_COMPLETE',
  dry_run: false,
  production_writes_attempted: 1,
  snapshot_date: result.snapshot_date,
  activity_basis: result.activity_basis,
  sequences_applied: Number(result.sequences_applied),
  dedupe_key: result.natural_key,
} }];`;

const pagination = {
  pagination: {
    paginationMode: 'responseContainsNextURL',
    nextURL: '={{ (typeof $response.body === \'string\' ? JSON.parse($response.body) : $response.body).links?.next || \'\' }}',
    paginationCompleteWhen: 'other',
    completeExpression: '={{ !((typeof $response.body === \'string\' ? JSON.parse($response.body) : $response.body).links?.next) }}',
    requestInterval: 350,
  },
};

const httpGet = (name, id, position, url, queryParameters) => ({
  parameters: {
    url,
    authentication: 'genericCredentialType',
    genericAuthType: 'oAuth2Api',
    sendQuery: true,
    queryParameters: { parameters: queryParameters },
    sendHeaders: true,
    headerParameters: {
      parameters: [{ name: 'Content-Type', value: 'application/vnd.api+json' }],
    },
    options: pagination,
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  position,
  id,
  name,
});

const codeNode = (name, id, position, jsCode) => ({
  parameters: { jsCode },
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position,
  id,
  name,
});

const googleSheetSchema = qaColumns.map((column) => ({
  id: column,
  displayName: column,
  required: false,
  defaultMatch: column === 'snapshot_key',
  display: true,
  type: 'string',
  canBeUsedToMatch: true,
  removed: false,
}));
const googleSheetValues = Object.fromEntries(
  qaColumns.map((column) => [column, `={{ $json.${column} }}`]),
);

const workflow = {
  name: '[Sourced] - Outreach Daily Activity Ingestion v3 - DISABLED',
  nodes: [
    {
      parameters: {},
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-1320, 180],
      id: 'ac1d9a63-b393-41c0-a1d9-300000000001',
      name: 'Manual Trigger',
    },
    {
      parameters: {
        rule: {
          interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 23, triggerAtMinute: 50 }],
        },
      },
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.3,
      position: [-1320, -20],
      id: 'ac1d9a63-b393-41c0-a1d9-300000000002',
      name: 'Daily 11:50 PM America/Denver (DISABLED)',
    },
    codeNode('Prepare closed daily window', 'ac1d9a63-b393-41c0-a1d9-300000000003', [-1080, 80], prepareWindowCode),
    httpGet(
      'READ: all Outreach sequences',
      'ac1d9a63-b393-41c0-a1d9-300000000004',
      [-840, 80],
      'https://api.outreach.io/api/v2/sequences',
      [
        { name: 'fields[sequence]', value: 'name,createdAt,sequenceStepCount,durationInDays,enabled' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '200' },
      ],
    ),
    codeNode('Normalize complete sequences', 'ac1d9a63-b393-41c0-a1d9-300000000005', [-600, 80], normalizeSequencesCode),
    httpGet(
      'READ: daily sequence-state enrollments',
      'ac1d9a63-b393-41c0-a1d9-300000000006',
      [-360, 80],
      'https://api.outreach.io/api/v2/sequenceStates',
      [
        { name: 'newFilterSyntax', value: 'true' },
        { name: 'filter[createdAt][gte]', value: "={{ $('Prepare closed daily window').first().json.window_start_utc }}" },
        { name: 'filter[createdAt][lte]', value: "={{ $('Prepare closed daily window').first().json.window_end_utc }}" },
        { name: 'fields[sequenceState]', value: 'createdAt,sequence' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '200' },
      ],
    ),
    codeNode('Collect daily enrollments', 'ac1d9a63-b393-41c0-a1d9-300000000007', [-120, 80], collectEnrollmentsCode),
    httpGet(
      'READ: active sequence-state snapshot',
      'ac1d9a63-b393-41c0-a1d9-300000000008',
      [120, 80],
      'https://api.outreach.io/api/v2/sequenceStates',
      [
        { name: 'filter[state]', value: 'active' },
        { name: 'fields[sequenceState]', value: 'state,sequence' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '200' },
      ],
    ),
    codeNode('Collect active prospect snapshot', 'ac1d9a63-b393-41c0-a1d9-300000000009', [360, 80], collectActiveCode),
    httpGet(
      'READ: mailings updated in daily window',
      'ac1d9a63-b393-41c0-a1d9-300000000010',
      [600, 80],
      'https://api.outreach.io/api/v2/mailings',
      [
        { name: 'newFilterSyntax', value: 'true' },
        { name: 'filter[updatedAt][gte]', value: "={{ $('Prepare closed daily window').first().json.window_start_utc }}" },
        { name: 'filter[updatedAt][lte]', value: "={{ $('Prepare closed daily window').first().json.window_end_utc }}" },
        { name: 'fields[mailing]', value: 'deliveredAt,bouncedAt,openedAt,clickedAt,repliedAt,unsubscribedAt,state,stateChangedAt,updatedAt,sequence' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '200' },
      ],
    ),
    codeNode('Collect daily mailing activity', 'ac1d9a63-b393-41c0-a1d9-300000000011', [840, 80], collectMailingsCode),
    httpGet(
      'READ: calls completed in daily window',
      'ac1d9a63-b393-41c0-a1d9-300000000012',
      [1080, 80],
      'https://api.outreach.io/api/v2/calls',
      [
        { name: 'newFilterSyntax', value: 'true' },
        { name: 'filter[completedAt][gte]', value: "={{ $('Prepare closed daily window').first().json.window_start_utc }}" },
        { name: 'filter[completedAt][lte]', value: "={{ $('Prepare closed daily window').first().json.window_end_utc }}" },
        { name: 'fields[call]', value: 'completedAt,direction,sequence' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '200' },
      ],
    ),
    codeNode('Collect daily outbound calls', 'ac1d9a63-b393-41c0-a1d9-300000000013', [1320, 80], collectCallsCode),
    httpGet(
      'READ: LinkedIn tasks completed in daily window',
      'ac1d9a63-b393-41c0-a1d9-300000000014',
      [1560, 80],
      'https://api.outreach.io/api/v2/tasks',
      [
        { name: 'newFilterSyntax', value: 'true' },
        { name: 'filter[completedAt][gte]', value: "={{ $('Prepare closed daily window').first().json.window_start_utc }}" },
        { name: 'filter[completedAt][lte]', value: "={{ $('Prepare closed daily window').first().json.window_end_utc }}" },
        { name: 'filter[state]', value: 'complete' },
        { name: 'fields[task]', value: 'completedAt,completed,state,taskType,sequence' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '200' },
      ],
    ),
    codeNode('Collect daily LinkedIn tasks', 'ac1d9a63-b393-41c0-a1d9-300000000015', [1800, 80], collectTasksCode),
    codeNode('PRIVATE: daily activity rows - DO NOT SHARE', 'ac1d9a63-b393-41c0-a1d9-300000000016', [2040, 80], assembleRowsCode),
    codeNode('Prepare Google Sheets QA rows', 'ac1d9a63-b393-41c0-a1d9-300000000017', [2280, 80], prepareQaRowsCode),
    {
      parameters: {
        operation: 'appendOrUpdate',
        documentId: { __rl: true, value: googleSheetId, mode: 'id' },
        sheetName: { __rl: true, value: googleSheetTab, mode: 'name' },
        columns: {
          mappingMode: 'defineBelow',
          value: googleSheetValues,
          matchingColumns: ['snapshot_key'],
          schema: googleSheetSchema,
          attemptToConvertTypes: false,
          convertFieldsToString: false,
        },
        options: {},
      },
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.7,
      position: [2520, 80],
      id: 'ac1d9a63-b393-41c0-a1d9-300000000018',
      name: 'QA WRITE: append or update daily activity',
    },
    codeNode('PACKAGE: QA result and closed apply gate', 'ac1d9a63-b393-41c0-a1d9-300000000019', [2760, 80], packageAndGateCode),
    {
      parameters: {
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
      },
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3000, 80],
      id: 'ac1d9a63-b393-41c0-a1d9-300000000020',
      name: 'ROUTE: dry run or apply',
    },
    codeNode('DRY RUN: aggregate summary', 'ac1d9a63-b393-41c0-a1d9-300000000021', [3240, 180], dryRunCode),
    codeNode('APPLY GATE: exact confirmation', 'ac1d9a63-b393-41c0-a1d9-300000000022', [3240, -40], prepareApplyCode),
    {
      parameters: {
        method: 'POST',
        url: "={{ $json._private_supabase_url + '/rest/v1/rpc/sourced_apply_outreach_daily_activity_v2' }}",
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendHeaders: true,
        headerParameters: {
          parameters: [{ name: 'Content-Type', value: 'application/json' }],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ p_rows: $json.p_rows, p_run: $json.p_run }) }}',
        options: {},
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.4,
      position: [3480, -40],
      id: 'ac1d9a63-b393-41c0-a1d9-300000000023',
      name: 'APPLY: daily Outreach activity',
    },
    codeNode('VERIFY: apply result', 'ac1d9a63-b393-41c0-a1d9-300000000024', [3720, -40], verifyApplyCode),
  ],
  pinData: {},
  connections: {},
  active: false,
  settings: {
    executionOrder: 'v1',
    timezone: 'America/Denver',
    availableInMCP: false,
  },
  meta: { templateCredsSetupCompleted: false },
  tags: [],
};

const chain = [
  'Prepare closed daily window',
  'READ: all Outreach sequences',
  'Normalize complete sequences',
  'READ: daily sequence-state enrollments',
  'Collect daily enrollments',
  'READ: active sequence-state snapshot',
  'Collect active prospect snapshot',
  'READ: mailings updated in daily window',
  'Collect daily mailing activity',
  'READ: calls completed in daily window',
  'Collect daily outbound calls',
  'READ: LinkedIn tasks completed in daily window',
  'Collect daily LinkedIn tasks',
  'PRIVATE: daily activity rows - DO NOT SHARE',
  'Prepare Google Sheets QA rows',
  'QA WRITE: append or update daily activity',
  'PACKAGE: QA result and closed apply gate',
  'ROUTE: dry run or apply',
];
workflow.connections['Manual Trigger'] = {
  main: [[{ node: chain[0], type: 'main', index: 0 }]],
};
workflow.connections['Daily 11:50 PM America/Denver (DISABLED)'] = {
  main: [[{ node: chain[0], type: 'main', index: 0 }]],
};
for (let index = 0; index < chain.length - 1; index += 1) {
  workflow.connections[chain[index]] = {
    main: [[{ node: chain[index + 1], type: 'main', index: 0 }]],
  };
}
workflow.connections['ROUTE: dry run or apply'] = {
  main: [
    [{ node: 'APPLY GATE: exact confirmation', type: 'main', index: 0 }],
    [{ node: 'DRY RUN: aggregate summary', type: 'main', index: 0 }],
  ],
};
workflow.connections['APPLY GATE: exact confirmation'] = {
  main: [[{ node: 'APPLY: daily Outreach activity', type: 'main', index: 0 }]],
};
workflow.connections['APPLY: daily Outreach activity'] = {
  main: [[{ node: 'VERIFY: apply result', type: 'main', index: 0 }]],
};

const rendered = `${JSON.stringify(workflow, null, 2)}\n`;
if (process.argv.includes('--check')) {
  let existing = '';
  try {
    existing = readFileSync(outputPath, 'utf8');
  } catch {
    process.stderr.write(`Missing generated workflow: ${outputPath}\n`);
    process.exit(1);
  }
  if (existing !== rendered) {
    process.stderr.write('Generated Outreach daily activity workflow is stale. Run the build script.\n');
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered);
  process.stdout.write(`${outputPath}\n`);
}
