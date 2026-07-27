// opportunityStageHistory.ts: pure Salesforce Opportunity movement and
// velocity contract (Bite 5A).
//
// The Salesforce funnel level of an Opportunity is its Record Type (HPP /
// Opportunity / Pursuit), not the detailed Stage field. Movement between
// levels is non-monotonic in reality: deals start at any level, skip levels,
// regress, re-enter, park in excluded types such as Nurture, and close or
// reopen through the separate Stage field. This module turns
// OpportunityFieldHistory-shaped rows into:
//
//   1. An append-only movement ledger. Historical events are never deleted
//      or overwritten; regressions and excluded-state visits stay on record.
//   2. A derived current view per Opportunity: the visible funnel stage, the
//      ACTIVE entry date per stage (a regression clears higher-stage dates
//      from the derived path only), terminal status, movement counts, and
//      current-path velocity intervals.
//
// Follows the hardened source-validation patterns of the lead-history
// adapter (salesforceLifecycleHistory.ts): history-record Id is the
// idempotency key, exact duplicates are informational, conflicting
// duplicates and malformed rows go to review, invalid configuration rejects
// the run, unknown record-type values are retained as evidence but never
// mapped to a visible stage, and today's date is never substituted.
//
// This is a calculation/audit foundation only: not wired into dashboards,
// Create HPP, attributions, Supabase, or n8n. No RecordType IDs are
// hardcoded; classification uses a closed, validated, configurable mapping
// of record-type labels and developer names.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpportunityFunnelStage = 'hpp' | 'opp' | 'pursuit';

export type OpportunityRecordTypeState = OpportunityFunnelStage | 'out_of_scope';

// A ledger event's endpoint: a mapped state, or 'unknown' when the source
// carried a record-type value the configuration does not recognize. Unknown
// is retained as evidence and flagged, never shown as a funnel stage.
export type OpportunityEventState = OpportunityRecordTypeState | 'unknown';

export type OpportunityTerminalState =
  | 'open'
  | 'won'
  | 'lost'
  | 'disqualified'
  | 'nurture'
  | 'unknown';

// One Salesforce field-history row in source-neutral shape.
export interface OpportunityHistoryRow {
  historyId: string;
  opportunityId: string;
  // The changed field's label/name as reported by the history object.
  field: string;
  oldValue: string | null;
  newValue: string | null;
  // Full history CreatedDate timestamp. Date-only ordering is not enough:
  // multiple movements can happen on one day, so the full timestamp orders
  // events, with the history Id as the deterministic tie-break.
  changedAt: string;
  raw?: Record<string, unknown>;
}

// A current-record observation for an Opportunity with no retained
// record-type history: its present record type as of an export. Used as an
// observed baseline; the entry date is unknown and never invented.
export interface OpportunityBaselineObservation {
  opportunityId: string;
  recordTypeValue: string;
  observedAt: string;
  sourceId: string;
}

export interface OpportunityStageConfig {
  // History field label carrying record-type changes (for example
  // 'Opportunity Record Type' in report exports, 'RecordType' via API).
  recordTypeFieldName: string;
  // Closed mapping from exact record-type values (labels, legacy labels,
  // developer names) to funnel states. Values not present are unknown and
  // route to review. Never keyed by RecordType Id.
  recordTypeMap: Record<string, OpportunityRecordTypeState>;
  // Optional: the history field label for the detailed Stage field, plus the
  // mapping of terminal stage values and the closed set of KNOWN open stage
  // values. A stage value in neither set is unknown: it is flagged for
  // review and never closes or reopens the opportunity. Detailed Stage
  // values are never funnel levels.
  stageFieldName?: string;
  terminalStageMap?: Record<string, Exclude<OpportunityTerminalState, 'open' | 'unknown'>>;
  openStageValues?: string[];
}

// The observed closed Stage labels, verified against the July 2026 read-only
// audit. Exact source spellings.
export const DEFAULT_OPPORTUNITY_TERMINAL_STAGE_MAP: Record<
  string,
  Exclude<OpportunityTerminalState, 'open' | 'unknown'>
