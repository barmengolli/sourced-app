// Legacy five-region scheme, used ONLY by the Outreach section.
// Outreach sequence names embed these tokens ("[2026] - EMEA - ..."),
// so the Outreach tabs keep this taxonomy independently of the EIS
// funnel regions in ./regions.ts.
export type OutreachRegionKey = 'NA' | 'EMEA' | 'APAC' | 'LATAM' | 'Other';

export const OUTREACH_REGIONS: OutreachRegionKey[] = [
  'NA',
  'EMEA',
  'APAC',
  'LATAM',
  'Other',
];

export const OUTREACH_REGION_LABELS: Record<OutreachRegionKey, string> = {
  NA: 'North America',
  EMEA: 'Europe, Middle East & Africa',
  APAC: 'Asia Pacific',
  LATAM: 'Latin America',
  Other: 'Other',
};
