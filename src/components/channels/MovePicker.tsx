import { useMemo, useState } from 'react';
import type { Channel } from '../../types/db';

interface MovePickerProps {
  source: Channel;
  candidates: Channel[]; // already filtered: excludes source and all its descendants
  currentParentId: string | null;
  onConfirm: (newParentId: string | null) => Promise<void>;
  onCancel: () => void;
}

const TOP_LEVEL = '__top_level__';

export default function MovePicker({
  source,
  candidates,
  currentParentId,
  onConfirm,
  onCancel,
}: MovePickerProps) {
  const [search, setSearch] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.name.toLowerCase().includes(q));
  }, [candidates, search]);

  const previewName: string | null = useMemo(() => {
    if (pendingId === null) return null;
    if (pendingId === TOP_LEVEL) return null; // top-level marker
    const target = candidates.find((c) => c.id === pendingId);
    return target?.name ?? null;
  }, [pendingId, candidates]);

  const previewText = (() => {
    if (pendingId === null) return null;
    if (pendingId === TOP_LEVEL) {
      return (
        <>
          Move <span className="font-medium">{source.name}</span> to top level
          (no parent).
        </>
      );
    }
    if (!previewName) return null;
    return (
      <>
        Move <span className="font-medium">{source.name}</span> under{' '}
        <span className="font-medium">{previewName}</span>.
      </>
    );
  })();

  const submit = async () => {
    if (pendingId === null) return;
    setBusy(true);
    setErr(null);
    try {
      const newParentId = pendingId === TOP_LEVEL ? null : pendingId;
      await onConfirm(newParentId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Move failed');
      setBusy(false);
    }
  };

  return (
    <div className="ml-12 mt-1 mb-2 p-3 border border-border rounded-md bg-muted space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-muted">Move under</span>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={busy}
          placeholder="Search channels"
          className="flex-1 min-w-[200px] text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
        />
      </div>

      <ul className="max-h-48 overflow-y-auto border border-border rounded bg-bg divide-y divide-border">
        <li>
          <button
            type="button"
            onClick={() => setPendingId(TOP_LEVEL)}
            disabled={busy || currentParentId === null}
            title={
              currentParentId === null
                ? 'Already at top level'
                : 'Move to top level'
            }
            className={
              'w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ' +
              (pendingId === TOP_LEVEL
                ? 'bg-indigo/10 text-indigo'
                : 'text-charcoal hover:bg-muted/60') +
              (currentParentId === null
                ? ' opacity-40 cursor-not-allowed'
                : '')
            }
          >
            <span className="italic">Top level (no parent)</span>
          </button>
        </li>
        {filtered.length === 0 ? (
          <li className="px-3 py-2 text-xs text-slate-muted italic">
            No matches.
          </li>
        ) : (
          filtered.map((c) => {
            const isCurrent = c.id === currentParentId;
            const isPending = c.id === pendingId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setPendingId(c.id)}
                  disabled={busy || isCurrent}
                  title={isCurrent ? 'Already this channel\'s parent' : c.name}
                  className={
                    'w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ' +
                    (isPending
                      ? 'bg-indigo/10 text-indigo'
                      : 'text-charcoal hover:bg-muted/60') +
                    (isCurrent ? ' opacity-40 cursor-not-allowed' : '')
                  }
                >
                  {c.name}
                  {isCurrent && (
                    <span className="text-slate-muted text-[10px]">
                      (current)
                    </span>
                  )}
                </button>
              </li>
            );
          })
        )}
      </ul>

      {previewText && <p className="text-xs text-charcoal">{previewText}</p>}
      {err && <p className="text-xs text-danger">{err}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={pendingId === null || busy}
          className="text-xs px-3 py-1 rounded bg-indigo text-white disabled:opacity-40"
        >
          {busy ? 'Moving' : 'Confirm move'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="text-xs px-2 py-1 text-slate-muted hover:text-charcoal"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
