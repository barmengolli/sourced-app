// Shared region-filter helpers. Every list/table builder in
// compute.ts routes its region check through matchesRegionFilter so
// the semantics stay identical across the Data Entry, Leads & MQLs,
// and Opportunities surfaces. Distribution builders
// (computeRegionDistribution, computeChannelDistribution) are
// intentionally region-agnostic and must not call these.

import type { Attribution, AttributionStageKey } from '../types/db';
import { REGIONS, type RegionKey } from '../constants/regions';

// Stage order used to pick a deal's "canonical" row for region
// derivation. Mirrors REGION_STAGE_PRIORITY in compute.ts (and the
// closeWon/closeLost terminals fall through last so a closed-only
// chain still resolves).
export const REGION_STAGE_PRIORITY: AttributionStageKey[] = [
  'hpp',
  'opp',
  'pursuit',
  'closeWon',
  'closeLost',
];

// Returns true when the row should pass the region filter.
//
// Contract:
//   - undefined selected set → no filter (include everything).
//   - selected set covers every REGION → no filter (include everything).
//   - null/blank row region maps to 'Other' before comparing, so
//     manual deals with no region show up under 'Other' and stay
//     hidden when other regions are selected.
//   - otherwise: included iff the row's region is in the set.
export function matchesRegionFilter(
  region: RegionKey | string | null | undefined,
  selected: Set<RegionKey> | undefined,
): boolean {
  if (!selected) return true;
  if (selected.size === 0) return true;
  if (selected.size === REGIONS.length) return true;
  const effective: RegionKey =
    region && (REGIONS as readonly string[]).includes(region as RegionKey)
      ? (region as RegionKey)
      : 'Other';
  return selected.has(effective);
}

// Derive a deal's region from its attribution chain by walking
// REGION_STAGE_PRIORITY in order. The first stage row present wins;
// its region is the deal's region. Empty chains return null, which
// matchesRegionFilter then treats as 'Other'.
export function deriveDealRegion(
  rows: Attribution[],
): RegionKey | null {
  for (const stage of REGION_STAGE_PRIORITY) {
    const found = rows.find((r) => r.stage_key === stage);
    if (found) {
      return (found.region as RegionKey | null) ?? null;
    }
  }
  return null;
}
