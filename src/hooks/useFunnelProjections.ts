import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { FunnelProjection, PeriodIndex } from '../types/db';
import type { FunnelStageKey } from '../constants/funnelStages';

const EDITED_BY = 'Marketing';

export interface UseFunnelProjectionsResult {
  projections: FunnelProjection[];
  loading: boolean;
  upsert: (
    channelId: string,
    year: number,
    periodIndex: PeriodIndex,
    stageKey: FunnelStageKey,
    projection: number | null,
  ) => Promise<void>;
}

export function useFunnelProjections(): UseFunnelProjectionsResult {
  const [projections, setProjections] = useState<FunnelProjection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      // PostgREST default cap is 1000 rows; page until exhausted to support full set.
      const PAGE = 1000;
      const all: FunnelProjection[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('funnel_projections')
          .select('*')
          .range(from, from + PAGE - 1);
        if (cancelled) return;
        if (error) {
          console.error('Failed to load projections', error);
          return;
        }
        if (!data || data.length === 0) break;
        all.push(...(data as FunnelProjection[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      setProjections(all);
      setLoading(false);
    };

    void refresh();

    const channel = supabase
      .channel('public:funnel_projections')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'funnel_projections' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as FunnelProjection;
            setProjections((prev) =>
              prev.some((p) => p.id === next.id) ? prev : [...prev, next],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as FunnelProjection;
            setProjections((prev) =>
              prev.map((p) => (p.id === next.id ? next : p)),
            );
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setProjections((prev) => prev.filter((p) => p.id !== old.id));
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
    channelId: string,
    year: number,
    periodIndex: PeriodIndex,
    stageKey: FunnelStageKey,
    projection: number | null,
  ): Promise<void> => {
    if (projection === null) {
      const { error } = await supabase
        .from('funnel_projections')
        .delete()
        .eq('channel_id', channelId)
        .eq('year', year)
        .eq('period_index', periodIndex)
        .eq('stage_key', stageKey);
      if (error) throw error;
      return;
    }
    const { error } = await supabase
      .from('funnel_projections')
      .upsert(
        {
          channel_id: channelId,
          year,
          period_index: periodIndex,
          stage_key: stageKey,
          projection,
          edited_at: new Date().toISOString(),
          edited_by: EDITED_BY,
        },
        { onConflict: 'channel_id,year,period_index,stage_key' },
      );
    if (error) throw error;
  };

  return { projections, loading, upsert };
}
