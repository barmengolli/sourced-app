// useLeadCampaignTouches: fetch + realtime subscription for
// lead_campaign_touches (Bite 4E). Read-only: the importer
// (touchImportApply) is the writer. Mirrors the useAttributionTouches
// pattern: paged initial fetch (~3k rows today) and per-row realtime
// deltas so the funnel grid recounts live after an import.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { LeadCampaignTouchRow } from '../types/db';
import { assertUniquePagedIds } from '../lib/paginationIntegrity';

const PAGE = 1000;

export interface UseLeadCampaignTouchesResult {
  touches: LeadCampaignTouchRow[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

async function fetchAllLeadCampaignTouches(): Promise<LeadCampaignTouchRow[]> {
  const all: LeadCampaignTouchRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('lead_campaign_touches')
      .select('*')
      // `created_at` is not unique because batch ingestion creates many rows
      // at once. A unique stable order prevents duplicates and omissions where
      // offset pages cross a shared-timestamp boundary.
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as LeadCampaignTouchRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  assertUniquePagedIds(all, 'Campaign membership');
  return all;
}

export function useLeadCampaignTouches(): UseLeadCampaignTouchesResult {
  const [touches, setTouches] = useState<LeadCampaignTouchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const channelRef = useRef<RealtimeChannel | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await fetchAllLeadCampaignTouches();
      setTouches(all);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('Failed to load lead campaign touches', err);
    }
  }, []);

  useEffect(() => {
    // loading starts true; only the async completion paths set state.
    let cancelled = false;
    fetchAllLeadCampaignTouches()
      .then((all) => {
        if (cancelled) return;
        setTouches(all);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        console.error('Failed to load lead campaign touches', err);
        setLoading(false);
      });

    // Unique per mount to avoid .on()-after-.subscribe() collisions.
    const channelName = `public:lead_campaign_touches:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lead_campaign_touches' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as LeadCampaignTouchRow;
            setTouches((prev) =>
              prev.some((t) => t.id === next.id) ? prev : [...prev, next],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as LeadCampaignTouchRow;
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

  return { touches, loading, error, refresh };
}
