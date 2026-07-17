// Compact campaign-tag picker embedded in each silo (6Sense section headers,
// Outreach sequence list, Channels tree). Shows the campaigns an asset belongs
// to as chips and opens a menu to add or remove them. Presentational: the host
// passes the tag list + the asset's current tags and the toggle/clear handlers
// (all sourced from a single useCampaignTags instance threaded through App).
//
// An asset can belong to SEVERAL campaigns, so the menu toggles rather than
// assigns and stays open across selections.

import { useEffect, useRef, useState } from 'react';
import type { CampaignTag } from '../../types/db';

// Chips rendered on the trigger before collapsing the rest into "+N". Keeps the
// row height stable when an asset is shared across many campaigns.
const MAX_CHIPS = 2;

export default function CampaignTagPicker({
  tags,
  current,
  onToggle,
  onClearAll,
  size = 'sm',
}: {
  tags: CampaignTag[];
  current: CampaignTag[];
  onToggle: (tagId: string) => void | Promise<void>;
  onClearAll: () => void | Promise<void>;
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pad = size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs';
  const has = current.length > 0;
  const shown = current.slice(0, MAX_CHIPS);
  const overflow = current.length - shown.length;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={
          has
            ? `Campaigns: ${current.map((c) => c.name).join(', ')}`
            : 'Assign a campaign'
        }
        className={
          `inline-flex items-center gap-1 rounded-full border transition-colors ${pad} ` +
          (has
            ? 'border-indigo/40 text-indigo bg-indigo/5 hover:bg-indigo/10'
            : 'border-dashed border-border text-slate-muted hover:text-charcoal hover:border-charcoal/30')
        }
      >
        {has ? (
          <>
            {shown.map((t, i) => (
              <span key={t.id} className="inline-flex items-center gap-1">
                {i > 0 && <span className="text-indigo/40">·</span>}
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: t.color || '#4F46E5' }}
                />
                {t.name}
              </span>
            ))}
            {overflow > 0 && <span className="text-indigo/70">+{overflow}</span>}
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
              const active = current.some((c) => c.id === t.id);
              return (
                <button
                  key={t.id}
                  type="button"
                  // Stay open: an asset usually gets several campaigns at once.
                  onClick={() => onToggle(t.id)}
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
          {has && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                type="button"
                onClick={async () => {
                  await onClearAll();
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-danger hover:bg-muted"
              >
                Clear all campaigns
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
