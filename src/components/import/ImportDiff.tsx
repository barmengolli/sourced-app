import { useMemo, useState } from 'react';
import type { Lead } from '../../types/db';
import { EDITABLE_LEAD_FIELDS, LEAD_FIELD_LABELS } from '../../constants/leadFields';
import type { CoalesceResult, LeadCandidate } from '../../lib/csv';
import { comparableField } from '../../lib/leadSync';
import LockIcon from '../common/LockIcon';

interface ImportDiffProps {
  parseSummary: {
    totalRows: number;
  };
  coalesce: CoalesceResult;
  existingLeads: Lead[];
  onApply: (
    candidates: LeadCandidate[],
    existingByEmail: Map<string, Lead>,
  ) => void;
  onBack: () => void;
}

interface FieldDiff {
  field: (typeof EDITABLE_LEAD_FIELDS)[number];
  before: unknown;
  after: unknown;
  locked: boolean;
}

interface RowDiff {
  email: string;
  account?: string;
  changes: FieldDiff[];          // unlocked, will overwrite
  driftOnly: FieldDiff[];        // locked, source_sfdc only
}

function eqValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && (b === '' || b === undefined || b === null)) return true;
  if (b == null && (a === '' || a === undefined || a === null)) return true;
  return String(a ?? '') === String(b ?? '');
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  return String(v);
}

