// Shared filter chip group: one or more category selections (CLAUDE.md section
// 5). Full-pill chips. Multi-select toggle model. Includes a neutral
// clear/reset control matching its neighbors. Controlled.
//
// Selection is understandable without color: each chip exposes aria-pressed and
// a visible active style; the accessible name plus pressed state convey
// selection to screen readers independent of color.

import { optionClasses, CONTROL_BASE, RADIUS_CONTROL, FOCUS_RING, STATE_INACTIVE } from './controlStyles';

export interface FilterChip<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface FilterChipGroupProps<T extends string> {
  label: string;
  chips: ReadonlyArray<FilterChip<T>>;
  selected: ReadonlyArray<T>;
  onToggle: (value: T) => void;
  onClear?: () => void;
  // Optional Clear/All toggle mode: when provided together with onClear, the
  // reset control switches between "Clear" (all chips selected -> clears via
  // onClear) and "All" (some deselected -> selects all via onSelectAll), so it
  // always has a visible effect. Without it, the original Clear-only behavior
  // is unchanged.
  onSelectAll?: () => void;
  showLabel?: boolean;
}

export default function FilterChipGroup<T extends string>({
  label,
  chips,
  selected,
  onToggle,
  onClear,
  onSelectAll,
  showLabel = true,
}: FilterChipGroupProps<T>) {
  const selectedSet = new Set(selected);
  const anySelected = selected.length > 0;
  const allSelected = chips.length > 0 && chips.every((c) => selectedSet.has(c.value));

  return (
    <div className="inline-flex flex-col gap-1">
      {showLabel ? (
        <span className="text-xs font-medium text-slate-muted">{label}</span>
      ) : null}
      <div
        className="flex flex-wrap items-center gap-1"
        role="group"
        aria-label={showLabel ? undefined : label}
      >
        {chips.map((chip) => {
          const active = selectedSet.has(chip.value);
          const disabled = Boolean(chip.disabled);
          return (
            <button
              key={chip.value}
              type="button"
              aria-pressed={active}
              aria-label={chip.label}
              disabled={disabled}
              onClick={() => !disabled && onToggle(chip.value)}
              className={optionClasses({ active, disabled, pill: true })}
            >
              {chip.label}
            </button>
          );
        })}
        {onClear && onSelectAll ? (
          // Clear/All toggle mode: always actionable.
          <button
            type="button"
            onClick={allSelected ? onClear : onSelectAll}
            aria-label={allSelected ? `Clear ${label}` : `Select all ${label}`}
            className={[CONTROL_BASE, RADIUS_CONTROL, FOCUS_RING, 'px-3', STATE_INACTIVE].join(' ')}
          >
            {allSelected ? 'Clear' : 'All'}
          </button>
        ) : onClear ? (
          <button
            type="button"
            onClick={onClear}
            disabled={!anySelected}
            aria-label={`Clear ${label}`}
            className={[
              CONTROL_BASE,
              RADIUS_CONTROL,
              FOCUS_RING,
              'px-3',
              STATE_INACTIVE,
              anySelected ? '' : 'opacity-50 cursor-not-allowed',
            ].join(' ')}
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
