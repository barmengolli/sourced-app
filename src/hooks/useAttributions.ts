import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type {
  Attribution,
  AttributionStageKey,
  PeriodIndex,
} from '../types/db';
import type { RegionKey } from '../constants/regions';
import { TERMINAL_STAGES } from '../constants/funnelStages';
import { quarterOfIsoDate } from '../lib/dates';

const PAGE = 1000;

export interface NewAttributionInput {
  stage_key: AttributionStageKey;
  channel_id: string;
  year: number;
  period_index: PeriodIndex;
  label?: string | null;
  account?: string | null;
  amount?: number | null;
  sf_link?: string | null;
  region?: RegionKey | null;
  deal_id?: string | null;
  lead_id?: string | null;
  // ISO date the deal entered the new stage. Optional on the input
  // shape so legacy callers that don't pass a date keep working — the
  // hook defaults to today before insert.
  stage_entered_at?: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Derive (year, period_index) from an ISO date. Used at every write path
// so stage_entered_at is the single source of truth for period assignment.
// Falls back to today if the input is malformed — the modals validate the
// date before submit, so this branch is defensive.
function periodFromIso(iso: string): { year: number; period_index: PeriodIndex } {
  const q = quarterOfIsoDate(iso) ?? quarterOfIsoDate(todayIso());
  if (!q) {
    // Truly defensive: today() can only fail in a runtime with a broken Date.
    return { year: new Date().getFullYear(), period_index: 1 as PeriodIndex };
  }
  return { year: q.year, period_index: q.quarter };
}

export interface UseAttributionsResult {
  attributions: Attribution[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (input: NewAttributionInput) => Promise<Attribution>;
  update: (id: string, patch: Partial<Attribution>) => Promise<void>;
  deleteAttribution: (id: string) => Promise<void>;
  // Deletes the row AND any strictly-downstream rows on the same
  // deal_id (e.g. deleting Opp also nukes Pursuit / Won / Lost). For
  // rows without a deal_id, behaves identically to deleteAttribution.
  // Touches cascade via the attribution_touches ON DELETE CASCADE
  // foreign key, so this hook only deletes attribution rows.
  deleteWithCascade: (id: string) => Promise<{ deletedIds: string[] }>;
  // Promote copies the source attribution into a new one at the next stage,
  // preserving deal_id and copying touches. Source is NOT deleted (history).
  // Promote takes only stage_entered_at; year + period_index are derived
  // from it at write time so a deal's row can never disagree with its date.
  promote: (
    id: string,
    args: { stage_entered_at: string },
  ) => Promise<Attribution>;
  // markLost is the parallel-terminal action to promote: insert a new row
  // at stage_key='closeLost' sharing the source's deal_id. The source row
  // is preserved so the deal's history stays intact. Same date-derives-
  // period contract as promote.
  markLost: (
    id: string,
    args: { stage_entered_at: string },
  ) => Promise<Attribution>;
}

const STAGE_NEXT: Record<AttributionStageKey, AttributionStageKey | null> = {
  hpp: 'opp',
  opp: 'pursuit',
  pursuit: 'closeWon',
  closeWon: null,
  closeLost: null,
};

// Rank used by deleteWithCascade to identify "strictly-downstream"
// rows. closeWon and closeLost share rank 4 because they're parallel
// terminals — deleting one shouldn't sweep the other.
export const STAGE_RANK: Record<AttributionStageKey, number> = {
  hpp: 1,
  opp: 2,
  pursuit: 3,
  closeWon: 4,
  closeLost: 4,
};

// PostgREST default cap is 1000 rows; page until exhausted to support full set.
async function fetchAllAttributions(): Promise<Attribution[]> {
  const all: Attribution[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('attributions')
      .select('*')
      .order('updated_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as Attribution[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export function useAttributions(): UseAttributionsResult {
  const [attributions, setAttributions] = useState<Attribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const attributionsRef = useRef<Attribution[]>([]);
  attributionsRef.current = attributions;

  const channelRef = useRef<RealtimeChannel | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await fetchAllAttributions();
      setAttributions(all);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('Failed to load attributions', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAllAttributions()
      .then((all) => {
        if (cancelled) return;
        setAttributions(all);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        console.error('Failed to load attributions', err);
        setLoading(false);
      });

    // Unique per mount to avoid .on()-after-.subscribe() collisions.
    const channelName = `public:attributions:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    channelRef.current = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'attributions' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as Attribution;
            setAttributions((prev) =>
              prev.some((a) => a.id === next.id) ? prev : [next, ...prev],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as Attribution;
            setAttributions((prev) =>
              prev.map((a) => (a.id === next.id ? next : a)),
            );
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setAttributions((prev) => prev.filter((a) => a.id !== old.id));
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

  const create = useCallback(
    async (input: NewAttributionInput): Promise<Attribution> => {
      // stage_entered_at is the single source of truth for period
      // assignment. Override whatever year/period_index the caller passed
      // so the row's date and period_index can never disagree.
      const stage_entered_at = input.stage_entered_at ?? todayIso();
      const derived = periodFromIso(stage_entered_at);
      const row = {
        ...input,
        stage_entered_at,
        year: derived.year,
        period_index: derived.period_index,
      };
      const { data, error: err } = await supabase
        .from('attributions')
        .insert(row)
        .select()
        .single();
      if (err) {
        console.error('Attribution insert failed', err);
        throw err;
      }
      const created = data as Attribution;
      // Optimistic add; realtime echo will be a no-op since we dedupe by id.
      setAttributions((prev) =>
        prev.some((a) => a.id === created.id) ? prev : [created, ...prev],
      );
      return created;
    },
    [],
  );

  const update = useCallback(
    async (id: string, patch: Partial<Attribution>): Promise<void> => {
      const before = attributionsRef.current.find((a) => a.id === id);
      if (!before) throw new Error('Attribution not found');
      // When the patch changes stage_entered_at, re-derive year +
      // period_index from the new date and fold them into the patch. The
      // caller no longer needs to keep these in sync manually.
      let finalPatch = patch;
      if (patch.stage_entered_at) {
        const derived = periodFromIso(patch.stage_entered_at);
        finalPatch = {
          ...patch,
          year: derived.year,
          period_index: derived.period_index,
        };
      }
      const optimistic = { ...before, ...finalPatch } as Attribution;
      setAttributions((prev) => prev.map((a) => (a.id === id ? optimistic : a)));
      const { error: err } = await supabase
        .from('attributions')
        .update(finalPatch)
        .eq('id', id);
      if (err) {
        // Roll back on failure.
        setAttributions((prev) => prev.map((a) => (a.id === id ? before : a)));
        console.error('Attribution update failed', err);
        throw err;
      }
    },
    [],
  );

  const deleteAttribution = useCallback(
    async (id: string): Promise<void> => {
      const before = attributionsRef.current;
      setAttributions((prev) => prev.filter((a) => a.id !== id));
      const { error: err } = await supabase
        .from('attributions')
        .delete()
        .eq('id', id);
      if (err) {
        setAttributions(before);
        console.error('Attribution delete failed', err);
        throw err;
      }
    },
    [],
  );

  // Delete a row plus every strictly-downstream row on the same
  // deal_id. closeWon and closeLost share rank 4 so deleting one of
  // them is a single-row delete (it has no downstream); deleting an
  // upstream stage sweeps BOTH terminals if they exist.
  //
  // Single supabase DELETE with .in() over the collected ids so the
  // operation is one round trip. attribution_touches cascades via
  // its ON DELETE CASCADE foreign key, so we don't delete touches
  // explicitly.
  const deleteWithCascade = useCallback(
    async (id: string): Promise<{ deletedIds: string[] }> => {
      const before = attributionsRef.current;
      const target = before.find((a) => a.id === id);
      if (!target) {
        // Already gone or wrong id — match the existing
        // deleteAttribution behavior of throwing only on the
        // backend error, not on a stale ref.
        return { deletedIds: [] };
      }

      // Build the deletion set: the target row itself, plus every
      // other row with the same deal_id and strictly-higher rank.
      const ids = [id];
      if (target.deal_id) {
        const targetRank = STAGE_RANK[target.stage_key];
        for (const a of before) {
          if (a.id === id) continue;
          if (a.deal_id !== target.deal_id) continue;
          if (STAGE_RANK[a.stage_key] > targetRank) ids.push(a.id);
        }
      }

      // Optimistic local update.
      const idSet = new Set(ids);
      setAttributions((prev) => prev.filter((a) => !idSet.has(a.id)));

      const { error: err } = await supabase
        .from('attributions')
        .delete()
        .in('id', ids);
      if (err) {
        setAttributions(before);
        console.error('Attribution cascade delete failed', err);
        throw err;
      }
      return { deletedIds: ids };
    },
    [],
  );

  const promote = useCallback(
    async (
      id: string,
      args: { stage_entered_at: string },
    ): Promise<Attribution> => {
      const source = attributionsRef.current.find((a) => a.id === id);
      if (!source) throw new Error('Attribution not found');
      const next = STAGE_NEXT[source.stage_key];
      if (!next) {
        throw new Error('Already at the final stage');
      }

      // 1. Insert the new attribution. year + period_index derive from
      //    stage_entered_at so the row can't disagree with its own date.
      const derived = periodFromIso(args.stage_entered_at);
      const newRow: NewAttributionInput = {
        stage_key: next,
        channel_id: source.channel_id ?? '',
        year: derived.year,
        period_index: derived.period_index,
        label: source.label,
        account: source.account,
        amount: source.amount,
        sf_link: source.sf_link,
        deal_id: source.deal_id,
        lead_id: source.lead_id,
        stage_entered_at: args.stage_entered_at,
      };
      const { data: inserted, error: insErr } = await supabase
        .from('attributions')
        .insert(newRow)
        .select()
        .single();
      if (insErr) {
        console.error('Promote insert failed', insErr);
        throw insErr;
      }
      const created = inserted as Attribution;

      // 2. Copy touches.
      const { data: srcTouches, error: tErr } = await supabase
        .from('attribution_touches')
        .select('*')
        .eq('attribution_id', source.id)
        .order('touch_order', { ascending: true });
      if (tErr) {
        console.error('Promote touches read failed', tErr);
        throw tErr;
      }
      const newTouches = (srcTouches ?? []).map(
        (t: {
          touch_order: number;
          channel_id: string | null;
          touched_at: string | null;
          notes: string | null;
        }) => ({
          attribution_id: created.id,
          touch_order: t.touch_order,
          channel_id: t.channel_id,
          touched_at: t.touched_at,
          notes: t.notes,
        }),
      );
      if (newTouches.length > 0) {
        const { error: tInsErr } = await supabase
          .from('attribution_touches')
          .insert(newTouches);
        if (tInsErr) {
          // Rollback the new attribution row so we don't orphan a deal at the
          // new stage with no touches.
          await supabase.from('attributions').delete().eq('id', created.id);
          console.error('Promote touches insert failed', tInsErr);
          throw tInsErr;
        }
      }

      setAttributions((prev) =>
        prev.some((a) => a.id === created.id) ? prev : [created, ...prev],
      );
      return created;
    },
    [],
  );

  // markLost: parallel-terminal cousin of promote. Inserts a new row at
  // stage_key='closeLost' sharing the source's deal_id, copies its touches,
  // and leaves the source row intact so the deal's stage history is
  // preserved. Cannot fire from a terminal source (closeWon, closeLost) —
  // the UI hides the action there but we double-guard here.
  const markLost = useCallback(
    async (
      id: string,
      args: { stage_entered_at: string },
    ): Promise<Attribution> => {
      const source = attributionsRef.current.find((a) => a.id === id);
      if (!source) throw new Error('Attribution not found');
      if (TERMINAL_STAGES.includes(source.stage_key)) {
        throw new Error('Cannot close-lost a terminal deal');
      }

      const derived = periodFromIso(args.stage_entered_at);
      const newRow: NewAttributionInput = {
        stage_key: 'closeLost',
        channel_id: source.channel_id ?? '',
        year: derived.year,
        period_index: derived.period_index,
        label: source.label,
        account: source.account,
        amount: source.amount,
        sf_link: source.sf_link,
        region: source.region,
        deal_id: source.deal_id,
        lead_id: source.lead_id,
        stage_entered_at: args.stage_entered_at,
      };
      const { data: inserted, error: insErr } = await supabase
        .from('attributions')
        .insert(newRow)
        .select()
        .single();
      if (insErr) {
        console.error('markLost insert failed', insErr);
        throw insErr;
      }
      const created = inserted as Attribution;

      // Copy touches so the Lost row has the same channel-influence trail
      // as the source. Same rollback shape as promote: if touch insert
      // fails, drop the new attribution row to avoid an orphan.
      const { data: srcTouches, error: tErr } = await supabase
        .from('attribution_touches')
        .select('*')
        .eq('attribution_id', source.id)
        .order('touch_order', { ascending: true });
      if (tErr) {
        console.error('markLost touches read failed', tErr);
        throw tErr;
      }
      const newTouches = (srcTouches ?? []).map(
        (t: {
          touch_order: number;
          channel_id: string | null;
          touched_at: string | null;
          notes: string | null;
        }) => ({
          attribution_id: created.id,
          touch_order: t.touch_order,
          channel_id: t.channel_id,
          touched_at: t.touched_at,
          notes: t.notes,
        }),
      );
      if (newTouches.length > 0) {
        const { error: tInsErr } = await supabase
          .from('attribution_touches')
          .insert(newTouches);
        if (tInsErr) {
          await supabase.from('attributions').delete().eq('id', created.id);
          console.error('markLost touches insert failed', tInsErr);
          throw tInsErr;
        }
      }

      setAttributions((prev) =>
        prev.some((a) => a.id === created.id) ? prev : [created, ...prev],
      );
      return created;
    },
    [],
  );

  return {
    attributions,
    loading,
    error,
    refresh,
    create,
    update,
    deleteAttribution,
    deleteWithCascade,
    promote,
    markLost,
  };
}
