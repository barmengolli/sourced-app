// Deterministic tests for the OutreachSnapshot -> OutreachReportingRow
// adapter. Synthetic rows only.

import { describe, it, expect } from 'vitest';
import type { OutreachSnapshot } from '../types/db';
import { toOutreachReportingRow, toOutreachReportingRows, LINKEDIN_TASKS_MISSING_DATES } from './outreachSnapshotAdapter';
import { dedupeSnapshots, filterDedupedSeries } from './outreachReporting';

let idc = 0;
function snap(over: Partial<OutreachSnapshot> = {}): OutreachSnapshot {
  idc += 1;
  return {
    id: `s${idc}`,
    export_date: '2026-07-09',
    week_number: 28,
    year: 2026,
    sequence_id: 1,
    sequence_name: 'Seq 1 [2026]',
    enabled: true,
    step_count: 5,
    duration_days: 30,
    total_sent: 100,
    delivered: 95,
    bounced: 3,
    failed: 2,
    opened: 40,
    clicked: 10,
    replied: 5,
    positive_replies: 2,
    neutral_replies: 2,
    negative_replies: 1,
    opted_out: 1,
    delivery_rate: 0,
    open_rate: 0,
    click_rate: 0,
    reply_rate: 0,
    bounce_rate: 0,
    opt_out_rate: 0,
    contacted_prospects: 50,
    replied_prospects: 5,
    prospects_added: 60,
    prospects_active: 20,
    total_tasks: 80,
    overdue_tasks: 4,
    outbound_calls: 12,
    linkedin_tasks_completed: 7,
    created_at: '2026-07-09T08:00:00Z',
    ...over,
  };
}

describe('toOutreachReportingRow', () => {
  it('maps all approved counters and preserves identity fields', () => {
    const r = toOutreachReportingRow(snap());
    expect(r.export_date).toBe('2026-07-09');
    expect(r.sequence_id).toBe(1);
    expect(r.sequence_name).toBe('Seq 1 [2026]');
    expect(r.created_at).toBe('2026-07-09T08:00:00Z');
    expect(r.counters.total_sent).toBe(100);
    expect(r.counters.delivered).toBe(95);
    expect(r.counters.opened).toBe(40);
    expect(r.counters.replied).toBe(5);
    expect(r.counters.outbound_calls).toBe(12);
    expect(r.counters.linkedin_tasks_completed).toBe(7);
  });

  it('keeps a measured zero as zero, not missing', () => {
    const r = toOutreachReportingRow(snap({ total_sent: 0, opened: 0 }));
    expect(r.counters.total_sent).toBe(0);
    expect(r.counters.opened).toBe(0);
  });

  it('nulls linkedin_tasks_completed ONLY on the verified gap dates', () => {
    for (const gap of LINKEDIN_TASKS_MISSING_DATES) {
      const r = toOutreachReportingRow(snap({ export_date: gap, linkedin_tasks_completed: 0 }));
      expect(r.counters.linkedin_tasks_completed).toBeNull();
      // Other metrics on the same row stay measured.
      expect(r.counters.total_sent).toBe(100);
    }
  });

  it('does not treat arbitrary zeros or other/future dates as missing', () => {
    // A zero on a non-gap date is a measured zero.
    const zeroDay = toOutreachReportingRow(snap({ export_date: '2026-07-09', linkedin_tasks_completed: 0 }));
    expect(zeroDay.counters.linkedin_tasks_completed).toBe(0);
    // A later date beyond the verified gaps is not blanket-nulled.
    const future = toOutreachReportingRow(snap({ export_date: '2026-07-30', linkedin_tasks_completed: 9 }));
    expect(future.counters.linkedin_tasks_completed).toBe(9);
  });

  it('does not expose the disallowed nonmonotonic fields as counters', () => {
    const r = toOutreachReportingRow(snap());
    const keys = Object.keys(r.counters);
    for (const banned of ['contacted_prospects', 'replied_prospects', 'prospects_added', 'total_tasks']) {
      expect(keys).not.toContain(banned);
    }
  });
});

describe('filterDedupedSeries preserves feed context', () => {
  it('keeps the feed-wide feedStart when a filter removes the earliest sequences', () => {
    const rows = toOutreachReportingRows([
      snap({ export_date: '2026-03-19', sequence_id: 1 }), // feed birth via seq 1
      snap({ export_date: '2026-07-09', sequence_id: 2 }),
    ]);
    const full = dedupeSnapshots(rows);
    expect(full.feedStart).toBe('2026-03-19');
    const onlySeq2 = filterDedupedSeries(full, new Set([2]));
    // feedStart must NOT shift to seq 2's first date (no false pre-feed exemption).
    expect(onlySeq2.feedStart).toBe('2026-03-19');
    expect(onlySeq2.bySequence.has(1)).toBe(false);
    expect(onlySeq2.bySequence.has(2)).toBe(true);
  });

  it('an empty keep-set means all sequences', () => {
    const rows = toOutreachReportingRows([snap({ sequence_id: 1 }), snap({ sequence_id: 2 })]);
    const full = dedupeSnapshots(rows);
    expect(filterDedupedSeries(full, new Set())).toBe(full);
  });
});
