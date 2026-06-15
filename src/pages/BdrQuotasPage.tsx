// BDR Quotas: editable annual targets, one numeric cell per (BDR, stage).
// Mirrors the Funnel Data Entry editable-cell pattern: type a number, blur or
// Enter commits an upsert; clearing the cell deletes the quota row. Actuals
// are computed elsewhere (the Dashboard); this only sets the targets.

import { useMemo, useState } from 'react';
import type { PageKey } from '../App';
import type { BdrQuota } from '../types/db';
import { BDRS, BDR_STAGES, BDR_STAGE_LABELS, type BdrStage } from '../constants/bdr';

interface BdrQuotasPageProps {
  quotas: BdrQuota[];
  loading: boolean;
  upsert: (
    bdrName: string,
    year: number,
    stageKey: BdrStage,
    quota: number | null,
  ) => Promise<void>;
  onNavigate: (p: PageKey) => void;
}

export default function BdrQuotasPage({
  quotas,
  loading,
  upsert,
  onNavigate,
}: BdrQuotasPageProps) {
  const yearOptions = useMemo(() => {
    const years = new Set<number>([new Date().getFullYear()]);
    for (const q of quotas) years.add(q.year);
    return [...years].sort((a, b) => b - a);
  }, [quotas]);

  const [year, setYear] = useState<number>(() => new Date().getFullYear());

  // (bdr|stage) -> quota for the selected year.
  const valueOf = (bdr: string, stage: BdrStage): number | null => {
    const row = quotas.find(
      (q) => q.bdr_name === bdr && q.year === year && q.stage_key === stage,
    );
    return row?.quota ?? null;
  };

  return (
    <div className="p-8 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-charcoal">BDR quotas</h1>
          <p className="mt-1 text-sm text-slate-muted">
            Annual HPP (SQL) and Opp (SAO) targets per BDR. Actuals are computed
            from deals on the Dashboard; these are just the targets.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-muted">
            Year
            <select
              value={year}
              onChange={(e) => setYear(parseInt(e.target.value, 10))}
              className="text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => onNavigate('bdr-quota-dashboard')}
            className="text-xs px-3 py-1.5 rounded border border-border text-charcoal hover:border-charcoal/30"
          >
            View dashboard
          </button>
        </div>
      </header>

      {loading ? (
        <p className="text-sm text-slate-muted italic">Loading…</p>
      ) : (
        <div className="border border-border rounded overflow-x-auto bg-bg max-w-2xl">
          <table className="min-w-full text-sm">
            <thead className="bg-muted text-xs text-slate-muted uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">BDR</th>
                {BDR_STAGES.map((s) => (
                  <th key={s} className="px-3 py-2 text-left font-medium">
                    {BDR_STAGE_LABELS[s]} quota
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {BDRS.map((bdr, i) => (
                <tr key={bdr} className={i % 2 === 0 ? 'bg-bg' : 'bg-muted/40'}>
                  <td className="px-3 py-2 text-charcoal font-medium">{bdr}</td>
                  {BDR_STAGES.map((s) => (
                    <td key={s} className="px-3 py-2">
                      <QuotaCell
                        value={valueOf(bdr, s)}
                        onCommit={(v) => upsert(bdr, year, s, v)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Numeric input that commits on blur / Enter. Empty -> null (deletes the row).
function QuotaCell({
  value,
  onCommit,
}: {
  value: number | null;
  onCommit: (v: number | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>(value === null ? '' : String(value));
  const [saving, setSaving] = useState(false);

  // Keep the draft in sync when the underlying value changes (e.g. realtime).
  const valueStr = value === null ? '' : String(value);
  const [lastValueStr, setLastValueStr] = useState(valueStr);
  if (valueStr !== lastValueStr) {
    setLastValueStr(valueStr);
    setDraft(valueStr);
  }

  const commit = async () => {
    const trimmed = draft.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      // Reject invalid; reset to last good value.
      setDraft(valueStr);
      return;
    }
    if ((next === null ? '' : String(next)) === valueStr) return; // no change
    setSaving(true);
    try {
      await onCommit(next);
    } catch (e) {
      console.error('Quota upsert failed', e);
      setDraft(valueStr);
    } finally {
      setSaving(false);
    }
  };

  return (
    <input
      type="number"
      min={0}
      value={draft}
      disabled={saving}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      placeholder="—"
      className="w-20 text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
    />
  );
}
