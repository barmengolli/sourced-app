// channelFilter — shared year filter for the Funnel sub-tab row layer.
//
// Funnel sub-tabs render a channel only when its year matches the
// selected year OR when it's evergreen (year IS NULL). This mirrors
// the year-aware ChannelSelect dropdown rule but applies at the
// row-rendering layer instead.
//
// Sub-channel orphan promotion: if a child's parent was filtered out
// (cross-year nesting), the child still surfaces in the returned
// set. Downstream compute helpers (which iterate `parent_channel_id`
// against the filtered channels array) naturally promote it to a
// root because its parent isn't in the set. computeGrid has explicit
// defensive orphan pickup; computeWeekly and computeMonthly don't, so
// a deeply-nested 2025 child under a filtered-out 2026 parent on the
// Compare tab would be skipped — an edge case that doesn't apply to
// the seeded 2025 taxonomy (no sub-channels).

import type { Channel } from '../types/db';

// Returns the subset of `channels` whose year matches `selectedYear`
// or is null (evergreen). Preserves input order.
export function filterChannelsByYear(
  channels: Channel[],
  selectedYear: number,
): Channel[] {
  return channels.filter(
    (c) => c.year == null || c.year === selectedYear,
  );
}
