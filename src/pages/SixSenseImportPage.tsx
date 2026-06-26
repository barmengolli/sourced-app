// 6sense Import: drop a 6sense "Activities By Source" CSV export, preview the
// parsed KPIs, pick the snapshot month, and upsert a monthly snapshot.
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
import { OVERALL_SEGMENT, orderSegments } from '../constants/sixsense';
import DropZone from '../components/import/DropZone';

// Sentinel value for the "Add new segment…" option in the segment dropdown.
const ADD_NEW = '__add_new__';

interface SixSenseImportPageProps {
  snapshots: SixSenseSnapshot[];
  upsertSnapshot: (input: SixSenseSnapshotInput) => Promise<SixSenseSnapshot>;
  onNavigate: (p: PageKey) => void;
}

type Step = 'upload' | 'preview' | 'saving' | 'done';

const fmtInt = (n: number | null): string =>
  n === null ? '—' : n.toLocaleString();
const fmtPct = (n: number): string => `${(Math.round(n * 10) / 10).toFixed(1)}%`;

// The last completed month as `YYYY-MM`, the default for the month picker
// (e.g. on 2026-06-18 -> '2026-05').
function lastCompletedMonth(): string {
  const d = new Date();
  d.setDate(1); // avoid month-length rollover
  d.setMonth(d.getMonth() - 1);
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${mo}`;
}

// "2026-05" -> "May 2026" for display.
function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Last day of the given "YYYY-MM" month, as YYYY-MM-DD (for window_end).
function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, '0')}`;
}

