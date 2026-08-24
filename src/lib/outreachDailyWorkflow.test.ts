import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface WorkflowNode {
  name: string;
  type: string;
  credentials?: Record<string, unknown>;
  parameters: Record<string, any>;
}
interface Workflow {
  active: boolean;
  nodes: WorkflowNode[];
  pinData: Record<string, unknown>;
  settings: { timezone?: string };
  connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }>;
}

const artifactPath = resolve('artifacts/[Sourced] - Outreach Daily Activity Ingestion v3 - DISABLED.json');
const workflow = JSON.parse(readFileSync(artifactPath, 'utf8')) as Workflow;
const node = (name: string) => {
  const found = workflow.nodes.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing node: ${name}`);
  return found;
};
const query = (name: string) => node(name).parameters.queryParameters.parameters as Array<{ name: string; value: string }>;

describe('disabled Outreach daily activity ingestion workflow', () => {
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

  it('uses six paginated Outreach reads and exactly one guarded Supabase write', () => {
    const requests = workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.httpRequest');
    const outreach = requests.filter((item) => String(item.parameters.url).includes('api.outreach.io'));
    expect(outreach).toHaveLength(6);
    for (const read of outreach) {
      expect(read.parameters.method ?? 'GET').toBe('GET');
      expect(JSON.stringify(read.parameters)).toContain('responseContainsNextURL');
    }
    const writes = requests.filter((item) => item.parameters.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0].name).toBe('APPLY: daily Outreach activity');
    expect(writes[0].parameters.url).toContain('sourced_apply_outreach_daily_activity_v2');
    expect(writes[0].parameters.genericAuthType).toBe('httpHeaderAuth');
    expect(JSON.stringify(workflow)).not.toMatch(/service_role|eyJ[A-Za-z0-9_-]+\./);
  });

  it('does not copy lifetime email, call, or task counters from sequences', () => {
    const fields = query('READ: all Outreach sequences').find((item) => item.name === 'fields[sequence]')?.value ?? '';
    expect(fields).toBe('name,createdAt,sequenceStepCount,durationInDays,enabled');
    expect(fields).not.toMatch(/delivered|opened|clicked|replied|calls|tasks/i);
  });

  it('reads dated enrollments and activity for the closed Denver day', () => {
    expect(query('READ: daily sequence-state enrollments')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'filter[createdAt][gte]' }),
      expect.objectContaining({ name: 'filter[createdAt][lte]' }),
      { name: 'count', value: 'true' },
    ]));
    expect(node('READ: mailings updated in daily window').parameters.url).toContain('/mailings');
    expect(query('READ: mailings updated in daily window').find((item) => item.name === 'fields[mailing]')?.value)
      .toContain('deliveredAt');
    for (const name of ['READ: calls completed in daily window', 'READ: LinkedIn tasks completed in daily window']) {
      expect(query(name)).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'filter[completedAt][gte]' }),
        expect.objectContaining({ name: 'filter[completedAt][lte]' }),
        { name: 'count', value: 'true' },
      ]));
    }
    expect(JSON.stringify(workflow)).not.toContain('filter[sequence][id]');
  });

  it('writes the v3 QA sheet first using the stable daily key', () => {
    const writes = workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.googleSheets');
    expect(writes).toHaveLength(1);
    expect(writes[0].parameters).toMatchObject({
      operation: 'appendOrUpdate',
      documentId: { value: '1OT2q0JF0mfvOFkSfHWyBUJKTt68fDzHlrSew2IWzvEo', mode: 'id' },
      sheetName: { value: 'Daily Sequence Activity v3', mode: 'name' },
      columns: { matchingColumns: ['snapshot_key'] },
    });
    expect(workflow.connections['QA WRITE: append or update daily activity'].main[0][0].node)
      .toBe('PACKAGE: QA result and closed apply gate');
  });

  it('labels every row and run as daily event activity', () => {
    const source = node('PRIVATE: daily activity rows - DO NOT SHARE').parameters.jsCode as string;
    const packageSource = node('PACKAGE: QA result and closed apply gate').parameters.jsCode as string;
    expect(source).toContain("row.activity_basis !== 'daily_event'");
    expect(packageSource).toContain("activity_basis: 'daily_event'");
    expect(packageSource).toContain('source_counts');
  });

  it('requires apply mode and the new exact phrase at both gates', () => {
    const packageSource = node('PACKAGE: QA result and closed apply gate').parameters.jsCode as string;
    expect(packageSource).toContain("const MODE = 'dry_run'");
    expect(packageSource).toContain("const CONFIRM = ''");
    expect(packageSource).toContain('APPLY APPROVED OUTREACH DAILY ACTIVITY TO SOURCED');
    const gate = node('APPLY GATE: exact confirmation').parameters.jsCode as string;
    expect(gate).toContain("packaged.mode !== 'apply'");
    expect(gate).toContain('packaged.apply_authorized !== true');
    expect(gate).toContain('packaged._private_confirmation !== packaged._private_required_confirmation');
  });

  it('keeps the database write unreachable from the dry-run terminal', () => {
    expect(workflow.connections['ROUTE: dry run or apply'].main).toEqual([
      [{ node: 'APPLY GATE: exact confirmation', type: 'main', index: 0 }],
      [{ node: 'DRY RUN: aggregate summary', type: 'main', index: 0 }],
    ]);
    expect(workflow.connections['DRY RUN: aggregate summary']).toBeUndefined();
    expect(workflow.connections['APPLY GATE: exact confirmation'].main[0][0].node)
      .toBe('APPLY: daily Outreach activity');
  });

  it('builds exact Denver boundaries across daylight-saving transitions', () => {
    const source = node('Prepare closed daily window').parameters.jsCode as string;
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

  it('compiles every generated Code node', () => {
    for (const item of workflow.nodes) {
      if (item.parameters.jsCode) expect(() => new Function(item.parameters.jsCode)).not.toThrow();
    }
  });
});
