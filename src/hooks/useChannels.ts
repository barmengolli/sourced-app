import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Channel } from '../types/db';

// PostgREST default cap is 1000 rows; page through with .range() the same way
// useLeads and useChannelLeadCounts do so a >1000 channel taxonomy still loads
// fully (F-003).
const PAGE = 1000;

async function fetchAllChannels(): Promise<Channel[]> {
  const all: Channel[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('channels')
      .select('*')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as Channel[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export function useChannels(): Channel[] {
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchAllChannels()
      .then((all) => {
        if (cancelled) return;
        setChannels(all);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to load channels', error);
      });

    // Unique per mount to avoid colliding with another instance's channel.
    const channelName = `public:channels:${Math.random()
      .toString(36)
      .slice(2, 10)}`;
    const channel: RealtimeChannel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'channels' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const next = payload.new as Channel;
            setChannels((prev) =>
              prev.some((c) => c.id === next.id) ? prev : [...prev, next],
            );
          } else if (payload.eventType === 'UPDATE') {
            const next = payload.new as Channel;
            setChannels((prev) =>
              prev.map((c) => (c.id === next.id ? next : c)),
            );
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id?: string };
            if (!old?.id) return;
            setChannels((prev) => prev.filter((c) => c.id !== old.id));
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return channels;
}
