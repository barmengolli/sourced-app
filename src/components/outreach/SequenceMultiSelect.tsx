// SequenceMultiSelect — ported from DataVis 1's
// components/outreach/SequenceMultiSelect.tsx, with the palette swapped to
// Sourced's tokens (border, indigo, charcoal, slate-muted) and the same
// "empty set ↔ all selected" convention: callers can treat either as
// "All Sequences" when filtering.

import { useEffect, useRef, useState } from 'react';

interface SequenceMultiSelectProps {
  sequences: { id: number; name: string }[];
  selectedIds: Set<number>;
  onChange: (ids: Set<number>) => void;
}

export default function SequenceMultiSelect({
  sequences,
  selectedIds,
  onChange,
}: SequenceMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const allSelected = selectedIds.size === sequences.length;
  const noneSelected = selectedIds.size === 0;
  const label =
    allSelected || noneSelected
      ? 'All Sequences'
      : selectedIds.size === 1
        ? sequences.find((s) => selectedIds.has(s.id))?.name || '1 selected'
        : `${selectedIds.size} selected`;

  const toggleAll = () => {
    if (allSelected) onChange(new Set());
    else onChange(new Set(sequences.map((s) => s.id)));
  };

  const toggle = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 border border-border rounded px-2.5 py-1 text-xs bg-bg hover:border-charcoal/30 focus:outline-none focus:ring-2 focus:ring-indigo/30 min-w-[160px] max-w-[280px]"
      >
        <span className="truncate text-charcoal">{label}</span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="w-3 h-3 text-slate-muted shrink-0"
        >
          <path
            fillRule="evenodd"
            d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 bg-bg border border-border rounded-lg shadow-lg py-1 w-72 max-h-64 overflow-y-auto">
          <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 cursor-pointer border-b border-border">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="rounded border-border text-indigo focus:ring-indigo/30"
            />
            <span className="text-xs font-medium text-charcoal">
              Select All
            </span>
          </label>
          {sequences.map((seq) => (
            <label
              key={seq.id}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-muted/40 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(seq.id)}
                onChange={() => toggle(seq.id)}
                className="rounded border-border text-indigo focus:ring-indigo/30"
              />
              <span className="text-xs text-charcoal truncate">
                {seq.name}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
