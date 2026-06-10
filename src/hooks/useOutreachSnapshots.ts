// Read-only access to the outreach_snapshots table. The n8n weekly cron is
// the only writer. We page through the PostgREST 1000-row cap (same pattern
// as useLeads / useAttributions) and subscribe to realtime so a successful
// cron run pushes new rows into the UI without a refresh.
//
// Filter helpers (byYear / byWeek / byQuarter / bySequence / byRegion) live
// on the result so callers don't reinvent the same predicates. Region is
// inferred from sequence_name via inferRegionFromSequenceName.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { OutreachSnapshot } from '../types/db';
import type { PeriodIndex } from '../types/db';
import type { OutreachRegionKey } from '../constants/outreachRegions';
import { inferRegionFromSequenceName } from '../lib/outreach';

const PAGE = 1000;

async function fetchAllSnapshots(): Promise<OutreachSnapshot[]> {
  const all: OutreachSnapshot[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('outreach_snapshots')
      .select('*')
      .order('export_date', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as OutreachSnapshot[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export interface UseOutreachSnapshotsResult {
  snapshots: OutreachSnapshot[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  byYear: (year: number) => OutreachSnapshot[];
  byWeek: (year: number, week: number) => OutreachSnapshot[];
  byQuarter: (year: number, q: PeriodIndex) => OutreachSnapshot[];
  bySequence: (id: number) => OutreachSnapshot[];
  byRegion: (region: OutreachRegionKey) => OutreachSnapshot[];
}

// ISO week → calendar quarter mapping for the byQuarter helper. We don't
// store quarter on the row, but ISO week numbers map cleanly enough for
// reporting purposes: Q1=W1-13, Q2=W14-26, Q3=W27-39, Q4=W40-53.
function quarterOfWeek(week: number): PeriodIndex {
  if (week <= 13) return 1;
  if (week <= 26) return 2;
  if (week <= 39) return 3;
  return 4;
}

export function useOutreachSnapshots(): UseOutreachSnapshotsResult {
  const [snapshots, setSnapshots] = useState<OutreachSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  // Each hook instance gets its own realtime channel name. If two callers
  // mount in parallel (e.g. a parent passing data via props alongside a
  // page that still reads from the hook), shared names would collide:
  // .on() throws when invoked after .subscribe() on a previously-bound
  // channel. Suffix prevents that.
  const channelName = useMemo(
    () =>
      `public:outreach_snapshots:${Math.random().toString(36).slice(2, 10)}`,
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const all = await fetchAllSnapshots();
      setSnapshots(all);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('Failed to load outreach snapshots', err);
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
        console.error('Failed to load outreach snapshots', err);
        setLoading(false);
      });

    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'outreach_snapshots' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as OutreachSnapshot;
            setSnapshots((prev) =>
              prev.some((s) => s.id === next.id) ? prev : [next, ...prev],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as OutreachSnapshot;
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
  }, []);

  const byYear = useCallback(
    (year: number) => snapshots.filter((s) => s.year === year),
    [snapshots],
  );
  const byWeek = useCallback(
    (year: number, week: number) =>
      snapshots.filter((s) => s.year === year && s.week_number === week),
    [snapshots],
  );
  const byQuarter = useCallback(
    (year: number, q: PeriodIndex) =>
      snapshots.filter(
        (s) => s.year === year && quarterOfWeek(s.week_number) === q,
      ),
    [snapshots],
  );
  const bySequence = useCallback(
    (id: number) => snapshots.filter((s) => s.sequence_id === id),
    [snapshots],
  );
  const byRegion = useCallback(
    (region: OutreachRegionKey) =>
      snapshots.filter(
        (s) => inferRegionFromSequenceName(s.sequence_name) === region,
      ),
    [snapshots],
  );

  return useMemo(
    () => ({
      snapshots,
      loading,
      error,
      refresh,
      byYear,
      byWeek,
      byQuarter,
      bySequence,
      byRegion,
    }),
    [
      snapshots,
      loading,
      error,
      refresh,
      byYear,
      byWeek,
      byQuarter,
      bySequence,
      byRegion,
    ],
  );
}