> = {
  '100) Closed-Won': 'won',
  'Closed-Lost-Competitor': 'lost',
  'Closed-Lost-InHouse': 'lost',
  'Closed-Disqualified': 'disqualified',
  'Closed-Nurture': 'nurture',
};

// The observed open Stage labels. 'Opportunity Assesment' preserves the
// Salesforce org's own spelling; source data is matched as-is, never
// silently corrected.
export const DEFAULT_OPPORTUNITY_OPEN_STAGE_VALUES: string[] = [
  '1) Suspect',
  '2) Opportunity Assesment',
  '3) Qualification',
  '4) Discovery',
  '5) Pitching',
  '6) POC',
  '7) Proposal',
  '8) Negotiation',
  '10) Awaiting Execution',
];

// The confirmed record-type mapping including legacy labels and developer
// names, verified complete against the July 2026 history export (every
// observed value maps). RecordType IDs are deliberately absent.
export const DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP: Record<string, OpportunityRecordTypeState> = {
  'High Potential Prospect': 'hpp',
  High_Potential_Prospect: 'hpp',
  Opportunity: 'opp',
  Leads: 'opp',
  'Sales Accepted Opportunity': 'opp',
  Pursuit: 'pursuit',
  Licensing: 'pursuit',
  'Sales Qualified Opportunity': 'pursuit',
  Nurture: 'out_of_scope',
  // Business-confirmed (2026-07-27): Service engagements are not funnel
  // deals. Historical Service movements stay in the append-only ledger; a
  // current Service opportunity is excluded from the visible funnel and
  // from the future review queue.
  Service: 'out_of_scope',
};

// ---------------------------------------------------------------------------
// Ledger events
// ---------------------------------------------------------------------------

// One append-only record-type movement. Events are never deleted or
// rewritten; the derived current view is computed FROM them.
export interface OpportunityStageEvent {
  sourceHistoryId: string;
  salesforceOpportunityId: string;
  fromState: OpportunityEventState | null;
  toState: OpportunityEventState;
  changedAt: string;
  source: 'salesforce_history' | 'baseline_observation';
  // True when this event records "we observed the deal already in this
  // state" rather than a witnessed transition.
  baselineObservation: boolean;
  // False on the first event for a deal whose prior state predates retained
  // history (its earlier entry dates are unknown).
  historyKnownBefore: boolean;
  // Raw source values for diagnostics; never used for display.
  rawRecordType?: { oldValue: string | null; newValue: string | null };
}

