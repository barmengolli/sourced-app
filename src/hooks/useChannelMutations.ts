import { useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { Channel } from '../types/db';

export interface UseChannelMutationsResult {
  rename: (id: string, newName: string) => Promise<void>;
  setHidden: (id: string, hidden: boolean) => Promise<void>;
  moveUp: (id: string) => Promise<void>;
  moveDown: (id: string) => Promise<void>;
  deleteChannel: (id: string) => Promise<void>;
  merge: (sourceId: string, targetId: string) => Promise<{ leadsMoved: number }>;
  reparent: (id: string, newParentId: string | null) => Promise<void>;
  // Delete a non-leaf with no direct leads, promoting its children up to its
  // own parent. Returns the number of children promoted.
  deleteAndPromoteChildren: (id: string) => Promise<{ promoted: number }>;
  // Create a new channel at the bottom of its sibling group. Returns
  // the new row's id so the caller can focus it or scroll to it.
  create: (
    name: string,
    parentChannelId: string | null,
  ) => Promise<{ id: string }>;
}

const ORDER_GAP = 10;

function siblings(channels: Channel[], parentId: string | null | undefined): Channel[] {
  return channels
    .filter((c) => (c.parent_channel_id ?? null) === (parentId ?? null))
    .slice()
    .sort((a, b) => {
      if (a.display_order !== b.display_order) {
        return a.display_order - b.display_order;
      }
      return a.name.localeCompare(b.name);
    });
}

function children(channels: Channel[], parentId: string): Channel[] {
  return channels.filter((c) => c.parent_channel_id === parentId);
}

// Collect the id of `rootId` and every descendant beneath it. Used by
// `reparent` for cycle detection and by the MovePicker to filter the list of
// eligible new-parent candidates (a node can't be moved under itself or any
// of its descendants).
export function descendantIds(
  channels: Channel[],
  rootId: string,
): Set<string> {
  const out = new Set<string>([rootId]);
  // BFS via repeated scans of the flat channels array. N is small (≤ a few
  // hundred), so this is cheap and avoids building a separate adjacency map.
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const c of channels) {
        if (c.parent_channel_id === id && !out.has(c.id)) {
          out.add(c.id);
          next.push(c.id);
        }
      }
    }
    frontier = next;
  }
  return out;
}

