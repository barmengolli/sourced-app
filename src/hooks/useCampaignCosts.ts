// useCampaignCosts — CRUD + realtime hook for the campaign_costs table.
// Same shape as useAttributions: paginated initial fetch (1000-row
// chunks), one realtime channel per mount, optimistic local updates
// on mutation with realtime echoes deduped by id.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { CampaignCost } from '../types/db';

const PAGE = 1000;

export interface NewCampaignCostInput {
  channel_id: string;
  amount: number;
  start_date: string;
  end_date: string;
  notes?: string | null;
}

export interface UseCampaignCostsResult {
  costs: CampaignCost[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  insert: (input: NewCampaignCostInput) => Promise<CampaignCost>;
  update: (
    id: string,
    patch: Partial<NewCampaignCostInput>,
  ) => Promise<void>;
  deleteCost: (id: string) => Promise<void>;
}

async function fetchAllCosts(): Promise<CampaignCost[]> {
  const all: CampaignCost[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('campaign_costs')
      .select('*')
      .order('start_date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as CampaignCost[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export function useCampaignCosts(): UseCampaignCostsResult {
  const [costs, setCosts] = useState<CampaignCost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const costsRef = useRef<CampaignCost[]>([]);
  costsRef.current = costs;

  const channelRef = useRef<RealtimeChannel | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await fetchAllCosts();
      setCosts(all);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('Failed to load campaign_costs', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAllCosts()
      .then((all) => {
        if (cancelled) return;
        setCosts(all);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        console.error('Failed to load campaign_costs', err);
        setLoading(false);
      });

    // Unique-per-mount channel name to avoid .on()-after-.subscribe()
    // collisions if the hook is mounted twice (e.g. dev StrictMode).
    const channelName = `public:campaign_costs:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'campaign_costs' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as CampaignCost;
            setCosts((prev) =>
              prev.some((c) => c.id === next.id) ? prev : [...prev, next],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as CampaignCost;
            setCosts((prev) =>
              prev.map((c) => (c.id === next.id ? next : c)),
            );
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setCosts((prev) => prev.filter((c) => c.id !== old.id));
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

  const insert = useCallback(
    async (input: NewCampaignCostInput): Promise<CampaignCost> => {
      if (input.amount < 0) {
        throw new Error('Amount must be non-negative');
      }
      if (input.end_date < input.start_date) {
        throw new Error('End date must be on or after start date');
      }
      const { data, error: err } = await supabase
        .from('campaign_costs')
        .insert(input)
        .select()
        .single();
      if (err) {
        console.error('Campaign cost insert failed', err);
        throw err;
      }
      const created = data as CampaignCost;
      setCosts((prev) =>
        prev.some((c) => c.id === created.id) ? prev : [...prev, created],
      );
      return created;
    },
    [],
  );

  const update = useCallback(
    async (
      id: string,
      patch: Partial<NewCampaignCostInput>,
    ): Promise<void> => {
      const before = costsRef.current.find((c) => c.id === id);
      if (!before) throw new Error('Campaign cost not found');
      // Validate against the merged value so partial patches can't
      // produce a row that violates the same checks the insert path
      // enforces.
      const merged = { ...before, ...patch };
      if (merged.amount < 0) {
        throw new Error('Amount must be non-negative');
      }
      if (merged.end_date < merged.start_date) {
        throw new Error('End date must be on or after start date');
      }
      const optimistic = { ...before, ...patch } as CampaignCost;
      setCosts((prev) => prev.map((c) => (c.id === id ? optimistic : c)));
      const { error: err } = await supabase
        .from('campaign_costs')
        .update(patch)
        .eq('id', id);
      if (err) {
        // Roll back on failure.
        setCosts((prev) => prev.map((c) => (c.id === id ? before : c)));
        console.error('Campaign cost update failed', err);
        throw err;
      }
    },
    [],
  );

  const deleteCost = useCallback(async (id: string): Promise<void> => {
    const before = costsRef.current;
    setCosts((prev) => prev.filter((c) => c.id !== id));
    const { error: err } = await supabase
      .from('campaign_costs')
      .delete()
      .eq('id', id);
    if (err) {
      setCosts(before);
      console.error('Campaign cost delete failed', err);
      throw err;
    }
  }, []);

  return {
    costs,
    loading,
    error,
    refresh,
    insert,
    update,
    deleteCost,
  };
}
