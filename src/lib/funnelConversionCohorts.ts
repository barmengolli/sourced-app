// Cohort conversion metrics for the Funnel Data Entry sidebar.
//
// The Data Entry grid is stage activity: each stage belongs to the period in
// which it happened. Conversion rates are a different question and must not
// divide adjacent activity totals. This module follows explicit cohorts:
//
// - Lead -> MQL: CampaignMember touches entering in the selected period,
//   followed forward to whether that same membership's person has ever MQL'd.
// - HPP -> later deal stages: Opportunities entering HPP in the selected
//   period, followed through the current-qualified attribution projection.
// - MQL account -> HPP: distinct Salesforce Account IDs among memberships
//   becoming MQL in the selected period, followed to approved HPP attribution.

import type { RegionKey } from '../constants/regions';
import type {
  Attribution,
  Lead,
  LeadCampaignTouchRow,
  PeriodIndex,
} from '../types/db';
import type { PeriodFilter } from './compute';
import { hasReachedMql, mqlActivityDateForTouch } from './compute';
import { matchesRegionFilter } from './regionFilter';
import { quarterOfIsoDate } from './dates';

export type ConversionMetricStatus =
  | 'ready'
  | 'partial'
  | 'no_denominator'
  | 'unavailable';

export interface ConversionMetric {
  numerator: number | null;
  denominator: number | null;
  percent: number | null;
  status: ConversionMetricStatus;
  basis: string;
  coverage?: { measured: number; total: number };
}

export interface FunnelConversionCohorts {
  leadToMql: ConversionMetric;
  mqlAccountToHpp: ConversionMetric;
  hppToOpp: ConversionMetric;
  oppToPursuit: ConversionMetric;
  pursuitToWon: ConversionMetric;
  outcomes: {
    hppCohort: number;
    won: number;
    lost: number;
    inFlight: number;
  };
}

export interface FunnelConversionCohortInput {
  leads: Lead[];
  touches: LeadCampaignTouchRow[];
  attributions: Attribution[];
  year: number;
  filter: PeriodFilter;
  regions?: Set<RegionKey>;
}

function matchesSelectedPeriod(
  bucket: { year: number; quarter: PeriodIndex } | null,
  year: number,
  filter: PeriodFilter,
): boolean {
  if (!bucket || bucket.year !== year) return false;
  return filter === 'year' || `Q${bucket.quarter}` === filter;
}

function metric(
  numerator: number,
  denominator: number,
  basis: string,
): ConversionMetric {
  if (denominator === 0) {
    return {
      numerator,
      denominator,
      percent: null,
      status: 'no_denominator',
      basis,
    };
  }
  return {
    numerator,
    denominator,
    percent: (numerator / denominator) * 100,
    status: 'ready',
    basis,
  };
}

function dealKey(attribution: Attribution): string {
  return attribution.deal_id?.trim() || `row:${attribution.id}`;
}

