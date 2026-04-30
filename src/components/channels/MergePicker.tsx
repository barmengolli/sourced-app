import { useState } from 'react';
import type { Channel } from '../../types/db';

interface MergePickerProps {
  source: Channel;
  candidates: Channel[]; // already filtered to eligible leaves
  sourceLeadCount: number;
  onConfirm: (targetId: string) => Promise<void>;
  onCancel: () => void;
}

export default function MergePicker({
  source,
  candidates,
  sourceLeadCount,
  onConfirm,
  onCancel,
}: MergePickerProps) {
  const [targetId, setTargetId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const target = candidates.find((c) => c.id === targetId);

  const submit = async () => {
    if (!targetId) return;
    setBusy(true);
    setErr(null);
    try {
      await onConfirm(targetId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Merge failed');
      setBusy(false);
    }
  };

  return (
    <div className="ml-12 mt-1 mb-2 p-3 border border-border rounded-md bg-muted space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-muted">Merge into</span>
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          disabled={busy}
          className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal min-w-[200px]"
        >
          <option value="">Select a channel</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {target && (
        <p className="text-xs text-charcoal">
          This will move {sourceLeadCount} lead
          {sourceLeadCount === 1 ? '' : 's'} from{' '}
          <span className="font-medium">{source.name}</span> to{' '}
          <span className="font-medium">{target.name}</span> and delete{' '}
          <span className="font-medium">{source.name}</span>. This is
          irreversible.
        </p>
      )}
      {err && <p className="text-xs text-danger">{err}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!targetId || busy}
          className="text-xs px-3 py-1 rounded bg-danger text-white disabled:opacity-40"
        >
          {busy ? 'Merging' : 'Confirm merge'}
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
