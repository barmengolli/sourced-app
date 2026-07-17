// Access to the campaign-tag layer (campaign_tags + campaign_tag_links) that
// unifies the four data silos. A tag is the canonical campaign; links map a tag
// to one asset per silo (a channel, a 6Sense segment, or an Outreach sequence).
// Mirrors useSixSenseSnapshots: paged fetch, per-mount realtime channel,
// optimistic local writes.
//
// An asset may belong to SEVERAL campaigns: the link table is keyed
// UNIQUE(tag_id, asset_type, asset_ref), so tagsFor() returns every campaign
// claiming an asset. linkAsset ADDS a campaign (upserting on that key, so
// re-adding an existing link is a no-op); unlinkAsset removes ONE campaign and
// must always be given the tag_id, or it would strip every campaign from the
// asset. See migrations/2026-07-15_campaign_tag_links_multi_tag.sql.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type {
  CampaignTag,
  CampaignTagLink,
  CampaignAssetType,
} from '../types/db';

const PAGE = 1000;

async function fetchAll<T>(
  table: string,
  orderBy: string,
  ascending: boolean,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(orderBy, { ascending })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export interface UseCampaignTagsResult {
  tags: CampaignTag[]; // by display_order, then name
  links: CampaignTagLink[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  // CRUD on tags.
  createTag: (name: string, color?: string | null) => Promise<CampaignTag>;
  renameTag: (id: string, to: string) => Promise<void>;
  setColor: (id: string, color: string | null) => Promise<void>;
  deleteTag: (id: string) => Promise<void>;
  // Link ops. linkAsset ADDS the asset to a campaign, leaving its other
  // campaigns intact; unlinkAsset removes it from ONE campaign only.
  linkAsset: (
    tagId: string,
    assetType: CampaignAssetType,
    assetRef: string,
  ) => Promise<void>;
  unlinkAsset: (
    tagId: string,
    assetType: CampaignAssetType,
    assetRef: string,
  ) => Promise<void>;
  // Selectors.
  tagsFor: (assetType: CampaignAssetType, assetRef: string) => CampaignTag[];
  linksForTag: (tagId: string) => CampaignTagLink[];
}

export function useCampaignTags(): UseCampaignTagsResult {
  const [tags, setTags] = useState<CampaignTag[]>([]);
  const [links, setLinks] = useState<CampaignTagLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const tagChannelRef = useRef<RealtimeChannel | null>(null);
  const linkChannelRef = useRef<RealtimeChannel | null>(null);
  const suffix = useMemo(() => Math.random().toString(36).slice(2, 10), []);

  const refresh = useCallback(async () => {
    try {
      const [t, l] = await Promise.all([
        fetchAll<CampaignTag>('campaign_tags', 'display_order', true),
        fetchAll<CampaignTagLink>('campaign_tag_links', 'created_at', true),
      ]);
      setTags(sortTags(t));
      setLinks(l);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('Failed to load campaign tags', err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchAll<CampaignTag>('campaign_tags', 'display_order', true),
      fetchAll<CampaignTagLink>('campaign_tag_links', 'created_at', true),
    ])
      .then(([t, l]) => {
        if (cancelled) return;
        setTags(sortTags(t));
        setLinks(l);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        console.error('Failed to load campaign tags', err);
        setLoading(false);
      });

    tagChannelRef.current = supabase
      .channel(`public:campaign_tags:${suffix}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'campaign_tags' },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (old?.id) setTags((prev) => prev.filter((t) => t.id !== old.id));
            return;
          }
          const next = payload.new as CampaignTag;
          setTags((prev) =>
            sortTags([next, ...prev.filter((t) => t.id !== next.id)]),
          );
        },
      )
      .subscribe();

    linkChannelRef.current = supabase
      .channel(`public:campaign_tag_links:${suffix}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'campaign_tag_links' },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (old?.id)
              setLinks((prev) => prev.filter((l) => l.id !== old.id));
            return;
          }
          const next = payload.new as CampaignTagLink;
          // Replace by id ONLY. An asset legitimately holds several links now,
          // so a new link must not evict its siblings: dropping same-asset
          // links here would make an asset's other campaigns vanish for every
          // other connected client.
          setLinks((prev) => [next, ...prev.filter((l) => l.id !== next.id)]);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (tagChannelRef.current) supabase.removeChannel(tagChannelRef.current);
      if (linkChannelRef.current) supabase.removeChannel(linkChannelRef.current);
      tagChannelRef.current = null;
      linkChannelRef.current = null;
    };
  }, [suffix]);

  const createTag = useCallback(
    async (name: string, color?: string | null): Promise<CampaignTag> => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error('Tag name is required.');
      if (tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) {
        throw new Error(`A campaign named "${trimmed}" already exists.`);
      }
      const order = tags.reduce((m, t) => Math.max(m, t.display_order), 0) + 1;
      const { data, error: insErr } = await supabase
        .from('campaign_tags')
        .insert({ name: trimmed, color: color ?? null, display_order: order })
        .select()
        .single();
      if (insErr) throw insErr;
      const saved = data as CampaignTag;
      setTags((prev) => sortTags([saved, ...prev]));
      return saved;
    },
    [tags],
  );

  const renameTag = useCallback(
    async (id: string, to: string): Promise<void> => {
      const trimmed = to.trim();
      if (!trimmed) return;
      if (
        tags.some(
          (t) => t.id !== id && t.name.toLowerCase() === trimmed.toLowerCase(),
        )
      ) {
        throw new Error(`A campaign named "${trimmed}" already exists.`);
      }
      const { error: updErr } = await supabase
        .from('campaign_tags')
        .update({ name: trimmed })
        .eq('id', id);
      if (updErr) throw updErr;
      setTags((prev) =>
        sortTags(prev.map((t) => (t.id === id ? { ...t, name: trimmed } : t))),
      );
    },
    [tags],
  );

  const setColor = useCallback(
    async (id: string, color: string | null): Promise<void> => {
      const { error: updErr } = await supabase
        .from('campaign_tags')
        .update({ color })
        .eq('id', id);
      if (updErr) throw updErr;
      setTags((prev) => prev.map((t) => (t.id === id ? { ...t, color } : t)));
    },
    [],
  );

  const deleteTag = useCallback(async (id: string): Promise<void> => {
    const { error: delErr } = await supabase
      .from('campaign_tags')
      .delete()
      .eq('id', id);
    if (delErr) throw delErr;
    // Links cascade in the DB; mirror locally.
    setTags((prev) => prev.filter((t) => t.id !== id));
    setLinks((prev) => prev.filter((l) => l.tag_id !== id));
  }, []);

  const linkAsset = useCallback(
    async (
      tagId: string,
      assetType: CampaignAssetType,
      assetRef: string,
    ): Promise<void> => {
      // ADDITIVE: an asset can belong to several campaigns. Upsert on the
      // (tag_id, asset_type, asset_ref) key so re-adding a campaign the asset
      // already has is a no-op instead of a duplicate or a constraint error.
      const { data, error: upErr } = await supabase
        .from('campaign_tag_links')
        .upsert(
          { tag_id: tagId, asset_type: assetType, asset_ref: assetRef },
          { onConflict: 'tag_id,asset_type,asset_ref' },
        )
        .select()
        .single();
      if (upErr) throw upErr;
      const saved = data as CampaignTagLink;
      // Replace by link id ONLY: this asset's other campaigns must survive.
      setLinks((prev) => [saved, ...prev.filter((l) => l.id !== saved.id)]);
    },
    [],
  );

  const unlinkAsset = useCallback(
    async (
      tagId: string,
      assetType: CampaignAssetType,
      assetRef: string,
    ): Promise<void> => {
      // Scoped to ONE campaign. Without the tag_id filter this would strip the
      // asset from every campaign at once.
      const { error: delErr } = await supabase
        .from('campaign_tag_links')
        .delete()
        .eq('tag_id', tagId)
        .eq('asset_type', assetType)
        .eq('asset_ref', assetRef);
      if (delErr) throw delErr;
      setLinks((prev) =>
        prev.filter(
          (l) =>
            !(
              l.tag_id === tagId &&
              l.asset_type === assetType &&
              l.asset_ref === assetRef
            ),
        ),
      );
    },
    [],
  );

  // Every campaign claiming this asset. Filters `tags` rather than mapping the
  // links so the result inherits tag display order and silently drops links
  // whose tag has been deleted.
  const tagsFor = useCallback(
    (assetType: CampaignAssetType, assetRef: string): CampaignTag[] => {
      const ids = new Set(
        links
          .filter((l) => l.asset_type === assetType && l.asset_ref === assetRef)
          .map((l) => l.tag_id),
      );
      return tags.filter((t) => ids.has(t.id));
    },
    [links, tags],
  );

  const linksForTag = useCallback(
    (tagId: string) => links.filter((l) => l.tag_id === tagId),
    [links],
  );

  return useMemo(
    () => ({
      tags,
      links,
      loading,
      error,
      refresh,
      createTag,
      renameTag,
      setColor,
      deleteTag,
      linkAsset,
      unlinkAsset,
      tagsFor,
      linksForTag,
    }),
    [
      tags,
      links,
      loading,
      error,
      refresh,
      createTag,
      renameTag,
      setColor,
      deleteTag,
      linkAsset,
      unlinkAsset,
      tagsFor,
      linksForTag,
    ],
  );
}

function sortTags(rows: CampaignTag[]): CampaignTag[] {
  return [...rows].sort(
    (a, b) =>
      a.display_order - b.display_order || a.name.localeCompare(b.name),
  );
}
