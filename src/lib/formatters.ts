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