export function computeFunnelConversionCohorts(
  input: FunnelConversionCohortInput,
): FunnelConversionCohorts {
  const leadById = new Map(input.leads.map((lead) => [lead.id, lead]));
  const selectedLeadMemberships = input.touches.filter((touch) => {
    const lead = leadById.get(touch.lead_id);
    if (!lead || !matchesRegionFilter(lead.region, input.regions)) return false;
    return matchesSelectedPeriod(
      quarterOfIsoDate(touch.touch_date),
      input.year,
      input.filter,
    );
  });
  const mqlMemberships = selectedLeadMemberships.filter((touch) => {
    const lead = leadById.get(touch.lead_id);
    return Boolean(lead && hasReachedMql(lead));
  });
  const selectedMqlActivityMemberships = input.touches.filter((touch) => {
    const lead = leadById.get(touch.lead_id);
    if (!lead || !matchesRegionFilter(lead.region, input.regions)) return false;
    return matchesSelectedPeriod(
      quarterOfIsoDate(mqlActivityDateForTouch(lead, touch.touch_date)),
      input.year,
      input.filter,
    );
  });

  const measurableMqlMemberships = selectedMqlActivityMemberships.filter((touch) =>
    Boolean(leadById.get(touch.lead_id)?.sfdc_account_id?.trim()),
  );
  const mqlAccountIds = new Set(
    measurableMqlMemberships.map((touch) =>
      leadById.get(touch.lead_id)!.sfdc_account_id!.trim(),
    ),
  );

  const attrsByDeal = new Map<string, Attribution[]>();
  for (const attribution of input.attributions) {
    if (!matchesRegionFilter(attribution.region, input.regions)) continue;
    const key = dealKey(attribution);
    const rows = attrsByDeal.get(key) ?? [];
    rows.push(attribution);
    attrsByDeal.set(key, rows);
  }

  const hppCohortKeys = new Set<string>();
  for (const [key, rows] of attrsByDeal) {
    if (rows.some((row) =>
      row.stage_key === 'hpp'
      && matchesSelectedPeriod(
        { year: row.year, quarter: row.period_index },
        input.year,
        input.filter,
      ))) {
      hppCohortKeys.add(key);
    }
  }

  const hasStage = (key: string, stage: Attribution['stage_key']): boolean =>
    (attrsByDeal.get(key) ?? []).some((row) => row.stage_key === stage);
  const reachedOpp = [...hppCohortKeys].filter((key) => hasStage(key, 'opp'));
  const reachedPursuit = reachedOpp.filter((key) => hasStage(key, 'pursuit'));
  const reachedWon = reachedPursuit.filter((key) => hasStage(key, 'closeWon'));
  const reachedLost = [...hppCohortKeys].filter((key) => hasStage(key, 'closeLost'));
  const inFlight = Math.max(
    0,
    hppCohortKeys.size - reachedWon.length - reachedLost.length,
  );
  const hppAccountIds = new Set(
    input.attributions
      .filter((row) => row.stage_key === 'hpp')
      .filter((row) => matchesRegionFilter(row.region, input.regions))
      .map((row) => row.sfdc_account_id?.trim())
      .filter((value): value is string => Boolean(value)),
  );
  const mqlAccountsWithHpp = [...mqlAccountIds]
    .filter((accountId) => hppAccountIds.has(accountId)).length;

  let mqlAccountToHpp: ConversionMetric;
  if (selectedMqlActivityMemberships.length === 0) {
    mqlAccountToHpp = metric(
      0,
      0,
      'Distinct Salesforce Accounts becoming MQL in the selected period, followed to an approved HPP.',
    );
  } else if (measurableMqlMemberships.length === 0) {
    mqlAccountToHpp = {
      numerator: null,
      denominator: null,
      percent: null,
      status: 'unavailable',
      basis: 'Exact Salesforce Account IDs are not yet available for this MQL cohort.',
      coverage: { measured: 0, total: selectedMqlActivityMemberships.length },
    };
  } else {
    mqlAccountToHpp = {
      ...metric(
        mqlAccountsWithHpp,
        mqlAccountIds.size,
        'Distinct Salesforce Accounts becoming MQL in the selected period, followed to an approved primary-campaign HPP.',
      ),
      status: measurableMqlMemberships.length === selectedMqlActivityMemberships.length
        ? 'ready'
        : 'partial',
      coverage: {
        measured: measurableMqlMemberships.length,
        total: selectedMqlActivityMemberships.length,
      },
    };
  }

  return {
    leadToMql: metric(
      mqlMemberships.length,
      selectedLeadMemberships.length,
      'Campaign memberships entering as Leads in the selected period, followed forward to MQL.',
    ),
    mqlAccountToHpp,
    hppToOpp: metric(
      reachedOpp.length,
      hppCohortKeys.size,
      'Opportunities entering HPP in the selected period, currently qualified at Opp or beyond.',
    ),
    oppToPursuit: metric(
      reachedPursuit.length,
      reachedOpp.length,
      'The selected HPP cohort that currently qualifies at Opp, followed to Pursuit.',
    ),
    pursuitToWon: metric(
      reachedWon.length,
      reachedPursuit.length,
      'The selected HPP cohort that currently qualifies at Pursuit, followed to Closed Won.',
    ),
    outcomes: {
      hppCohort: hppCohortKeys.size,
      won: reachedWon.length,
      lost: reachedLost.length,
      inFlight,
    },
  };
}
