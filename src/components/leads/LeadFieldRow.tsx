import { useEffect, useRef, useState } from 'react';
import type { Channel, Lead, StageKey } from '../../types/db';
import {
  type EditableLeadField,
  LEAD_FIELD_KIND,
  LEAD_FIELD_LABELS,
} from '../../constants/leadFields';
import { STAGE_LABELS, STAGE_ORDER } from '../../constants/stages';
import {
  REGIONS,
  REGION_LABELS,
  type RegionKey,
} from '../../constants/regions';
import { formatDateTime } from '../../lib/dates';
import LockIcon from '../common/LockIcon';

interface LeadFieldRowProps {
  lead: Lead;
  field: EditableLeadField;
  channels: Channel[];
  onCommit: (value: unknown) => Promise<void>;
  onToggleLock: (locked: boolean) => Promise<void>;
  onRevert: () => Promise<void>;
}

function valueToInputString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function sfdcDisplay(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)';
  return String(v);
}

export default function LeadFieldRow({
  lead,
  field,
  channels,
  onCommit,
  onToggleLock,
  onRevert,
}: LeadFieldRowProps) {
  const kind = LEAD_FIELD_KIND[field];
  const label = LEAD_FIELD_LABELS[field];
  const locked = Boolean(lead.field_locks?.[field]);
  const hasSfdc = field in (lead.source_sfdc ?? {});
  const sfdcValue = lead.source_sfdc?.[field];

  const rawValue = lead[field as keyof Lead] as unknown;
  const [inputValue, setInputValue] = useState<string>(valueToInputString(rawValue));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialOnFocusRef = useRef<string>('');

  // Keep local input in sync with realtime updates while not actively editing.
  useEffect(() => {
    if (!editing) setInputValue(valueToInputString(rawValue));
  }, [rawValue, editing]);

  const commit = async (next: unknown) => {
    setError(null);
    try {
      await onCommit(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      // Revert local input to current store value on failure.
      setInputValue(valueToInputString(rawValue));
    } finally {
      setEditing(false);
    }
  };

  const handleTextBlur = () => {
    if (!editing) return;
    const trimmed = inputValue.trim();
    const next = trimmed === '' ? null : trimmed;
    if (next === (rawValue ?? null)) {
      setEditing(false);
      return;
    }
    void commit(next);
  };

  const handleTextKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (e.key === 'Escape') {
      setInputValue(initialOnFocusRef.current);
      setEditing(false);
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && kind !== 'longText') {
      e.preventDefault();
      e.currentTarget.blur();
    }
  };

  const startTextEdit = (
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    initialOnFocusRef.current = e.currentTarget.value;
    setEditing(true);
  };

  const renderEditor = () => {
    if (kind === 'stage') {
      return (
        <select
          value={(rawValue as StageKey | null) ?? 'lead'}
          onChange={(e) => void commit(e.target.value as StageKey)}
          className="w-full text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
        >
          {STAGE_ORDER.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
      );
    }
    if (kind === 'channel') {
      // Hidden channels are filtered out, but the lead's current channel is
      // always shown even if hidden — otherwise the dropdown would silently
      // drop the row's own value.
      const currentId = (rawValue as string | null) ?? '';
      const visible = channels.filter(
        (c) => !c.hidden || c.id === currentId,
      );
      return (
        <select
          value={currentId}
          onChange={(e) => void commit(e.target.value || null)}
          className="w-full text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
        >
          <option value="">(none)</option>
          {visible.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      );
    }
    if (kind === 'region') {
      // Region is independent from country: editing country does NOT auto-
      // update region. Users can revert region to SFDC if they want to
      // re-derive from the imported country (which sets it via
      // regionForCountry at import time).
      const currentRegion = (rawValue as RegionKey | null) ?? '';
      return (
        <select
          value={currentRegion}
          onChange={(e) =>
            void commit((e.target.value as RegionKey) || null)
          }
          className="w-full text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
        >
          <option value="">(none)</option>
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {r} — {REGION_LABELS[r]}
            </option>
          ))}
        </select>
      );
    }
    if (kind === 'date') {
      return (
        <input
          type="date"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onFocus={startTextEdit}
          onBlur={() => {
            if (!editing) return;
            const next = inputValue || null;
            if (next === (rawValue ?? null)) {
              setEditing(false);
              return;
            }
            void commit(next);
          }}
          onKeyDown={handleTextKeyDown}
          className="w-full text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
        />
      );
    }
    if (kind === 'longText') {
      return (
        <textarea
          value={inputValue}
          rows={3}
          onChange={(e) => setInputValue(e.target.value)}
          onFocus={startTextEdit}
          onBlur={handleTextBlur}
          onKeyDown={handleTextKeyDown}
          className="w-full text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
        />
      );
    }
    return (
      <input
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onFocus={startTextEdit}
        onBlur={handleTextBlur}
        onKeyDown={handleTextKeyDown}
        className="w-full text-sm px-2 py-1 border border-border rounded bg-bg text-charcoal focus:outline-none focus:ring-2 focus:ring-indigo focus:border-indigo"
      />
    );
  };

  const editor = lead.last_edited_by ?? 'someone';
  const when = formatDateTime(lead.updated_at);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="text-xs font-medium text-slate-muted flex-1">
          {label}
        </label>
        <button
          type="button"
          onClick={() => void onToggleLock(!locked)}
          title={locked ? 'Locked. Click to unlock.' : 'Click to lock this field.'}
          className={
            'inline-flex items-center justify-center w-6 h-6 rounded border ' +
            (locked
              ? 'bg-indigo/10 border-indigo text-indigo'
              : 'border-border text-slate-muted hover:text-charcoal')
          }
        >
          <LockIcon locked={locked} className="w-3.5 h-3.5" />
        </button>
      </div>
      {renderEditor()}
      {locked && (
        <div className="text-xs text-slate-muted flex flex-wrap items-center gap-2">
          <span>
            SFDC: {hasSfdc ? sfdcDisplay(sfdcValue) : 'no value on record'}
          </span>
          <span>·</span>
          <span>
            edited by {editor}
            {when ? ` on ${when}` : ''}
          </span>
          <button
            type="button"
            onClick={() => void onRevert()}
            disabled={!hasSfdc}
            className="ml-auto text-indigo hover:underline disabled:opacity-40 disabled:no-underline"
          >
            Revert to SFDC
          </button>
        </div>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
