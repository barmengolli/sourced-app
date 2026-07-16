// Coloring helpers ported from DataVis 1's utils/formatters.ts (lines 16-26),
// with text-gray-400 swapped to text-slate-400 to match Sourced's palette.
//
// Both functions take the RAW DECIMAL (e.g. 0.46 for 46%), not the
// formatted percent string, so callers must divide by 100 if they're
// already holding a 0-100 percent value.

export function getOTColor(value: number | null): string {
  if (value === null) return 'text-slate-400';
  if (value >= 1) return 'text-green-600';
  if (value >= 0.75) return 'text-yellow-600';
  return 'text-red-500';
}

export function getFEColor(value: number | null): string {
  if (value === null) return 'text-slate-400';
  return 'text-blue-600';
}

// USD, no decimals: "$1,234". The single source of truth for full-precision
// currency across the app (previously four local fmtMoney copies with divergent
// null handling). `nullDisplay` sets what a null/undefined amount renders as, so
// each former call site keeps its exact output:
//   - '' (Opportunities modal), '—' (Velocity), and non-null-only (BudgetEditor,
//     which passes a plain number and never a null).
export function formatCurrency(
  value: number | null | undefined,
  options?: { nullDisplay?: string },
): string {
  if (value === null || value === undefined) return options?.nullDisplay ?? '';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

// Compact currency for dense tiles: "$1.2M", "$3K", "$450". Matches the former
// CampaignsOverview fmtMoney exactly (1 decimal at millions, rounded K, plain
// dollars below 1000). Not null-safe by design: its call sites always pass a
// number.
export function formatCompactCurrency(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}
