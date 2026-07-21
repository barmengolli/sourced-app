// Shared segmented control: one choice from a short fixed set (CLAUDE.md
// section 5). Joined rounded rectangle, 32px tall, 6px radius, keyboard
// operable via a radio-group pattern.
//
// Controlled: the parent owns `value` and receives `onChange`. Selection is
// understandable without color because the selected option carries
// aria-checked and a visible active style plus an accessible name; screen
// readers announce the radio-group selection independent of color.

import { useId, useRef } from 'react';
import { optionClasses } from './controlStyles';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  // Optional accessible explanation, e.g. for a disabled segment.
  title?: string;
}

interface SegmentedControlProps<T extends string> {
  label: string; // accessible group name (visible label rendered by caller or here)
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  // When false, the visible label is not rendered but is still exposed to AT.
  showLabel?: boolean;
}

export default function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  showLabel = true,
}: SegmentedControlProps<T>) {
  const groupId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const enabledIndexes = options
    .map((o, i) => (o.disabled ? -1 : i))
    .filter((i) => i >= 0);

  function focusIndex(i: number) {
    const el = refs.current[i];
    if (el) el.focus();
  }

  function moveTo(nextEnabledPos: number) {
    if (enabledIndexes.length === 0) return;
    const wrapped =
      (nextEnabledPos + enabledIndexes.length) % enabledIndexes.length;
    const target = enabledIndexes[wrapped];
    onChange(options[target].value);
    focusIndex(target);
  }

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const posInEnabled = enabledIndexes.indexOf(index);
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        moveTo(posInEnabled + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        moveTo(posInEnabled - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveTo(0);
        break;
      case 'End':
        e.preventDefault();
        moveTo(enabledIndexes.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div className="inline-flex flex-col gap-1">
      {showLabel && (
        <span id={`${groupId}-label`} className="text-xs font-medium text-slate-muted">
          {label}
        </span>
      )}
      <div
        role="radiogroup"
        aria-label={showLabel ? undefined : label}
        aria-labelledby={showLabel ? `${groupId}-label` : undefined}
        className="inline-flex -space-x-px"
      >
        {options.map((opt, i) => {
          const active = opt.value === value;
          const disabled = Boolean(opt.disabled);
          return (
            <button
              key={opt.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={opt.label}
              title={opt.title}
              disabled={disabled}
              // Roving tabindex: only the selected (or first enabled) segment is
              // tabbable; arrows move within the group.
              tabIndex={active ? 0 : -1}
              onClick={() => !disabled && onChange(opt.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={[
                optionClasses({ active, disabled, pill: false }),
                // Join the segments: square the inner edges so they read as one
                // control, keep the outer corners rounded.
                i === 0 ? '' : 'rounded-l-none',
                i === options.length - 1 ? '' : 'rounded-r-none',
              ].join(' ')}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
