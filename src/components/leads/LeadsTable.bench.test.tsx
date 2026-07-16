// @vitest-environment jsdom
//
// Step 12: synthetic performance MEASUREMENT for the unvirtualized Leads table.
// This is a measurement harness, not a passing/failing behavior test and not a
// change. It renders the real LeadsTable at several row counts and records
// render time and DOM node count. jsdom timings are relative (no real layout),
// but the DOM node count is exact and is the dominant cost driver for a real
// browser. Numbers are asserted loosely so the harness never flakes CI; the
// recorded output feeds docs/perf/leads-table-2026-07-16.md.

import { describe, it, expect } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import LeadsTable from './LeadsTable';
import { lead, channel } from '../../test/fixtures/factories';
import type { Lead } from '../../types/db';

function makeLeads(n: number): Lead[] {
  const out: Lead[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      lead({
        first_name: `First${i}`,
        last_name: `Last${i}`,
        account: `Account ${i % 200}`,
        current_stage: 'lead',
        country: 'United States',
        region: 'NA',
        owner: `Owner ${i % 20}`,
        source_channel_id: 'c1',
        marketing_sourced_date: '2026-02-15',
        field_locks: i % 5 === 0 ? { account: true } : {},
      }),
    );
  }
  return out;
}

const channels = [channel({ id: 'c1', name: 'Content Syndication' })];

function measure(n: number) {
  const leads = makeLeads(n);
  const t0 = performance.now();
  const { container } = render(
    <LeadsTable
      leads={leads}
      channels={channels}
      sortKey="name"
      sortDir="asc"
      onSortChange={() => {}}
      onRowClick={() => {}}
    />,
  );
  const renderMs = performance.now() - t0;
  const domNodes = container.querySelectorAll('*').length;
  const rows = container.querySelectorAll('tbody tr').length;
  cleanup();
  return { n, renderMs: Math.round(renderMs), domNodes, rows };
}

describe('LeadsTable render cost (measurement only)', () => {
  it('records render time and DOM node count at 100 / 500 / 2642 rows', () => {
    const sizes = [100, 500, 2642]; // 2642 = current production lead count
    const results = sizes.map(measure);
    console.log(
      '\n[LeadsTable perf] ' +
        results
          .map((r) => `${r.n} rows: ${r.renderMs}ms, ${r.domNodes} DOM nodes`)
          .join(' | '),
    );
    // Loose sanity only: each size renders a header row + N data rows.
    for (const r of results) {
      expect(r.domNodes).toBeGreaterThan(r.n); // at least one node per row
    }
    // DOM nodes scale ~linearly with rows (the unvirtualized cost).
    const perRow2642 = results[2].domNodes / results[2].n;
    expect(perRow2642).toBeGreaterThan(10); // ~10 cells + wrappers per row
  });
});
