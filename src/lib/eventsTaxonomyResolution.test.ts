// eventsTaxonomyResolution.test.ts
//
// The Events parent must be resolved for the SELECTED year, and a missing
// taxonomy must stay distinguishable from a real zero.
//
// The defect these pin: the parent was looked up by the hardcoded name
// "2026 - Events". Selecting any other year missed, computeEventActivations
// returned an empty array, and the page rendered five hard zeros under the
// heading "Across all events in 2025". That claims we ran events and nobody
// engaged, when in truth that year's events structure does not exist.

import { describe, it, expect } from 'vitest';
import { computeEventActivations, resolveEventsParent } from './compute';
import type { Channel, Lead } from '../types/db';

const CONFIGURED = '2026 - Events';

function channel(over: Partial<Channel> & { id: string; name: string }): Channel {
  return {
    parent_channel_id: null,
    year: null,
    display_order: 0,
    hidden: false,
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function lead(over: Partial<Lead> & { id: string }): Lead {
  return {
    email: `${over.id}@example.test`,
    current_stage: 'lead',
    stage_history: [],
    field_locks: {},
    source_sfdc: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  } as Lead;
}

describe('resolveEventsParent', () => {
  it('prefers a parent explicitly tagged with the selected year', () => {
    const channels = [
      channel({ id: 'p25', name: '2025 - Events', year: 2025 }),
      channel({ id: 'p26', name: '2026 - Events', year: 2026 }),
    ];
    expect(resolveEventsParent(channels, 2025, CONFIGURED)?.id).toBe('p25');
    expect(resolveEventsParent(channels, 2026, CONFIGURED)?.id).toBe('p26');
  });

  it('falls back to the naming convention when the year column is unset', () => {
    // Older rows predate the year-aware-channels column.
    const channels = [channel({ id: 'p25', name: '2025 - Events', year: null })];
    expect(resolveEventsParent(channels, 2025, CONFIGURED)?.id).toBe('p25');
  });

  it('accepts an evergreen configured parent', () => {
    const channels = [channel({ id: 'ev', name: 'Events', year: null })];
    expect(resolveEventsParent(channels, 2024, 'Events')?.id).toBe('ev');
  });

  it('never borrows a parent belonging to a different year', () => {
    // THE CORE REFUSAL. Counting 2026's events under a 2025 heading would
    // attribute a whole year of activity to the wrong period.
    const channels = [channel({ id: 'p26', name: '2026 - Events', year: 2026 })];
    expect(resolveEventsParent(channels, 2025, CONFIGURED)).toBeNull();
    expect(resolveEventsParent(channels, 2027, CONFIGURED)).toBeNull();
  });

  it('ignores non-top-level channels', () => {
    // A sub-channel named "Events" under some other parent is not the taxonomy
    // root and must not be mistaken for it.
    const channels = [
      channel({ id: 'root', name: 'Paid' }),
      channel({ id: 'sub', name: '2025 - Events', year: 2025, parent_channel_id: 'root' }),
    ];
    expect(resolveEventsParent(channels, 2025, CONFIGURED)).toBeNull();
  });

  it('returns null when no events taxonomy exists at all', () => {
    const channels = [channel({ id: 'x', name: 'Paid Search' })];
    expect(resolveEventsParent(channels, 2026, CONFIGURED)).toBeNull();
  });
});

describe('computeEventActivations reports missing structure as missing', () => {
  const base = {
    leads: [] as Lead[],
    year: 2025,
    filter: 'year' as const,
    regions: new Set<never>() as never,
    parentChannelName: CONFIGURED,
  };

  it('reports no-parent rather than an empty result for an unset year', () => {
    // Previously this returned [] and the page drew five zeros.
    const r = computeEventActivations({
      ...base,
      channels: [channel({ id: 'p26', name: '2026 - Events', year: 2026 })],
    });
    expect(r.status).toBe('no-parent');
    expect(r.rows).toEqual([]);
    expect(r.parentName).toBeNull();
  });

  it('reports no-event-channels when the parent exists but is empty', () => {
    const r = computeEventActivations({
      ...base,
      channels: [channel({ id: 'p25', name: '2025 - Events', year: 2025 })],
    });
    expect(r.status).toBe('no-event-channels');
    expect(r.parentName).toBe('2025 - Events');
    expect(r.rows).toEqual([]);
  });

  it('reports ok with no rows for a genuine zero', () => {
    // The taxonomy exists and was searched; nobody was sourced in the period.
    // This is a REAL zero and must stay distinct from the two cases above.
    const r = computeEventActivations({
      ...base,
      channels: [
        channel({ id: 'p25', name: '2025 - Events', year: 2025 }),
        channel({ id: 'e1', name: 'Roadshow', year: 2025, parent_channel_id: 'p25' }),
      ],
    });
    expect(r.status).toBe('ok');
    expect(r.parentName).toBe('2025 - Events');
    expect(r.rows).toEqual([]);
  });

  it('counts activations under the year-matched parent', () => {
    const r = computeEventActivations({
      ...base,
      channels: [
        channel({ id: 'p25', name: '2025 - Events', year: 2025 }),
        channel({ id: 'e1', name: 'Roadshow', year: 2025, parent_channel_id: 'p25' }),
      ],
      leads: [
        lead({
          id: 'l1',
          source_channel_id: 'e1',
          marketing_sourced_date: '2025-04-15',
          event_activations: ['Booth Meeting'],
        }),
      ],
    });
    expect(r.status).toBe('ok');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].channelName).toBe('Roadshow');
    expect(r.rows[0].totalContacts).toBe(1);
    expect(r.rows[0].perType['Booth Meeting']).toBe(1);
  });

  it('does not attribute one year events to another year', () => {
    // A 2026 lead under the 2026 parent must not appear in a 2025 view, and
    // the 2025 view must not silently fall back to the 2026 taxonomy.
    const channels = [
      channel({ id: 'p26', name: '2026 - Events', year: 2026 }),
      channel({ id: 'e1', name: 'Summit', year: 2026, parent_channel_id: 'p26' }),
    ];
    const leads = [
      lead({
        id: 'l1',
        source_channel_id: 'e1',
        marketing_sourced_date: '2026-04-15',
        event_activations: ['Booth Meeting'],
      }),
    ];

    const y2026 = computeEventActivations({ ...base, year: 2026, channels, leads });
    expect(y2026.status).toBe('ok');
    expect(y2026.rows[0].perType['Booth Meeting']).toBe(1);

    const y2025 = computeEventActivations({ ...base, year: 2025, channels, leads });
    expect(y2025.status).toBe('no-parent');
    expect(y2025.rows).toEqual([]);
  });
});
