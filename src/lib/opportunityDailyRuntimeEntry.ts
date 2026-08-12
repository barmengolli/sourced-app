import {
  classifyCandidateEligibility,
  normalizedRecordTypeState,
  planStagingIngestion,
  serializeApplyPayload,
  suggestedBdrName,
} from './opportunityIngestionPlanner';
import type {
  ExistingStagingState,
  IngestionConfig,
} from './opportunityIngestionPlanner';
import type { SalesforceOpportunityRecord } from './salesforceOpportunitySync';
import type {
  SalesforceOpportunityHistoryRecord,
  SalesforceRecordTypeRef,
} from './salesforceOpportunitySync';

export interface OpportunityDailyRuntimeInput {
  opportunities: SalesforceOpportunityRecord[];
  historyRecords: SalesforceOpportunityHistoryRecord[];
  recordTypeRefs: SalesforceRecordTypeRef[];
  existingState: ExistingStagingState;
  runStartedAt: string;
  reportingYears: number[];
  includedBusinessTypeApiValues: string[];
}

const EMPTY_STATE: ExistingStagingState = {
  snapshots: {},
  eventContentByHistoryId: {},
  reviews: {},
  links: {},
};

export function planOpportunityDailyRun(input: OpportunityDailyRuntimeInput) {
  if (!Array.isArray(input.opportunities)) throw new Error('runtime: opportunities must be an array');
  if (!Array.isArray(input.historyRecords)) throw new Error('runtime: historyRecords must be an array');
  if (!Array.isArray(input.recordTypeRefs)) throw new Error('runtime: recordTypeRefs must be an array');
  if (!input.existingState || typeof input.existingState !== 'object') {
    throw new Error('runtime: existingState is required');
  }
  if (!Number.isFinite(Date.parse(input.runStartedAt))) {
    throw new Error('runtime: runStartedAt must be a real timestamp');
  }
  if (!Array.isArray(input.reportingYears) || input.reportingYears.length === 0
    || input.reportingYears.some((year) => !Number.isInteger(year))) {
    throw new Error('runtime: reportingYears must contain integers');
  }
  if (!Array.isArray(input.includedBusinessTypeApiValues)
    || input.includedBusinessTypeApiValues.length !== 1
    || input.includedBusinessTypeApiValues[0] !== 'New Project') {
    throw new Error('runtime: the confirmed New Logo API value must be exactly New Project');
  }

  const config: IngestionConfig = {
    reportingYears: [...input.reportingYears],
    includedBusinessTypeApiValues: [...input.includedBusinessTypeApiValues],
    runStartedAt: input.runStartedAt,
  };
  const state: ExistingStagingState = {
    ...EMPTY_STATE,
    ...input.existingState,
  };
  // Current snapshots and append-only Salesforce history are planned by the
  // same authoritative adapter. Regressions remain in the protected ledger;
  // reporting promotion later derives the reversible current-qualified path.
  const plan = planStagingIngestion(
    input.opportunities,
    input.historyRecords,
    input.recordTypeRefs,
    state,
    config,
  );
  const payload = serializeApplyPayload(plan);
  const currentPipeline = { hpp: 0, opp: 0, pursuit: 0 };
  const suggestedBdrs = { dave_cummins: 0, garrett_mcnally: 0, none: 0 };
  let open = 0;
  let closed = 0;
  for (const record of input.opportunities) {
    const outcome = classifyCandidateEligibility(record, state, config);
    if (outcome.startsWith('excluded_')) continue;
    const suggestedBdr = suggestedBdrName(record);
    if (suggestedBdr === 'Dave Cummins') suggestedBdrs.dave_cummins += 1;
    else if (suggestedBdr === 'Garrett McNally') suggestedBdrs.garrett_mcnally += 1;
    else suggestedBdrs.none += 1;
    if (record.IsClosed === true) {
      closed += 1;
      continue;
    }
    const stage = normalizedRecordTypeState(record);
    if (stage === 'hpp' || stage === 'opp' || stage === 'pursuit') {
      currentPipeline[stage] += 1;
      open += 1;
    }
  }

  return {
    summary: {
      status: 'PLAN_COMPLETE',
      dry_run: true,
      writes_attempted: 0,
      reporting_years: [...input.reportingYears],
      included_business_type_api_values: [...input.includedBusinessTypeApiValues],
      primary_revenue_field: 'SaaS_Revenue_USD__c',
      stored_hidden_revenue_fields: ['Amount', 'SaaS_Revenue__c'],
      source_opportunities: input.opportunities.length,
      source_history_rows: input.historyRecords.length,
      record_type_references: input.recordTypeRefs.length,
      open_current_pipeline: open,
      closed_staged_for_review: closed,
      current_pipeline_by_record_type: currentPipeline,
      suggested_bdrs: suggestedBdrs,
      source_attribution_requires_human_review: true,
      snapshots_planned: payload.p_snapshots.length,
      reviews_planned: payload.p_reviews.length,
      events_planned: payload.p_events.length,
      reconciliation_complete: open + closed
        === input.opportunities.length - plan.diagnostics.excludedNotStaged,
      planner_diagnostics: plan.diagnostics,
    },
    payload,
  };
}
