import { useState } from 'react';
import type { BulkSyncResult } from '../../hooks/useLeads';

interface ImportProgressModalProps {
  total: number;
  done: number;
  result: BulkSyncResult | null;
  onDone: () => void;
}

export default function ImportProgressModal({
  total,
  done,
  result,
  onDone,
}: ImportProgressModalProps) {
  const [copied, setCopied] = useState(false);
  const pct = total === 0 ? 100 : Math.min(100, Math.round((done / total) * 100));
  const finished = result !== null;

  const copyErrors = async () => {
    if (!result) return;
    const text = result.errors
      .map((e) => `${e.email}\t${e.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.warn('Clipboard write failed', e);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-charcoal/30 flex items-center justify-center p-4">
      <div className="bg-bg border border-border rounded-lg shadow-sm w-full max-w-md p-6 space-y-4">
        <h2 className="text-base font-semibold text-charcoal">
          {finished ? 'Import complete' : 'Importing'}
        </h2>

        <div className="space-y-1">
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-indigo transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-slate-muted">
            {done} of {total} ({pct}%)
          </p>
        </div>

        {finished && result && (
          <div className="space-y-2">
            <ul className="text-sm text-charcoal space-y-1">
              <li>
                <span className="font-medium">{result.inserted}</span> inserted
              </li>
              <li>
                <span className="font-medium">{result.updated}</span> updated
              </li>
              <li>
                <span className="font-medium">{result.errors.length}</span>{' '}
                error{result.errors.length === 1 ? '' : 's'}
              </li>
            </ul>
            {result.errors.length > 0 && (
              <details className="text-xs text-slate-muted">
                <summary className="cursor-pointer">Show errors</summary>
                <ul className="mt-1 max-h-40 overflow-y-auto space-y-0.5">
                  {result.errors.slice(0, 50).map((e, i) => (
                    <li key={i}>
                      <span className="font-mono">{e.email}</span>: {e.message}
                    </li>
                  ))}
                  {result.errors.length > 50 && (
                    <li>...and {result.errors.length - 50} more</li>
                  )}
                </ul>
                <button
                  type="button"
                  onClick={copyErrors}
                  className="mt-1 text-indigo hover:underline"
                >
                  {copied ? 'Copied' : 'Copy all errors'}
                </button>
              </details>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          {!finished && (
            <button
              type="button"
              disabled
              title="Cancel mid-import is a future feature."
              className="text-sm px-3 py-1.5 rounded text-slate-muted cursor-not-allowed"
            >
              Cancel
            </button>
          )}
          {finished && (
            <button
              type="button"
              onClick={onDone}
              className="text-sm px-3 py-1.5 rounded bg-indigo text-white"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
