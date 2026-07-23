// funnelCohorts.ts: pure cohort, lifecycle-history, and deal-uniqueness
// foundation for the funnel contract (Bite 4A).
//
// This module is intentionally NOT wired into any dashboard yet and does not
// replace computeGrid. It defines the target calculation contract described in
// docs/funnel-source-contract.md:
//
// - Funnel stages are non-additive: Leads 100 with MQLs 20 is still 100 unique
//   people, never 120. Deal stages are progression evidence for one deal_id,
//   never separate opportunities.
// - A lead belongs to the acquisition cohort of the period in which it
//   originally became a Lead. Later transitions (a Q3 MQL from a Q2 lead)
//   update that original cohort, they do not move the person.
// - Lifecycle is an event history that permits repeats
//   (Lead > MQL > Lead > MQL). The first valid Lead-to-MQL event supplies the
//   original cohort conversion; later ones are requalifications and never
//   increase the cohort's unique-MQL count.
// - Dates carry provenance (salesforce_confirmed / n8n_observed / unknown).
//   Unknown dates are reported as unknown, never invented.
// - Every calculation takes an explicit asOf date. Nothing here reads the
//   clock, the network, or the database.
//
// Results use explicit states (complete / incomplete / missing / invalid) plus
// issue counts so future UI disclosures can explain why a value is incomplete
// instead of silently rendering zero.

import type { StageKey, AttributionStageKey } from '../types/db';
import type { ReportingPeriod } from '../types/reporting';
import { periodBounds, isValidIsoDate } from './reportingPeriods';
import { computeDelta, computeRateDelta } from './reportingDeltas';
import type { DeltaResult } from './reportingDeltas';

// ---------------------------------------------------------------------------
// Shared result vocabulary
// ---------------------------------------------------------------------------

// complete: every input needed for the value was present and valid.
// incomplete: the value is computed from what could be safely proven, but some
//   inputs were unknown, contradictory, or excluded (see issues).
// missing: there was nothing to compute from.
// invalid: the request itself was unusable (bad period or asOf date).
export type CohortResultState = 'complete' | 'incomplete' | 'missing' | 'invalid';

export type CohortIssueKind =
  | 'invalid_as_of'
  | 'invalid_period'
  | 'duplicate_lead_id'
  | 'missing_lead_date'
  | 'unknown_mql_transition_date'
  | 'mql_before_lead'
  | 'stage_date_contradiction'
  | 'mql_timing_unknown'
  | 'invalid_member_lifecycle'
  | 'as_of_before_period_end'
  | 'missing_deal_id'
  | 'missing_stage_date'
  | 'duplicate_deal_stage';

export interface CohortIssue {
  kind: CohortIssueKind;
  count: number;
}

// Where a lifecycle date came from. salesforce_confirmed is a date Salesforce
// itself asserts; n8n_observed is the day an automation first saw the new
// stage (an upper bound, not the true transition day); unknown means the stage
// is known but no one can say when it began.
export type DateSource = 'salesforce_confirmed' | 'n8n_observed' | 'unknown';

export interface DatedValue {
  date: string | null; // ISO YYYY-MM-DD when known
  source: DateSource;
}

// ---------------------------------------------------------------------------
// Lifecycle event history
// ---------------------------------------------------------------------------

// One lifecycle transition (or baseline observation) for one person. The list
// for a lead is append-only and ordered by observation; repeats are legal.
export interface LifecycleEvent {
  leadId: string;
  // Previous stage when known. null means this is the first observation of the
  // lead and no earlier stage was ever seen (a baseline, not a transition).
  fromStage: StageKey | null;
  toStage: StageKey;
  // The day the transition actually happened, when a source asserts one.
  effectiveDate: string | null;
  // When the event was recorded/observed (full ISO timestamp or date).
  observedAt: string;
  dateSource: DateSource;
  // Raw source values or a provenance reference for audits. Never used in
  // calculations.
  raw?: Record<string, unknown>;
  qualityFlags?: CohortIssueKind[];
}

