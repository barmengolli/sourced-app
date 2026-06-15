// Access to the sixsense_snapshots table. Mirrors useOutreachSnapshots
// (paged fetch past the PostgREST 1000-row cap, per-instance realtime
// channel) but also writes: the in-app 6sense importer calls upsertSnapshot
// to add or replace a weekly summary, keyed by snapshot_date.
//
// latest() / priorTo() back the dashboard's week-over-week delta: the current
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
  // The snapshot immediately before the given snapshot_date (for WoW deltas).
  priorTo: (snapshotDate: string) => SixSenseSnapshot | null;
  // Upsert on snapshot_date. Returns the saved row.
  upsertSnapshot: (input: SixSenseSnapshotInput) => Promise<SixSenseSnapshot>;
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
        .upsert(input, { onConflict: 'snapshot_date' })
        .select()
        .single();
      if (upsertError) throw upsertError;
      const saved = data as SixSenseSnapshot;
      // Optimistic local merge; realtime will also fire but may lag.
      setSnapshots((prev) =>
        sortByDateDesc([
          saved,
          ...prev.filter((s) => s.snapshot_date !== saved.snapshot_date),
        ]),
      );
      return saved;
    },
    [],
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
    }),
    [snapshots, loading, error, refresh, byYear, latest, priorTo, upsertSnapshot],
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
