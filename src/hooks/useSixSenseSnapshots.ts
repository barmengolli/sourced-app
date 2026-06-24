// Access to the sixsense_snapshots table. Mirrors useOutreachSnapshots
// (paged fetch past the PostgREST 1000-row cap, per-instance realtime
// channel) but also writes: the in-app 6sense importer calls upsertSnapshot
// to add or replace a monthly summary, keyed by snapshot_date.
//
// latest() / priorTo() back the dashboard's month-over-month delta: the current
// snapshot vs the one immediately before it in time.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { SixSenseSnapshot } from '../types/db';
import type { SixSenseSnapshotInput } from '../lib/sixsense';

const PAGE = 1000;

async function fetchAllSnapshots(): Promise<SixSenseSnapshot[]> {
  const all: SixSenseSnapshot[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('sixsense_snapshots')
      .select('*')
      .order('snapshot_date', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as SixSenseSnapshot[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export interface UseSixSenseSnapshotsResult {
  snapshots: SixSenseSnapshot[]; // newest snapshot_date first
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  byYear: (year: number) => SixSenseSnapshot[];
  // Most recent snapshot at or before `date` (defaults to the latest overall).
  latest: () => SixSenseSnapshot | null;
  // The snapshot immediately before the given snapshot_date (for MoM deltas).
  priorTo: (snapshotDate: string) => SixSenseSnapshot | null;
  // Upsert on snapshot_date. Returns the saved row.
  upsertSnapshot: (input: SixSenseSnapshotInput) => Promise<SixSenseSnapshot>;
  // Rename a segment across all its snapshot rows (fixes a typo). Throws if
  // the target name already exists on another segment (would merge them).
  renameSegment: (from: string, to: string) => Promise<void>;
}

export function useSixSenseSnapshots(): UseSixSenseSnapshotsResult {
  const [snapshots, setSnapshots] = useState<SixSenseSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const channelName = useMemo(
    () => `public:sixsense_snapshots:${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const all = await fetchAllSnapshots();
      setSnapshots(all);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('Failed to load 6sense snapshots', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAllSnapshots()
      .then((all) => {
        if (cancelled) return;
        setSnapshots(all);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        console.error('Failed to load 6sense snapshots', err);
        setLoading(false);
      });

    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sixsense_snapshots' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as SixSenseSnapshot;
            setSnapshots((prev) =>
              prev.some((s) => s.id === next.id)
                ? prev
                : sortByDateDesc([next, ...prev]),
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as SixSenseSnapshot;
            setSnapshots((prev) =>
              sortByDateDesc(prev.map((s) => (s.id === next.id ? next : s))),
            );
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setSnapshots((prev) => prev.filter((s) => s.id !== old.id));
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, []);

  const byYear = useCallback(
    (year: number) => snapshots.filter((s) => s.year === year),
    [snapshots],
  );

  const latest = useCallback(
    () => (snapshots.length > 0 ? snapshots[0] : null),
    [snapshots],
  );

  const priorTo = useCallback(
    (snapshotDate: string) =>
      snapshots.find((s) => s.snapshot_date < snapshotDate) ?? null,
    [snapshots],
  );

  const upsertSnapshot = useCallback(
    async (input: SixSenseSnapshotInput): Promise<SixSenseSnapshot> => {
      const { data, error: upsertError } = await supabase
        .from('sixsense_snapshots')
        .upsert(input, { onConflict: 'snapshot_date,segment' })
        .select()
        .single();
      if (upsertError) throw upsertError;
      const saved = data as SixSenseSnapshot;
      // Optimistic local merge; realtime will also fire but may lag. Dedupe on
      // (snapshot_date, segment) so importing one segment doesn't evict
      // another segment's row for the same week.
      setSnapshots((prev) =>
        sortByDateDesc([
          saved,
          ...prev.filter(
            (s) =>
              !(
                s.snapshot_date === saved.snapshot_date &&
                s.segment === saved.segment
              ),
          ),
        ]),
      );
      return saved;
    },
    [],
  );

  const renameSegment = useCallback(
    async (from: string, to: string): Promise<void> => {
      const trimmed = to.trim();
      if (!trimmed || trimmed === from) return;
      // Refuse to merge into an existing segment: the (snapshot_date, segment)
      // unique key would collide for any shared month. A typo fix should target
      // a brand-new name, not an occupied one.
      const collision = snapshots.some((s) => s.segment === trimmed);
      if (collision) {
        throw new Error(
          `A segment named "${trimmed}" already exists. Pick a different name.`,
        );
      }
      const { error: updErr } = await supabase
        .from('sixsense_snapshots')
        .update({ segment: trimmed })
        .eq('segment', from);
      if (updErr) throw updErr;
      // Optimistic local rename; realtime UPDATEs will reconcile.
      setSnapshots((prev) =>
        prev.map((s) => (s.segment === from ? { ...s, segment: trimmed } : s)),
      );
    },
    [snapshots],
  );

  return useMemo(
    () => ({
      snapshots,
      loading,
      error,
      refresh,
      byYear,
      latest,
      priorTo,
      upsertSnapshot,
      renameSegment,
    }),
    [
      snapshots,
      loading,
      error,
      refresh,
      byYear,
      latest,
      priorTo,
      upsertSnapshot,
      renameSegment,
    ],
  );
}

function sortByDateDesc(rows: SixSenseSnapshot[]): SixSenseSnapshot[] {
  return [...rows].sort((a, b) =>
    a.snapshot_date < b.snapshot_date
      ? 1
      : a.snapshot_date > b.snapshot_date
        ? -1
        : 0,
  );
}
