import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const outputPath = resolve(
  'artifacts/[Sourced] - Outreach Daily Ingestion v2 - DISABLED.json',
);

const googleSheetId = '1OT2q0JF0mfvOFkSfHWyBUJKTt68fDzHlrSew2IWzvEo';
const googleSheetTab = 'Daily Sequence Snapshots v2';

const qaColumns = [
  'snapshot_key',
  'snapshot_date',
  'timezone',
  'window_start_utc',
  'window_end_utc',
  'collected_at',
  'source_name',
  'sequence_id',
  'sequence_name',
  'sequence_created_at',
  'sequence_created_date',
  'enabled',
  'step_count',
  'duration_days',
  'prospects_enrolled',
  'prospects_active',
  'total_sent',
  'delivered',
  'bounced',
  'failed',
  'opened',
  'clicked',
  'replied',
  'positive_replies',
  'neutral_replies',
  'negative_replies',
  'opted_out',
  'outbound_calls',
  'linkedin_tasks_completed',
  'expected_sequence_count',
  'pagination_complete',
  'natural_keys_unique',
];

const prepareWindowCode = String.raw`// READ-ONLY DAILY WINDOW.
// Leave blank for the prior closed America/Denver calendar day.
// For a controlled backfill, set YYYY-MM-DD and run manually.
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

const validDate = /^\d{4}-\d{2}-\d{2}$/;
let targetDate = TARGET_DATE;
if (!targetDate) {
  const localNow = partsInZone(new Date());
  const previous = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day) - 86400000);
  targetDate = [
    previous.getUTCFullYear(),
    String(previous.getUTCMonth() + 1).padStart(2, '0'),
    String(previous.getUTCDate()).padStart(2, '0'),
  ].join('-');
}
if (!validDate.test(targetDate)) {
  throw new Error('CONFIG FAILED: TARGET_DATE must be blank or YYYY-MM-DD.');
}
const [year, month, day] = targetDate.split('-').map(Number);
const start = zonedMidnightUtc(year, month, day);
const nextMarker = new Date(Date.UTC(year, month - 1, day) + 86400000);
const next = zonedMidnightUtc(
  nextMarker.getUTCFullYear(), nextMarker.getUTCMonth() + 1, nextMarker.getUTCDate(),
);
const end = new Date(next.getTime() - 1);

return [{ json: {
  dry_run: true,
  writes_attempted: 0,
  timezone: TIMEZONE,
  snapshot_date: targetDate,
  window_start_utc: start.toISOString(),
  window_end_utc: end.toISOString(),
  collected_at: new Date().toISOString(),
} }];`;

const normalizeSequencesCode = String.raw`const config = $('Prepare prior closed day').first().json;
const pages = $input.all().map((item) => {
  let body = item.json;
  if (typeof body.data === 'string') body = JSON.parse(body.data);
  if (body.data && !Array.isArray(body.data) && Array.isArray(body.data.data)) body = body.data;
  return body;
});
const firstMeta = pages.find((page) => page && page.meta)?.meta;
if (!firstMeta || !Number.isInteger(Number(firstMeta.count)) || firstMeta.count_truncated === true) {
  throw new Error('SEQUENCE EXTRACTION FAILED: exact untruncated source count is unavailable.');
}
const records = pages.flatMap((page) => Array.isArray(page.data) ? page.data : []);
const ids = records.map((record) => String(record.id));
if (new Set(ids).size !== ids.length) {
  throw new Error('SEQUENCE EXTRACTION FAILED: duplicate sequence id across pages.');
}
if (records.length !== Number(firstMeta.count)) {
  throw new Error('SEQUENCE EXTRACTION FAILED: expected ' + firstMeta.count + ' sequences, received ' + records.length + '.');
}

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
      timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return parts.year + '-' + parts.month + '-' + parts.day;
};

return records.map((record) => {
  const a = record.attributes || {};
  const delivered = numberOrNull(a.deliverCount);
  const bounced = numberOrNull(a.bounceCount);
  const failed = numberOrNull(a.failureCount);
  const totalSent = delivered === null || bounced === null || failed === null
    ? null
    : delivered + bounced + failed;
  return { json: {
    ...config,
    expected_sequence_count: Number(firstMeta.count),
    sequence_id: Number(record.id),
    sequence_name: a.name || '',
    sequence_created_at: a.createdAt || null,
    sequence_created_date: denverDate(a.createdAt),
    enabled: Boolean(a.enabled),
    step_count: numberOrNull(a.sequenceStepCount),
    duration_days: numberOrNull(a.durationInDays),
    total_sent: totalSent,
    delivered,
    bounced,
    failed,
    opened: numberOrNull(a.openCount),
    clicked: numberOrNull(a.clickCount),
    replied: numberOrNull(a.replyCount),
    positive_replies: numberOrNull(a.positiveReplyCount),
    neutral_replies: numberOrNull(a.neutralReplyCount),
    negative_replies: numberOrNull(a.negativeReplyCount),
    opted_out: numberOrNull(a.optOutCount),
  } };
});`;

