import { useEffect, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Channel } from '../types/db';

export function useChannels(): Channel[] {
  const [channels, setChannels] = useState<Channel[]>([]);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('channels')
      .select('*')
      .order('display_order', { ascending: true })
      .order('name', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Failed to load channels', error);
          return;
        }
        if (data) setChannels(data as Channel[]);
      });

    const channel: RealtimeChannel = supabase
      .channel('public:channels')
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
