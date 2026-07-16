// Pure, lock-aware SFDC sync builders extracted from useLeads.ts so the
// edit-lock contract is testable without a Supabase client or network. These
// functions decide WHAT to write; the hook keeps the orchestration (who to
// fetch, when to call, how to persist).
//
// The edit-lock contract (AGENTS.md): a locked field keeps the Marketing value
// but still records the incoming SFDC value under source_sfdc so drift is
// visible; an unlocked field is overwritten. Both paths always update
// last_synced_at.
//
// Clocks are injected (nowIso / todayIso) so tests are deterministic. No
// Math.random, no Date.now read inside the pure logic.

import type { Lead, StageHistoryEntry, StageKey } from '../types/db';
import type { EditableLeadField } from '../constants/leadFields';
import { EDITABLE_LEAD_FIELDS } from '../constants/leadFields';

// SFDC candidate values for one lead, typed to the actual Lead field types
// (was Partial<Record<EditableLeadField, unknown>>). Each editable field maps to
// its real Lead[K] type, so a wrong-typed value is now a compile error.
export type SfdcSyncValues = {
  [K in EditableLeadField]?: Lead[K];
};

export interface SfdcSync {
  email: string;
  values: SfdcSyncValues;
  // Channel hierarchy from the SFDC report (Parent Campaign and Campaign Name
  // columns). The bulk path resolves these into a leaf channel id.
  parentChannelName?: string;
  subChannelName?: string;
  sfdc_lead_id?: string;
  sfdc_contact_id?: string;
}

// Clock injection point. The hook passes real ISO producers; tests pass fixed
// strings.
export interface SyncClock {
  nowIso: () => string; // full timestamp for last_synced_at
  todayIso: () => string; // date-only for stage_history entered_at fallback
}

// Who edits are attributed to on sync-appended history entries.
const EDITED_BY = 'Marketing';

// Build the lock-aware patch to apply to an EXISTING lead row. Locked fields are
// preserved in the lead but recorded under source_sfdc; unlocked fields are
// overwritten. A stage upgrade appends one history entry (never modifies one).
export function buildSyncPatch(
  existing: Lead,
  sync: SfdcSync,
  clock: SyncClock,
): Partial<Lead> {
  const sourceSfdc: Record<string, unknown> = { ...existing.source_sfdc };
  const patch: Record<string, unknown> = {};
  for (const field of EDITABLE_LEAD_FIELDS) {
    const incoming = sync.values[field];
    if (incoming === undefined) continue;
    sourceSfdc[field] = incoming;
    if (!existing.field_locks?.[field]) {
      patch[field] = incoming;
    }
  }
  // Detect a stage upgrade on re-import. If the incoming stage differs from the
  // current one and the new stage has no history entry yet, append one dated
  // today. Always additive, never locked: this path only ADDS entries.
  const incomingStage = sync.values.current_stage as StageKey | undefined;
  if (
    incomingStage &&
    incomingStage !== 'lead' &&
    incomingStage !== existing.current_stage
  ) {
    const alreadyHasEntry = (existing.stage_history ?? []).some(
      (e) => e.stage === incomingStage,
    );
    if (!alreadyHasEntry) {
      const newEntry: StageHistoryEntry = {
        stage: incomingStage,
        entered_at: clock.todayIso(),
        edited_by: EDITED_BY,
        edit_locked: false,
      };
      patch.stage_history = [...(existing.stage_history ?? []), newEntry];
    }
  }
  if (sync.sfdc_lead_id && !existing.sfdc_lead_id) {
    patch.sfdc_lead_id = sync.sfdc_lead_id;
  }
  if (sync.sfdc_contact_id && !existing.sfdc_contact_id) {
    patch.sfdc_contact_id = sync.sfdc_contact_id;
  }
  patch.source_sfdc = sourceSfdc;
  patch.last_synced_at = clock.nowIso();
  return patch as Partial<Lead>;
}

// Build a brand-new lead row from an SFDC candidate. Email is normalized; a
// non-'lead' default stage seeds one history entry so the funnel MQL count
// (which reads stage_history) is correct on first insert.
export function buildInsertRow(sync: SfdcSync, clock: SyncClock): Partial<Lead> {
  const sourceSfdc: Record<string, unknown> = {};
  const row: Record<string, unknown> = {};
  for (const field of EDITABLE_LEAD_FIELDS) {
    const incoming = sync.values[field];
    if (incoming === undefined) continue;
    sourceSfdc[field] = incoming;
    row[field] = incoming;
  }
  if (sync.sfdc_lead_id) row.sfdc_lead_id = sync.sfdc_lead_id;
  if (sync.sfdc_contact_id) row.sfdc_contact_id = sync.sfdc_contact_id;
  row.email = sync.email.trim().toLowerCase();
  const stage: StageKey = sync.values.current_stage ?? 'lead';
  row.current_stage = stage;
  const history: StageHistoryEntry[] = [];
  if (stage !== 'lead') {
    const enteredAt = sync.values.marketing_sourced_date ?? clock.todayIso();
    history.push({
      stage,
      entered_at: enteredAt,
      edited_by: EDITED_BY,
      edit_locked: false,
    });
  }
  row.stage_history = history;
  row.field_locks = {};
  row.source_sfdc = sourceSfdc;
  row.last_synced_at = clock.nowIso();
  return row as Partial<Lead>;
}
