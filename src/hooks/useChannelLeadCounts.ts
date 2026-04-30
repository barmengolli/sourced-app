import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// Lead-id-by-channel-id map. Recomputed on mount and whenever a leads
// realtime event fires. At ~1700 leads this is ~50 KB transfer; trivial.
// Swap to an RPC with GROUP BY if leads ever cross ~50k.
export function useChannelLeadCounts(): Map<string, number> {
  const [counts, setCounts] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const m = new Map<string, number>();
      // PostgREST default cap is 1000 rows; page until exhausted to support full lead set.
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('leads')
          .select('source_channel_id')
          .not('source_channel_id', 'is', null)
          .range(from, from + PAGE - 1);
        if (cancelled) return;
        if (error) {
          console.error('Failed to load lead counts', error);
          return;
        }
        if (!data || data.length === 0) break;
        for (const row of data as { source_channel_id: string | null }[]) {
          const id = row.source_channel_id;
          if (!id) continue;
          m.set(id, (m.get(id) ?? 0) + 1);
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
      setCounts(m);
    };

    void refresh();

    // Recompute on any leads INSERT/UPDATE/DELETE. Cheap: one SELECT against
    // 1.7k rows, batched naturally because realtime events come in bursts.
    const channel = supabase
      .channel('public:leads:counts')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'leads' },
        () => {
          void refresh();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return counts;
}
