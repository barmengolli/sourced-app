// Step 4A: pure tests for the SFDC edit-lock sync builders. No Supabase client,
// no network, no mocks: the builders are pure functions of (lead, sync, clock).
// The clock is injected so entered_at / last_synced_at are deterministic.

import { describe, it, expect } from 'vitest';
import { buildSyncPatch, buildInsertRow, type SfdcSync, type SyncClock } from './leadSync';
import { lead, stageHistory } from '../test/fixtures/factories';

const CLOCK: SyncClock = {
  nowIso: () => '2026-07-16T12:00:00.000Z',
  todayIso: () => '2026-07-16',
};

function sync(over: Partial<SfdcSync> = {}): SfdcSync {
  return { email: 'x@example.test', values: {}, ...over };
}

describe('buildSyncPatch — edit-lock contract', () => {
  it('preserves the Marketing value on a LOCKED field', () => {
    const existing = lead({
      account: 'Marketing Corp',
      field_locks: { account: true },
    });
    const patch = buildSyncPatch(existing, sync({ values: { account: 'SFDC Corp' } }), CLOCK);
    // Locked: the field itself is NOT overwritten.
    expect(patch.account).toBeUndefined();
    // But drift is recorded under source_sfdc.
    expect(patch.source_sfdc?.account).toBe('SFDC Corp');
  });

  it('overwrites an UNLOCKED field and records source_sfdc', () => {
    const existing = lead({ account: 'Old', field_locks: {} });
    const patch = buildSyncPatch(existing, sync({ values: { account: 'New' } }), CLOCK);
    expect(patch.account).toBe('New');
    expect(patch.source_sfdc?.account).toBe('New');
  });

  it('preserves a locked field even when the incoming value is null', () => {
    const existing = lead({ account: 'Keep', field_locks: { account: true } });
    const patch = buildSyncPatch(existing, sync({ values: { account: null } }), CLOCK);
    expect(patch.account).toBeUndefined(); // not overwritten to null
    expect(patch.source_sfdc?.account).toBeNull(); // drift recorded
  });

  it('always sets last_synced_at from the injected clock', () => {
    const patch = buildSyncPatch(lead(), sync(), CLOCK);
    expect(patch.last_synced_at).toBe('2026-07-16T12:00:00.000Z');
  });

  it('appends one stage_history entry on a lead -> mql upgrade', () => {
    const existing = lead({ current_stage: 'lead', stage_history: [stageHistory('lead', '2026-01-01')] });
    const patch = buildSyncPatch(existing, sync({ values: { current_stage: 'mql' } }), CLOCK);
    expect(patch.stage_history).toHaveLength(2);
    const appended = patch.stage_history?.[1];
    expect(appended?.stage).toBe('mql');
    expect(appended?.entered_at).toBe('2026-07-16'); // injected today
    expect(appended?.edit_locked).toBe(false);
  });

  it('does NOT duplicate history when the incoming stage already has an entry', () => {
    const existing = lead({
      current_stage: 'lead',
      stage_history: [stageHistory('lead', '2026-01-01'), stageHistory('mql', '2026-02-01')],
    });
    const patch = buildSyncPatch(existing, sync({ values: { current_stage: 'mql' } }), CLOCK);
    // mql already present, so no new entry (and no stage_history in the patch).
    expect(patch.stage_history).toBeUndefined();
  });

  it('fills a system ID only when the existing one is empty', () => {
    const existing = lead({ sfdc_lead_id: undefined });
    const patch = buildSyncPatch(existing, sync({ sfdc_lead_id: 'L-1' }), CLOCK);
    expect(patch.sfdc_lead_id).toBe('L-1');

    const existing2 = lead({ sfdc_lead_id: 'ALREADY' });
    const patch2 = buildSyncPatch(existing2, sync({ sfdc_lead_id: 'L-2' }), CLOCK);
    expect(patch2.sfdc_lead_id).toBeUndefined(); // not clobbered
  });
});

describe('buildInsertRow — new lead construction', () => {
  it('normalizes email to trimmed lowercase', () => {
    const row = buildInsertRow(sync({ email: '  MixedCase@Example.TEST  ' }), CLOCK);
    expect(row.email).toBe('mixedcase@example.test');
  });

  it('seeds stage_history when a fresh lead is inserted at MQL', () => {
    const row = buildInsertRow(
      sync({ values: { current_stage: 'mql', marketing_sourced_date: '2026-03-15' } }),
      CLOCK,
    );
    expect(row.current_stage).toBe('mql');
    expect(row.stage_history).toHaveLength(1);
    expect(row.stage_history?.[0].stage).toBe('mql');
    // entered_at uses marketing_sourced_date when present.
    expect(row.stage_history?.[0].entered_at).toBe('2026-03-15');
  });

  it('seeds no history for a plain lead-stage insert', () => {
    const row = buildInsertRow(sync({ values: { current_stage: 'lead' } }), CLOCK);
    expect(row.stage_history).toHaveLength(0);
  });

  it('falls back to today for the MQL entered_at when no sourced date', () => {
    const row = buildInsertRow(sync({ values: { current_stage: 'mql' } }), CLOCK);
    expect(row.stage_history?.[0].entered_at).toBe('2026-07-16');
  });

  it('starts every new lead with empty field_locks', () => {
    const row = buildInsertRow(sync({ values: { account: 'A' } }), CLOCK);
    expect(row.field_locks).toEqual({});
    expect(row.source_sfdc).toEqual({ account: 'A' });
  });
});
