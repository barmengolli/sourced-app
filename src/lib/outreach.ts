// Outreach-domain helpers. Region inference is the load-bearing one in M9:
// our Outreach.io sequence naming convention encodes the region in the
// `[YYYY] - REGION - ...` prefix, so we can derive an OutreachRegionKey
// from the sequence name without storing it on the snapshot row.

import { type OutreachRegionKey } from '../constants/outreachRegions';

// Match `[2026] - NA - foo`, `[2025] - EMEA - bar`, etc. The leading [YYYY]
// is required so an arbitrary "NA" substring elsewhere in the name doesn't
// trigger a false positive. Sequences that don't follow the convention
// fall through to 'Other'.
const SEQUENCE_REGION_RE = /\[\d{4}\]\s*-\s*(NA|EMEA|APAC|LATAM)\s*-/i;

export function inferRegionFromSequenceName(name: string): OutreachRegionKey {
  if (!name) return 'Other';
  const m = SEQUENCE_REGION_RE.exec(name);
  if (!m) return 'Other';
  const code = m[1].toUpperCase();
  switch (code) {
    case 'NA':
      return 'NA';
    case 'EMEA':
      return 'EMEA';
    case 'APAC':
      return 'APAC';
    case 'LATAM':
      return 'LATAM';
    default:
      return 'Other';
  }
}