// One terminal-status change derived from the detailed Stage field,
// represented separately from record-type movement.
export interface OpportunityTerminalEvent {
  sourceHistoryId: string;
  salesforceOpportunityId: string;
  fromStatus: OpportunityTerminalState;
  toStatus: OpportunityTerminalState;
  changedAt: string;
  rawStage: { oldValue: string | null; newValue: string | null };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type OpportunityIssueKind =
  | 'invalid_config'
  | 'invalid_source_row'
  | 'invalid_history_timestamp'
  | 'conflicting_duplicate_history_id'
  | 'unknown_record_type'
  | 'unknown_stage_value'
  | 'ambiguous_same_timestamp'
  | 'incomplete_baseline'
  | 'inconsistent_path_dates';

export interface OpportunityIssue {
  kind: OpportunityIssueKind;
  count: number;
}

export interface OpportunityReviewItem {
  reason: OpportunityIssueKind;
  historyId?: string;
  opportunityId?: string;
}

export interface OpportunityVelocity {
  // Days between ACTIVE entry dates on the current valid path. null means
  // unavailable (stage skipped, regressed away, or entry date unknown),
  // never zero: only a real same-day transition may be 0.
  hppToOppDays: number | null;
  oppToPursuitDays: number | null;
  // Direct HPP-to-Pursuit interval, available only when Opportunity was
  // skipped on the current path (both endpoint dates known, opp null).
  hppToPursuitDays: number | null;
}

export interface OpportunityDerivedState {
  opportunityId: string;
  // The current operational funnel stage; null while out of scope, unknown,
  // or never classified. Each Opportunity appears at most once here.
  currentStage: OpportunityFunnelStage | null;
  // Raw current state including out_of_scope/unknown, for diagnostics.
  currentState: OpportunityEventState | null;
  // ACTIVE entry dates on the current path. A regression clears the higher
  // stages here (the ledger keeps the events); a skipped stage stays null;
  // re-entry uses the latest valid entry date; a baseline-observed stage has
  // an unknown (null) entry date.
  activeDates: Record<OpportunityFunnelStage, string | null>;
  terminalStatus: OpportunityTerminalState;
  forwardMoves: number;
  backwardMoves: number;
  skips: { forward: number; backward: number };
  reEntries: Record<OpportunityFunnelStage, number>;
  incompleteBaseline: boolean;
  velocity: OpportunityVelocity;
  issues: OpportunityIssue[];
  // Complete enough for reporting: the current state is classified and no
  // review-blocking issue affects this deal. Velocity nulls do not block
  // reportability; they are individually suppressed.
  reportable: boolean;
}

export interface OpportunityHistoryResult {
  state: 'complete' | 'incomplete' | 'missing' | 'invalid';
  opportunities: OpportunityDerivedState[];
  // Append-only ledgers: every movement and terminal change, including
  // regressions, skips, re-entries, and excluded-state visits.
  ledger: OpportunityStageEvent[];
  terminalLedger: OpportunityTerminalEvent[];
  review: OpportunityReviewItem[];
  duplicatesIgnored: number;
  otherFieldRowsIgnored: number;
  issues: OpportunityIssue[];
}

// The current operational funnel lens: each Opportunity exactly once.
export interface OpportunityFunnelSnapshot {
  counts: Record<OpportunityFunnelStage, number>;
  outOfScope: number;
  unknown: number;
  totalUnique: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const STAGE_RANK: Record<OpportunityFunnelStage, number> = { hpp: 1, opp: 2, pursuit: 3 };
const FUNNEL_STAGES: OpportunityFunnelStage[] = ['hpp', 'opp', 'pursuit'];
const LEGAL_RECORD_TYPE_STATES: ReadonlySet<string> = new Set(['hpp', 'opp', 'pursuit', 'out_of_scope']);
const LEGAL_TERMINAL_STATES: ReadonlySet<string> = new Set(['won', 'lost', 'disqualified', 'nurture']);

const TIME_PART = /^T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const DATE_PART = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidCalendarDate(value: string): boolean {
  const m = DATE_PART.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2200) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

function isValidHistoryTimestamp(value: string): boolean {
  if (!isValidCalendarDate(value.slice(0, 10))) return false;
  const rest = value.slice(10);
  return rest === '' || TIME_PART.test(rest);
}

function sameRowContent(a: OpportunityHistoryRow, b: OpportunityHistoryRow): boolean {
  return (
    a.opportunityId === b.opportunityId &&
    a.field === b.field &&
    a.oldValue === b.oldValue &&
    a.newValue === b.newValue &&
    a.changedAt === b.changedAt
  );
}

function diffDays(fromIso: string, toIso: string): number {
  const from = Date.UTC(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)));
  const to = Date.UTC(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)));
  return Math.round((to - from) / 86_400_000);
}

function pushIssue(issues: OpportunityIssue[], kind: OpportunityIssueKind, count = 1): void {
  const found = issues.find((i) => i.kind === kind);
  if (found) found.count += count;
  else issues.push({ kind, count });
}

type MappedRecordType =
  | { kind: 'state'; state: OpportunityRecordTypeState }
  | { kind: 'blank' }
  | { kind: 'unknown' };

function mapRecordType(value: string | null, config: OpportunityStageConfig): MappedRecordType {
  if (value === null || value.trim() === '') return { kind: 'blank' };
  const mapped = config.recordTypeMap[value.trim()];
  if (mapped === undefined) return { kind: 'unknown' };
  return { kind: 'state', state: mapped };
}

type MappedStageValue =
  | { kind: 'terminal'; status: Exclude<OpportunityTerminalState, 'open' | 'unknown'> }
  | { kind: 'open' }
  | { kind: 'blank' }
  | { kind: 'unknown' };

