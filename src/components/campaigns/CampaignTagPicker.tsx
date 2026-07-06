// Compact campaign-tag picker embedded in each silo (6Sense section headers,
// Outreach sequence list, Channels tree). Shows the asset's current campaign
// tag as a chip and opens a menu to assign, change, or clear it. Presentational:
// the host passes the tag list + the current tag and the assign/clear handlers
// (all sourced from a single useCampaignTags instance threaded through App).

import { useEffect, useRef, useState } from 'react';
import type { CampaignTag } from '../../types/db';

export default function CampaignTagPicker({
  tags,
  current,
  onAssign,
  onClear,
  size = 'sm',
}: {
  tags: CampaignTag[];
  current: CampaignTag | null;
  onAssign: (tagId: string) => void | Promise<void>;
  onClear: () => void | Promise<void>;
  size?: 'sm' | 'xs';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pad = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs';

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={current ? `Campaign: ${current.name}` : 'Assign a campaign'}
        className={
          `inline-flex items-center gap-1 rounded-full border transition-colors ${pad} ` +
          (current
            ? 'border-indigo/40 text-indigo bg-indigo/5 hover:bg-indigo/10'
            : 'border-dashed border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30')
        }
      >
        {current ? (
          <>
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ backgroundColor: current.color || '#4F46E5' }}
            />
            {current.name}
          </>
        ) : (
          '+ campaign'
        )}
      </button>

      {open && (
        <div className="absolute z-20 mt-1 min-w-[180px] rounded-md border border-border bg-bg shadow-lg py-1">
          {tags.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-muted italic">
              No campaigns yet. Create one on the Campaigns tab.
            </p>
          ) : (
            tags.map((t) => {
              const active = current?.id === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={async () => {
                    await onAssign(t.id);
                    setOpen(false);
                  }}
                  className={
                    'w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-muted ' +
                    (active ? 'text-indigo font-medium' : 'text-charcoal')
                  }
                >
                  <span
                    className="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: t.color || '#4F46E5' }}
                  />
                  {t.name}
                  {active && <span className="ml-auto text-indigo">✓</span>}
                </button>
              );
            })
          )}
          {current && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                onClick={async () => {
                  await onClear();
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-danger hover:bg-muted"
              >
                Remove from {current.name}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
