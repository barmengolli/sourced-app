export type RoadmapPhase =
  | 'Foundation'
  | 'Integrations'
  | 'Channel Tabs'
  | 'Product Marketing'
  | 'Unified Campaign'
  | 'Productization';

export type RoadmapStatus = 'not-started' | 'in-progress' | 'shipped';

export interface RoadmapItem {
  phase: RoadmapPhase;
  name: string;
  outcome: string;
  owner: string;
  startDate: string; // ISO yyyy-mm-dd
  endDate: string;   // ISO yyyy-mm-dd, inclusive
  status: RoadmapStatus;
}

// Phase color tokens. Hex values match the Marketing Reporting Roadmap.xlsx
// Gantt color coding so the in-app view and the file share a visual language.
export const PHASE_COLORS: Record<RoadmapPhase, { dark: string; light: string }> = {
  Foundation:          { dark: '#4F46E5', light: '#E0E7FF' },
  Integrations:        { dark: '#0891B2', light: '#CFFAFE' },
  'Channel Tabs':      { dark: '#059669', light: '#D1FAE5' },
  'Product Marketing': { dark: '#D97706', light: '#FEF3C7' },
  'Unified Campaign':  { dark: '#7C3AED', light: '#EDE9FE' },
  Productization:     { dark: '#475569', light: '#E2E8F0' },
};

export const PHASE_ORDER: RoadmapPhase[] = [
  'Foundation',
  'Integrations',
  'Channel Tabs',
  'Product Marketing',
  'Unified Campaign',
  'Productization',
];

// Timeline range that the Gantt renders. All items must fall within
// this window; extend when the roadmap extends.
export const ROADMAP_RANGE = {
  start: '2026-05-01',
  end:   '2026-12-31',
};