// The date used for asOf visibility: the effective date when asserted,
// otherwise the day we first observed the event (we cannot know an event
// before observing it).
function eventVisibleDate(e: LifecycleEvent): string | null {
  if (e.effectiveDate) return e.effectiveDate;
  const day = e.observedAt.slice(0, 10);
  return isValidIsoDate(day) ? day : null;
}

export interface LeadLifecycleAssessment {
  leadId: string;
  state: CohortResultState;
  // Original acquisition date (cohort anchor). date null when the lead's own
  // entry date was never confirmed.
  leadDate: DatedValue;
  // First VALID Lead-to-MQL conversion, or null when the lead never reached
  // MQL within asOf. A null date with a non-null firstMql means the person is
  // known to have reached MQL but the transition day is unknown.
  firstMql: DatedValue | null;
  // Later valid Lead-to-MQL events after a return to Lead. Reported as a
  // separate activity metric; never added to cohort unique MQLs.
  requalifications: number;
  // MQL-to-Lead returns seen within asOf. Recorded, never erased.
  returnsToLead: number;
  // Point-in-time stage as of asOf: the last visible event's toStage.
  currentStage: StageKey | null;
  // Days from leadDate to firstMql when both are known. 0 is a valid same-day
  // conversion.
  conversionDays: number | null;
  issues: CohortIssue[];
}

function pushIssue(issues: CohortIssue[], kind: CohortIssueKind, count = 1): void {
  const found = issues.find((i) => i.kind === kind);
  if (found) found.count += count;
  else issues.push({ kind, count });
}

