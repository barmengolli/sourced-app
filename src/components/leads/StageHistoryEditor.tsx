import { useEffect, useState } from 'react';
import type { StageHistoryEntry, StageKey } from '../../types/db';
import { STAGE_LABELS, STAGE_ORDER } from '../../constants/stages';
import { todayIso } from '../../lib/dates';
import LockIcon from '../common/LockIcon';

interface StageHistoryEditorProps {
  history: StageHistoryEntry[];
  currentStage: StageKey;
  onSave: (entries: StageHistoryEntry[]) => Promise<void>;
}

function entriesEqual(
  a: StageHistoryEntry[],
  b: StageHistoryEntry[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.stage !== y.stage ||
      x.entered_at !== y.entered_at ||
      (x.notes ?? '') !== (y.notes ?? '') ||
      Boolean(x.edit_locked) !== Boolean(y.edit_locked) ||
      (x.edited_by ?? '') !== (y.edited_by ?? '')
    ) {
      return false;
    }
  }
  return true;
}

export default function StageHistoryEditor({
  history,
  currentStage,
  onSave,
}: StageHistoryEditorProps) {
  const [working, setWorking] = useState<StageHistoryEntry[]>(history);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset working copy when the prop changes (different lead, or realtime).
  useEffect(() => {
    setWorking(history);
  }, [history]);

  const dirty = !entriesEqual(working, history);

  const update = (idx: number, patch: Partial<StageHistoryEntry>) => {
    setWorking((prev) =>
      prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)),
    );
  };
  const remove = (idx: number) => {
    setWorking((prev) => prev.filter((_, i) => i !== idx));
  };
  const add = () => {
    setWorking((prev) => [
      ...prev,
      {
        stage: currentStage,
        entered_at: todayIso(),
        edited_by: 'Marketing',
        edit_locked: false,
      },
    ]);
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const sorted = [...working].sort((a, b) =>
        a.entered_at.localeCompare(b.entered_at),
      );
      await onSave(sorted);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {working.length === 0 ? (
        <p className="text-sm text-slate-muted italic">
          No stage history yet. Changing the stage above appends an entry.
        </p>
      ) : (
        <ul className="space-y-2">
          {working.map((entry, idx) => (
            <li
              key={idx}
              className="border border-border rounded-md p-2 bg-muted/40 space-y-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={entry.stage}
                  onChange={(e) =>
                    update(idx, { stage: e.target.value as StageKey })
                  }
                  className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
                >
                  {STAGE_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
                <input
                  type="date"
                  value={entry.entered_at}
                  onChange={(e) =>
                    update(idx, { entered_at: e.target.value })
                  }
                  className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
                />
                <button
                  type="button"
                  onClick={() =>
                    update(idx, { edit_locked: !entry.edit_locked })
                  }
                  title={
                    entry.edit_locked
                      ? 'Locked. Click to unlock.'
                      : 'Unlocked. Click to lock.'
                  }
                  className={
                    'inline-flex items-center justify-center w-7 h-7 rounded border ' +
                    (entry.edit_locked
                      ? 'bg-indigo/10 border-indigo text-indigo'
                      : 'border-border text-slate-muted hover:text-charcoal')
                  }
                >
                  <LockIcon
                    locked={Boolean(entry.edit_locked)}
                    className="w-4 h-4"
                  />
                </button>
                <button
                  type="button"
                  onClick={() => remove(idx)}
                  className="ml-auto text-xs text-danger hover:underline"
                >
                  Remove
                </button>
              </div>
              <textarea
                value={entry.notes ?? ''}
                onChange={(e) =>
                  update(idx, { notes: e.target.value || undefined })
                }
                placeholder="Notes (optional)"
                rows={2}
                className="w-full text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={add}
          className="text-sm px-3 py-1.5 rounded border border-border text-charcoal hover:bg-muted"
        >
          Add entry
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="text-sm px-3 py-1.5 rounded bg-indigo text-white disabled:opacity-40"
        >
          {saving ? 'Saving' : 'Save history'}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => setWorking(history)}
            className="text-sm px-3 py-1.5 rounded text-slate-muted hover:text-charcoal"
          >
            Cancel
          </button>
        )}
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}
      <p className="text-xs text-slate-muted">
        Stage transitions made via the stage selector above append a new entry
        automatically.
      </p>
    </div>
  );
}
