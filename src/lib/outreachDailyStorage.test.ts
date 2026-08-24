import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  resolve(process.cwd(), 'migrations/2026-08-20_outreach_daily_ingestion.sql'),
  'utf8',
);
const ACTIVITY_MIGRATION = readFileSync(
  resolve(process.cwd(), 'migrations/2026-08-24_outreach_daily_activity_inputs.sql'),
  'utf8',
);
const SCHEMA = readFileSync(resolve(process.cwd(), 'SCHEMA.sql'), 'utf8');

const metricColumns = [
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
] as const;

describe('Outreach daily storage contract', () => {
  it('uses one stable natural key for a sequence on a Denver reporting day', () => {
    for (const sql of [MIGRATION, SCHEMA]) {
      expect(sql).toContain('UNIQUE (snapshot_date, sequence_id)');
      expect(sql).toContain("timezone TEXT NOT NULL CHECK (timezone = 'America/Denver')");
    }
  });

  it('keeps missing measurements nullable rather than silently defaulting to zero', () => {
    const table = MIGRATION.slice(
      MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS public.outreach_daily_snapshots'),
      MIGRATION.indexOf('CREATE INDEX IF NOT EXISTS idx_outreach_daily_snapshots_sequence_date'),
    );
    for (const column of metricColumns) {
      expect(table).toMatch(new RegExp(`${column} INTEGER CHECK`));
      expect(table).not.toMatch(new RegExp(`${column} INTEGER[^,]*DEFAULT\\s+0`));
    }
  });

  it('stores extraction metadata and refuses an incomplete complete run', () => {
    for (const field of [
      'window_start_utc TIMESTAMPTZ NOT NULL',
      'window_end_utc TIMESTAMPTZ NOT NULL',
      'collected_at TIMESTAMPTZ NOT NULL',
      'expected_sequences INTEGER NOT NULL',
      'observed_sequences INTEGER NOT NULL',
      'pagination_complete BOOLEAN NOT NULL',
      'natural_keys_unique BOOLEAN NOT NULL',
    ]) {
      expect(MIGRATION).toContain(field);
    }
    expect(MIGRATION).toContain("status <> 'complete'");
    expect(MIGRATION).toContain('expected_sequences = observed_sequences');
  });

  it('upserts both rows and the run so an exact rerun cannot duplicate data', () => {
    expect(MIGRATION).toContain('ON CONFLICT (snapshot_date, sequence_id) DO UPDATE SET');
    expect(MIGRATION).toContain('ON CONFLICT (snapshot_date) DO UPDATE SET');
    expect(MIGRATION).toContain("'natural_key', 'snapshot_date + sequence_id'");
  });

  it('rechecks uniqueness, row scope, and stored completeness inside the database', () => {
    expect(MIGRATION).toContain('duplicate snapshot_date + sequence_id key');
    expect(MIGRATION).toContain('row scope or completeness differs from run');
    expect(MIGRATION).toContain('stored sequence count % differs from expected %');
  });

  it('limits mutation access to the service role with a pinned search path', () => {
    expect(MIGRATION).toContain('SECURITY DEFINER');
    expect(MIGRATION).toContain('SET search_path = pg_catalog');
    expect(MIGRATION).toContain('FROM PUBLIC, anon, authenticated');
    expect(MIGRATION).toContain('TO service_role');
    expect(MIGRATION).not.toContain('GRANT EXECUTE ON FUNCTION public.sourced_apply_outreach_daily_snapshot(JSONB, JSONB)\n  TO anon');
  });

  it('enables RLS and exposes read-only reporting access', () => {
    for (const table of ['outreach_daily_runs', 'outreach_daily_snapshots']) {
      expect(MIGRATION).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(MIGRATION).toContain(`CREATE POLICY "Allow public read" ON public.${table}`);
    }
    expect(MIGRATION).not.toMatch(/CREATE POLICY[^;]+FOR (?:INSERT|UPDATE|DELETE)/s);
  });

  it('keeps the canonical schema synchronized with the migration', () => {
    for (const fragment of [
      'CREATE TABLE IF NOT EXISTS public.outreach_daily_runs',
      'CREATE TABLE IF NOT EXISTS public.outreach_daily_snapshots',
      'CREATE OR REPLACE FUNCTION public.sourced_apply_outreach_daily_snapshot',
      'UNIQUE (snapshot_date, sequence_id)',
      'OUTREACH APPLY REFUSED: extraction completeness checks failed',
    ]) {
      expect(SCHEMA).toContain(fragment);
    }
  });

  it('adds an explicit basis without relabeling legacy cumulative history', () => {
    for (const sql of [ACTIVITY_MIGRATION, SCHEMA]) {
      expect(sql).toContain("activity_basis TEXT NOT NULL DEFAULT 'legacy_cumulative'");
      expect(sql).toContain("activity_basis IN ('legacy_cumulative', 'daily_event')");
      expect(sql).toContain("source_counts JSONB NOT NULL DEFAULT '{}'::JSONB");
    }
    expect(ACTIVITY_MIGRATION).toContain("WHERE snapshot_date = v_snapshot_date");
    expect(ACTIVITY_MIGRATION).not.toMatch(/UPDATE public\.outreach_daily_snapshots\s+SET activity_basis = 'daily_event'\s*;/s);
  });

  it('provides a service-role-only daily-event wrapper around the atomic apply', () => {
    for (const sql of [ACTIVITY_MIGRATION, SCHEMA]) {
      expect(sql).toContain('CREATE OR REPLACE FUNCTION public.sourced_apply_outreach_daily_activity_v2');
      expect(sql).toContain("p_run->>'activity_basis' <> 'daily_event'");
      expect(sql).toContain("item->>'activity_basis' <> 'daily_event'");
      expect(sql).toContain("p_run->'source_counts'");
      expect(sql).toContain('public.sourced_apply_outreach_daily_snapshot(p_rows, p_run)');
      expect(sql).toContain('FROM PUBLIC, anon, authenticated');
      expect(sql).toContain('TO service_role');
    }
  });
});
