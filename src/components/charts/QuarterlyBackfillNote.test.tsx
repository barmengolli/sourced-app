// @vitest-environment jsdom
//
// Step 7: component test for the quarterly-backfill annotation. jsdom is opted
// in per-file so the pure suite stays Node-only. Explicit assertions, no
// snapshots.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import QuarterlyBackfillNote from './QuarterlyBackfillNote';
import type { QuarterlyLeadFallback } from '../../lib/compute';

afterEach(cleanup);

function fb(over: Partial<QuarterlyLeadFallback> = {}): QuarterlyLeadFallback {
  return { channelId: 'c1', channelName: 'Content Syndication', quarter: 1, value: 30, ...over };
}

describe('QuarterlyBackfillNote', () => {
  it('renders nothing when there is no fallback', () => {
    const { container } = render(<QuarterlyBackfillNote fallback={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('labels one fallback with metric, quarter, value, and backfill status', () => {
    render(<QuarterlyBackfillNote fallback={[fb({ quarter: 1, value: 30 })]} />);
    expect(screen.getByTestId('quarterly-backfill-note')).toBeTruthy();
    expect(
      screen.getByText(/Content Syndication:.*Q1 Lead actual: 30 \(quarterly backfill\)/),
    ).toBeTruthy();
    // Must not present the value as currency.
    expect(screen.queryByText(/\$30/)).toBeNull();
  });

  it('lists multiple fallback quarters, grouped per channel', () => {
    render(
      <QuarterlyBackfillNote
        fallback={[
          fb({ channelName: 'Content Syndication', quarter: 1, value: 30 }),
          fb({ channelName: 'Content Syndication', quarter: 3, value: 12 }),
          fb({ channelName: 'Events', quarter: 2, value: 8 }),
        ]}
      />,
    );
    // Content Syndication line carries both Q1 and Q3.
    expect(
      screen.getByText(/Content Syndication:.*Q1 Lead actual: 30.*Q3 Lead actual: 12/),
    ).toBeTruthy();
    // Events line carries Q2.
    expect(screen.getByText(/Events:.*Q2 Lead actual: 8 \(quarterly backfill\)/)).toBeTruthy();
  });
});
