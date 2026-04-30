import type { PeriodIndex } from '../types/db';

export function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Local-date parse of YYYY-MM-DD. Avoids the `new Date(iso)` UTC pitfall
// where an ISO date with no time component lands one day off in negative
// timezones (e.g. '2026-04-01' in UTC-5 becomes 2026-03-31 → wrong quarter).
export function quarterOfIsoDate(
  iso: string | null | undefined,
): { year: number; quarter: PeriodIndex } | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;
  const quarter = (Math.floor((month - 1) / 3) + 1) as PeriodIndex;
  return { year, quarter };
}

export function currentQuarter(): { year: number; quarter: PeriodIndex } {
  const d = new Date();
  return {
    year: d.getFullYear(),
    quarter: (Math.floor(d.getMonth() / 3) + 1) as PeriodIndex,
  };
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' at ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  );
}
