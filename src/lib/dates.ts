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

// ISO 8601 week number. Week 1 is the week containing Jan 4 (equivalently, the
// first week with a Thursday in it). Weeks run Mon→Sun. Returned year is the
// ISO week-numbering year, which can differ from the calendar year for the
// last few days of December or first few days of January.
export interface IsoWeek {
  year: number;       // ISO week-numbering year
  week: number;       // 1..53
}

function parseLocalYmd(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d);
}

export function isoWeekOf(iso: string | null | undefined): IsoWeek | null {
  if (!iso) return null;
  const d = parseLocalYmd(iso);
  if (!d) return null;
  return isoWeekOfDate(d);
}

function isoWeekOfDate(date: Date): IsoWeek {
  // Copy as UTC so the math is timezone-independent.
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Shift to nearest Thursday: ISO weeks are numbered by their Thursday.
  const day = target.getUTCDay() || 7; // Sun=0 → 7
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const isoYear = target.getUTCFullYear();
  // Start of ISO year = Jan 4's week's Monday.
  const yearStart = new Date(Date.UTC(isoYear, 0, 4));
  const week = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return { year: isoYear, week };
}

// Monday of the given ISO week (UTC midnight).
export function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const out = new Date(week1Mon);
  out.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  return out;
}

// All ISO weeks whose Monday-Sunday span overlaps the given calendar quarter.
// A week is included when its Thursday (the canonical day) falls inside the
// quarter, which matches how reporting systems usually attribute weeks. So
// W14 may belong to either Q1 or Q2 depending on whether its Thursday lands
// in March or April.
export function weeksInQuarter(
  year: number,
  quarter: PeriodIndex,
): IsoWeek[] {
  const startMonth = (quarter - 1) * 3;       // Q1=0, Q2=3, Q3=6, Q4=9
  const qStart = new Date(Date.UTC(year, startMonth, 1));
  const qEndExclusive = new Date(Date.UTC(year, startMonth + 3, 1));
  const out: IsoWeek[] = [];
  const seen = new Set<string>();
  // Walk day-by-day, capture each week whose Thursday is inside the quarter.
  for (let d = new Date(qStart); d < qEndExclusive; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = isoWeekOfDate(d);
    const day = d.getUTCDay() || 7;
    if (day !== 4) continue; // only count via Thursdays
    const key = `${w.year}-W${w.week}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

export function currentIsoWeek(): IsoWeek {
  return isoWeekOfDate(new Date());
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
