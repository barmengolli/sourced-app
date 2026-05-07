export type RegionKey = 'NA' | 'EMEA' | 'APAC' | 'LATAM' | 'Other';

export const REGIONS: RegionKey[] = ['NA', 'EMEA', 'APAC', 'LATAM', 'Other'];

export const REGION_LABELS: Record<RegionKey, string> = {
  NA: 'North America',
  EMEA: 'Europe, Middle East & Africa',
  APAC: 'Asia Pacific',
  LATAM: 'Latin America',
  Other: 'Other',
};

// Country to region mapping. Add countries as they appear in the data.
// Portugal was added during the M7.5 region rollout (it appeared in
// sample-import.csv). Keep this in sync with the SQL backfill snippet in
// the M7.5 plan if you ever rebalance the buckets.
export const COUNTRY_TO_REGION: Record<string, RegionKey> = {
  'United States': 'NA',
  Canada: 'NA',
  Mexico: 'NA',
  'United Kingdom': 'EMEA',
  Ireland: 'EMEA',
  France: 'EMEA',
  Germany: 'EMEA',
  Switzerland: 'EMEA',
  Belgium: 'EMEA',
  Netherlands: 'EMEA',
  Italy: 'EMEA',
  Spain: 'EMEA',
  Finland: 'EMEA',
  Sweden: 'EMEA',
  Norway: 'EMEA',
  Denmark: 'EMEA',
  'United Arab Emirates': 'EMEA',
  'South Africa': 'EMEA',
  Portugal: 'EMEA',
  India: 'APAC',
  China: 'APAC',
  Japan: 'APAC',
  Australia: 'APAC',
  'New Zealand': 'APAC',
  Singapore: 'APAC',
  Malaysia: 'APAC',
  Brazil: 'LATAM',
  Argentina: 'LATAM',
  Chile: 'LATAM',
  Colombia: 'LATAM',
};

export function regionForCountry(
  country: string | null | undefined,
): RegionKey {
  if (!country) return 'Other';
  return COUNTRY_TO_REGION[country.trim()] ?? 'Other';
}
