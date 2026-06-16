// 6sense "Activities By Source" summary parsing + derived metrics.
//
// EIS has no 6sense API, so the summary view is exported as a flat
// `Metric,Accounts` CSV and imported in-app. This module maps those rows to
// the sixsense_snapshots column shape and exposes the reach / engagement /
// intent percentage helpers the MOps lead currently computes by hand.
//
// The account-level reach/engagement CSVs are intentionally NOT handled here
// (v1 stores summary KPIs only).

import type { SixSenseSnapshot } from '../types/db';
import { isoWeekOf } from './dates';

// Counts written on import. Excludes server-managed columns (id, created_at)
// and `source` (defaulted by the importer). snapshot_date / year / week_number
// are derived from the user-chosen window end via toSnapshotInput.
export type SixSenseCounts = Omit<
  SixSenseSnapshot,
  | 'id'
  | 'created_at'
  | 'source'
  | 'segment'
  | 'snapshot_date'
  | 'window_start'
  | 'window_end'
  | 'year'
  | 'week_number'
>;

// Full row passed to the upsert. (snapshot_date, segment) is the natural key.
export interface SixSenseSnapshotInput extends SixSenseCounts {
  snapshot_date: string;
  segment: string;
  window_start: string | null;
  window_end: string | null;
  year: number;
  week_number: number;
  source?: string;
}

// Exact 6sense metric labels -> column. The summary lists Reach and
// Engagement breakdowns with distinct suffixes ("CRM / MAP Campaigns Reached"
// vs "... Engaged"), so exact-label matching keeps the two grids separate.
// Keys are trimmed and collapsed-whitespace before lookup (see normalizeLabel).
const METRIC_TO_FIELD: Record<string, keyof SixSenseCounts> = {
  'Total Accounts': 'total_accounts',
  'Accounts with Activity': 'accounts_with_activity',
  'No Activity': 'no_activity',
  Reach: 'reach',
  Intent: 'intent',
  Engagement: 'engagement',
  // Reach breakdown
  'CRM / MAP Campaigns Reached': 'crm_map_campaigns_reached',
  'Sales Reached': 'sales_reached',
  '6sense Campaigns Reached': 'sixsense_campaigns_reached',
  'External Campaigns Reached': 'external_campaigns_reached',
  'Linkedin Campaigns Reached': 'linkedin_campaigns_reached',
  'A.I. Emails Reached': 'ai_emails_reached',
  // Intent breakdown
  '6sense Keyword Research': 'sixsense_keyword_research',
  'Bombora Topics': 'bombora_topics',
  'G2 Intent': 'g2_intent',
  'TrustRadius Intent': 'trustradius_intent',
  // Engagement breakdown
  'Anonymous Web Engaged': 'anonymous_web_engaged',
  'Known Web Engaged': 'known_web_engaged',
  'CRM / MAP Campaigns Engaged': 'crm_map_campaigns_engaged',
  'Sales Engaged': 'sales_engaged',
  '6sense Campaigns Engaged': 'sixsense_campaigns_engaged',
  'External Campaigns Engaged': 'external_campaigns_engaged',
  'Linkedin Campaigns Engaged': 'linkedin_campaigns_engaged',
  'Attended Webinars': 'attended_webinars',
  'Attended Trade Shows': 'attended_trade_shows',
  'Attended Field Events': 'attended_field_events',
  'A.I. Emails Engaged': 'ai_emails_engaged',
};

// Fields 6sense leaves as "--" when not licensed; these stay null rather than
// coercing to 0 so the dashboard can render a blank instead of a real zero.
const NULLABLE_FIELDS: ReadonlySet<keyof SixSenseCounts> = new Set([
  'g2_intent',
  'trustradius_intent',
]);

function normalizeLabel(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// "--", "", "N/A" -> null; "1,172" -> 1172; otherwise null on non-numeric.
function parseCount(raw: string | undefined): number | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (v === '' || v === '--' || v === '-' || /^n\/?a$/i.test(v)) return null;
  const n = Number(v.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export interface ParsedActivities {
  counts: SixSenseCounts;
  // Labels present in the CSV that we didn't recognize. Surfaced in the
  // import preview so an unexpected 6sense relabel is visible, not silent.
  unknownMetrics: string[];
}

// Map the flat `Metric,Accounts` rows to the counts shape. Tolerant of the
// header column being named anything (we read the metric label from the first
// column and the value from a column named "Accounts" or the second column).
export function parseActivitiesBySource(
  rows: Record<string, string>[],
  headers: string[],
): ParsedActivities {
  const metricKey = headers[0] ?? 'Metric';
  const valueKey =
    headers.find((h) => normalizeLabel(h).toLowerCase() === 'accounts') ??
    headers[1] ??
    'Accounts';

  // Start every non-nullable count at 0, nullable ones at null.
  const counts = {} as SixSenseCounts;
  for (const field of Object.values(METRIC_TO_FIELD)) {
    counts[field] = (NULLABLE_FIELDS.has(field) ? null : 0) as never;
  }

  const unknownMetrics: string[] = [];
  for (const row of rows) {
    const label = normalizeLabel(row[metricKey] ?? '');
    if (!label) continue;
    const field = METRIC_TO_FIELD[label];
    if (!field) {
      unknownMetrics.push(label);
      continue;
    }
    const value = parseCount(row[valueKey]);
    counts[field] = (NULLABLE_FIELDS.has(field) ? value : value ?? 0) as never;
  }

  return { counts, unknownMetrics };
}

// Assemble the full upsert row from parsed counts + a chosen window end date.
// year / week_number come from the ISO week of snapshotDate.
export function toSnapshotInput(
  counts: SixSenseCounts,
  opts: {
    snapshotDate: string;
    segment: string;
    windowStart?: string | null;
    windowEnd?: string | null;
    source?: string;
  },
): SixSenseSnapshotInput {
  const iso = isoWeekOf(opts.snapshotDate);
  return {
    ...counts,
    snapshot_date: opts.snapshotDate,
    segment: opts.segment,
    window_start: opts.windowStart ?? null,
    window_end: opts.windowEnd ?? opts.snapshotDate,
    year: iso?.year ?? new Date(opts.snapshotDate).getFullYear(),
    week_number: iso?.week ?? 0,
    source: opts.source ?? 'csv-import',
  };
}

// Percentage of total target accounts. Guards divide-by-zero (returns 0).
// Matches the manual math: reach / total, engagement / total, intent / total.
function pctOfTotal(count: number, total: number): number {
  if (!total) return 0;
  return (count / total) * 100;
}

export function reachPct(s: Pick<SixSenseSnapshot, 'reach' | 'total_accounts'>): number {
  return pctOfTotal(s.reach, s.total_accounts);
}
export function engagementPct(
  s: Pick<SixSenseSnapshot, 'engagement' | 'total_accounts'>,
): number {
  return pctOfTotal(s.engagement, s.total_accounts);
}
export function intentPct(s: Pick<SixSenseSnapshot, 'intent' | 'total_accounts'>): number {
  return pctOfTotal(s.intent, s.total_accounts);
}
export function activityPct(
  s: Pick<SixSenseSnapshot, 'accounts_with_activity' | 'total_accounts'>,
): number {
  return pctOfTotal(s.accounts_with_activity, s.total_accounts);
}