// Classify a detailed Stage value against the CLOSED sets of known terminal
// and known open labels. Anything else is unknown: it is never allowed to
// close or reopen an opportunity on its own.
function mapStageValue(value: string | null, config: OpportunityStageConfig): MappedStageValue {
  if (value === null || value.trim() === '') return { kind: 'blank' };
  const v = value.trim();
  const terminal = config.terminalStageMap?.[v];
  if (terminal !== undefined) return { kind: 'terminal', status: terminal };
  if (config.openStageValues?.includes(v)) return { kind: 'open' };
  return { kind: 'unknown' };
}

// One derived-path simulation state. applyPathStep is the single
// implementation of the current-path rules, used both by the main
// derivation and by same-timestamp permutation checks.
interface PathSim {
  state: OpportunityEventState | null;
  dates: Record<OpportunityFunnelStage, string | null>;
}

function applyPathStep(sim: PathSim, toState: OpportunityEventState, day: string): PathSim {
  const next: PathSim = { state: toState, dates: { ...sim.dates } };
  if (toState === 'hpp' || toState === 'opp' || toState === 'pursuit') {
    next.dates[toState] = day;
    for (const s of FUNNEL_STAGES) {
      if (STAGE_RANK[s] > STAGE_RANK[toState]) next.dates[s] = null;
    }
  }
  // out_of_scope / unknown suspend the visible stage without erasing dates.
  return next;
}