// A stored snapshot's month label from its year + month (week_number 1-12),
// e.g. "Jun 2026". Used in the overwrite warning and registry.
function snapshotMonthLabel(year: number, monthNum: number): string {
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// ISO timestamp -> "Jun 3, 2026, 2:14 PM" (local). Empty for null.
function fmtTimestamp(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function SixSenseImportPage({
  snapshots,
  upsertSnapshot,
  onNavigate,
}: SixSenseImportPageProps) {
  const [step, setStep] = useState<Step>('upload');
  const [counts, setCounts] = useState<SixSenseCounts | null>(null);
  const [unknownMetrics, setUnknownMetrics] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string>('');
  // Snapshot month as `YYYY-MM`. Defaults to the last completed month.
  const [month, setMonth] = useState<string>(lastCompletedMonth());
  const [error, setError] = useState<string | null>(null);
  // Segment selection. `segment` holds the chosen value; when the user picks
  // "Add new segment…", `addingNew` reveals a text input feeding `newSegment`.
  const [segment, setSegment] = useState<string>(OVERALL_SEGMENT);
  const [addingNew, setAddingNew] = useState<boolean>(false);
  const [newSegment, setNewSegment] = useState<string>('');

  // Existing segments from the data (overall first), for the dropdown.
  const existingSegments = useMemo(
    () => orderSegments([OVERALL_SEGMENT, ...snapshots.map((s) => s.segment)]),
    [snapshots],
  );

  // The effective segment to import under.
  const effectiveSegment = addingNew ? newSegment.trim() : segment;

  // Existing snapshot for the chosen (month, segment), if any. Drives the
  // overwrite warning: importing here REPLACES this row (upsert on the natural
  // key), so the most likely mistake is a wrong-month/segment pick clobbering
  // real data. snapshot_date is the first of the month.
  const existingForChosen = useMemo(() => {
    if (!month || !effectiveSegment) return null;
    const key = `${month}-01`;
    return (
      snapshots.find(
        (s) => s.snapshot_date === key && s.segment === effectiveSegment,
      ) ?? null
    );
  }, [snapshots, month, effectiveSegment]);

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
    if (!month) {
      setError('Pick the snapshot month before importing.');
      return;
    }
    if (!effectiveSegment) {
      setError('Choose a segment (or type a new one) before importing.');
      return;
    }
    setError(null);
    setStep('saving');
    try {
      // The snapshot is keyed to the first of the month; window start/end
      // bracket the full month for display context.
      const input = toSnapshotInput(counts, {
        snapshotDate: `${month}-01`,
        segment: effectiveSegment,
        windowStart: `${month}-01`,
        windowEnd: monthEnd(month),
        fileName: fileName || null,
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

          {/* Segment: which account set this report covers. Existing segments
              plus an "Add new segment…" option for a brand-new campaign. */}
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-xs text-slate-muted">
              Segment
              <select
                value={addingNew ? ADD_NEW : segment}
                onChange={(e) => {
                  if (e.target.value === ADD_NEW) {
                    setAddingNew(true);
                  } else {
                    setAddingNew(false);
                    setSegment(e.target.value);
                  }
                }}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
              >
                {existingSegments.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                <option value={ADD_NEW}>Add new segment…</option>
              </select>
            </label>
            {addingNew && (
              <label className="flex flex-col gap-1 text-xs text-slate-muted">
                New segment name
                <input
                  type="text"
                  value={newSegment}
                  onChange={(e) => setNewSegment(e.target.value)}
                  placeholder="e.g. Life & Annuities"
                  className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
                />
              </label>
            )}
          </div>

          {/* Snapshot month. 6Sense reporting is monthly; the row is keyed to
              this month (per segment). */}
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-xs text-slate-muted">
              Snapshot month
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
              />
            </label>
          </div>
          <p className="text-xs text-slate-muted">
            Monthly snapshot for{' '}
            <span className="text-charcoal font-medium">{fmtMonth(month)}</span>.
            Importing the same month + segment again replaces that snapshot.
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

          {/* Overwrite guardrail: the chosen (month, segment) already has data.
              Importing replaces it — so a wrong-month/segment pick would clobber
              a real snapshot. Name the file/date already stored so the mistake
              is obvious before confirming. */}
          {existingForChosen && (
            <div className="text-sm text-warning border border-warning/40 bg-warning/5 rounded px-3 py-2">
              ⚠ This replaces the existing{' '}
              <span className="font-medium">
                {snapshotMonthLabel(
                  existingForChosen.year,
                  existingForChosen.week_number,
                )}
              </span>{' '}
              snapshot for{' '}
              <span className="font-medium">{effectiveSegment}</span>
              {existingForChosen.imported_at || existingForChosen.file_name ? (
                <>
                  {' '}(imported {fmtTimestamp(existingForChosen.imported_at)}
                  {existingForChosen.file_name
                    ? ` from ${existingForChosen.file_name}`
                    : ''}
                  )
                </>
              ) : null}
              . Double-check the month and segment if this isn't intended.
            </div>
          )}

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
            Imported {effectiveSegment} for {fmtMonth(month)}.
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

      {/* Import history: an audit registry of every snapshot, newest import
          first, so a wrong-month/segment upload can be spotted after the fact. */}
      <ImportHistory snapshots={snapshots} />
    </div>
  );
}

// Registry of all imported snapshots: Segment / Month / Imported / File.
// Sorted by imported_at desc (created_at fallback) so the most recent import
// is at the top. Historical rows (pre-audit) show "—" for file.
function ImportHistory({ snapshots }: { snapshots: SixSenseSnapshot[] }) {
  const rows = useMemo(() => {
    const keyOf = (s: SixSenseSnapshot) => s.imported_at ?? s.created_at ?? '';
    return [...snapshots].sort((a, b) => (keyOf(a) < keyOf(b) ? 1 : -1));
  }, [snapshots]);

  if (rows.length === 0) return null;

  return (
    <section className="space-y-2 pt-4 border-t border-border">
      <h2 className="text-sm font-semibold text-charcoal">Import history</h2>
      <p className="text-xs text-slate-muted">
        Every imported snapshot, most recent first. Use this to confirm the
        right file went into the right month and segment.
      </p>
      <div className="border border-border rounded overflow-x-auto bg-bg">
        <table className="min-w-full text-sm">
          <thead className="bg-muted text-xs text-slate-muted uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Segment</th>
              <th className="px-3 py-2 text-left font-medium">Month</th>
              <th className="px-3 py-2 text-left font-medium">Imported</th>
              <th className="px-3 py-2 text-left font-medium">File</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={s.id} className={i % 2 === 0 ? 'bg-bg' : 'bg-muted/40'}>
                <td className="px-3 py-2 text-charcoal">{s.segment}</td>
                <td className="px-3 py-2 text-charcoal">
                  {snapshotMonthLabel(s.year, s.week_number)}
                </td>
                <td className="px-3 py-2 text-slate-muted">
                  {fmtTimestamp(s.imported_at ?? s.created_at)}
                </td>
                <td className="px-3 py-2 text-slate-muted">
                  {s.file_name ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
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
