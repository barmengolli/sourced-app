export type RegionKey =
  | 'NA'
  | 'EMEA cont & LATAM'
  | 'UK&IRE, ME, Japan'
  | 'Other';

export const REGIONS: RegionKey[] = [
  'NA',
  'EMEA cont & LATAM',
  'UK&IRE, ME, Japan',
  'Other',
];

export const REGION_LABELS: Record<RegionKey, string> = {
  NA: 'North America',
  'EMEA cont & LATAM': 'Continental Europe, Africa & Latin America',
  'UK&IRE, ME, Japan': 'UK & Ireland, Middle East, Japan & APAC',
  Other: 'Other',
};

// Country to region mapping, EIS taxonomy. Add countries as they
// appear in the data. Keep in sync with the CASE expression in
// migrations/2026-06-10_region_taxonomy_migration.sql.
export const COUNTRY_TO_REGION: Record<string, RegionKey> = {
  'United States': 'NA',
  Canada: 'NA',
  Mexico: 'NA',
  France: 'EMEA cont & LATAM',
  Germany: 'EMEA cont & LATAM',
  Switzerland: 'EMEA cont & LATAM',
  Belgium: 'EMEA cont & LATAM',
  Netherlands: 'EMEA cont & LATAM',
  Italy: 'EMEA cont & LATAM',
  Spain: 'EMEA cont & LATAM',
  Finland: 'EMEA cont & LATAM',
  Sweden: 'EMEA cont & LATAM',
  Norway: 'EMEA cont & LATAM',
  Denmark: 'EMEA cont & LATAM',
  Portugal: 'EMEA cont & LATAM',
  'South Africa': 'EMEA cont & LATAM',
  Brazil: 'EMEA cont & LATAM',
  Argentina: 'EMEA cont & LATAM',
  Chile: 'EMEA cont & LATAM',
  Colombia: 'EMEA cont & LATAM',
  'United Kingdom': 'UK&IRE, ME, Japan',
  Ireland: 'UK&IRE, ME, Japan',
  'United Arab Emirates': 'UK&IRE, ME, Japan',
  Japan: 'UK&IRE, ME, Japan',
  India: 'UK&IRE, ME, Japan',
  China: 'UK&IRE, ME, Japan',
  Australia: 'UK&IRE, ME, Japan',
  'New Zealand': 'UK&IRE, ME, Japan',
  Singapore: 'UK&IRE, ME, Japan',
  Malaysia: 'UK&IRE, ME, Japan',
};

export function regionForCountry(
  country: string | null | undefined,
): RegionKey {
  if (!country) return 'Other';
  return COUNTRY_TO_REGION[country.trim()] ?? 'Other';
}
