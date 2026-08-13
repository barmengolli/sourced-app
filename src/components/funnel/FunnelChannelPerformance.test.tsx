// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComputedRow } from '../../lib/compute';
import type { Channel } from '../../types/db';
import FunnelChannelPerformance from './FunnelChannelPerformance';

afterEach(cleanup);

const cells = (lead: number, mql: number): ComputedRow['cells'] => ({
  lead: { actual: lead, projection: null },
  mql: { actual: mql, projection: null },
  hpp: { actual: 0, projection: null },
  opp: { actual: 0, projection: null },
  pursuit: { actual: 0, projection: null },
  closeWon: { actual: 0, projection: null },
  closeLost: { actual: 0, projection: null },
});

const channels: Channel[] = [
  { id: 'parent-a', name: '2026 - Events', parent_channel_id: null, year: 2026, display_order: 1, hidden: false, created_at: '' },
  { id: 'child-a', name: '2026 - Event A', parent_channel_id: 'parent-a', year: 2026, display_order: 2, hidden: false, created_at: '' },
  { id: 'parent-b', name: '2026 - Website', parent_channel_id: null, year: 2026, display_order: 3, hidden: false, created_at: '' },
];

const rows: ComputedRow[] = [
  { channelId: 'parent-b', hasChildren: false, parentId: null, depth: 1, ancestors: [], cells: cells(10, 4) },
  { channelId: 'parent-a', hasChildren: true, parentId: null, depth: 1, ancestors: [], cells: cells(50, 20) },
  { channelId: 'child-a', hasChildren: false, parentId: 'parent-a', depth: 2, ancestors: ['parent-a'], cells: cells(50, 20) },
];

describe('FunnelChannelPerformance', () => {
  it('shows parent channels only and ranks them by supplied Lead volume', () => {
    render(<FunnelChannelPerformance rows={rows} channels={channels} />);

    const names = screen.getAllByRole('rowheader').map((node) => node.textContent);
    expect(names).toEqual(['2026 - Events', '2026 - Website']);
    expect(screen.queryByText('2026 - Event A')).toBeNull();
  });
});
