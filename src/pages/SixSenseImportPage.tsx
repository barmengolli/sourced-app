// 6sense Import: drop a 6sense "Activities By Source" CSV export, preview the
// parsed KPIs, set the analysis-window end date, and upsert a weekly snapshot.
// Mirrors the Funnel importer's upload -> preview -> confirm flow but is a
// single summary row, so there's no column-mapping or per-row diff step.

import { useMemo, useState } from 'react';
import type { PageKey } from '../App';
import type { SixSenseSnapshot } from '../types/db';
import type { ParsedCsv } from '../lib/csv';
import {
  parseActivitiesBySource,
  toSnapshotInput,
  reachPct,
  engagementPct,
  intentPct,
  type SixSenseCounts,
  type SixSenseSnapshotInput,
} from '../lib/sixsense';
import DropZone from '../components/import/DropZone';

interface SixSenseImportPageProps {
  upsertSnapshot: (input: SixSenseSnapshotInput) => Promise<SixSenseSnapshot>;
  onNavigate: (p: PageKey) => void;
}

type Step = 'upload' | 'preview' | 'saving' | 'done';

const fmtInt = (n: number | null): string =>
  n === null ? '—' : n.toLocaleString();
const fmtPct = (n: number): string => `${(Math.round(n * 10) / 10).toFixed(1)}%`;

// Today as YYYY-MM-DD in local time, for the default window-end value.
function todayYmd(): string {
  const d = new Date();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mo}-${day}`;
}

export default function SixSenseImportPage({
  upsertSnapshot,
  onNavigate,
}: SixSenseImportPageProps) {
  const [step, setStep] = useState<Step>('upload');
  const [counts, setCounts] = useState<SixSenseCounts | null>(null);
  const [unknownMetrics, setUnknownMetrics] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string>('');
  const [windowStart, setWindowStart] = useState<string>('');
  const [windowEnd, setWindowEnd] = useState<string>(todayYmd());
  const [error, setError] = useState<string | null>(null);

  const onParsed = (parsed: ParsedCsv, file: File) => {
    setError(null);
    const { counts: parsedCounts, unknownMetrics: unknown } =
      parseActivitiesBySource(parsed.rows, parsed.headers);
    if (parsedCounts.total_accounts === 0 && parsedCounts.reach === 0) {
      setError(
        'No recognizable 6sense metrics found. Make sure this is the "Activities By Source" export (a Metric, Accounts CSV).',
      );
      return;
    }
    setCounts(parsedCounts);
    setUnknownMetrics(unknown);
    setFileName(file.name);
    setStep('preview');
  };

  // Preview percentages computed exactly as the dashboard will show them.
  const preview = useMemo(() => {
    if (!counts) return null;
    const asSnapshot = {
      reach: counts.reach,
      engagement: counts.engagement,
      intent: counts.intent,
      total_accounts: counts.total_accounts,
    };
    return {
      reach: reachPct(asSnapshot),
      engagement: engagementPct(asSnapshot),
      intent: intentPct(asSnapshot),
    };
  }, [counts]);

  const confirm = async () => {
    if (!counts) return;
    if (!windowEnd) {
      setError('Set the analysis-window end date before importing.');
      return;
    }
    setError(null);
    setStep('saving');
    try {
      const input = toSnapshotInput(counts, {
        snapshotDate: windowEnd,
        windowStart: windowStart || null,
        windowEnd: windowEnd,
      });
      await upsertSnapshot(input);
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import failed');
      setStep('preview');
    }
  };

  const reset = () => {
    setStep('upload');
    setCounts(null);
    setUnknownMetrics([]);
    setFileName('');
    setError(null);
  };

  return (
    <div className="p-8 space-y-4 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold text-charcoal">
          Import 6sense activities
        </h1>
        <p className="mt-1 text-sm text-slate-muted">
          Drop the 6sense "Activities By Source" CSV export (the Download as CSV
          button on that view). It is parsed in your browser; nothing is saved
          until you confirm.
        </p>
      </header>

      {error && (
        <div className="text-sm text-danger border border-danger/40 bg-danger/5 rounded px-3 py-2">
          {error}
        </div>
      )}

      {step === 'upload' && <DropZone onParsed={onParsed} />}

      {step === 'preview' && counts && preview && (
        <div className="space-y-4">
          <div className="text-xs text-slate-muted">
            Parsed <span className="text-charcoal font-medium">{fileName}</span>.
          </div>

          {unknownMetrics.length > 0 && (
            <div className="text-xs text-warning border border-warning/40 bg-warning/5 rounded px-3 py-2">
              {unknownMetrics.length} unrecognized metric
              {unknownMetrics.length === 1 ? '' : 's'} ignored:{' '}
              {unknownMetrics.join(', ')}. If 6sense renamed a row, the column
              map in src/lib/sixsense.ts needs updating.
            </div>
          )}

          {/* Window dates. End date is the snapshot key; start is optional
              context for display. */}
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-xs text-slate-muted">
              Window start (optional)
              <input
                type="date"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-muted">
              Window end (snapshot date)
              <input
                type="date"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
              />
            </label>
          </div>
          <p className="text-xs text-slate-muted">
            Importing the same window end date again replaces that snapshot.
          </p>

          {/* Headline preview: the same reach/engagement % the dashboard shows. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <PreviewStat label="Total accounts" value={fmtInt(counts.total_accounts)} />
            <PreviewStat
              label="Reach"
              value={`${fmtInt(counts.reach)} (${fmtPct(preview.reach)})`}
            />
            <PreviewStat
              label="Engagement"
              value={`${fmtInt(counts.engagement)} (${fmtPct(preview.engagement)})`}
            />
            <PreviewStat
              label="Intent"
              value={`${fmtInt(counts.intent)} (${fmtPct(preview.intent)})`}
            />
            <PreviewStat
              label="Accounts with activity"
              value={fmtInt(counts.accounts_with_activity)}
            />
            <PreviewStat label="No activity" value={fmtInt(counts.no_activity)} />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={confirm}
              className="text-sm px-4 py-2 rounded bg-indigo text-white hover:bg-indigo/90"
            >
              Import snapshot
            </button>
            <button
              type="button"
              onClick={reset}
              className="text-sm px-4 py-2 rounded border border-border text-charcoal hover:border-charcoal/30"
            >
              Choose a different file
            </button>
          </div>
        </div>
      )}

      {step === 'saving' && (
        <p className="text-sm text-slate-muted italic">Saving snapshot…</p>
      )}

      {step === 'done' && (
        <div className="space-y-4">
          <div className="text-sm text-success border border-success/40 bg-success/5 rounded px-3 py-2">
            Snapshot imported for window ending {windowEnd}.
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onNavigate('sixsense-dashboard')}
              className="text-sm px-4 py-2 rounded bg-indigo text-white hover:bg-indigo/90"
            >
              View dashboard
            </button>
            <button
              type="button"
              onClick={reset}
              className="text-sm px-4 py-2 rounded border border-border text-charcoal hover:border-charcoal/30"
            >
              Import another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded bg-muted/40 px-3 py-2">
      <p className="text-xs text-slate-muted">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-charcoal">{value}</p>
    </div>
  );
}
