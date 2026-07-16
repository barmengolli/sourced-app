import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Lead, StageHistoryEntry, StageKey } from '../types/db';
import {
  type EditableLeadField,
  isEditableLeadField,
} from '../constants/leadFields';
import { todayIso } from '../lib/dates';
import {
  buildSyncPatch as buildSyncPatchPure,
  buildInsertRow as buildInsertRowPure,
  type SfdcSync,
  type SyncClock,
} from '../lib/leadSync';

// Re-export so existing callers importing SfdcSync from useLeads keep working.
export type { SfdcSync } from '../lib/leadSync';

const EDITED_BY = 'Marketing';
const PENDING_WRITE_TTL_MS = 1500;
const BULK_CHUNK = 100;
const LOOKUP_CHUNK = 500;

// Real clock for the pure sync builders. Tests pass a fixed clock instead.
const SYNC_CLOCK: SyncClock = {
  nowIso: () => new Date().toISOString(),
  todayIso,
};

export interface BulkSyncResult {
  inserted: number;
  updated: number;
  errors: { email: string; message: string }[];
}

export interface UseLeadsResult {
  leads: Lead[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  createLead: (input: { email: string } & Partial<Lead>) => Promise<Lead>;
  editField: <K extends EditableLeadField>(
    leadId: string,
    field: K,
    value: Lead[K],
  ) => Promise<void>;
  toggleLock: (
    leadId: string,
    field: EditableLeadField,
    locked: boolean,
  ) => Promise<void>;
  revertField: (leadId: string, field: EditableLeadField) => Promise<void>;
  setStageHistory: (
    leadId: string,
    entries: StageHistoryEntry[],
  ) => Promise<void>;
  deleteLead: (leadId: string) => Promise<void>;
  syncFromSfdc: (leadId: string, sync: SfdcSync) => Promise<void>;
  bulkSyncFromSfdc: (
    syncs: SfdcSync[],
    options?: { onProgress?: (done: number, total: number) => void },
  ) => Promise<BulkSyncResult>;
}

function pendingKey(leadId: string, field: string): string {
  return `${leadId}:${field}`;
}

const PAGE = 1000;

// PostgREST default cap is 1000 rows; page until exhausted to support full lead set.
async function fetchAllLeads(): Promise<Lead[]> {
  const all: Lead[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .order('updated_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as Lead[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Resolve channel hierarchy by name-stitching. The SFDC export collapses an
// N-level tree into (parent_name, child_name) pairs per row; the same name
// can appear as a parent in some rows and a child in others. This function:
//
//   1. Collects every distinct name and every (parent, child) pair.
//   2. Looks up existing channels with any of those names.
//   3. Inserts missing names at the root.
//   4. UPDATEs each child's parent_channel_id to point at its parent's id,
//      idempotently and skipping cycles.
//   5. Mutates each sync's source_channel_id to the leaf (subChannelName) id.
async function resolveChannelHierarchy(syncs: SfdcSync[]): Promise<void> {
  // 1. Collect every distinct name + every (parent, child) pair. If a child
  //    appears with multiple parents across rows, last-write-wins and we
  //    emit a console.warn so the conflict is visible in the dev console.
  const allNames = new Set<string>();
  const parentOf = new Map<string, string>(); // childName → parentName
  for (const s of syncs) {
    const parent = s.parentChannelName?.trim();
    const child = s.subChannelName?.trim();
    if (parent) allNames.add(parent);
    if (child) allNames.add(child);
    if (parent && child && parent !== child) {
      const existing = parentOf.get(child);
      if (existing !== undefined && existing !== parent) {
        console.warn(
          `Child "${child}" has conflicting parents in the import: previously "${existing}", now "${parent}". Last-write wins.`,
        );
      }
      parentOf.set(child, parent);
    }
  }
  if (allNames.size === 0) return;

  // 2. Look up every existing channel matching any name. Returns ALL rows
  //    whose name is in the set, regardless of where they sit in the tree.
  const { data: existing, error: lookupErr } = await supabase
    .from('channels')
    .select('id, name, parent_channel_id')
    .in('name', [...allNames]);
  if (lookupErr) throw lookupErr;

  // 3. Pick a single canonical id per name. On a clean re-import after
  //    truncate, every name has at most one row anyway.
  const idByName = new Map<string, string>();
  const currentParentByName = new Map<string, string | null>();
  for (const row of (existing ?? []) as {
    id: string;
    name: string;
    parent_channel_id: string | null;
  }[]) {
    if (!idByName.has(row.name)) {
      idByName.set(row.name, row.id);
      currentParentByName.set(row.name, row.parent_channel_id);
    }
  }

  // 4. INSERT missing names at the root. Re-parent happens in step 6.
  const namesToInsert = [...allNames].filter((n) => !idByName.has(n));
  if (namesToInsert.length > 0) {
    const rows = namesToInsert.map((name) => ({
      name,
      parent_channel_id: null,
      display_order: 0,
    }));
    const { data: inserted, error: insErr } = await supabase
      .from('channels')
      .insert(rows)
      .select('id, name');
    if (insErr) throw insErr;
    for (const c of (inserted ?? []) as { id: string; name: string }[]) {
      idByName.set(c.name, c.id);
      currentParentByName.set(c.name, null);
    }
  }

  // 5. Cycle detection: walk up the proposed parent's ancestor chain looking
  //    for the child name. If we find it, this assignment would form a cycle.
  const wouldCycle = (childName: string, parentName: string): boolean => {
    let cursor: string | undefined = parentName;
    const visited = new Set<string>();
    while (cursor) {
      if (cursor === childName) return true;
      if (visited.has(cursor)) return false; // input already cycles; bail
      visited.add(cursor);
      cursor = parentOf.get(cursor);
    }
    return false;
  };

  // 6. UPDATE each child's parent_channel_id. Idempotent: skip if already
  //    correct. Cycle-safe: skip with warning if the assignment would loop.
  const updates: { id: string; parentId: string }[] = [];
  for (const [childName, parentName] of parentOf) {
    if (wouldCycle(childName, parentName)) {
      console.warn(
        `Skipping "${childName}" → "${parentName}": would form a cycle`,
      );
      continue;
    }
    const childId = idByName.get(childName);
    const parentId = idByName.get(parentName);
    if (!childId || !parentId) continue;
    if (childId === parentId) continue;
    if (currentParentByName.get(childName) === parentId) continue;
    updates.push({ id: childId, parentId });
  }

  if (updates.length > 0) {
    const settled = await Promise.allSettled(
      updates.map((u) =>
        supabase
          .from('channels')
          .update({ parent_channel_id: u.parentId })
          .eq('id', u.id),
      ),
    );
    for (const s of settled) {
      if (s.status === 'rejected') {
        throw s.reason instanceof Error
          ? s.reason
          : new Error('Channel re-parent failed');
      }
      if (s.status === 'fulfilled' && s.value.error) {
        throw s.value.error;
      }
    }
  }

  // 7. Mutate syncs in place: the leaf for each lead is whatever appeared in
  //    the row's Campaign Name column (subChannelName). The parentChannelName
  //    was only used to stitch the tree.
  for (const s of syncs) {
    const child = s.subChannelName?.trim();
    if (!child) continue;
    const id = idByName.get(child);
    if (id) s.values.source_channel_id = id;
  }
}

export function useLeads(): UseLeadsResult {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Avoid stale closures inside the realtime callback.
  const leadsRef = useRef<Lead[]>([]);
  leadsRef.current = leads;

  // Field-level write guard: while a write for {leadId}:{field} is pending,
  // ignore that one column from realtime payloads to keep the cursor stable.
  const pendingWritesRef = useRef<Map<string, number>>(new Map());

  // Realtime channel handle, used so bulk sync can pause/resume the
  // subscription without clobbering the useEffect lifecycle.
  const channelRef = useRef<RealtimeChannel | null>(null);
  const realtimePausedRef = useRef(false);
  // Per-instance unique channel name so multiple parallel mounts don't
  // collide on .on() after .subscribe().
  const channelName = useMemo(
    () => `public:leads:${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  const markPending = useCallback((leadId: string, fields: string[]) => {
    const now = Date.now();
    for (const f of fields) {
      pendingWritesRef.current.set(pendingKey(leadId, f), now);
    }
    window.setTimeout(() => {
      const cutoff = Date.now() - PENDING_WRITE_TTL_MS / 2;
      for (const [k, ts] of pendingWritesRef.current) {
        if (ts < cutoff) pendingWritesRef.current.delete(k);
      }
    }, PENDING_WRITE_TTL_MS);
  }, []);

  const isPending = useCallback((leadId: string, field: string) => {
    const ts = pendingWritesRef.current.get(pendingKey(leadId, field));
    if (ts === undefined) return false;
    return Date.now() - ts < PENDING_WRITE_TTL_MS;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const all = await fetchAllLeads();
      setLeads(all);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('Failed to load leads', err);
    }
  }, []);

  // Initial load + realtime subscription.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAllLeads()
      .then((all) => {
        if (cancelled) return;
        setLeads(all);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        console.error('Failed to load leads', err);
        setLoading(false);
      });

    const subscribe = (): RealtimeChannel => {
      return supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'leads' },
          (payload) => {
            if (realtimePausedRef.current) return;
            if (payload.eventType === 'INSERT') {
              const next = payload.new as Lead;
              setLeads((prev) =>
                prev.some((l) => l.id === next.id) ? prev : [next, ...prev],
              );
            } else if (payload.eventType === 'UPDATE') {
              const next = payload.new as Lead;
              setLeads((prev) => {
                const existing = prev.find((l) => l.id === next.id);
                if (!existing) return [next, ...prev];
                // Per-field guard: keep our optimistic value for any column
                // that is currently in flight, take the server value for
                // everything else.
                const merged = { ...next } as unknown as Record<string, unknown>;
                const existingRecord = existing as unknown as Record<
                  string,
                  unknown
                >;
                for (const key of Object.keys(existingRecord)) {
                  if (isPending(next.id, key)) {
                    merged[key] = existingRecord[key];
                  }
                }
                return prev.map((l) =>
                  l.id === next.id ? (merged as unknown as Lead) : l,
                );
              });
            } else if (payload.eventType === 'DELETE') {
              const old = payload.old as { id?: string };
              if (!old?.id) return;
              setLeads((prev) => prev.filter((l) => l.id !== old.id));
            }
          },
        )
        .subscribe();
    };

    channelRef.current = subscribe();

    return () => {
      cancelled = true;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [isPending]);

  const pauseRealtime = useCallback(() => {
    realtimePausedRef.current = true;
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, []);

  const resumeRealtime = useCallback(() => {
    realtimePausedRef.current = false;
    if (channelRef.current) return;
    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'leads' },
        (payload) => {
          // Same handler logic as the initial subscription. Duplicated only
          // because the initial copy is closed over by the useEffect; pulling
          // it out into a module-scoped function would force us to thread
          // the leads ref and isPending through, which is uglier than this.
          if (realtimePausedRef.current) return;
          if (payload.eventType === 'INSERT') {
            const next = payload.new as Lead;
            setLeads((prev) =>
              prev.some((l) => l.id === next.id) ? prev : [next, ...prev],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as Lead;
            setLeads((prev) => {
              const existing = prev.find((l) => l.id === next.id);
              if (!existing) return [next, ...prev];
              const merged = { ...next } as unknown as Record<string, unknown>;
              const existingRecord = existing as unknown as Record<
                string,
                unknown
              >;
              for (const key of Object.keys(existingRecord)) {
                if (isPending(next.id, key)) {
                  merged[key] = existingRecord[key];
                }
              }
              return prev.map((l) =>
                l.id === next.id ? (merged as unknown as Lead) : l,
              );
            });
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setLeads((prev) => prev.filter((l) => l.id !== old.id));
          }
        },
      )
      .subscribe();
  }, [isPending]);

  const applyPatch = useCallback(
    async (
      leadId: string,
      patch: Partial<Lead>,
      changedFields: string[],
    ): Promise<void> => {
      const before = leadsRef.current.find((l) => l.id === leadId);
      if (!before) throw new Error('Lead not found');

      // Optimistic update.
      const optimistic: Lead = { ...before, ...patch } as Lead;
      setLeads((prev) => prev.map((l) => (l.id === leadId ? optimistic : l)));
      markPending(leadId, changedFields);

      const { error: err } = await supabase
        .from('leads')
        .update(patch)
        .eq('id', leadId);
      if (err) {
        // Roll back.
        setLeads((prev) => prev.map((l) => (l.id === leadId ? before : l)));
        console.error('Lead update failed', err);
        throw err;
      }
    },
    [markPending],
  );

  const editField = useCallback(
    async <K extends EditableLeadField>(
      leadId: string,
      field: K,
      value: Lead[K],
    ): Promise<void> => {
      if (!isEditableLeadField(field)) {
        throw new Error(`Field ${field} is not editable`);
      }
      const lead = leadsRef.current.find((l) => l.id === leadId);
      if (!lead) throw new Error('Lead not found');

      const oldValue = lead[field];
      if (oldValue === value) return;

      const sourceSfdc: Record<string, unknown> = { ...lead.source_sfdc };
      if (!(field in sourceSfdc)) {
        sourceSfdc[field] = oldValue ?? null;
      }
      const fieldLocks: Record<string, boolean> = {
        ...lead.field_locks,
        [field]: true,
      };
      const patch: Partial<Lead> = {
        [field]: value,
        field_locks: fieldLocks,
        source_sfdc: sourceSfdc,
        last_edited_by: EDITED_BY,
      } as Partial<Lead>;

      const changedFields: string[] = [field, 'field_locks', 'source_sfdc', 'last_edited_by'];

      if (field === 'current_stage') {
        const newStage = value as StageKey;
        const newEntry: StageHistoryEntry = {
          stage: newStage,
          entered_at: todayIso(),
          edited_by: EDITED_BY,
          edit_locked: false,
        };
        patch.stage_history = [...lead.stage_history, newEntry];
        changedFields.push('stage_history');
      }

      await applyPatch(leadId, patch, changedFields);
    },
    [applyPatch],
  );

  const toggleLock = useCallback(
    async (
      leadId: string,
      field: EditableLeadField,
      locked: boolean,
    ): Promise<void> => {
      const lead = leadsRef.current.find((l) => l.id === leadId);
      if (!lead) throw new Error('Lead not found');
      const fieldLocks: Record<string, boolean> = {
        ...lead.field_locks,
        [field]: locked,
      };
      const patch: Partial<Lead> = {
        field_locks: fieldLocks,
        last_edited_by: EDITED_BY,
      };
      await applyPatch(leadId, patch, ['field_locks', 'last_edited_by']);
    },
    [applyPatch],
  );

  const revertField = useCallback(
    async (leadId: string, field: EditableLeadField): Promise<void> => {
      const lead = leadsRef.current.find((l) => l.id === leadId);
      if (!lead) throw new Error('Lead not found');
      if (!(field in lead.source_sfdc)) {
        throw new Error('No SFDC value on record for this field');
      }
      const sfdcValue = lead.source_sfdc[field] as Lead[EditableLeadField];
      const fieldLocks: Record<string, boolean> = { ...lead.field_locks };
      delete fieldLocks[field];
      const patch: Partial<Lead> = {
        [field]: sfdcValue,
        field_locks: fieldLocks,
        last_edited_by: EDITED_BY,
      } as Partial<Lead>;
      await applyPatch(leadId, patch, [field, 'field_locks', 'last_edited_by']);
    },
    [applyPatch],
  );

  const setStageHistory = useCallback(
    async (leadId: string, entries: StageHistoryEntry[]): Promise<void> => {
      const patch: Partial<Lead> = {
        stage_history: entries,
        last_edited_by: EDITED_BY,
      };
      await applyPatch(leadId, patch, ['stage_history', 'last_edited_by']);
    },
    [applyPatch],
  );

  const createLead = useCallback(
    async (input: { email: string } & Partial<Lead>): Promise<Lead> => {
      const email = input.email.trim().toLowerCase();
      if (!email) throw new Error('Email is required');
      const row: Partial<Lead> = {
        ...input,
        email,
        current_stage: input.current_stage ?? 'lead',
        stage_history: input.stage_history ?? [],
        field_locks: input.field_locks ?? {},
        source_sfdc: input.source_sfdc ?? {},
        last_edited_by: EDITED_BY,
      };
      const { data, error: err } = await supabase
        .from('leads')
        .insert(row)
        .select()
        .single();
      if (err) {
        console.error('Lead insert failed', err);
        throw err;
      }
      const created = data as Lead;
      setLeads((prev) =>
        prev.some((l) => l.id === created.id) ? prev : [created, ...prev],
      );
      return created;
    },
    [],
  );

  const deleteLead = useCallback(async (leadId: string): Promise<void> => {
    const before = leadsRef.current;
    setLeads((prev) => prev.filter((l) => l.id !== leadId));
    const { error: err } = await supabase.from('leads').delete().eq('id', leadId);
    if (err) {
      setLeads(before);
      console.error('Lead delete failed', err);
      throw err;
    }
  }, []);

  // Thin wrappers over the pure lock-aware builders in lib/leadSync.ts, bound to
  // the real clock. The edit-lock logic and its tests live there.
  const buildSyncPatch = useCallback(
    (existing: Lead, sync: SfdcSync): Partial<Lead> =>
      buildSyncPatchPure(existing, sync, SYNC_CLOCK),
    [],
  );

  const buildInsertRow = useCallback(
    (sync: SfdcSync): Partial<Lead> => buildInsertRowPure(sync, SYNC_CLOCK),
    [],
  );

  const syncFromSfdc = useCallback(
    async (leadId: string, sync: SfdcSync): Promise<void> => {
      const lead = leadsRef.current.find((l) => l.id === leadId);
      if (!lead) throw new Error('Lead not found');
      const patch = buildSyncPatch(lead, sync);
      const changed = Object.keys(patch);
      await applyPatch(leadId, patch, changed);
    },
    [applyPatch, buildSyncPatch],
  );

  const bulkSyncFromSfdc = useCallback(
    async (
      syncs: SfdcSync[],
      options?: { onProgress?: (done: number, total: number) => void },
    ): Promise<BulkSyncResult> => {
      const onProgress = options?.onProgress;
      const result: BulkSyncResult = { inserted: 0, updated: 0, errors: [] };
      if (syncs.length === 0) return result;

      // Phase 0: resolve channel hierarchy by find-or-create.
      // Mutates each sync.values.source_channel_id in place. Done before the
      // realtime pause so the channel inserts broadcast normally; the leads
      // bulk write is what we need to shield from broadcast feedback.
      try {
        await resolveChannelHierarchy(syncs);
      } catch (e) {
        console.error('Channel resolution failed', e);
        throw e;
      }

      pauseRealtime();
      try {
        // 1. Look up existing leads by email in chunks.
        const emailToExisting = new Map<string, Lead>();
        const allEmails = syncs.map((s) => s.email.trim().toLowerCase());
        for (let i = 0; i < allEmails.length; i += LOOKUP_CHUNK) {
          const slice = allEmails.slice(i, i + LOOKUP_CHUNK);
          const { data, error: err } = await supabase
            .from('leads')
            .select('*')
            .in('email', slice);
          if (err) throw err;
          for (const row of (data ?? []) as Lead[]) {
            emailToExisting.set(row.email.toLowerCase(), row);
          }
        }

        // 2. Partition into inserts and updates.
        const toInsert: SfdcSync[] = [];
        const toUpdate: { id: string; patch: Partial<Lead>; email: string }[] =
          [];
        for (const sync of syncs) {
          const key = sync.email.trim().toLowerCase();
          const existing = emailToExisting.get(key);
          if (existing) {
            try {
              const patch = buildSyncPatch(existing, { ...sync, email: key });
              toUpdate.push({ id: existing.id, patch, email: key });
            } catch (e) {
              result.errors.push({
                email: key,
                message: e instanceof Error ? e.message : 'patch build failed',
              });
            }
          } else {
            toInsert.push({ ...sync, email: key });
          }
        }

        const total = toInsert.length + toUpdate.length;
        let done = 0;

        // 3. Inserts in chunks.
        for (let i = 0; i < toInsert.length; i += BULK_CHUNK) {
          const slice = toInsert.slice(i, i + BULK_CHUNK);
          const rows = slice.map(buildInsertRow);
          const { error: err } = await supabase.from('leads').insert(rows);
          if (err) {
            for (const s of slice) {
              result.errors.push({ email: s.email, message: err.message });
            }
          } else {
            result.inserted += slice.length;
          }
          done += slice.length;
          onProgress?.(done, total);
        }

        // 4. Updates in chunks (parallel within each chunk).
        for (let i = 0; i < toUpdate.length; i += BULK_CHUNK) {
          const slice = toUpdate.slice(i, i + BULK_CHUNK);
          const settled = await Promise.allSettled(
            slice.map(({ id, patch }) =>
              supabase.from('leads').update(patch).eq('id', id),
            ),
          );
          settled.forEach((s, idx) => {
            const row = slice[idx];
            if (s.status === 'fulfilled') {
              if (s.value.error) {
                result.errors.push({
                  email: row.email,
                  message: s.value.error.message,
                });
              } else {
                result.updated += 1;
              }
            } else {
              result.errors.push({
                email: row.email,
                message:
                  s.reason instanceof Error ? s.reason.message : 'update failed',
              });
            }
          });
          done += slice.length;
          onProgress?.(done, total);
        }
      } finally {
        // 5. Single refresh, then resubscribe.
        try {
          await refresh();
        } catch (e) {
          console.error('Failed to refresh leads after bulk sync', e);
        }
        resumeRealtime();
      }
      return result;
    },
    [buildSyncPatch, buildInsertRow, pauseRealtime, resumeRealtime, refresh],
  );

  return {
    leads,
    loading,
    error,
    refresh,
    createLead,
    editField,
    toggleLock,
    revertField,
    setStageHistory,
    deleteLead,
    syncFromSfdc,
    bulkSyncFromSfdc,
  };
}