const attachEnrollmentCode = String.raw`const sequence = $('Normalize complete sequence pages').item.json;
let body = $json;
if (typeof body.data === 'string') body = JSON.parse(body.data);
if (body.data && !Array.isArray(body.data) && body.data.meta) body = body.data;
const count = body && body.meta ? Number(body.meta.count) : NaN;
if (!Number.isInteger(count) || count < 0 || body.meta.count_truncated === true) {
  throw new Error('ENROLLMENT EXTRACTION FAILED: exact daily count unavailable for one sequence.');
}
return { json: { ...sequence, prospects_enrolled: count } };`;

const attachActiveCode = String.raw`const sequence = $('Attach daily enrollment count').item.json;
let body = $json;
if (typeof body.data === 'string') body = JSON.parse(body.data);
if (body.data && !Array.isArray(body.data) && body.data.meta) body = body.data;
const count = body && body.meta ? Number(body.meta.count) : NaN;
if (!Number.isInteger(count) || count < 0 || body.meta.count_truncated === true) {
  throw new Error('ACTIVE SNAPSHOT FAILED: exact active count unavailable for one sequence.');
}
return { json: { ...sequence, prospects_active: count } };`;

const attachLinkedInCode = String.raw`const sequence = $('Attach active-prospect snapshot').item.json;
let body = $json;
if (typeof body.data === 'string') body = JSON.parse(body.data);
if (body.data && !Array.isArray(body.data) && body.data.meta) body = body.data;
const count = body && body.meta ? Number(body.meta.count) : NaN;
if (!Number.isInteger(count) || count < 0 || body.meta.count_truncated === true) {
  throw new Error('LINKEDIN TASK EXTRACTION FAILED: exact cumulative count unavailable for one sequence.');
}
return { json: { ...sequence, linkedin_tasks_completed: count } };`;

const attachCallsCode = String.raw`const sequence = $('Attach cumulative LinkedIn tasks').item.json;
let body = $json;
if (typeof body.data === 'string') body = JSON.parse(body.data);
if (body.data && !Array.isArray(body.data) && body.data.meta) body = body.data;
const count = body && body.meta ? Number(body.meta.count) : NaN;
if (!Number.isInteger(count) || count < 0 || body.meta.count_truncated === true) {
  throw new Error('CALL EXTRACTION FAILED: exact cumulative count unavailable for one sequence.');
}
return { json: { ...sequence, outbound_calls: count } };`;

const privateRowsCode = String.raw`const rows = $input.all().map((item) => item.json);
if (rows.length === 0) throw new Error('DAILY EXTRACTION FAILED: zero sequence rows.');
const expected = rows[0].expected_sequence_count;
if (!Number.isInteger(expected) || rows.length !== expected) {
  throw new Error('DAILY EXTRACTION FAILED: expected ' + expected + ' rows, assembled ' + rows.length + '.');
}
const keys = rows.map((row) => row.snapshot_date + '|' + row.sequence_id);
if (new Set(keys).size !== keys.length) {
  throw new Error('DAILY EXTRACTION FAILED: duplicate snapshot_date + sequence_id key.');
}
return rows.map((row) => ({ json: row }));`;

