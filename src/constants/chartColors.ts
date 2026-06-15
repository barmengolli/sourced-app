// Recharts SVG attrs don't reliably resolve CSS custom properties; using hex
// literals here mirrors the Tailwind theme in src/index.css. Keep these in
// sync if the brand palette ever shifts.
export const CHART_COLORS = {
  indigo: '#4F46E5',
  teal: '#06B6D4',
  charcoal: '#0F172A',
  slateMuted: '#64748B',
  border: '#E2E8F0',
  muted: '#F8FAFC',
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444',
} as const;

// Six-color rotation used by the donut, trend, and Sankey charts. Indigo and
// teal lead because they're the brand colors; the rest are tonally similar
// so the donut reads as one family rather than a clown wig.
export const CHART_PALETTE = [
  '#4F46E5', // indigo
  '#06B6D4', // teal
  '#10B981', // success/green
  '#F59E0B', // warning/amber
  '#8B5CF6', // violet
  '#64748B', // slate-muted
] as const;

// Lighten a hex color toward white. Used for prior-year series tints
// in YearLeadCharts (same hue family, visibly distinct).
export function tintColor(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const to2 = (c: number) => mix(c).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

// Stage gradient for the funnel chart: indigo at top descending into teal,
// six tonal stops to match the six funnel stages.
export const FUNNEL_STAGE_BARS = [
  '#4F46E5',
  '#5950E0',
  '#5E62D6',
  '#3486C9',
  '#1FA1C0',
  '#06B6D4',
] as const;
