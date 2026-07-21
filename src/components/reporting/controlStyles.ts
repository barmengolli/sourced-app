// One source of truth for reporting-control visual rules (CLAUDE.md section 5).
// Every reporting control imports these instead of hand-writing Tailwind, so
// height, radius, states, and focus stay identical across the app.
//
//   - 32px control height
//   - 6px radius for segmented controls and selects
//   - full-pill radius for category chips
//   - 12px medium text with tabular numerals
//   - inactive / hover / active / disabled / focus states with equal borders
//   - indigo focus ring with offset
//
// These are plain class strings (Tailwind v4 tokens defined in index.css). No
// component defines its own copy of these rules.

// Fixed 32px height, 12px medium text, tabular numerals, equal 1px border.
export const CONTROL_BASE =
  'inline-flex h-8 items-center justify-center border text-xs font-medium ' +
  'tabular-nums transition-colors select-none';

// 6px radius for segmented-control segments and selects.
export const RADIUS_CONTROL = 'rounded-md'; // Tailwind md == 6px

// Full pill for category filter chips only.
export const RADIUS_PILL = 'rounded-full';

// Visible indigo focus ring with offset. Applied to every interactive control.
export const FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo ' +
  'focus-visible:ring-offset-1';

// Inactive: white background, border token, charcoal text.
export const STATE_INACTIVE =
  'bg-bg border-border text-charcoal hover:border-slate-muted';

// Active: indigo background and border, white text.
export const STATE_ACTIVE = 'bg-indigo border-indigo text-white';

// Disabled: muted background and text. Callers must also supply an accessible
// explanation (title / aria-describedby) alongside this class.
export const STATE_DISABLED =
  'bg-muted border-border text-slate-muted cursor-not-allowed opacity-70';

// Compose the class string for a single-select option (segment or chip).
export function optionClasses(opts: {
  active: boolean;
  disabled: boolean;
  pill?: boolean;
}): string {
  const radius = opts.pill ? RADIUS_PILL : RADIUS_CONTROL;
  const state = opts.disabled
    ? STATE_DISABLED
    : opts.active
      ? STATE_ACTIVE
      : STATE_INACTIVE;
  return [CONTROL_BASE, radius, FOCUS_RING, 'px-3', state].join(' ');
}