const prepareQaRowsCode = String.raw`const rows = $input.all().map((item) => item.json);
const keys = rows.map((row) => row.snapshot_date + '|' + row.sequence_id);
if (new Set(keys).size !== rows.length) {
  throw new Error('QA WRITE REFUSED: duplicate snapshot_date + sequence_id key.');
}

const blankIfMissing = (value) => value === null || value === undefined ? '' : value;
return rows.map((row) => ({ json: {
  snapshot_key: row.snapshot_date + '|' + row.sequence_id,
  snapshot_date: row.snapshot_date,
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
  total_sent: blankIfMissing(row.total_sent),
  delivered: blankIfMissing(row.delivered),
  bounced: blankIfMissing(row.bounced),
  failed: blankIfMissing(row.failed),
  opened: blankIfMissing(row.opened),
  clicked: blankIfMissing(row.clicked),
  replied: blankIfMissing(row.replied),
  positive_replies: blankIfMissing(row.positive_replies),
  neutral_replies: blankIfMissing(row.neutral_replies),
  negative_replies: blankIfMissing(row.negative_replies),
  opted_out: blankIfMissing(row.opted_out),
  outbound_calls: blankIfMissing(row.outbound_calls),
  linkedin_tasks_completed: blankIfMissing(row.linkedin_tasks_completed),
  expected_sequence_count: row.expected_sequence_count,
  pagination_complete: true,
  natural_keys_unique: true,
} }));`;

const packageAndGateCode = String.raw`// This is the only ordinary configuration node.
const MODE = 'dry_run';
const CONFIRM = '';
const REQUIRED_CONFIRMATION = 'APPLY APPROVED OUTREACH DAILY SNAPSHOT TO SOURCED';
const SUPABASE_PROJECT_URL = 'https://rsyjxtuatrwtqajjkgvd.supabase.co';

if (!['dry_run', 'apply'].includes(MODE)) {
  throw new Error('CONFIG FAILED: MODE must be dry_run or apply.');
}
const validProjectUrl = SUPABASE_PROJECT_URL.startsWith('https://')
  && /^[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_PROJECT_URL.slice('https://'.length));
if (!validProjectUrl) {
  throw new Error('CONFIG FAILED: invalid Supabase project URL; never paste a key here.');
}

const rows = $('PRIVATE: daily sequence rows - DO NOT SHARE').all().map((item) => item.json);
const sheetResults = $input.all();
if (sheetResults.length !== rows.length) {
  throw new Error('QA WRITE FAILED: Google Sheets returned ' + sheetResults.length + ' row(s) for ' + rows.length + ' submitted row(s).');
}
const first = rows[0];
const nullableCounters = [
  'total_sent', 'delivered', 'bounced', 'failed', 'opened', 'clicked', 'replied',
  'positive_replies', 'neutral_replies', 'negative_replies', 'opted_out',
  'outbound_calls', 'linkedin_tasks_completed',
];
const missingByMetric = Object.fromEntries(nullableCounters.map((metric) => [
  metric,
  rows.filter((row) => row[metric] === null || row[metric] === undefined).length,
]));
const paginationComplete = rows.length === first.expected_sequence_count;
const naturalKeysUnique = new Set(rows.map((row) => row.snapshot_date + '|' + row.sequence_id)).size === rows.length;
if (!paginationComplete || !naturalKeysUnique) {
  throw new Error('PACKAGE FAILED: extraction completeness or natural-key validation failed.');
}
const applyAuthorized = MODE === 'apply' && CONFIRM === REQUIRED_CONFIRMATION;
const privateRows = rows.map((row) => ({
  ...row,
  source_name: 'outreach',
  pagination_complete: true,
  natural_keys_unique: true,
}));
const privateRun = {
  status: 'complete',
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
  pagination_complete: paginationComplete,
  natural_keys_unique: naturalKeysUnique,
};
return [{ json: {
  status: 'QA_SHEET_COMPLETE',
  dry_run: MODE === 'dry_run',
  mode: MODE,
  apply_authorized: applyAuthorized,
  production_writes_attempted: 0,
  google_sheet_rows_written_or_updated: rows.length,
  google_sheet_tab: 'Daily Sequence Snapshots v2',
  dedupe_key: 'snapshot_date + sequence_id',
  timezone: first.timezone,
  snapshot_date: first.snapshot_date,
  window_start_utc: first.window_start_utc,
  window_end_utc: first.window_end_utc,
  sequences_expected: first.expected_sequence_count,
  sequences_observed: rows.length,
  enrollments_observed: privateRun.enrollments_observed,
  active_sequence_states_observed: privateRun.active_sequence_states_observed,
  missing_measurements_by_metric: missingByMetric,
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
    || packaged.pagination_complete !== true
    || packaged.natural_keys_unique !== true
    || packaged.sequences_expected !== packaged.sequences_observed
    || !Array.isArray(packaged._private_rows)
    || packaged._private_rows.length !== packaged.sequences_expected
    || !packaged._private_run) {
  throw new Error('APPLY GATE CLOSED: exact confirmation and complete extraction are required.');
}
return [{ json: {
  p_rows: packaged._private_rows,
  p_run: packaged._private_run,
  _private_supabase_url: packaged._private_supabase_url,
} }];`;