function diffDays(fromIso: string, toIso: string): number {
  const from = Date.UTC(
    Number(fromIso.slice(0, 4)),
    Number(fromIso.slice(5, 7)) - 1,
    Number(fromIso.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(toIso.slice(0, 4)),
    Number(toIso.slice(5, 7)) - 1,
    Number(toIso.slice(8, 10)),
  );
  return Math.round((to - from) / 86_400_000);
}

// Assess one lead's full event history as of an explicit date. Pure: events
// after asOf are invisible (they must not appear early), and nothing is ever
// silently reordered or corrected.
export function assessLeadLifecycle(
  leadId: string,
  events: LifecycleEvent[],
  asOf: string,
): LeadLifecycleAssessment {
  const issues: CohortIssue[] = [];
  if (!isValidIsoDate(asOf)) {
    return {
      leadId,
      state: 'invalid',
      leadDate: { date: null, source: 'unknown' },
      firstMql: null,
      requalifications: 0,
      returnsToLead: 0,
      currentStage: null,
      conversionDays: null,
      issues: [{ kind: 'invalid_as_of', count: 1 }],
    };
  }

  const visible = events.filter((e) => {
    const d = eventVisibleDate(e);
    return d !== null && d <= asOf;
  });

  if (visible.length === 0) {
    return {
      leadId,
      state: 'missing',
      leadDate: { date: null, source: 'unknown' },
      firstMql: null,
      requalifications: 0,
      returnsToLead: 0,
      currentStage: null,
      conversionDays: null,
      issues,
    };
  }

  // Original acquisition date: the first visible event that entered 'lead'.
  const leadEvent = visible.find((e) => e.toStage === 'lead');
  let leadDate: DatedValue;
  if (leadEvent) {
    leadDate = { date: leadEvent.effectiveDate, source: leadEvent.dateSource };
    if (!leadEvent.effectiveDate) pushIssue(issues, 'missing_lead_date');
  } else {
    // Known only at MQL or later; the acquisition date was never seen.
    leadDate = { date: null, source: 'unknown' };
    pushIssue(issues, 'missing_lead_date');
  }

  let firstMql: DatedValue | null = null;
  let requalifications = 0;
  let returnsToLead = 0;
  let invalid = false;
  let returnedSinceMql = false;

  for (const e of visible) {
    if (e.qualityFlags) {
      for (const flag of e.qualityFlags) pushIssue(issues, flag);
      if (e.qualityFlags.includes('mql_before_lead') || e.qualityFlags.includes('stage_date_contradiction')) {
        invalid = true;
      }
    }
    if (e.toStage === 'lead' && e.fromStage === 'mql') {
      returnsToLead += 1;
      if (firstMql) returnedSinceMql = true;
      continue;
    }
    if (e.toStage !== 'mql') continue;

    // Reverse dating: a confirmed or observed MQL day earlier than the
    // confirmed Lead day is flagged, never swapped.
    if (e.effectiveDate && leadDate.date && e.effectiveDate < leadDate.date) {
      pushIssue(issues, 'mql_before_lead');
      invalid = true;
      continue;
    }
    if (!firstMql) {
      firstMql = e.effectiveDate
        ? { date: e.effectiveDate, source: e.dateSource }
        : { date: null, source: e.dateSource };
      if (!e.effectiveDate) pushIssue(issues, 'unknown_mql_transition_date');
    } else if (returnedSinceMql) {
      requalifications += 1;
      returnedSinceMql = false;
    }
    // A repeated MQL observation without an intervening return is the same
    // state seen again, not a new conversion; it counts nowhere.
  }

  const last = visible[visible.length - 1];
  const conversionDays =
    firstMql?.date && leadDate.date ? diffDays(leadDate.date, firstMql.date) : null;

  let state: CohortResultState = 'complete';
  if (invalid) state = 'invalid';
  else if (issues.length > 0) state = 'incomplete';

  return {
    leadId,
    state,
    leadDate,
    firstMql,
    requalifications,
    returnsToLead,
    currentStage: last ? last.toStage : null,
    conversionDays,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Observation-to-events seam (future ingestion contract)
// ---------------------------------------------------------------------------

// One synchronization observation in the shape a future validated n8n feed
// would deliver: the stage the source reports now, the confirmed dates it
// asserts (when it asserts them), and when we saw it. This is the seam where
// "first sync is a baseline observation, not proof of when the stage began"
// is enforced.
export interface LifecycleObservation {
  leadId: string;
  currentStage: StageKey;
  // Confirmed Salesforce dates when supplied. Exact API field names are an
  // open item; see docs/funnel-source-contract.md.
  confirmedLeadDate: string | null;
  confirmedMqlDate: string | null;
  observedAt: string;
  // The stage this system last knew for the lead. null/undefined means this
  // is the first known observation, which establishes the acquisition
  // baseline exactly once. 'lead' followed by an MQL observation is an
  // observed transition; 'mql' followed by a Lead observation is a return.
  priorKnownStage?: StageKey | null;
  // True when an MQL stage was already seen for this lead in an earlier
  // observation. Distinguishes the residual historical MQL date Salesforce
  // keeps after a return (expected, not flagged) from a genuine stage/date
  // contradiction. eventsFromObservations threads this automatically.
  mqlSeenBefore?: boolean;
  raw?: Record<string, unknown>;
}

export interface ObservationResult {
  events: LifecycleEvent[];
  issues: CohortIssue[];
  // True when the record should be routed to human review instead of being
  // silently corrected (contradictions, reverse dates).
  reviewRequired: boolean;
}

// Build one Lead-to-MQL transition event: the confirmed MQL date when valid,
// otherwise the observation day marked as observed. Reverse dates are flagged,
// never swapped.
function mqlTransitionEvent(
  obs: LifecycleObservation,
  issues: CohortIssue[],
): { event: LifecycleEvent; reviewRequired: boolean } {
  if (obs.confirmedMqlDate) {
    const flags: CohortIssueKind[] = [];
    let reviewRequired = false;
    if (obs.confirmedLeadDate && obs.confirmedMqlDate < obs.confirmedLeadDate) {
      flags.push('mql_before_lead');
      pushIssue(issues, 'mql_before_lead');
      reviewRequired = true;
    }
    return {
      event: {
        leadId: obs.leadId,
        fromStage: 'lead',
        toStage: 'mql',
        effectiveDate: obs.confirmedMqlDate,
        observedAt: obs.observedAt,
        dateSource: 'salesforce_confirmed',
        raw: obs.raw,
        qualityFlags: flags.length ? flags : undefined,
      },
      reviewRequired,
    };
  }
  // No confirmed date: the only honest date is the observation day, marked
  // observed rather than confirmed.
  const day = obs.observedAt.slice(0, 10);
  return {
    event: {
      leadId: obs.leadId,
      fromStage: 'lead',
      toStage: 'mql',
      effectiveDate: isValidIsoDate(day) ? day : null,
      observedAt: obs.observedAt,
      dateSource: 'n8n_observed',
      raw: obs.raw,
    },
    reviewRequired: false,
  };
}

// Convert one observation into lifecycle events without inventing anything:
// unknown stays unknown, observed stays observed, contradictions are flagged.
//
// The acquisition baseline is emitted only on the FIRST known observation
// (priorKnownStage null/undefined); later observations emit only the
// transition they evidence, so an unchanged stage emits nothing and
// reprocessing the same observation is idempotent.
export function eventsFromObservation(obs: LifecycleObservation): ObservationResult {
  const issues: CohortIssue[] = [];
  const events: LifecycleEvent[] = [];
  let reviewRequired = false;
  const prior = obs.priorKnownStage ?? null;

  if (prior === null) {
    // First known observation: establish the original acquisition exactly
    // once. Later observations never re-emit or alter it.
    events.push({
      leadId: obs.leadId,
      fromStage: null,
      toStage: 'lead',
      effectiveDate: obs.confirmedLeadDate,
      observedAt: obs.observedAt,
      dateSource: obs.confirmedLeadDate ? 'salesforce_confirmed' : 'unknown',
      raw: obs.raw,
    });
    if (!obs.confirmedLeadDate) pushIssue(issues, 'missing_lead_date');

    if (obs.currentStage === 'lead') {
      // A confirmed MQL date on a first record that claims to still be a Lead
      // is a contradiction: flag it for review, do not fabricate an MQL event.
      if (obs.confirmedMqlDate) {
        pushIssue(issues, 'stage_date_contradiction');
        reviewRequired = true;
      }
      return { events, issues, reviewRequired };
    }
    // Already MQL at first sight.
    if (obs.confirmedMqlDate) {
      const t = mqlTransitionEvent(obs, issues);
      events.push(t.event);
      return { events, issues, reviewRequired: t.reviewRequired };
    }
    // Stage is known but the historical transition date is not. Do not
    // invent one.
    pushIssue(issues, 'unknown_mql_transition_date');
    events.push({
      leadId: obs.leadId,
      fromStage: null,
      toStage: 'mql',
      effectiveDate: null,
      observedAt: obs.observedAt,
      dateSource: 'unknown',
      raw: obs.raw,
    });
    return { events, issues, reviewRequired };
  }

  if (prior === obs.currentStage) {
    // Unchanged stage: a re-observation of the same state is not a lifecycle
    // transition. No events; reprocessing is idempotent. The one thing worth
    // flagging: a confirmed MQL date appearing while the stage claims Lead
    // and MQL was never seen (either dirty data or a round trip that
    // happened entirely between observations). After a seen MQL, the
    // residual historical date Salesforce keeps is expected.
    if (
      obs.currentStage === 'lead' &&
      obs.confirmedMqlDate &&
      obs.mqlSeenBefore !== true
    ) {
      pushIssue(issues, 'stage_date_contradiction');
      reviewRequired = true;
    }
    return { events, issues, reviewRequired };
  }

  if (prior === 'lead' && obs.currentStage === 'mql') {
    // Observed Lead-to-MQL transition (first conversion or, after a return,
    // a requalification; assessLeadLifecycle tells them apart). The original
    // Lead cohort date is never touched here.
    const t = mqlTransitionEvent(obs, issues);
    events.push(t.event);
    return { events, issues, reviewRequired: t.reviewRequired };
  }

  // prior === 'mql' && currentStage === 'lead': a return to Lead. The
  // Became a Lead Date is the original acquisition, never the regression
  // day, so the only honest date for the return is the observation day.
  const day = obs.observedAt.slice(0, 10);
  events.push({
    leadId: obs.leadId,
    fromStage: 'mql',
    toStage: 'lead',
    effectiveDate: isValidIsoDate(day) ? day : null,
    observedAt: obs.observedAt,
    dateSource: 'n8n_observed',
    raw: obs.raw,
  });
  return { events, issues, reviewRequired };
}

// Fold an observation series for ONE lead into its lifecycle event history.
// Observations are put into stable observation order first (sorted by
// observedAt, ties keeping input order), then prior stage and MQL-seen state
// are threaded automatically, so callers cannot produce duplicate baselines
// or missed returns by mis-threading priorKnownStage themselves.
// assessLeadLifecycle expects events in exactly this observation order.
export function eventsFromObservations(
  observations: LifecycleObservation[],
): ObservationResult {
  const ordered = observations
    .map((obs, index) => ({ obs, index }))
    .sort((a, b) => {
      if (a.obs.observedAt < b.obs.observedAt) return -1;
      if (a.obs.observedAt > b.obs.observedAt) return 1;
      return a.index - b.index;
    })
    .map((x) => x.obs);

  const events: LifecycleEvent[] = [];
  const issues: CohortIssue[] = [];
  let reviewRequired = false;
  let prior: StageKey | null = null;
  let mqlSeen = false;
  let first = true;

  for (const obs of ordered) {
    const r = eventsFromObservation({
      ...obs,
      // The caller may seed prior knowledge for the first observation only;
      // afterwards the threaded state is authoritative.
      priorKnownStage: first ? (obs.priorKnownStage ?? null) : prior,
      mqlSeenBefore: first ? (obs.mqlSeenBefore ?? false) : mqlSeen,
    });
    events.push(...r.events);
    for (const issue of r.issues) pushIssue(issues, issue.kind, issue.count);
    reviewRequired = reviewRequired || r.reviewRequired;
    prior = obs.currentStage;
    if (obs.currentStage === 'mql') mqlSeen = true;
    first = false;
  }

  return { events, issues, reviewRequired };
}

// ---------------------------------------------------------------------------
// Acquisition cohort reporting
// ---------------------------------------------------------------------------

export interface LeadLifecycleInput {
  leadId: string;
  events: LifecycleEvent[];
}

export interface CohortMaturity {
  periodEnd: string;
  asOf: string;
  // Days from the cohort period's end to asOf. Negative means asOf is inside
  // the period (the cohort is still open). Newer cohorts have had less time
  // to mature, so efficiency across cohorts of different maturity is not
  // directly comparable.
  maturityDays: number;
}

export interface AcquisitionCohortReport {
  state: CohortResultState;
  period: ReportingPeriod;
  asOf: string;
  // Unique people whose original Lead date falls inside the period. This IS
  // the total unique-person count for the cohort; stage counts below are
  // non-additive memberships of the same people.
  uniqueLeads: number;
  leads: number; // alias of uniqueLeads, kept explicit for display parity
  // Cohort members who ever reached MQL within asOf (first valid conversion
  // only). Never added to leads to make a total.
  mqls: number;
  // Of the mqls above, how many have an unknown transition day (counted from
  // observation evidence, flagged for disclosure).
  mqlsWithUnknownDate: number;
  // Requalification activity (later Lead-to-MQL events) as a separate metric.
  requalifications: number;
  // Lead-to-MQL efficiency percent (mqls / uniqueLeads * 100), null when the
  // cohort is empty.
  efficiencyPercent: number | null;
  maturity: CohortMaturity | null;
  // True when a delta against another period must be suppressed (partial
  // cohort window or data-quality problems).
  suppressDelta: boolean;
  // Leads in the input population whose acquisition date is unknown; they
  // cannot be placed in any cohort and are disclosed, not dropped silently.
  unplaceableLeads: number;
  issues: CohortIssue[];
}

function invalidCohortReport(
  period: ReportingPeriod,
  asOf: string,
  kind: CohortIssueKind,
): AcquisitionCohortReport {
  return {
    state: 'invalid',
    period,
    asOf,
    uniqueLeads: 0,
    leads: 0,
    mqls: 0,
    mqlsWithUnknownDate: 0,
    requalifications: 0,
    efficiencyPercent: null,
    maturity: null,
    suppressDelta: true,
    unplaceableLeads: 0,
    issues: [{ kind, count: 1 }],
  };
}

// Build the acquisition cohort for one period as of an explicit date.
// Membership anchors to the original Lead date; later-quarter MQL transitions
// update this cohort rather than moving the person.
export function acquisitionCohortReport(
  lifecycles: LeadLifecycleInput[],
  period: ReportingPeriod,
  asOf: string,
): AcquisitionCohortReport {
  if (!isValidIsoDate(asOf)) return invalidCohortReport(period, asOf, 'invalid_as_of');
  const bounds = periodBounds(period);
  if (!bounds) return invalidCohortReport(period, asOf, 'invalid_period');

  const issues: CohortIssue[] = [];
  const seen = new Set<string>();
  const members: LeadLifecycleAssessment[] = [];
  let unplaceable = 0;

  for (const input of lifecycles) {
    if (seen.has(input.leadId)) {
      pushIssue(issues, 'duplicate_lead_id');
      continue;
    }
    seen.add(input.leadId);
    const a = assessLeadLifecycle(input.leadId, input.events, asOf);
    if (a.state === 'missing') continue;
    if (!a.leadDate.date) {
      unplaceable += 1;
      continue;
    }
    if (a.leadDate.date >= bounds.start && a.leadDate.date <= bounds.end) {
      members.push(a);
    }
  }

  let mqls = 0;
  let mqlsWithUnknownDate = 0;
  let requalifications = 0;
  let invalidMembers = 0;
  for (const m of members) {
    if (m.state === 'invalid') {
      invalidMembers += 1;
      continue;
    }
    if (m.firstMql) {
      mqls += 1;
      if (!m.firstMql.date) {
        mqlsWithUnknownDate += 1;
        pushIssue(issues, 'mql_timing_unknown');
      }
    }
    requalifications += m.requalifications;
  }
  if (invalidMembers > 0) pushIssue(issues, 'invalid_member_lifecycle', invalidMembers);

  const maturity: CohortMaturity = {
    periodEnd: bounds.end,
    asOf,
    maturityDays: diffDays(bounds.end, asOf),
  };
  if (maturity.maturityDays < 0) pushIssue(issues, 'as_of_before_period_end');

  const uniqueLeads = members.length;
  let state: CohortResultState = 'complete';
  if (uniqueLeads === 0) state = 'missing';
  else if (issues.length > 0 || unplaceable > 0) state = 'incomplete';

  return {
    state,
    period,
    asOf,
    uniqueLeads,
    leads: uniqueLeads,
    mqls,
    mqlsWithUnknownDate,
    requalifications,
    efficiencyPercent: uniqueLeads > 0 ? (mqls / uniqueLeads) * 100 : null,
    maturity,
    suppressDelta: state !== 'complete',
    unplaceableLeads: unplaceable,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Cohort comparison with the maturity limitation made explicit
// ---------------------------------------------------------------------------

export interface CohortComparison {
  // Volume deltas are calculable across cohorts of different maturity.
  leadsDelta: DeltaResult;
  mqlsDelta: DeltaResult;
  // Efficiency is maturity-sensitive: a newer cohort has had less time to
  // convert, so its efficiency is not directly comparable.
  efficiencyDelta: DeltaResult;
  maturityComparable: boolean;
  // True when the efficiency delta should not be presented as a like-for-like
  // change. Volume deltas carry their own delta kinds and are unaffected.
  suppressEfficiencyDelta: boolean;
  suppressReasons: string[];
}

// No maturity-alignment rule has been selected by the business yet, so the
// default is to expose the limitation and suppress the efficiency delta when
// cohort maturities differ. 'compare_anyway' exists for explicit opt-in once
// a rule is decided; it never becomes a silent default.
export type MaturityRule = 'none_selected' | 'compare_anyway';

export function compareAcquisitionCohorts(
  current: AcquisitionCohortReport,
  comparison: AcquisitionCohortReport,
  maturityRule: MaturityRule = 'none_selected',
): CohortComparison {
  const metric = (r: AcquisitionCohortReport, v: number) =>
    r.state === 'missing' || r.state === 'invalid'
      ? ({ state: 'missing' } as const)
      : ({ state: 'present', value: v } as const);

  const leadsDelta = computeDelta(
    metric(current, current.uniqueLeads),
    metric(comparison, comparison.uniqueLeads),
    'higher_is_better',
  );
  const mqlsDelta = computeDelta(
    metric(current, current.mqls),
    metric(comparison, comparison.mqls),
    'higher_is_better',
  );
  const efficiencyDelta = computeRateDelta(
    current.efficiencyPercent === null
      ? { state: 'missing' }
      : { state: 'present', value: current.efficiencyPercent },
    comparison.efficiencyPercent === null
      ? { state: 'missing' }
      : { state: 'present', value: comparison.efficiencyPercent },
    'higher_is_better',
  );

  const maturityComparable =
    current.maturity !== null &&
    comparison.maturity !== null &&
    current.maturity.maturityDays === comparison.maturity.maturityDays;

  const suppressReasons: string[] = [];
  if (!maturityComparable && maturityRule !== 'compare_anyway') {
    suppressReasons.push('unequal_cohort_maturity');
  }
  if (current.suppressDelta) suppressReasons.push('current_cohort_incomplete');
  if (comparison.suppressDelta) suppressReasons.push('comparison_cohort_incomplete');

  return {
    leadsDelta,
    mqlsDelta,
    efficiencyDelta,
    maturityComparable,
    suppressEfficiencyDelta: suppressReasons.length > 0,
    suppressReasons,
  };
}

// ---------------------------------------------------------------------------
// Deal (opportunity) uniqueness and stage progression
// ---------------------------------------------------------------------------

// Synthetic mirror of one attribution stage row. One logical deal shares
// deal_id across its stage rows; each row is progression evidence, not a
// separate opportunity.
export interface DealStageRow {
  dealId: string | null;
  stage: AttributionStageKey;
  stageEnteredAt: string | null; // ISO date the deal entered THIS stage
  leadId?: string | null;
}

export interface DealStageSummary {
  state: CohortResultState;
  asOf: string;
  // Distinct non-blank deal_ids visible as of asOf. Never the sum of stage
  // counts.
  uniqueDeals: number;
  // Distinct deals that have reached each stage as of asOf. Memberships
  // overlap by design (one deal can appear at every stage it reached).
  stageCounts: Record<AttributionStageKey, number>;
  // Distinct deals per linked lead. A lead sourcing two deals contributes two
  // unique opportunities.
  dealCountByLead: Record<string, number>;
  // Rows with a blank deal_id: they break the unique-opportunity total and
  // are excluded from it, never guessed into a deal.
  uniqueTotalTrustworthy: boolean;
  issues: CohortIssue[];
}

const DEAL_STAGES: AttributionStageKey[] = ['hpp', 'opp', 'pursuit', 'closeWon', 'closeLost'];

function emptyStageCounts(): Record<AttributionStageKey, number> {
  return { hpp: 0, opp: 0, pursuit: 0, closeWon: 0, closeLost: 0 };
}

export function summarizeDealStages(rows: DealStageRow[], asOf: string): DealStageSummary {
  const issues: CohortIssue[] = [];
  if (!isValidIsoDate(asOf)) {
    return {
      state: 'invalid',
      asOf,
      uniqueDeals: 0,
      stageCounts: emptyStageCounts(),
      dealCountByLead: {},
      uniqueTotalTrustworthy: false,
      issues: [{ kind: 'invalid_as_of', count: 1 }],
    };
  }

  const stageSets = new Map<AttributionStageKey, Set<string>>(
    DEAL_STAGES.map((s) => [s, new Set<string>()]),
  );
  const deals = new Set<string>();
  const dealLeads = new Map<string, Set<string>>(); // leadId -> dealIds
  const seenDealStage = new Set<string>();
  let missingDealId = 0;

  for (const row of rows) {
    const dealId = row.dealId?.trim() || null;
    if (!dealId) {
      missingDealId += 1;
      continue;
    }
    if (!row.stageEnteredAt) {
      pushIssue(issues, 'missing_stage_date');
      continue;
    }
    if (row.stageEnteredAt > asOf) continue;
    const key = `${dealId}::${row.stage}`;
    if (seenDealStage.has(key)) {
      pushIssue(issues, 'duplicate_deal_stage');
      continue;
    }
    seenDealStage.add(key);
    deals.add(dealId);
    stageSets.get(row.stage)!.add(dealId);
    if (row.leadId) {
      if (!dealLeads.has(row.leadId)) dealLeads.set(row.leadId, new Set());
      dealLeads.get(row.leadId)!.add(dealId);
    }
  }

  if (missingDealId > 0) pushIssue(issues, 'missing_deal_id', missingDealId);

  const stageCounts = emptyStageCounts();
  for (const s of DEAL_STAGES) stageCounts[s] = stageSets.get(s)!.size;

  const dealCountByLead: Record<string, number> = {};
  for (const [leadId, set] of dealLeads) dealCountByLead[leadId] = set.size;

  let state: CohortResultState = 'complete';
  if (deals.size === 0 && rows.length === 0) state = 'missing';
  else if (issues.length > 0) state = 'incomplete';

  return {
    state,
    asOf,
    uniqueDeals: deals.size,
    stageCounts,
    dealCountByLead,
    uniqueTotalTrustworthy: missingDealId === 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// HPP-anchored deal cohort progression
// ---------------------------------------------------------------------------

export interface DealCohortReport {
  state: CohortResultState;
  period: ReportingPeriod;
  asOf: string;
  // Deals whose HPP entry date falls inside the period. This is the cohort's
  // unique-opportunity total; stage counts below are progression of the SAME
  // deals and never sum to a total.
  uniqueDeals: number;
  stageCounts: Record<AttributionStageKey, number>;
  maturity: CohortMaturity | null;
  suppressDelta: boolean;
  issues: CohortIssue[];
}

// A deal entering HPP in Q2 stays in the Q2 HPP cohort; an OPP or Pursuit
// entry in Q3 (visible as of asOf) updates the Q2 cohort's progression.
export function dealCohortReport(
  rows: DealStageRow[],
  period: ReportingPeriod,
  asOf: string,
): DealCohortReport {
  const bounds = periodBounds(period);
  if (!isValidIsoDate(asOf) || !bounds) {
    return {
      state: 'invalid',
      period,
      asOf,
      uniqueDeals: 0,
      stageCounts: emptyStageCounts(),
      maturity: null,
      suppressDelta: true,
      issues: [{ kind: !isValidIsoDate(asOf) ? 'invalid_as_of' : 'invalid_period', count: 1 }],
    };
  }

  const summary = summarizeDealStages(rows, asOf);
  const issues: CohortIssue[] = summary.issues.map((i) => ({ ...i }));

  // Cohort membership: deals whose (deduplicated) HPP entry is in the period.
  const cohort = new Set<string>();
  const seenHpp = new Set<string>();
  for (const row of rows) {
    const dealId = row.dealId?.trim() || null;
    if (!dealId || row.stage !== 'hpp' || !row.stageEnteredAt) continue;
    if (seenHpp.has(dealId)) continue;
    seenHpp.add(dealId);
    if (
      row.stageEnteredAt >= bounds.start &&
      row.stageEnteredAt <= bounds.end &&
      row.stageEnteredAt <= asOf
    ) {
      cohort.add(dealId);
    }
  }

  // Progression: cohort deals that reached each stage as of asOf, whenever
  // that later entry happened.
  const stageCounts = emptyStageCounts();
  const seenStage = new Set<string>();
  for (const row of rows) {
    const dealId = row.dealId?.trim() || null;
    if (!dealId || !cohort.has(dealId)) continue;
    if (!row.stageEnteredAt || row.stageEnteredAt > asOf) continue;
    const key = `${dealId}::${row.stage}`;
    if (seenStage.has(key)) continue;
    seenStage.add(key);
    stageCounts[row.stage] += 1;
  }

  const maturity: CohortMaturity = {
    periodEnd: bounds.end,
    asOf,
    maturityDays: diffDays(bounds.end, asOf),
  };
  if (maturity.maturityDays < 0) pushIssue(issues, 'as_of_before_period_end');

  let state: CohortResultState = 'complete';
  if (cohort.size === 0) state = 'missing';
  else if (issues.length > 0) state = 'incomplete';

  return {
    state,
    period,
    asOf,
    uniqueDeals: cohort.size,
    stageCounts,
    maturity,
    suppressDelta: state !== 'complete',
    issues,
  };
}
