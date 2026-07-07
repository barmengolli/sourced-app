// Read-only access to the linkedin_ads_snapshots table. The n8n weekly cron is
// the only writer. Mirrors useOutreachSnapshots: page past the PostgREST
// 1000-row cap, subscribe to realtime so a cron run pushes new rows without a
// refresh. Metrics are PER-WEEK (not cumulative), so callers sum rows directly.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { LinkedinAdSnapshot } from '../types/db';

const PAGE = 1000;

async function fetchAllSnapshots(): Promise<LinkedinAdSnapshot[]> {
  const all: LinkedinAdSnapshot[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('linkedin_ads_snapshots')
      .select('*')
      .order('snapshot_date', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as LinkedinAdSnapshot[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export interface UseLinkedinSnapshotsResult {
  snapshots: LinkedinAdSnapshot[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  byYear: (year: number) => LinkedinAdSnapshot[];
  byWeek: (year: number, week: number) => LinkedinAdSnapshot[];
  byMonth: (year: number, month: number) => LinkedinAdSnapshot[];
}

// Calendar month of a snapshot, parsed from snapshot_date (YYYY-MM-DD).
export function monthOfSnapshotDate(
  iso: string,
): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

export function useLinkedinSnapshots(): UseLinkedinSnapshotsResult {
  const [snapshots, setSnapshots] = useState<LinkedinAdSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const channelName = useMemo(
    () =>
      `public:linkedin_ads_snapshots:${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  const refresh = useCallback(async () => {
    try {
      setSnapshots(await fetchAllSnapshots());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('Failed to load LinkedIn snapshots', err);
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
        console.error('Failed to load LinkedIn snapshots', err);
        setLoading(false);
      });

    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'linkedin_ads_snapshots' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as LinkedinAdSnapshot;
            setSnapshots((prev) =>
              prev.some((s) => s.id === next.id) ? prev : [next, ...prev],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as LinkedinAdSnapshot;
            setSnapshots((prev) =>
              prev.map((s) => (s.id === next.id ? next : s)),
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
  }, [channelName]);

  const byYear = useCallback(
    (year: number) => snapshots.filter((s) => s.year === year),
    [snapshots],
  );
  const byWeek = useCallback(
    (year: number, week: number) =>
      snapshots.filter((s) => s.year === year && s.week_number === week),
    [snapshots],
  );
  const byMonth = useCallback(
    (year: number, month: number) =>
      snapshots.filter((s) => {
        const m = monthOfSnapshotDate(s.snapshot_date);
        return m !== null && m.year === year && m.month === month;
      }),
    [snapshots],
  );

  return useMemo(
    () => ({ snapshots, loading, error, refresh, byYear, byWeek, byMonth }),
    [snapshots, loading, error, refresh, byYear, byWeek, byMonth],
  );
}
