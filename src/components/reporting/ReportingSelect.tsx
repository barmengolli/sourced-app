// Shared select: one choice from a longer or changing set (CLAUDE.md section
// 5). Native <select> so keyboard and screen-reader behavior are built in.
// 32px tall, 6px radius, matched to the segmented control. Controlled.

import { useId } from 'react';
import { CONTROL_BASE, RADIUS_CONTROL, FOCUS_RING, STATE_INACTIVE, STATE_DISABLED } from './controlStyles';

export interface ReportingSelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface ReportingSelectProps<T extends string> {
  label: string;
  options: ReadonlyArray<ReportingSelectOption<T>>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  showLabel?: boolean;
}

export default function ReportingSelect<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  showLabel = true,
}: ReportingSelectProps<T>) {
  const id = useId();
  return (
    <div className="inline-flex flex-col gap-1">
      {showLabel ? (
        <label htmlFor={id} className="text-xs font-medium text-slate-muted">
          {label}
        </label>
      ) : null}
      <select
        id={id}
        aria-label={showLabel ? undefined : label}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className={[
          CONTROL_BASE,
          RADIUS_CONTROL,
          FOCUS_RING,
          'px-3 pr-8',
          disabled ? STATE_DISABLED : STATE_INACTIVE,
        ].join(' ')}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
