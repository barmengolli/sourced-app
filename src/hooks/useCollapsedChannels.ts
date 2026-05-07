// Per-channel collapse state for the funnel tables, shared across the
// Funnel Data Entry and Funnel Compare views via a single hook instance
// per page. State is in-memory only: every fresh page load starts with all
// parents collapsed, regardless of prior session interactions. Per-session
// expand/collapse works while the user is on the page; the state resets on
// refresh or navigating away.
//
// useEffect re-syncs collapsedSet when the channel list changes, so newly
// loaded channels (realtime + initial fetch) start collapsed too.

import { useEffect, useState } from 'react';
import type { Channel } from '../types/db';

export interface UseCollapsedChannelsResult {
  collapsedSet: Set<string>;
  toggle: (channelId: string) => void;
  isCollapsed: (channelId: string) => boolean;
  // True when ANY ancestor in the chain is collapsed; rows under a
  // collapsed grandparent must stay hidden even if their direct parent
  // happens to be expanded.
  isHiddenByAncestors: (ancestors: string[]) => boolean;
}

function buildAllCollapsed(channels: Channel[]): Set<string> {
  const childCount = new Map<string, number>();
  for (const c of channels) {
    if (!c.parent_channel_id) continue;
    childCount.set(
      c.parent_channel_id,
      (childCount.get(c.parent_channel_id) ?? 0) + 1,
    );
  }
  const initial = new Set<string>();
  for (const c of channels) {
    if ((childCount.get(c.id) ?? 0) > 0) initial.add(c.id);
  }
  return initial;
}

export function useCollapsedChannels(
  channels: Channel[],
): UseCollapsedChannelsResult {
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(() =>
    buildAllCollapsed(channels),
  );

  // Channels load asynchronously (Supabase fetch + realtime). When the list
  // first arrives, or grows, fold the new parent ids into the collapsed set
  // so they default to collapsed. Existing entries (including any the user
  // has expanded this session) are preserved.
  useEffect(() => {
    setCollapsedSet((prev) => {
      const fresh = buildAllCollapsed(channels);
      let changed = false;
      const next = new Set(prev);
      for (const id of fresh) {
        if (!next.has(id) && !prev.has(id)) {
          // New parent: collapse by default. We only add ids the previous
          // set didn't know about; ones the user explicitly expanded stay
          // expanded.
          // (prev.has(id) check is redundant with !next.has(id) above but
          // kept for clarity.)
          next.add(id);
          changed = true;
        }
      }
      // Drop ids for channels that no longer exist (deleted or merged).
      for (const id of prev) {
        if (!fresh.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [channels]);

  const toggle = (channelId: string) => {
    setCollapsedSet((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const isCollapsed = (channelId: string) => collapsedSet.has(channelId);
  const isHiddenByAncestors = (ancestors: string[]) =>
    ancestors.some((aid) => collapsedSet.has(aid));

  return { collapsedSet, toggle, isCollapsed, isHiddenByAncestors };
}
