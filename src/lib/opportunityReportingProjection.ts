// Pure projection from an approved Salesforce Opportunity review into the
// reporting rows consumed by Data Entry. This module performs no writes.
//
// The append-only sf_opportunity_events ledger remains the historical truth.
// Reporting is a reversible current-qualified projection:
//   current HPP     -> HPP
//   current Opp     -> HPP + Opp
//   current Pursuit -> HPP + Opp + Pursuit
// A regression therefore removes only higher-stage GENERATED reporting rows;
// it never deletes Salesforce movement evidence or manual attribution rows.

import type { Attribution, AttributionStageKey, PeriodIndex } from '../types/db';
import { REGIONS, type RegionKey } from '../constants/regions';
import { quarterOfIsoDate } from './dates';
import type {
  OpportunityDerivedState,
  OpportunityFunnelStage,
} from './opportunityStageHistory';

export type OpportunityReportingIssue =
  | 'review_not_approved'
  | 'missing_channel'
  | 'missing_active_link'
  | 'unreportable_current_state'
  | 'missing_stage_entry_date'
  | 'unsupported_commercial_region';

export interface OpportunityReportingSnapshot {
  sfOpportunityId: string;
  opportunityName: string | null;
  accountId: string | null;
  accountName: string | null;
  saasRevenueUsd: number | null;
  commercialRegion: string | null;
  suggestedBdrName: string | null;
}

export interface OpportunityReportingReview {
  reviewState: 'pending' | 'approved' | 'linked' | 'ignored' | 'blocked' | 'resolved';
  channelId: string | null;
  leadId: string | null;
  bdrName: string | null;
  commercialRegionOverride: string | null;
}

export interface OpportunityReportingLink {
  dealId: string;
  linkState: 'active' | 'retired';
}

export interface OpportunityReportingRow
  extends Omit<Attribution, 'id' | 'created_at' | 'updated_at' | 'sf_link'> {
  source_system: 'salesforce';
  sf_opportunity_id: string;
  sf_link: null;
}

export interface OpportunityReportingProjection {
  state: 'ready' | 'partial' | 'not_approved' | 'out_of_scope';
  rows: OpportunityReportingRow[];
  // Generated stages that must be deleted from the reporting projection.
  // This is what makes Opp/Pursuit counts disappear after a regression.
  removeGeneratedStages: AttributionStageKey[];
  issues: OpportunityReportingIssue[];
}

const FUNNEL_ORDER: OpportunityFunnelStage[] = ['hpp', 'opp', 'pursuit'];
const REPORTING_REGION_SET = new Set<string>(REGIONS);

function currentQualifiedStages(stage: OpportunityFunnelStage): OpportunityFunnelStage[] {
  return FUNNEL_ORDER.slice(0, FUNNEL_ORDER.indexOf(stage) + 1);
}

export function normalizeOpportunityReportingRegion(value: string | null): RegionKey | null {
  const clean = value?.trim() ?? '';
  return REPORTING_REGION_SET.has(clean) ? (clean as RegionKey) : null;
}

export function projectOpportunityToReporting(input: {
  derived: OpportunityDerivedState;
  snapshot: OpportunityReportingSnapshot;
  review: OpportunityReportingReview;
  link: OpportunityReportingLink | null;
  existingGeneratedRows?: Attribution[];
}): OpportunityReportingProjection {
  const { derived, snapshot, review, link, existingGeneratedRows = [] } = input;
  const issues: OpportunityReportingIssue[] = [];
  const ownedGeneratedRows = existingGeneratedRows.filter(
    (row) =>
      row.source_system === 'salesforce' &&
      row.sf_opportunity_id === snapshot.sfOpportunityId,
  );

  if (review.reviewState !== 'approved' && review.reviewState !== 'linked') {
    return {
      state: 'not_approved',
      rows: [],
      removeGeneratedStages: [],
      issues: ['review_not_approved'],
    };
  }
  if (!derived.currentStage || derived.currentState === 'out_of_scope') {
    return {
      state: 'out_of_scope',
      rows: [],
      removeGeneratedStages: ownedGeneratedRows.map((row) => row.stage_key),
      issues: [],
    };
  }
  if (!derived.reportable) issues.push('unreportable_current_state');
  if (!review.channelId?.trim()) issues.push('missing_channel');
  if (!link || link.linkState !== 'active' || !link.dealId.trim()) {
    issues.push('missing_active_link');
  }

  // Reviewer-owned Commercial Region wins over the nightly source value.
  // Only the exact app reporting taxonomy is accepted. Unknown source text is
  // never silently collapsed into Other because that would corrupt filters.
  const region = normalizeOpportunityReportingRegion(
    review.commercialRegionOverride ?? snapshot.commercialRegion,
  );
  if (!region) issues.push('unsupported_commercial_region');

  const expected = currentQualifiedStages(derived.currentStage);
  const expectedSet = new Set<AttributionStageKey>(expected);
  const removeGeneratedStages = ownedGeneratedRows
    .filter((row) => !expectedSet.has(row.stage_key))
    .map((row) => row.stage_key);

  const canBuild =
    derived.reportable &&
    Boolean(review.channelId?.trim()) &&
    Boolean(link && link.linkState === 'active' && link.dealId.trim()) &&
    region !== null;
  const rows: OpportunityReportingRow[] = [];

  for (const stage of expected) {
    const enteredAt = derived.activeDates[stage];
    const period = quarterOfIsoDate(enteredAt);
    if (!enteredAt || !period) {
      issues.push('missing_stage_entry_date');
      continue;
    }
    if (!canBuild || !link) continue;
    rows.push({
      source_system: 'salesforce',
      sf_opportunity_id: snapshot.sfOpportunityId,
      deal_id: link.dealId,
      lead_id: review.leadId,
      stage_key: stage,
      channel_id: review.channelId,
      year: period.year,
      period_index: period.quarter as PeriodIndex,
      label: snapshot.opportunityName,
      account: snapshot.accountName,
      sfdc_account_id: snapshot.accountId,
      amount: snapshot.saasRevenueUsd,
      sf_link: null,
      region,
      stage_entered_at: enteredAt,
      lost_reason: null,
      bdr_name: review.bdrName ?? snapshot.suggestedBdrName,
    });
  }

  return {
    state: issues.length === 0 ? 'ready' : 'partial',
    rows,
    removeGeneratedStages: [...new Set(removeGeneratedStages)],
    issues: [...new Set(issues)],
  };
}