const verifyApplyCode = String.raw`const result = $input.first().json;
const request = $('APPLY GATE: exact confirmation').first().json;
if (result.status !== 'applied'
    || result.snapshot_date !== request.p_run.snapshot_date
    || Number(result.sequences_applied) !== request.p_run.observed_sequences) {
  throw new Error('APPLY FAILED: database result did not reconcile to the packaged extraction.');
}
return [{ json: {
  status: 'APPLY_COMPLETE',
  dry_run: false,
  production_writes_attempted: 1,
  snapshot_date: result.snapshot_date,
  sequences_applied: Number(result.sequences_applied),
  dedupe_key: result.natural_key,
} }];`;

const pagination = {
  pagination: {
    paginationMode: 'responseContainsNextURL',
    nextURL: '={{ (typeof $response.body === \'string\' ? JSON.parse($response.body) : $response.body).links?.next || \'\' }}',
    paginationCompleteWhen: 'other',
    completeExpression: '={{ !((typeof $response.body === \'string\' ? JSON.parse($response.body) : $response.body).links?.next) }}',
    requestInterval: 250,
  },
};

const outreachHeaders = {
  parameters: [{ name: 'Content-Type', value: 'application/vnd.api+json' }],
};

const httpGet = (name, id, position, url, queryParameters, options = {}) => ({
  parameters: {
    url,
    authentication: 'genericCredentialType',
    genericAuthType: 'oAuth2Api',
    sendQuery: true,
    queryParameters: { parameters: queryParameters },
    sendHeaders: true,
    headerParameters: outreachHeaders,
    options,
  },
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  position,
  id,
  name,
});

