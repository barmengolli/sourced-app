import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { AttributionTouch } from '../types/db';

const PAGE = 1000;

export interface NewTouchInput {
  channel_id?: string | null;
  touched_at?: string | null;
  notes?: string | null;
}

export interface UseAttributionTouchesResult {
  touches: AttributionTouch[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  forAttribution: (attributionId: string) => AttributionTouch[];
  // Replace-all: deletes existing touches for the attribution, inserts the
  // new ones with touch_order = i + 1. Used by Create (with empty existing)
  // and Edit (after add/remove/reorder).
  setTouches: (
    attributionId: string,
    touches: NewTouchInput[],
  ) => Promise<void>;
}

async function fetchAllTouches(): Promise<AttributionTouch[]> {
  const all: AttributionTouch[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('attribution_touches')
      .select('*')
      .order('touch_order', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as AttributionTouch[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export function useAttributionTouches(): UseAttributionTouchesResult {
  const [touches, setTouches] = useState<AttributionTouch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const channelRef = useRef<RealtimeChannel | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await fetchAllTouches();
      setTouches(all);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('Failed to load attribution touches', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAllTouches()
      .then((all) => {
        if (cancelled) return;
        setTouches(all);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        console.error('Failed to load attribution touches', err);
        setLoading(false);
      });

    // Unique per mount to avoid .on()-after-.subscribe() collisions.
    const channelName = `public:attribution_touches:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'attribution_touches' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as AttributionTouch;
            setTouches((prev) =>
              prev.some((t) => t.id === next.id) ? prev : [...prev, next],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as AttributionTouch;
            setTouches((prev) =>
              prev.map((t) => (t.id === next.id ? next : t)),
            );
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setTouches((prev) => prev.filter((t) => t.id !== old.id));
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

  const touchesByAttribution = useMemo(() => {
    const m = new Map<string, AttributionTouch[]>();
    for (const t of touches) {
      const arr = m.get(t.attribution_id) ?? [];
      arr.push(t);
      m.set(t.attribution_id, arr);
    }
    for (const [k, arr] of m) {
      m.set(
        k,
        arr.slice().sort((a, b) => a.touch_order - b.touch_order),
      );
    }
    return m;
  }, [touches]);

  const forAttribution = useCallback(
    (attributionId: string): AttributionTouch[] => {
      return touchesByAttribution.get(attributionId) ?? [];
    },
    [touchesByAttribution],
  );

  const setTouchesFor = useCallback(
    async (
      attributionId: string,
      next: NewTouchInput[],
    ): Promise<void> => {
      // Delete existing for this attribution, then insert new in order.
      // Not transactional, but failure mid-flight just means a re-save replays.
      const { error: delErr } = await supabase
        .from('attribution_touches')
        .delete()
        .eq('attribution_id', attributionId);
      if (delErr) {
        console.error('Touch delete failed', delErr);
        throw delErr;
      }
      if (next.length === 0) return;
      const rows = next.map((t, i) => ({
        attribution_id: attributionId,
        touch_order: i + 1,
        channel_id: t.channel_id ?? null,
        touched_at: t.touched_at ?? null,
        notes: t.notes ?? null,
      }));
      const { error: insErr } = await supabase
        .from('attribution_touches')
        .insert(rows);
      if (insErr) {
        console.error('Touch insert failed', insErr);
        throw insErr;
      }
    },
    [],
  );

  return {
    touches,
    loading,
    error,
    refresh,
    forAttribution,
    setTouches: setTouchesFor,
  };
}
