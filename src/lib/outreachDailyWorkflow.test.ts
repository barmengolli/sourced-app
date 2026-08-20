import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface WorkflowNode {
  name: string;
  type: string;
  credentials?: Record<string, unknown>;
  parameters: {
    [key: string]: unknown;
    rule: { interval: Array<Record<string, unknown>> };
    url?: string;
    method?: string;
    genericAuthType?: string;
    operation?: string;
    documentId?: { value: string; mode: string };
    sheetName?: { value: string; mode: string };
    columns?: { matchingColumns: string[] };
    jsCode: string;
    queryParameters: { parameters: Array<{ name: string; value: string }> };
  };
}

interface Workflow {
  active: boolean;
  nodes: WorkflowNode[];
  pinData: Record<string, unknown>;
  settings: { timezone?: string };
  connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
}

const artifactPath = resolve('artifacts/[Sourced] - Outreach Daily Ingestion v2 - DISABLED.json');
const workflow = JSON.parse(readFileSync(artifactPath, 'utf8')) as Workflow;
const node = (name: string) => {
  const found = workflow.nodes.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing node: ${name}`);
  return found;
};

const syntheticRows = () => [{
  snapshot_date: '2026-08-09', timezone: 'America/Denver',
  window_start_utc: '2026-08-09T06:00:00.000Z',
  window_end_utc: '2026-08-10T05:59:59.999Z',
  collected_at: '2026-08-10T05:50:00.000Z', expected_sequence_count: 1,
  sequence_id: 65, sequence_name: 'Synthetic sequence', sequence_created_at: null,
  sequence_created_date: null, enabled: true, step_count: 14, duration_days: 18,
  prospects_enrolled: 3, prospects_active: 27, total_sent: null, delivered: 74,
  bounced: 3, failed: 0, opened: 12, clicked: 2, replied: 1,
  positive_replies: null, neutral_replies: null, negative_replies: null,
  opted_out: 0, outbound_calls: 121, linkedin_tasks_completed: 32,
}];

describe('disabled Outreach daily ingestion workflow', () => {
  it('is generated deterministically from the committed builder', () => {
    expect(() => execFileSync(process.execPath, ['scripts/build-outreach-daily-workflow.mjs', '--check'], {
      cwd: process.cwd(), stdio: 'pipe',
    })).not.toThrow();
  });

  it('is inactive, timezone-explicit, credentialless, and scheduled for 11:50 PM', () => {
    expect(workflow.active).toBe(false);
    expect(workflow.settings.timezone).toBe('America/Denver');
    expect(workflow.pinData).toEqual({});
    expect(node('Daily 11:50 PM America/Denver (DISABLED)').parameters.rule.interval[0])
      .toMatchObject({ triggerAtHour: 23, triggerAtMinute: 50 });
    for (const item of workflow.nodes) expect(item.credentials).toBeUndefined();
  });

  it('keeps Outreach calls read-only and has exactly one guarded Supabase write', () => {
    const requests = workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.httpRequest');
    const outreach = requests.filter((item) => String(item.parameters.url).includes('api.outreach.io'));
    expect(outreach).toHaveLength(5);
    for (const read of outreach) expect(read.parameters.method ?? 'GET').toBe('GET');
    const writes = requests.filter((item) => item.parameters.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0].name).toBe('APPLY: daily Outreach snapshot');
    expect(writes[0].parameters.url).toContain('sourced_apply_outreach_daily_snapshot');
    expect(writes[0].parameters.genericAuthType).toBe('httpHeaderAuth');
    expect(JSON.stringify(workflow)).not.toMatch(/service_role|eyJ[A-Za-z0-9_-]+\./);
  });

  it('writes the approved QA sheet first using the stable daily key', () => {
    const writes = workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.googleSheets');
    expect(writes).toHaveLength(1);
    expect(writes[0].parameters).toMatchObject({
      operation: 'appendOrUpdate',
      documentId: { value: '1OT2q0JF0mfvOFkSfHWyBUJKTt68fDzHlrSew2IWzvEo', mode: 'id' },
      sheetName: { value: 'Daily Sequence Snapshots v2', mode: 'name' },
      columns: { matchingColumns: ['snapshot_key'] },
    });
    expect(workflow.connections['QA WRITE: append or update daily row'].main[0][0].node)
      .toBe('PACKAGE: QA result and closed apply gate');
  });

  it('creates allowlisted QA rows, retains zero, and blanks missing source values', () => {
    const execute = new Function('$input', node('Prepare Google Sheets QA rows').parameters.jsCode) as
      (input: { all: () => Array<{ json: Record<string, unknown> }> }) => Array<{ json: Record<string, unknown> }>;
    const result = execute({ all: () => syntheticRows().map((json) => ({ json })) });
    expect(result[0].json).toMatchObject({
      snapshot_key: '2026-08-09|65', source_name: 'outreach', prospects_enrolled: 3,
      failed: 0, total_sent: '', positive_replies: '', pagination_complete: true,
      natural_keys_unique: true,
    });
  });

  it('fails before either write when the daily natural key is duplicated', () => {
    const execute = new Function('$input', node('PRIVATE: daily sequence rows - DO NOT SHARE').parameters.jsCode) as
      (input: { all: () => Array<{ json: Record<string, unknown> }> }) => unknown;
    const row = { ...syntheticRows()[0], expected_sequence_count: 2 };
    expect(() => execute({ all: () => [{ json: row }, { json: row }] }))
      .toThrow('duplicate snapshot_date + sequence_id key');
  });

  it('requires apply mode and the exact phrase, then rechecks both at the apply seam', () => {
    const packageSource = node('PACKAGE: QA result and closed apply gate').parameters.jsCode as string;
    expect(packageSource).toContain("const MODE = 'dry_run'");
    expect(packageSource).toContain("const CONFIRM = ''");
    expect(packageSource).toContain('APPLY APPROVED OUTREACH DAILY SNAPSHOT TO SOURCED');
    expect(packageSource).toContain("MODE === 'apply' && CONFIRM === REQUIRED_CONFIRMATION");
    const gate = node('APPLY GATE: exact confirmation').parameters.jsCode as string;
    expect(gate).toContain("packaged.mode !== 'apply'");
    expect(gate).toContain('packaged.apply_authorized !== true');
    expect(gate).toContain('packaged._private_confirmation !== packaged._private_required_confirmation');
    expect(gate).toContain('packaged.sequences_expected !== packaged.sequences_observed');
  });

  it('makes the Supabase RPC unreachable from the dry-run branch', () => {
    expect(workflow.connections['ROUTE: dry run or apply'].main).toEqual([
      [{ node: 'APPLY GATE: exact confirmation', type: 'main', index: 0 }],
      [{ node: 'DRY RUN: aggregate summary', type: 'main', index: 0 }],
    ]);
    expect(workflow.connections['DRY RUN: aggregate summary']).toBeUndefined();
    expect(workflow.connections['APPLY GATE: exact confirmation'].main[0][0].node)
      .toBe('APPLY: daily Outreach snapshot');
  });

  it('emits only aggregate terminals and strips private rows from the dry result', () => {
    const outgoing = new Map(Object.entries(workflow.connections).map(([name, value]) => [
      name, value.main.flat().map((edge) => edge.node),
    ]));
    const terminals = workflow.nodes.map((item) => item.name)
      .filter((name) => (outgoing.get(name) ?? []).length === 0);
    expect(terminals.sort()).toEqual(['DRY RUN: aggregate summary', 'VERIFY: apply result'].sort());
    const dry = node('DRY RUN: aggregate summary').parameters.jsCode as string;
    expect(dry).toContain('_private_rows, _private_run, ...summary');
    expect(dry).toContain('apply_payload_created: false');
    expect(dry).not.toMatch(/sequence_id\s*:/);
  });

  it('requests createdAt, exact counts, and the prior closed Denver day', () => {
    const read = node('READ: all Outreach sequences');
    const query = read.parameters.queryParameters.parameters as Array<{ name: string; value: string }>;
    expect(query.find((item) => item.name === 'fields[sequence]')?.value).toContain('createdAt');
    expect(query.find((item) => item.name === 'count')?.value).toBe('true');
    expect(JSON.stringify(read.parameters)).toContain('responseContainsNextURL');
    expect(node('READ: daily sequence-state enrollments').parameters.queryParameters.parameters)
      .toEqual(expect.arrayContaining([
        { name: 'filter[createdAt][gte]', value: '={{ $json.window_start_utc }}' },
        { name: 'filter[createdAt][lte]', value: '={{ $json.window_end_utc }}' },
        { name: 'count', value: 'true' },
      ]));
  });

  it('builds exact Denver boundaries across daylight-saving transitions', () => {
    const source = node('Prepare prior closed day').parameters.jsCode as string;
    const executeFor = (date: string) => new Function(source.replace(
      "const TARGET_DATE = '';", `const TARGET_DATE = '${date}';`,
    ))() as Array<{ json: Record<string, unknown> }>;
    expect(executeFor('2026-03-08')[0].json).toMatchObject({
      window_start_utc: '2026-03-08T07:00:00.000Z', window_end_utc: '2026-03-09T05:59:59.999Z',
    });
    expect(executeFor('2026-11-01')[0].json).toMatchObject({
      window_start_utc: '2026-11-01T06:00:00.000Z', window_end_utc: '2026-11-02T06:59:59.999Z',
    });
  });

  it('preserves missing measurements and compiles every generated Code node', () => {
    const normalize = node('Normalize complete sequence pages').parameters.jsCode as string;
    expect(normalize).toContain('numberOrNull');
    expect(normalize).not.toContain('|| 0');
    expect(workflow.nodes.map((item) => item.parameters.jsCode ?? '').join('\n'))
      .toContain('count_truncated === true');
    for (const item of workflow.nodes) {
      if (item.parameters.jsCode) expect(() => new Function(item.parameters.jsCode)).not.toThrow();
    }
  });
});