const codeNode = (name, id, position, jsCode, mode) => ({
  parameters: { ...(mode ? { mode } : {}), jsCode },
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
  name: '[Sourced] - Outreach Daily Ingestion v2 - DISABLED',
  nodes: [
    {
      parameters: {},
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-1080, 160],
      id: 'bfe9a639-b393-41c0-a1d9-100000000001',
      name: 'Manual Trigger',
    },
    {
      parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 23, triggerAtMinute: 50 }] } },
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.3,
      position: [-1080, -20],
      id: 'bfe9a639-b393-41c0-a1d9-100000000002',
      name: 'Daily 11:50 PM America/Denver (DISABLED)',
    },
    codeNode('Prepare prior closed day', 'bfe9a639-b393-41c0-a1d9-100000000003', [-840, 80], prepareWindowCode),
    httpGet(
      'READ: all Outreach sequences',
      'bfe9a639-b393-41c0-a1d9-100000000004',
      [-600, 80],
      'https://api.outreach.io/api/v2/sequences',
      [
        {
          name: 'fields[sequence]',
          value: 'name,createdAt,bounceCount,clickCount,deliverCount,openCount,optOutCount,replyCount,negativeReplyCount,neutralReplyCount,positiveReplyCount,failureCount,sequenceStepCount,durationInDays,enabled',
        },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '200' },
      ],
      pagination,
    ),
    codeNode('Normalize complete sequence pages', 'bfe9a639-b393-41c0-a1d9-100000000005', [-340, 80], normalizeSequencesCode),
    httpGet(
      'READ: daily sequence-state enrollments',
      'bfe9a639-b393-41c0-a1d9-100000000006',
      [-80, 80],
      'https://api.outreach.io/api/v2/sequenceStates',
      [
        { name: 'newFilterSyntax', value: 'true' },
        { name: 'filter[sequence][id]', value: '={{ $json.sequence_id }}' },
        { name: 'filter[createdAt][gte]', value: '={{ $json.window_start_utc }}' },
        { name: 'filter[createdAt][lte]', value: '={{ $json.window_end_utc }}' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '1' },
      ],
    ),
    codeNode('Attach daily enrollment count', 'bfe9a639-b393-41c0-a1d9-100000000007', [180, 80], attachEnrollmentCode, 'runOnceForEachItem'),
    httpGet(
      'READ: active sequence-state snapshot',
      'bfe9a639-b393-41c0-a1d9-100000000008',
      [440, 80],
      'https://api.outreach.io/api/v2/sequenceStates',
      [
        { name: 'filter[sequence][id]', value: '={{ $json.sequence_id }}' },
        { name: 'filter[state]', value: 'active' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '1' },
      ],
    ),
    codeNode('Attach active-prospect snapshot', 'bfe9a639-b393-41c0-a1d9-100000000009', [700, 80], attachActiveCode, 'runOnceForEachItem'),
    httpGet(
      'READ: cumulative completed LinkedIn tasks',
      'bfe9a639-b393-41c0-a1d9-100000000010',
      [960, 80],
      'https://api.outreach.io/api/v2/tasks',
      [
        { name: 'filter[sequence][id]', value: '={{ $json.sequence_id }}' },
        {
          name: 'filter[taskType]',
          value: 'sequence_step_linkedin_send_message,sequence_step_linkedin_view_profile,sequence_step_linkedin_send_connection_request,sequence_step_linkedin_interact_with_post,sequence_step_linkedin_other',
        },
        { name: 'filter[state]', value: 'complete' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '1' },
      ],
    ),
    codeNode('Attach cumulative LinkedIn tasks', 'bfe9a639-b393-41c0-a1d9-100000000011', [1220, 80], attachLinkedInCode, 'runOnceForEachItem'),
    httpGet(
      'READ: cumulative outbound calls',
      'bfe9a639-b393-41c0-a1d9-100000000012',
      [1480, 80],
      'https://api.outreach.io/api/v2/calls',
      [
        { name: 'filter[sequence][id]', value: '={{ $json.sequence_id }}' },
        { name: 'count', value: 'true' },
        { name: 'page[size]', value: '1' },
      ],
    ),
    codeNode('Attach cumulative outbound calls', 'bfe9a639-b393-41c0-a1d9-100000000013', [1740, 80], attachCallsCode, 'runOnceForEachItem'),
    codeNode('PRIVATE: daily sequence rows - DO NOT SHARE', 'bfe9a639-b393-41c0-a1d9-100000000014', [2000, 80], privateRowsCode),
    codeNode('Prepare Google Sheets QA rows', 'bfe9a639-b393-41c0-a1d9-100000000015', [2260, 80], prepareQaRowsCode),
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
      id: 'bfe9a639-b393-41c0-a1d9-100000000016',
      name: 'QA WRITE: append or update daily row',
    },
    codeNode('PACKAGE: QA result and closed apply gate', 'bfe9a639-b393-41c0-a1d9-100000000017', [2780, 80], packageAndGateCode),
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
      position: [3040, 80],
      id: 'bfe9a639-b393-41c0-a1d9-100000000018',
      name: 'ROUTE: dry run or apply',
    },
    codeNode('DRY RUN: aggregate summary', 'bfe9a639-b393-41c0-a1d9-100000000019', [3300, 180], dryRunCode),
    codeNode('APPLY GATE: exact confirmation', 'bfe9a639-b393-41c0-a1d9-100000000020', [3300, -40], prepareApplyCode),
    {
      parameters: {
        method: 'POST',
        url: "={{ $json._private_supabase_url + '/rest/v1/rpc/sourced_apply_outreach_daily_snapshot' }}",
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ p_rows: $json.p_rows, p_run: $json.p_run }) }}',
        options: {},
      },
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.4,
      position: [3560, -40],
      id: 'bfe9a639-b393-41c0-a1d9-100000000021',
      name: 'APPLY: daily Outreach snapshot',
    },
    codeNode('VERIFY: apply result', 'bfe9a639-b393-41c0-a1d9-100000000022', [3820, -40], verifyApplyCode),
  ],
  pinData: {},
  connections: {
    'Manual Trigger': { main: [[{ node: 'Prepare prior closed day', type: 'main', index: 0 }]] },
    'Daily 11:50 PM America/Denver (DISABLED)': { main: [[{ node: 'Prepare prior closed day', type: 'main', index: 0 }]] },
    'Prepare prior closed day': { main: [[{ node: 'READ: all Outreach sequences', type: 'main', index: 0 }]] },
    'READ: all Outreach sequences': { main: [[{ node: 'Normalize complete sequence pages', type: 'main', index: 0 }]] },
    'Normalize complete sequence pages': { main: [[{ node: 'READ: daily sequence-state enrollments', type: 'main', index: 0 }]] },
    'READ: daily sequence-state enrollments': { main: [[{ node: 'Attach daily enrollment count', type: 'main', index: 0 }]] },
    'Attach daily enrollment count': { main: [[{ node: 'READ: active sequence-state snapshot', type: 'main', index: 0 }]] },
    'READ: active sequence-state snapshot': { main: [[{ node: 'Attach active-prospect snapshot', type: 'main', index: 0 }]] },
    'Attach active-prospect snapshot': { main: [[{ node: 'READ: cumulative completed LinkedIn tasks', type: 'main', index: 0 }]] },
    'READ: cumulative completed LinkedIn tasks': { main: [[{ node: 'Attach cumulative LinkedIn tasks', type: 'main', index: 0 }]] },
    'Attach cumulative LinkedIn tasks': { main: [[{ node: 'READ: cumulative outbound calls', type: 'main', index: 0 }]] },
    'READ: cumulative outbound calls': { main: [[{ node: 'Attach cumulative outbound calls', type: 'main', index: 0 }]] },
    'Attach cumulative outbound calls': { main: [[{ node: 'PRIVATE: daily sequence rows - DO NOT SHARE', type: 'main', index: 0 }]] },
    'PRIVATE: daily sequence rows - DO NOT SHARE': { main: [[{ node: 'Prepare Google Sheets QA rows', type: 'main', index: 0 }]] },
    'Prepare Google Sheets QA rows': { main: [[{ node: 'QA WRITE: append or update daily row', type: 'main', index: 0 }]] },
    'QA WRITE: append or update daily row': { main: [[{ node: 'PACKAGE: QA result and closed apply gate', type: 'main', index: 0 }]] },
    'PACKAGE: QA result and closed apply gate': { main: [[{ node: 'ROUTE: dry run or apply', type: 'main', index: 0 }]] },
    'ROUTE: dry run or apply': { main: [
      [{ node: 'APPLY GATE: exact confirmation', type: 'main', index: 0 }],
      [{ node: 'DRY RUN: aggregate summary', type: 'main', index: 0 }],
    ] },
    'APPLY GATE: exact confirmation': { main: [[{ node: 'APPLY: daily Outreach snapshot', type: 'main', index: 0 }]] },
    'APPLY: daily Outreach snapshot': { main: [[{ node: 'VERIFY: apply result', type: 'main', index: 0 }]] },
  },
  active: false,
  settings: {
    executionOrder: 'v1',
    timezone: 'America/Denver',
    availableInMCP: false,
  },
  meta: { templateCredsSetupCompleted: false },
  tags: [],
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
    process.stderr.write('Generated Outreach daily workflow is stale. Run the build script.\n');
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered);
  process.stdout.write(`${outputPath}\n`);
}