export default function ImportDiff({
  parseSummary,
  coalesce,
  existingLeads,
  onApply,
  onBack,
}: ImportDiffProps) {
  const [showAll, setShowAll] = useState(false);

  const existingByEmail = useMemo(() => {
    const m = new Map<string, Lead>();
    for (const l of existingLeads) m.set(l.email.toLowerCase(), l);
    return m;
  }, [existingLeads]);

  const buckets = useMemo(() => {
    const newLeads: LeadCandidate[] = [];
    const changed: RowDiff[] = [];
    const driftOnly: RowDiff[] = [];
    let unchanged = 0;

    for (const cand of coalesce.candidates) {
      const existing = existingByEmail.get(cand.email);
      if (!existing) {
        newLeads.push(cand);
        continue;
      }
      const changes: FieldDiff[] = [];
      const drift: FieldDiff[] = [];
      for (const field of EDITABLE_LEAD_FIELDS) {
        const incoming = comparableField(cand, field);
        if (incoming === undefined) continue;
        const before = comparableField(existing, field);
        if (eqValue(before, incoming)) continue;
        const locked = Boolean(existing.field_locks?.[field]);
        const diff: FieldDiff = { field, before, after: incoming, locked };
        if (locked) drift.push(diff);
        else changes.push(diff);
      }
      const row: RowDiff = {
        email: cand.email,
        account: cand.account,
        changes,
        driftOnly: drift,
      };
      if (changes.length === 0 && drift.length === 0) {
        unchanged += 1;
      } else if (changes.length === 0) {
        driftOnly.push(row);
      } else {
        changed.push(row);
      }
    }

    return { newLeads, changed, driftOnly, unchanged };
  }, [coalesce.candidates, existingByEmail]);

  const changedShown = showAll ? buckets.changed : buckets.changed.slice(0, 50);
  const driftShown = showAll
    ? buckets.driftOnly
    : buckets.driftOnly.slice(0, 50);
  const totalChangesToWrite = buckets.newLeads.length + buckets.changed.length;

  return (
    <div className="space-y-4">
      <div className="border border-border rounded-lg bg-bg p-4 space-y-2">
        <h2 className="text-base font-semibold text-charcoal">Diff</h2>
        <p className="text-sm text-slate-muted">
          {coalesce.candidates.length} leads from CSV. {parseSummary.totalRows}{' '}
          rows. {coalesce.duplicatesCollapsed} duplicates collapsed.{' '}
          {coalesce.rowsSkipped} skipped (no email).
        </p>
        <ul className="text-sm text-charcoal space-y-1">
          <li>
            <span className="font-medium">{buckets.newLeads.length}</span> new
            leads
          </li>
          <li>
            <span className="font-medium">{buckets.changed.length}</span>{' '}
            changed leads (some fields)
          </li>
          <li>
            <span className="font-medium">{buckets.driftOnly.length}</span>{' '}
            drift only (locked fields, source_sfdc updates only)
          </li>
          <li>
            <span className="font-medium">{buckets.unchanged}</span> unchanged
          </li>
        </ul>
        {coalesce.parseWarnings.length > 0 && (
          <details className="text-xs text-slate-muted">
            <summary className="cursor-pointer">
              {coalesce.parseWarnings.length} parse warning(s)
            </summary>
            <ul className="mt-1 space-y-0.5 list-disc list-inside">
              {coalesce.parseWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      {buckets.changed.length > 0 && (
        <section className="border border-border rounded-lg bg-bg p-4 space-y-2">
          <h3 className="text-sm font-semibold text-charcoal">
            Changed leads ({buckets.changed.length})
          </h3>
          <ul className="space-y-3">
            {changedShown.map((r) => (
              <li key={r.email} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
                <div className="text-sm text-charcoal">
                  {r.email}
                  {r.account && (
                    <span className="text-slate-muted"> ({r.account})</span>
                  )}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {r.changes.map((d) => (
                    <li
                      key={d.field}
                      className="text-xs text-charcoal flex gap-2"
                    >
                      <span className="text-slate-muted w-32 flex-shrink-0">
                        {LEAD_FIELD_LABELS[d.field]}
                      </span>
                      <span className="text-slate-muted">{fmt(d.before)}</span>
                      <span className="text-slate-muted">→</span>
                      <span>{fmt(d.after)}</span>
                    </li>
                  ))}
                  {r.driftOnly.map((d) => (
                    <li
                      key={d.field}
                      className="text-xs text-slate-muted flex gap-2 italic"
                    >
                      <span className="w-32 flex-shrink-0 inline-flex items-center gap-1">
                        <LockIcon locked className="w-3 h-3" />
                        {LEAD_FIELD_LABELS[d.field]}
                      </span>
                      <span>{fmt(d.before)}</span>
                      <span>→</span>
                      <span>{fmt(d.after)}</span>
                      <span className="ml-1">drift only, source_sfdc updated</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {buckets.driftOnly.length > 0 && (
        <section className="border border-border rounded-lg bg-bg p-4 space-y-2">
          <h3 className="text-sm font-semibold text-charcoal flex items-center gap-2">
            <LockIcon locked className="w-3.5 h-3.5" />
            Drift only ({buckets.driftOnly.length})
          </h3>
          <p className="text-xs text-slate-muted">
            These leads have only locked-field changes. Their visible columns
            are preserved; source_sfdc is updated so you can see drift in the
            lead drawer.
          </p>
          <ul className="space-y-3">
            {driftShown.map((r) => (
              <li
                key={r.email}
                className="border-t border-border pt-2 first:border-t-0 first:pt-0"
              >
                <div className="text-sm text-charcoal">{r.email}</div>
                <ul className="mt-1 space-y-0.5">
                  {r.driftOnly.map((d) => (
                    <li
                      key={d.field}
                      className="text-xs text-slate-muted flex gap-2 italic"
                    >
                      <span className="w-32 flex-shrink-0">
                        {LEAD_FIELD_LABELS[d.field]}
                      </span>
                      <span>{fmt(d.before)}</span>
                      <span>→</span>
                      <span>{fmt(d.after)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!showAll &&
        (buckets.changed.length > 50 || buckets.driftOnly.length > 50) && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-sm text-indigo hover:underline"
          >
            Show all changed and drift rows
          </button>
        )}

      <div className="flex items-center gap-2 sticky bottom-0 bg-bg/80 backdrop-blur py-3">
        <button
          type="button"
          onClick={onBack}
          className="text-sm px-3 py-1.5 rounded text-slate-muted hover:text-charcoal"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => onApply(coalesce.candidates, existingByEmail)}
          disabled={totalChangesToWrite === 0}
          className="text-sm px-3 py-1.5 rounded bg-indigo text-white disabled:opacity-40"
        >
          Apply ({totalChangesToWrite} writes, {buckets.driftOnly.length} drift)
        </button>
      </div>
    </div>
  );
}