export function useChannelMutations(channels: Channel[]): UseChannelMutationsResult {
  // Avoid stale closures: the manager passes a fresh array on each render,
  // but our async methods need the value at the moment they execute.
  const channelsRef = useRef<Channel[]>(channels);
  channelsRef.current = channels;

  const rename = useCallback(async (id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error('Name cannot be empty');
    const { error } = await supabase
      .from('channels')
      .update({ name: trimmed })
      .eq('id', id);
    if (error) throw error;
  }, []);

  const setHidden = useCallback(async (id: string, hidden: boolean) => {
    const { error } = await supabase
      .from('channels')
      .update({ hidden })
      .eq('id', id);
    if (error) throw error;
  }, []);

  // Lazy normalization: if any sibling in this group has display_order = 0,
  // assign sparse 10/20/30 across the group in a single batch BEFORE the
  // caller tries to swap. Returns the freshly-ordered siblings (ascending).
  const ensureNormalizedSiblings = useCallback(
    async (parentId: string | null): Promise<Channel[]> => {
      const group = siblings(channelsRef.current, parentId);
      const needsNormalize = group.some((c) => c.display_order === 0);
      if (!needsNormalize) return group;

      const updates = group.map((c, i) => ({ id: c.id, order: (i + 1) * ORDER_GAP }));
      const settled = await Promise.allSettled(
        updates.map((u) =>
          supabase
            .from('channels')
            .update({ display_order: u.order })
            .eq('id', u.id),
        ),
      );
      for (const s of settled) {
        if (s.status === 'rejected') {
          throw s.reason instanceof Error
            ? s.reason
            : new Error('Failed to normalize sibling order');
        }
        if (s.status === 'fulfilled' && s.value.error) {
          throw s.value.error;
        }
      }
      // Return locally-corrected ordering. Realtime will catch up shortly.
      return group.map((c, i) => ({ ...c, display_order: (i + 1) * ORDER_GAP }));
    },
    [],
  );

  const swap = useCallback(async (aId: string, aOrder: number, bId: string, bOrder: number) => {
    const settled = await Promise.allSettled([
      supabase.from('channels').update({ display_order: bOrder }).eq('id', aId),
      supabase.from('channels').update({ display_order: aOrder }).eq('id', bId),
    ]);
    for (const s of settled) {
      if (s.status === 'rejected') {
        throw s.reason instanceof Error ? s.reason : new Error('Reorder failed');
      }
      if (s.status === 'fulfilled' && s.value.error) {
        throw s.value.error;
      }
    }
  }, []);

  const moveUp = useCallback(
    async (id: string) => {
      const me = channelsRef.current.find((c) => c.id === id);
      if (!me) throw new Error('Channel not found');
      const group = await ensureNormalizedSiblings(me.parent_channel_id ?? null);
      const idx = group.findIndex((c) => c.id === id);
      if (idx <= 0) return; // already topmost
      const above = group[idx - 1];
      const meCurrent = group[idx];
      await swap(meCurrent.id, meCurrent.display_order, above.id, above.display_order);
    },
    [ensureNormalizedSiblings, swap],
  );

  const moveDown = useCallback(
    async (id: string) => {
      const me = channelsRef.current.find((c) => c.id === id);
      if (!me) throw new Error('Channel not found');
      const group = await ensureNormalizedSiblings(me.parent_channel_id ?? null);
      const idx = group.findIndex((c) => c.id === id);
      if (idx === -1 || idx >= group.length - 1) return; // bottommost
      const below = group[idx + 1];
      const meCurrent = group[idx];
      await swap(meCurrent.id, meCurrent.display_order, below.id, below.display_order);
    },
    [ensureNormalizedSiblings, swap],
  );

  const deleteChannel = useCallback(async (id: string) => {
    const me = channelsRef.current.find((c) => c.id === id);
    if (!me) throw new Error('Channel not found');

    if (children(channelsRef.current, id).length > 0) {
      throw new Error('Channel has sub-channels. Delete or reparent them first.');
    }

    const { count: leadCount, error: countErr } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('source_channel_id', id);
    if (countErr) throw countErr;
    if ((leadCount ?? 0) > 0) {
      throw new Error(
        `Channel has ${leadCount} lead${leadCount === 1 ? '' : 's'}. Merge into another channel first.`,
      );
    }

    const { error: delErr } = await supabase.from('channels').delete().eq('id', id);
    if (delErr) throw delErr;
  }, []);

  const merge = useCallback(
    async (sourceId: string, targetId: string): Promise<{ leadsMoved: number }> => {
      if (sourceId === targetId) {
        throw new Error('Cannot merge a channel into itself');
      }
      const source = channelsRef.current.find((c) => c.id === sourceId);
      const target = channelsRef.current.find((c) => c.id === targetId);
      if (!source) throw new Error('Source channel not found');
      if (!target) throw new Error('Target channel not found');

      if (children(channelsRef.current, sourceId).length > 0) {
        throw new Error('Source has sub-channels. Merge is leaf-only.');
      }
      if (children(channelsRef.current, targetId).length > 0) {
        throw new Error('Target has sub-channels. Merge is leaf-only.');
      }

      // Move leads first; if this fails, we have not deleted anything yet.
      const { count: beforeCount, error: countErr } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('source_channel_id', sourceId);
      if (countErr) throw countErr;
      const leadsMoved = beforeCount ?? 0;

      if (leadsMoved > 0) {
        const { error: updErr } = await supabase
          .from('leads')
          .update({ source_channel_id: targetId })
          .eq('source_channel_id', sourceId);
        if (updErr) throw updErr;
      }

      const { error: delErr } = await supabase
        .from('channels')
        .delete()
        .eq('id', sourceId);
      if (delErr) throw delErr;

      return { leadsMoved };
    },
    [],
  );

  const reparent = useCallback(
    async (id: string, newParentId: string | null): Promise<void> => {
      const me = channelsRef.current.find((c) => c.id === id);
      if (!me) throw new Error('Channel not found');

      const currentParent = me.parent_channel_id ?? null;
      if ((newParentId ?? null) === currentParent) return; // no-op

      // Cycle: the new parent must not be the channel itself or any of its
      // descendants. descendantIds includes `id` itself, so a single check
      // covers both cases.
      if (newParentId !== null) {
        const target = channelsRef.current.find((c) => c.id === newParentId);
        if (!target) throw new Error('Target parent not found');
        const forbidden = descendantIds(channelsRef.current, id);
        if (forbidden.has(newParentId)) {
          throw new Error(
            'Cannot move a channel under itself or one of its descendants.',
          );
        }
      }

      // Uniqueness: the DB enforces UNIQUE(name, parent_channel_id). Pre-check
      // so we can give a friendly error instead of a Postgres constraint
      // violation. A sibling under newParentId with the same name conflicts.
      const wouldCollide = channelsRef.current.some(
        (c) =>
          c.id !== id &&
          (c.parent_channel_id ?? null) === (newParentId ?? null) &&
          c.name === me.name,
      );
      if (wouldCollide) {
        throw new Error(
          `A channel named "${me.name}" already exists at that level.`,
        );
      }

      const { error } = await supabase
        .from('channels')
        .update({ parent_channel_id: newParentId })
        .eq('id', id);
      if (error) throw error;
    },
    [],
  );

  const deleteAndPromoteChildren = useCallback(
    async (id: string): Promise<{ promoted: number }> => {
      const me = channelsRef.current.find((c) => c.id === id);
      if (!me) throw new Error('Channel not found');

      const kids = children(channelsRef.current, id);
      if (kids.length === 0) {
        // Nothing to promote; this is the regular delete case. Caller should
        // use deleteChannel instead, but be forgiving and route through the
        // normal delete (which will also check leads).
        await deleteChannelInner(id);
        return { promoted: 0 };
      }

      // Direct leads under this channel would orphan if we deleted without
      // moving them; refuse so the user goes through merge instead.
      const { count: leadCount, error: countErr } = await supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
        .eq('source_channel_id', id);
      if (countErr) throw countErr;
      if ((leadCount ?? 0) > 0) {
        throw new Error(
          `Channel has ${leadCount} direct lead${leadCount === 1 ? '' : 's'}. Merge into another channel first; promote-children would orphan them.`,
        );
      }

      // Uniqueness pre-check: every child's name must not already exist as a
      // sibling under our parent. Otherwise the bulk UPDATE will hit the
      // UNIQUE(name, parent_channel_id) constraint and fail mid-batch.
      const newParentId = me.parent_channel_id ?? null;
      const existingSiblingNames = new Set(
        channelsRef.current
          .filter(
            (c) =>
              c.id !== id &&
              (c.parent_channel_id ?? null) === newParentId,
          )
          .map((c) => c.name),
      );
      const collisions = kids.filter((k) => existingSiblingNames.has(k.name));
      if (collisions.length > 0) {
        throw new Error(
          `Cannot promote: ${collisions
            .map((c) => `"${c.name}"`)
            .join(', ')} already exist${collisions.length === 1 ? 's' : ''} at the target level. Rename first.`,
        );
      }

      // Batch the child UPDATEs in parallel; collect any errors.
      const settled = await Promise.allSettled(
        kids.map((k) =>
          supabase
            .from('channels')
            .update({ parent_channel_id: newParentId })
            .eq('id', k.id),
        ),
      );
      for (const s of settled) {
        if (s.status === 'rejected') {
          throw s.reason instanceof Error
            ? s.reason
            : new Error('Failed to promote children');
        }
        if (s.status === 'fulfilled' && s.value.error) {
          throw s.value.error;
        }
      }

      // Now safe to delete this channel.
      const { error: delErr } = await supabase
        .from('channels')
        .delete()
        .eq('id', id);
      if (delErr) throw delErr;

      return { promoted: kids.length };
    },
    [],
  );

  // Inline helper so deleteAndPromoteChildren can fall back to a regular
  // delete (with lead checks) when called against a node that turns out to
  // have no children. Mirrors the body of the public deleteChannel.
  async function deleteChannelInner(id: string): Promise<void> {
    const { count: leadCount, error: countErr } = await supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('source_channel_id', id);
    if (countErr) throw countErr;
    if ((leadCount ?? 0) > 0) {
      throw new Error(
        `Channel has ${leadCount} lead${leadCount === 1 ? '' : 's'}. Merge into another channel first.`,
      );
    }
    const { error: delErr } = await supabase.from('channels').delete().eq('id', id);
    if (delErr) throw delErr;
  }

  const create = useCallback(
    async (
      name: string,
      parentChannelId: string | null,
    ): Promise<{ id: string }> => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Name cannot be empty');

      if (parentChannelId !== null) {
        const parent = channelsRef.current.find(
          (c) => c.id === parentChannelId,
        );
        if (!parent) throw new Error('Parent channel not found');
      }

      // Pre-check the DB's UNIQUE(name, parent_channel_id) so a duplicate
      // shows up as a friendly message instead of a Postgres constraint
      // code surfacing through the supabase-js error.
      const collision = channelsRef.current.some(
        (c) =>
          (c.parent_channel_id ?? null) === (parentChannelId ?? null) &&
          c.name === trimmed,
      );
      if (collision) {
        throw new Error(
          `A channel named "${trimmed}" already exists at that level.`,
        );
      }

      // Place new channel at the bottom of its sibling group. siblings()
      // returns the group sorted ascending; reading the last entry's
      // display_order gives us a stable max even when the group is
      // un-normalized (some entries at 0).
      const group = siblings(channelsRef.current, parentChannelId);
      const maxOrder = group.reduce(
        (m, c) => (c.display_order > m ? c.display_order : m),
        0,
      );
      const display_order = maxOrder + ORDER_GAP;

      const { data, error } = await supabase
        .from('channels')
        .insert({
          name: trimmed,
          parent_channel_id: parentChannelId,
          display_order,
          hidden: false,
        })
        .select('id')
        .single();
      if (error) throw error;
      const row = data as { id: string };
      return { id: row.id };
    },
    [],
  );

  return {
    rename,
    setHidden,
    moveUp,
    moveDown,
    deleteChannel,
    merge,
    reparent,
    deleteAndPromoteChildren,
    create,
  };
}
