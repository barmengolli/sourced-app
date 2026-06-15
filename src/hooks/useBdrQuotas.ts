// Access to the bdr_quotas table (annual BDR targets). Mirrors
// useFunnelActuals: paged fetch, per-mount realtime channel, and an upsert
// keyed by (bdr_name, year, stage_key). Passing quota === null deletes the row.

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { BdrQuota } from '../types/db';
import type { BdrStage } from '../constants/bdr';

const EDITED_BY = 'Marketing';

export interface UseBdrQuotasResult {
  quotas: BdrQuota[];
  loading: boolean;
  upsert: (
    bdrName: string,
    year: number,
    stageKey: BdrStage,
    quota: number | null,
  ) => Promise<void>;
}

export function useBdrQuotas(): UseBdrQuotasResult {
  const [quotas, setQuotas] = useState<BdrQuota[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const PAGE = 1000;
      const all: BdrQuota[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('bdr_quotas')
          .select('*')
          .range(from, from + PAGE - 1);
        if (cancelled) return;
        if (error) {
          console.error('Failed to load BDR quotas', error);
          return;
        }
        if (!data || data.length === 0) break;
        all.push(...(data as BdrQuota[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      setQuotas(all);
      setLoading(false);
    };

    void refresh();

    const channelName = `public:bdr_quotas:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bdr_quotas' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as BdrQuota;
            setQuotas((prev) =>
              prev.some((q) => q.id === next.id) ? prev : [...prev, next],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as BdrQuota;
            setQuotas((prev) => prev.map((q) => (q.id === next.id ? next : q)));
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setQuotas((prev) => prev.filter((q) => q.id !== old.id));
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  const upsert = async (
    bdrName: string,
    year: number,
    stageKey: BdrStage,
    quota: number | null,
  ): Promise<void> => {
    if (quota === null) {
      const { error } = await supabase
        .from('bdr_quotas')
        .delete()
        .eq('bdr_name', bdrName)
        .eq('year', year)
        .eq('stage_key', stageKey);
      if (error) throw error;
      return;
    }
    const { error } = await supabase
      .from('bdr_quotas')
      .upsert(
        {
          bdr_name: bdrName,
          year,
          stage_key: stageKey,
          quota,
          edited_at: new Date().toISOString(),
          edited_by: EDITED_BY,
        },
        { onConflict: 'bdr_name,year,stage_key' },
      );
    if (error) throw error;
  };

  return { quotas, loading, upsert };
}