function samePathSim(a: PathSim, b: PathSim): boolean {
  return (
    a.state === b.state &&
    a.dates.hpp === b.dates.hpp &&
    a.dates.opp === b.dates.opp &&
    a.dates.pursuit === b.dates.pursuit
  );
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Adapter and derivation
// ---------------------------------------------------------------------------

export function adaptOpportunityHistory(
  rows: OpportunityHistoryRow[],
  config: OpportunityStageConfig,
  baselines: OpportunityBaselineObservation[] = [],
): OpportunityHistoryResult {
  const issues: OpportunityIssue[] = [];
  const review: OpportunityReviewItem[] = [];

  const invalidResult = (): OpportunityHistoryResult => ({
    state: 'invalid',
    opportunities: [],
    ledger: [],
    terminalLedger: [],
    review,
    duplicatesIgnored: 0,
    otherFieldRowsIgnored: 0,
    issues: [{ kind: 'invalid_config', count: 1 }],
  });

  // Configuration is validated before any record is processed.
  if (!config.recordTypeFieldName.trim()) return invalidResult();
  const mapEntries = Object.entries(config.recordTypeMap);
  if (mapEntries.length === 0) return invalidResult();
  for (const [key, state] of mapEntries) {
    if (!key.trim() || !LEGAL_RECORD_TYPE_STATES.has(state)) return invalidResult();
  }
  if (config.terminalStageMap) {
    for (const [key, state] of Object.entries(config.terminalStageMap)) {
      if (!key.trim() || !LEGAL_TERMINAL_STATES.has(state)) return invalidResult();
    }
  }
  if (config.openStageValues) {
    for (const v of config.openStageValues) {
      // A value cannot be both a known open stage and a terminal stage.
      if (!v.trim() || config.terminalStageMap?.[v.trim()] !== undefined) return invalidResult();
    }
  }

  // Source-row validation: malformed rows are reviewed, never guessed, and
  // today's date is never substituted.
  const wellFormed: OpportunityHistoryRow[] = [];
  for (const row of rows) {
    if (!row.historyId.trim() || !row.opportunityId.trim()) {
      pushIssue(issues, 'invalid_source_row');
      review.push({ reason: 'invalid_source_row', historyId: row.historyId.trim() || undefined });
      continue;
    }
    if (!isValidHistoryTimestamp(row.changedAt)) {
      pushIssue(issues, 'invalid_history_timestamp');
      review.push({ reason: 'invalid_history_timestamp', historyId: row.historyId });
      continue;
    }
    wellFormed.push(row);
  }

  // Idempotency: exact repeats are informational; conflicting content under
  // one history Id is a quality failure with no version trusted.
  const byId = new Map<string, OpportunityHistoryRow[]>();
  for (const row of wellFormed) {
    if (!byId.has(row.historyId)) byId.set(row.historyId, []);
    byId.get(row.historyId)!.push(row);
  }
  let duplicatesIgnored = 0;
  const unique: OpportunityHistoryRow[] = [];
  for (const [historyId, group] of byId) {
    const first = group[0];
    if (!group.every((r) => sameRowContent(r, first))) {
      pushIssue(issues, 'conflicting_duplicate_history_id');
      // The first-seen row's opportunity attributes the conflict to a deal
      // so the review inbox can carry it per-opportunity.
      review.push({
        reason: 'conflicting_duplicate_history_id',
        historyId,
        opportunityId: first.opportunityId,
      });
      continue;
    }
    duplicatesIgnored += group.length - 1;
    unique.push(first);
  }

  // Split by field: record-type movement, terminal stage, everything else.
  let otherFieldRowsIgnored = 0;
  const recordTypeRows = new Map<string, OpportunityHistoryRow[]>();
  const stageRows = new Map<string, OpportunityHistoryRow[]>();
  for (const row of unique) {
    if (row.field === config.recordTypeFieldName) {
      if (!recordTypeRows.has(row.opportunityId)) recordTypeRows.set(row.opportunityId, []);
      recordTypeRows.get(row.opportunityId)!.push(row);
    } else if (config.stageFieldName && row.field === config.stageFieldName) {
      if (!stageRows.has(row.opportunityId)) stageRows.set(row.opportunityId, []);
      stageRows.get(row.opportunityId)!.push(row);
    } else {
      otherFieldRowsIgnored += 1;
    }
  }

  // Deterministic order: full source timestamp, then history Id.
  const ordered = (list: OpportunityHistoryRow[]): OpportunityHistoryRow[] =>
    [...list].sort((a, b) => {
      if (a.changedAt < b.changedAt) return -1;
      if (a.changedAt > b.changedAt) return 1;
      return a.historyId < b.historyId ? -1 : a.historyId > b.historyId ? 1 : 0;
    });

  const oppIds = new Set<string>([...recordTypeRows.keys(), ...stageRows.keys()]);
  // Baselines apply only to Opportunities with no retained record-type
  // history; witnessed history always supersedes an observed snapshot.
  const applicableBaselines = baselines.filter((b) => !recordTypeRows.has(b.opportunityId));
  for (const b of applicableBaselines) oppIds.add(b.opportunityId);

  const ledger: OpportunityStageEvent[] = [];
  const terminalLedger: OpportunityTerminalEvent[] = [];
  const opportunities: OpportunityDerivedState[] = [];

  for (const opportunityId of oppIds) {
    const oppIssues: OpportunityIssue[] = [];
    const activeDates: Record<OpportunityFunnelStage, string | null> = { hpp: null, opp: null, pursuit: null };
    const entries: Record<OpportunityFunnelStage, number> = { hpp: 0, opp: 0, pursuit: 0 };
    let currentState: OpportunityEventState | null = null;
    let forwardMoves = 0;
    let backwardMoves = 0;
    let forwardSkips = 0;
    let backwardSkips = 0;
    let incompleteBaseline = false;
    let blocked = false;

    // Baseline observation: state known, entry date unknown, never invented.
    const baseline = applicableBaselines.find((b) => b.opportunityId === opportunityId);
    if (baseline) {
      const mapped = mapRecordType(baseline.recordTypeValue, config);
      const toState: OpportunityEventState = mapped.kind === 'state' ? mapped.state : 'unknown';
      if (mapped.kind !== 'state') {
        pushIssue(oppIssues, 'unknown_record_type');
        review.push({ reason: 'unknown_record_type', opportunityId, historyId: baseline.sourceId });
        blocked = true;
      }
      ledger.push({
        sourceHistoryId: baseline.sourceId,
        salesforceOpportunityId: opportunityId,
        fromState: null,
        toState,
        changedAt: baseline.observedAt,
        source: 'baseline_observation',
        baselineObservation: true,
        historyKnownBefore: false,
        rawRecordType: { oldValue: null, newValue: baseline.recordTypeValue },
      });
      currentState = toState;
      incompleteBaseline = true;
      if (toState === 'hpp' || toState === 'opp' || toState === 'pursuit') {
        entries[toState] += 1;
        // Entry date unknown: activeDates stays null so no velocity can be
        // fabricated from an observation time.
      }
    }

    // Pass 1 over record-type rows: validation, ledger, and the per-row
    // facts (movement counts, entries) that do not depend on same-timestamp
    // ordering. Path resolution happens in pass 2.
    interface RtStep {
      row: OpportunityHistoryRow;
      fromState: OpportunityEventState | null;
      toState: OpportunityEventState;
    }
    const steps: RtStep[] = [];
    let firstHistoryEvent = true;
    for (const row of ordered(recordTypeRows.get(opportunityId) ?? [])) {
      const oldMapped = mapRecordType(row.oldValue, config);
      const newMapped = mapRecordType(row.newValue, config);
      const fromState: OpportunityEventState | null =
        oldMapped.kind === 'state' ? oldMapped.state : oldMapped.kind === 'unknown' ? 'unknown' : null;
      const toState: OpportunityEventState =
        newMapped.kind === 'state' ? newMapped.state : 'unknown';

      if (newMapped.kind === 'blank') {
        // A cleared record type is malformed source data for this contract.
        pushIssue(oppIssues, 'invalid_source_row');
        review.push({ reason: 'invalid_source_row', historyId: row.historyId, opportunityId });
        continue;
      }
      if (newMapped.kind === 'unknown' || oldMapped.kind === 'unknown') {
        // Retained as ledger evidence below, flagged, never a visible stage.
        pushIssue(oppIssues, 'unknown_record_type');
        review.push({ reason: 'unknown_record_type', historyId: row.historyId, opportunityId });
        blocked = true;
      }

      // The first witnessed transition with a pre-existing old value means
      // earlier movement predates retained history: those entry dates are
      // unknown. The event itself is still fully recorded.
      const historyKnownBefore = !firstHistoryEvent || oldMapped.kind === 'blank';
      if (firstHistoryEvent && oldMapped.kind !== 'blank') incompleteBaseline = true;
      firstHistoryEvent = false;

      // Ledger order is deterministic storage order (timestamp, then history
      // Id); for same-timestamp groups it is NOT a claim about business
      // order, which pass 2 resolves or flags.
      ledger.push({
        sourceHistoryId: row.historyId,
        salesforceOpportunityId: opportunityId,
        fromState,
        toState,
        changedAt: row.changedAt,
        source: 'salesforce_history',
        baselineObservation: false,
        historyKnownBefore,
        rawRecordType: { oldValue: row.oldValue, newValue: row.newValue },
      });

      // Movement classification is a per-row fact (each row's own old/new
      // values), independent of same-timestamp ordering.
      const fromRank = fromState && fromState !== 'out_of_scope' && fromState !== 'unknown' ? STAGE_RANK[fromState] : null;
      const toRank = toState !== 'out_of_scope' && toState !== 'unknown' ? STAGE_RANK[toState] : null;
      if (fromRank !== null && toRank !== null) {
        const delta = toRank - fromRank;
        if (delta > 0) {
          forwardMoves += 1;
          if (delta === 2) forwardSkips += 1;
        } else if (delta < 0) {
          backwardMoves += 1;
          if (delta === -2) backwardSkips += 1;
        }
      }
      if (toRank !== null) entries[toState as OpportunityFunnelStage] += 1;

      steps.push({ row, fromState, toState });
    }

    // Pass 2: derived current path. Steps sharing one exact timestamp are
    // never business-ordered by History Id: the order must be proven by
    // old-value chaining, or every ordering must produce the same outcome;
    // otherwise the group is ambiguous, affected dates are suppressed, and
    // the events remain in the ledger for audit.
    let sim: PathSim = { state: currentState, dates: { ...activeDates } };
    let index = 0;
    while (index < steps.length) {
      const group: RtStep[] = [steps[index]];
      let next = index + 1;
      while (next < steps.length && steps[next].row.changedAt === steps[index].row.changedAt) {
        group.push(steps[next]);
        next += 1;
      }
      const day = group[0].row.changedAt.slice(0, 10);
      if (group.length === 1) {
        sim = applyPathStep(sim, group[0].toState, day);
      } else {
        const run = (perm: RtStep[]): PathSim =>
          perm.reduce((acc, st) => applyPathStep(acc, st.toState, day), sim);
        const allAgree = (perms: RtStep[][]): PathSim | null => {
          const outcomes = perms.map(run);
          return outcomes.every((o) => samePathSim(o, outcomes[0])) ? outcomes[0] : null;
        };
        let resolved: PathSim | null = null;
        if (group.length <= 4) {
          // An order proven by the source's own old values is business
          // evidence, not a History Id guess.
          const chained = permutations(group).filter((perm) => {
            let state = sim.state;
            for (const st of perm) {
              if (st.fromState === null) {
                // A blank old value is the first assignment: it can only
                // chain when nothing precedes it.
                if (state !== null) return false;
              } else if (st.fromState !== 'unknown' && state !== null && st.fromState !== state) {
                return false;
              }
              state = st.toState;
            }
            return true;
          });
          if (chained.length > 0) resolved = allAgree(chained);
          if (resolved === null) resolved = allAgree(permutations(group));
        }
        if (resolved === null) {
          pushIssue(oppIssues, 'ambiguous_same_timestamp');
          review.push({ reason: 'ambiguous_same_timestamp', opportunityId, historyId: group[0].row.historyId });
          const outcomes = permutations(group.slice(0, 4)).map(run);
          const finalStates = new Set(outcomes.map((o) => o.state));
          if (finalStates.size === 1) {
            // The stage is certain; only the disagreeing milestone dates are
            // unknowable, so those (and their velocity) are suppressed.
            const dates: PathSim['dates'] = { hpp: null, opp: null, pursuit: null };
            for (const s of FUNNEL_STAGES) {
              const values = new Set(outcomes.map((o) => o.dates[s]));
              dates[s] = values.size === 1 ? outcomes[0].dates[s] : null;
            }
            resolved = { state: outcomes[0].state, dates };
          } else {
            // Even the resulting stage depends on unprovable ordering.
            blocked = true;
            resolved = { state: 'unknown', dates: { hpp: null, opp: null, pursuit: null } };
          }
        }
        sim = resolved;
      }
      index = next;
    }
    currentState = sim.state;
    activeDates.hpp = sim.dates.hpp;
    activeDates.opp = sim.dates.opp;
    activeDates.pursuit = sim.dates.pursuit;

    // Terminal status from the detailed Stage field, kept separate from
    // record-type movement. Known terminal labels close; known open labels
    // keep the deal open or reopen a closed one; a value in NEITHER closed
    // set is unknown: flagged for review and never allowed to close or
    // reopen the opportunity on its own.
    let terminalStatus: OpportunityTerminalState = 'unknown';
    const oppStageRows = ordered(stageRows.get(opportunityId) ?? []);
    if (oppStageRows.length > 0) {
      terminalStatus = 'open';
      for (const row of oppStageRows) {
        const oldStage = mapStageValue(row.oldValue, config);
        const newStage = mapStageValue(row.newValue, config);
        if (newStage.kind === 'unknown' || newStage.kind === 'blank') {
          pushIssue(oppIssues, 'unknown_stage_value');
          review.push({ reason: 'unknown_stage_value', historyId: row.historyId, opportunityId });
          continue;
        }
        const toStatus: OpportunityTerminalState =
          newStage.kind === 'terminal' ? newStage.status : 'open';
        const fromStatus: OpportunityTerminalState =
          oldStage.kind === 'terminal'
            ? oldStage.status
            : oldStage.kind === 'unknown'
              ? 'unknown'
              : 'open';
        if (fromStatus === toStatus) continue; // open-to-open detail moves
        terminalLedger.push({
          sourceHistoryId: row.historyId,
          salesforceOpportunityId: opportunityId,
          fromStatus,
          toStatus,
          changedAt: row.changedAt,
          rawStage: { oldValue: row.oldValue, newValue: row.newValue },
        });
        // Reopening (terminal back to a known open value) is supported when
        // history proves it; the terminal ledger retains the closure.
        terminalStatus = toStatus;
      }
    }

    if (incompleteBaseline) pushIssue(oppIssues, 'incomplete_baseline');

    // Current-path velocity: only between ACTIVE dates of the latest valid
    // forward path. Missing or regressed stages yield null, never zero.
    const velocity: OpportunityVelocity = { hppToOppDays: null, oppToPursuitDays: null, hppToPursuitDays: null };
    const { hpp, opp, pursuit } = activeDates;
    const interval = (from: string | null, to: string | null): number | null => {
      if (!from || !to) return null;
      const d = diffDays(from, to);
      if (d < 0) {
        pushIssue(oppIssues, 'inconsistent_path_dates');
        return null;
      }
      return d;
    };
    velocity.hppToOppDays = interval(hpp, opp);
    velocity.oppToPursuitDays = interval(opp, pursuit);
    if (opp === null) velocity.hppToPursuitDays = interval(hpp, pursuit);

    const currentStage: OpportunityFunnelStage | null =
      currentState === 'hpp' || currentState === 'opp' || currentState === 'pursuit' ? currentState : null;

    for (const i of oppIssues) pushIssue(issues, i.kind, i.count);
    opportunities.push({
      opportunityId,
      currentStage,
      currentState,
      activeDates,
      terminalStatus,
      forwardMoves,
      backwardMoves,
      skips: { forward: forwardSkips, backward: backwardSkips },
      reEntries: {
        hpp: Math.max(0, entries.hpp - 1),
        opp: Math.max(0, entries.opp - 1),
        pursuit: Math.max(0, entries.pursuit - 1),
      },
      incompleteBaseline,
      velocity,
      issues: oppIssues,
      reportable: !blocked && currentState !== null && currentState !== 'unknown',
    });
  }

  let state: OpportunityHistoryResult['state'] = 'complete';
  if (opportunities.length === 0 && review.length === 0) state = 'missing';
  else if (review.length > 0 || issues.length > 0) state = 'incomplete';

  return {
    state,
    opportunities,
    ledger,
    terminalLedger,
    review,
    duplicatesIgnored,
    otherFieldRowsIgnored,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Reporting lenses
// ---------------------------------------------------------------------------

// Lens 1, the current operational funnel: each Opportunity appears exactly
// once at its current visible stage, regardless of how many stages it
// occupied historically.
export function currentFunnelSnapshot(
  opportunities: OpportunityDerivedState[],
): OpportunityFunnelSnapshot {
  const counts: Record<OpportunityFunnelStage, number> = { hpp: 0, opp: 0, pursuit: 0 };
  let outOfScope = 0;
  let unknown = 0;
  for (const o of opportunities) {
    if (o.currentStage) counts[o.currentStage] += 1;
    else if (o.currentState === 'out_of_scope') outOfScope += 1;
    else unknown += 1;
  }
  return { counts, outOfScope, unknown, totalUnique: opportunities.length };
}

// Lens 2, historical movement: the append-only ledgers themselves are the
// view. This summary totals them without ever collapsing or deleting events.
export interface OpportunityMovementSummary {
  totalMovements: number;
  forwardMoves: number;
  backwardMoves: number;
  forwardSkips: number;
  backwardSkips: number;
  reEntries: number;
  excludedVisits: number;
  terminalChanges: number;
}

export function movementSummary(result: OpportunityHistoryResult): OpportunityMovementSummary {
  let forwardMoves = 0;
  let backwardMoves = 0;
  let forwardSkips = 0;
  let backwardSkips = 0;
  let reEntries = 0;
  for (const o of result.opportunities) {
    forwardMoves += o.forwardMoves;
    backwardMoves += o.backwardMoves;
    forwardSkips += o.skips.forward;
    backwardSkips += o.skips.backward;
    reEntries += o.reEntries.hpp + o.reEntries.opp + o.reEntries.pursuit;
  }
  const excludedVisits = result.ledger.filter(
    (e) => e.toState === 'out_of_scope' || e.fromState === 'out_of_scope',
  ).length;
  return {
    totalMovements: result.ledger.length,
    forwardMoves,
    backwardMoves,
    forwardSkips,
    backwardSkips,
    reEntries,
    excludedVisits,
    terminalChanges: result.terminalLedger.length,
  };
}