export const ROADMAP_ITEMS: RoadmapItem[] = [
  // Foundation
  { phase: 'Foundation', name: 'Conversion-rate benchmarks on funnel dashboard',
    outcome: 'Sara sees actuals vs quarterly projection benchmarks per stage.',
    owner: 'Ben', startDate: '2026-05-18', endDate: '2026-05-29',
    status: 'not-started' },
  { phase: 'Foundation', name: 'Name-account vs non-name-account filter',
    outcome: 'Funnel and opportunity views toggle between Global Strategic and All.',
    owner: 'Ben', startDate: '2026-05-18', endDate: '2026-06-05',
    status: 'not-started' },
  { phase: 'Foundation', name: 'Events: complete activation data backfill',
    outcome: 'Each event row shows the full activation chain end-to-end.',
    owner: 'Ben + Garrett', startDate: '2026-05-25', endDate: '2026-06-19',
    status: 'in-progress' },

  // Integrations
  { phase: 'Integrations', name: 'HubSpot integration (email engagement)',
    outcome: 'Nurture and newsletter engagement data lands in Sourced automatically.',
    owner: 'Ben', startDate: '2026-06-08', endDate: '2026-06-26',
    status: 'not-started' },
  { phase: 'Integrations', name: 'SEO tool integration (Ahrefs / SEMrush / Conductor TBD)',
    outcome: 'Google ranking and agentic visibility data feeds Sourced without manual uploads.',
    owner: 'Ben + Chelsea', startDate: '2026-06-22', endDate: '2026-07-10',
    status: 'not-started' },
  { phase: 'Integrations', name: 'Google Analytics 4 integration',
    outcome: 'Web traffic, conversions, and source / medium flow into Sourced nightly.',
    owner: 'Ben', startDate: '2026-06-29', endDate: '2026-07-17',
    status: 'not-started' },
  { phase: 'Integrations', name: 'LinkedIn integration (organic + paid)',
    outcome: 'LinkedIn engagement and campaign performance lands in Sourced.',
    owner: 'Ben', startDate: '2026-07-27', endDate: '2026-08-14',
    status: 'not-started' },
  { phase: 'Integrations', name: 'Zoominfo enrichment feed (data quality)',
    outcome: 'Lead and company records are enriched and de-duped before they hit the funnel.',
    owner: 'Ben + Dan', startDate: '2026-08-17', endDate: '2026-09-11',
    status: 'not-started' },
  { phase: 'Integrations', name: '6sense integration (intent + account engagement)',
    outcome: '6sense intent scores and surge accounts visible per campaign.',
    owner: 'Ben', startDate: '2026-09-14', endDate: '2026-10-02',
    status: 'not-started' },
  { phase: 'Integrations', name: 'People.ai integration (fallback activity capture)',
    outcome: 'When SFDC and HubSpot have gaps, People.ai backfills the engagement timeline.',
    owner: 'Ben + Dan', startDate: '2026-11-09', endDate: '2026-12-04',
    status: 'not-started' },

  // Channel Tabs
  { phase: 'Channel Tabs', name: 'Email Marketing tab (Nurture + Newsletter split)',
    outcome: 'Weekly nurture and newsletter engagement KPIs, segmented by audience.',
    owner: 'Ben', startDate: '2026-06-29', endDate: '2026-07-24',
    status: 'not-started' },
  { phase: 'Channel Tabs', name: 'SEO tab (Google + agentic ranking)',
    outcome: 'Monthly SEO ranking trends, including agentic visibility, side by side.',
    owner: 'Ben + Chelsea', startDate: '2026-07-13', endDate: '2026-08-14',
    status: 'not-started' },
  { phase: 'Channel Tabs', name: 'Web Analytics tab',
    outcome: 'Monthly traffic and conversion attribution by source.',
    owner: 'Ben', startDate: '2026-07-20', endDate: '2026-08-21',
    status: 'not-started' },
  { phase: 'Channel Tabs', name: 'Organic Social tab',
    outcome: 'Weekly LinkedIn (and other) engagement KPIs in one view.',
    owner: 'Ben', startDate: '2026-08-17', endDate: '2026-09-18',
    status: 'not-started' },

  // Product Marketing
  { phase: 'Product Marketing', name: 'Manual input: new content created per quarter',
    outcome: 'Quarterly rollup of new content count, by type.',
    owner: 'Ben + Product Mktg', startDate: '2026-08-10', endDate: '2026-08-28',
    status: 'not-started' },
  { phase: 'Product Marketing', name: 'Manual input: PR KPIs (releases, bylines, placements)',
    outcome: 'Quarterly PR scorecard visible alongside funnel performance.',
    owner: 'Ben + PR Lead', startDate: '2026-08-24', endDate: '2026-09-11',
    status: 'not-started' },
  { phase: 'Product Marketing', name: 'Manual input: enablement sessions (SMACK program)',
    outcome: 'Quarterly view of sessions delivered and reach.',
    owner: 'Ben + Mike', startDate: '2026-09-07', endDate: '2026-09-25',
    status: 'not-started' },
  { phase: 'Product Marketing', name: 'Manual input: competitive insights output',
    outcome: 'Quarterly tracker of battle cards and competitive assets shipped.',
    owner: 'Ben + Dave', startDate: '2026-09-14', endDate: '2026-10-02',
    status: 'not-started' },

  // Unified Campaign
  { phase: 'Unified Campaign', name: 'Unified Campaign Dashboard (cross-channel rollup)',
    outcome: 'Pick a campaign (e.g. Life & Annuity); see every touchpoint in one view.',
    owner: 'Ben', startDate: '2026-10-05', endDate: '2026-11-27',
    status: 'not-started' },

  // Productization
  { phase: 'Productization', name: 'EIS-licensed tooling migration (Lisa + Sergey audit)',
    outcome: 'Dashboard runs entirely on the EIS-approved stack.',
    owner: 'Ben + Dan + Lisa', startDate: '2026-09-01', endDate: '2026-10-30',
    status: 'not-started' },
  { phase: 'Productization', name: 'Security review and sign-off',
    outcome: 'Dashboard cleared for organization-wide rollout.',
    owner: 'Sara + Rich (Security)', startDate: '2026-11-02', endDate: '2026-12-11',
    status: 'not-started' },
  { phase: 'Productization', name: 'Stakeholder rollout (broader marketing leadership)',
    outcome: 'Dashboard adopted as the source of truth for marketing performance.',
    owner: 'Sara + Ben', startDate: '2026-12-14', endDate: '2026-12-31',
    status: 'not-started' },
];
