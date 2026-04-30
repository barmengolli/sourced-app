import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type {
  AttributionStageKey,
  FunnelActual,
  PeriodIndex,
} from '../types/db';

const EDITED_BY = 'Marketing';

export interface UseFunnelActualsResult {
  actuals: FunnelActual[];
  loading: boolean;
  upsert: (
    channelId: string,
    year: number,
    periodIndex: PeriodIndex,
    stageKey: AttributionStageKey,
    actual: number | null,
  ) => Promise<void>;
}

export function useFunnelActuals(): UseFunnelActualsResult {
  const [actuals, setActuals] = useState<FunnelActual[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      // PostgREST default cap is 1000 rows; page until exhausted to support full set.
      const PAGE = 1000;
      const all: FunnelActual[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('funnel_actuals')
          .select('*')
          .range(from, from + PAGE - 1);
        if (cancelled) return;
        if (error) {
          console.error('Failed to load funnel actuals', error);
          return;
        }
        if (!data || data.length === 0) break;
        all.push(...(data as FunnelActual[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      setActuals(all);
      setLoading(false);
    };

    void refresh();

    const channel = supabase
      .channel('public:funnel_actuals')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'funnel_actuals' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as FunnelActual;
            setActuals((prev) =>
              prev.some((a) => a.id === next.id) ? prev : [...prev, next],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as FunnelActual;
            setActuals((prev) =>
              prev.map((a) => (a.id === next.id ? next : a)),
            );
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setActuals((prev) => prev.filter((a) => a.id !== old.id));
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
    stageKey: AttributionStageKey,
    actual: number | null,
  ): Promise<void> => {
    if (actual === null) {
      const { error } = await supabase
        .from('funnel_actuals')
        .delete()
        .eq('channel_id', channelId)
        .eq('year', year)
        .eq('period_index', periodIndex)
        .eq('stage_key', stageKey);
      if (error) throw error;
      return;
    }
    const { error } = await supabase
      .from('funnel_actuals')
      .upsert(
        {
          channel_id: channelId,
          year,
          period_index: periodIndex,
          stage_key: stageKey,
          actual,
          edited_at: new Date().toISOString(),
          edited_by: EDITED_BY,
        },
        { onConflict: 'channel_id,year,period_index,stage_key' },
      );
    if (error) throw error;
  };

  return { actuals, loading, upsert };
}
