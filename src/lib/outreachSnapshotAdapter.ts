// Typed adapter from the database OutreachSnapshot rows to the Bite 3A
// OutreachReportingRow calculation input (Bite 3B).
//
// The n8n ingest coerces missing numerics to 0 (parseInt(value) || 0), erasing
// the missing-vs-zero distinction the calculation contract requires. This
// adapter restores ONLY the verified source coverage gaps documented in
// docs/outreach-n8n-mapping.md:
//
//   - linkedin_tasks_completed was NOT measured on the 2026-07-16 and
//     2026-07-23 exports (the Sheet shows blanks; Supabase stores 0s). Those
//     two dates' values are normalized to null (missing).
//
// TEMPORARY SOURCE-NORMALIZATION EXCEPTION: this date list is a stopgap until
// the n8n workflow preserves nulls end-to-end. It deliberately does NOT treat
// arbitrary zeros as missing and does NOT blanket future dates; only the
// verified gap dates are converted. When the workflow is fixed (or new gap
// dates are verified), update LINKEDIN_TASKS_MISSING_DATES alongside the
// mapping doc.

import type { OutreachSnapshot } from '../types/db';
import type { OutreachReportingRow, ActivityCounter } from './outreachReporting';

// Verified export dates where linkedin_tasks_completed was not measured at the
// source (stored 0s are coercion artifacts, not measured zeros).
export const LINKEDIN_TASKS_MISSING_DATES: ReadonlySet<string> = new Set([
  '2026-07-16',
  '2026-07-23',
]);

// Map one snapshot to a reporting row. All approved cumulative and conditional
// counters are carried over as measured numbers except the verified gaps,
// which become null (missing). Identity fields pass through unchanged.
export function toOutreachReportingRow(s: OutreachSnapshot): OutreachReportingRow {
  const linkedinMissing = LINKEDIN_TASKS_MISSING_DATES.has(s.export_date);
  const counters: Partial<Record<ActivityCounter, number | null>> = {
    total_sent: s.total_sent,
    delivered: s.delivered,
    bounced: s.bounced,
    failed: s.failed,
    opened: s.opened,
    clicked: s.clicked,
    replied: s.replied,
    positive_replies: s.positive_replies,
    neutral_replies: s.neutral_replies,
    negative_replies: s.negative_replies,
    opted_out: s.opted_out,
    outbound_calls: s.outbound_calls,
    linkedin_tasks_completed: linkedinMissing ? null : s.linkedin_tasks_completed,
  };
  return {
    export_date: s.export_date,
    sequence_id: s.sequence_id,
    sequence_name: s.sequence_name,
    created_at: s.created_at,
    enabled: s.enabled,
    counters,
  };
}

export function toOutreachReportingRows(
  snapshots: readonly OutreachSnapshot[],
): OutreachReportingRow[] {
  return snapshots.map(toOutreachReportingRow);
}
