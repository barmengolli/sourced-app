// campaignAttribution.ts: pure primary-source and campaign-influence
// attribution foundation (Bite 4A).
//
// Two distinct models, both defined here and documented in
// docs/funnel-source-contract.md:
//
// - Primary-source funnel: each lead has ONE original qualifying source, set
//   by the earliest valid qualifying campaign touch. Later touches never
//   replace it. Totals are mutually exclusive and reconcile to unique people.
//   Manual Marketing corrections (edit locks) always win over recomputation.
// - Campaign influence: every meaningful campaign touch is retained. A person
//   sourced by Product Overview who later books a call is influenced by both
//   campaigns. Influence totals intentionally overlap and are NEVER a
//   denominator for overall acquisition efficiency.
//
// The LeadCampaignTouch shape is the normalized contract for campaign
// membership ingestion. Its storage table is lead_campaign_touches
// (Bite 4C, migrations/2026-07-29_lead_campaign_touches.sql; row shape
// LeadCampaignTouchRow in src/types/db.ts, mapped here by
// touchRowToLeadCampaignTouch). The Salesforce Campaign Member ID is the
// preferred idempotency key once the feed captures it. Synthetic
// identifiers only; nothing here touches the network, the clock, or the
// database.

import type { CohortIssueKind } from './funnelCohorts';
import type { LeadCampaignTouchRow } from '../types/db';

// ---------------------------------------------------------------------------
// The future normalized touch contract
// ---------------------------------------------------------------------------

export interface LeadCampaignTouch {
  // Stable lead identity (application lead id, not an email).
  leadId: string;
  // Salesforce CampaignMember Id: the preferred idempotency key. The current
  // workflow queries it but discards it; null models that gap.
  campaignMemberId: string | null;
  // Campaign identity (sub-campaign level, the level a touch belongs to).
  campaignId: string;
  // Optional channel resolution for funnel bucketing.
  channelId?: string | null;
  // The day the touch happened (CampaignMember association date), when known.
  touchDate: string | null;
  // Parent and sub-campaign provenance as delivered by the source.
  parentCampaign?: string | null;
  subCampaign?: string | null;
  // When the import observed this touch (full ISO timestamp).
  observedAt: string;
  raw?: Record<string, unknown>;
}

export type TouchIssueKind =
  | Extract<CohortIssueKind, 'duplicate_lead_id'>
  | 'missing_campaign_member_id'
  | 'missing_lead_identity'
  | 'missing_campaign_identity'
  | 'missing_touch_date'
  | 'no_dated_touch';

export interface TouchIssue {
  kind: TouchIssueKind;
  count: number;
}

export type AttributionResultState = 'complete' | 'incomplete' | 'missing' | 'invalid';

function pushIssue(issues: TouchIssue[], kind: TouchIssueKind, count = 1): void {
  const found = issues.find((i) => i.kind === kind);
  if (found) found.count += count;
  else issues.push({ kind, count });
}

// ---------------------------------------------------------------------------
// Idempotent dedupe
// ---------------------------------------------------------------------------

export interface DedupedTouches {
  touches: LeadCampaignTouch[];
  // Records that cannot participate in attribution at all (no lead or no
  // campaign identity). Routed to review, never guessed.
  rejected: LeadCampaignTouch[];
  duplicatesRemoved: number;
  issues: TouchIssue[];
}

// Deduplicate touches so re-processing the same source rows is idempotent.
// The CampaignMember Id is the preferred key; rows without one fall back to
// the natural key (lead + campaign + touch date) and are flagged so the feed
// gap stays visible.
export function dedupeTouches(input: LeadCampaignTouch[]): DedupedTouches {
  const issues: TouchIssue[] = [];
  const rejected: LeadCampaignTouch[] = [];
  const out: LeadCampaignTouch[] = [];
  const seen = new Set<string>();
  let duplicatesRemoved = 0;

  for (const t of input) {
    if (!t.leadId?.trim()) {
      pushIssue(issues, 'missing_lead_identity');
      rejected.push(t);
      continue;
    }
    if (!t.campaignId?.trim()) {
      pushIssue(issues, 'missing_campaign_identity');
      rejected.push(t);
      continue;
    }
    const key = t.campaignMemberId?.trim()
      ? `cm::${t.campaignMemberId.trim()}`
      : `nk::${t.leadId}|${t.campaignId}|${t.touchDate ?? 'unknown'}`;
    if (!t.campaignMemberId?.trim()) pushIssue(issues, 'missing_campaign_member_id');
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(key);
    out.push(t);
  }

  return { touches: out, rejected, duplicatesRemoved, issues };
}

// ---------------------------------------------------------------------------
// Storage row mapping (Bite 4C)
// ---------------------------------------------------------------------------

// Pure mapper from the lead_campaign_touches storage row
// (LeadCampaignTouchRow in src/types/db.ts) to the calculation type above.
// A row without campaign identity (the seeded 'backfill' primary-source
// rows) maps to an empty campaignId, which dedupeTouches deliberately
// routes to `rejected`: membership ingestion and dedupe apply only to real
// campaign touches, while seed rows are protected by the migration's own
// guard instead.
export function touchRowToLeadCampaignTouch(row: LeadCampaignTouchRow): LeadCampaignTouch {
  return {
    leadId: row.lead_id,
    campaignMemberId: row.campaign_member_id,
    campaignId: row.campaign_id ?? '',
    channelId: row.channel_id,
    touchDate: row.touch_date,
    parentCampaign: row.parent_campaign,
    subCampaign: row.sub_campaign,
    observedAt: row.observed_at,
    raw: row.raw,
  };
}

// ---------------------------------------------------------------------------
// Primary-source resolution
// ---------------------------------------------------------------------------

export interface PrimarySourceResolution {
  leadId: string;
  // The one original qualifying source, or null when no dated touch can
  // establish it.
  campaignId: string | null;
  // manual_lock: a Marketing correction (edit-locked source) that always wins.
  // earliest_touch: derived from the earliest valid dated touch.
  // unresolved: no dated touch and no manual value.
  basis: 'manual_lock' | 'earliest_touch' | 'unresolved';
  state: AttributionResultState;
  issues: TouchIssue[];
}

export interface PrimarySourceReport {
  state: AttributionResultState;
  byLead: Record<string, PrimarySourceResolution>;
  // Mutually exclusive totals: each lead counts under exactly one campaign
  // (or under unresolved). sum(byCampaign) + unresolved === uniqueLeads.
  byCampaign: Record<string, number>;
  uniqueLeads: number;
  unresolved: number;
  issues: TouchIssue[];
}

// Resolve each lead's primary source from deduplicated touches. The earliest
// dated touch wins; ties on the same day break on earlier observedAt, then
// input order, so recomputation is deterministic. A later campaign
// interaction can never replace the primary source. manualPrimaries models
// Marketing's edit-locked corrections and always wins.
export function resolvePrimarySources(
  touches: LeadCampaignTouch[],
  manualPrimaries: Record<string, string> = {},
): PrimarySourceReport {
  const reportIssues: TouchIssue[] = [];
  const byLeadTouches = new Map<string, LeadCampaignTouch[]>();
  for (const t of touches) {
    if (!byLeadTouches.has(t.leadId)) byLeadTouches.set(t.leadId, []);
    byLeadTouches.get(t.leadId)!.push(t);
  }
  // Leads that only exist as manual corrections still resolve.
  for (const leadId of Object.keys(manualPrimaries)) {
    if (!byLeadTouches.has(leadId)) byLeadTouches.set(leadId, []);
  }

  const byLead: Record<string, PrimarySourceResolution> = {};
  const byCampaign: Record<string, number> = {};
  let unresolved = 0;

  for (const [leadId, list] of byLeadTouches) {
    const issues: TouchIssue[] = [];
    const manual = manualPrimaries[leadId];
    if (manual) {
      byLead[leadId] = { leadId, campaignId: manual, basis: 'manual_lock', state: 'complete', issues };
      byCampaign[manual] = (byCampaign[manual] ?? 0) + 1;
      continue;
    }
    let earliest: LeadCampaignTouch | null = null;
    let undated = 0;
    for (const t of list) {
      if (!t.touchDate) {
        undated += 1;
        continue;
      }
      if (
        !earliest ||
        t.touchDate < earliest.touchDate! ||
        (t.touchDate === earliest.touchDate && t.observedAt < earliest.observedAt)
      ) {
        earliest = t;
      }
    }
    if (undated > 0) pushIssue(issues, 'missing_touch_date', undated);
    if (earliest) {
      byLead[leadId] = {
        leadId,
        campaignId: earliest.campaignId,
        basis: 'earliest_touch',
        state: issues.length > 0 ? 'incomplete' : 'complete',
        issues,
      };
      byCampaign[earliest.campaignId] = (byCampaign[earliest.campaignId] ?? 0) + 1;
    } else {
      pushIssue(issues, 'no_dated_touch');
      byLead[leadId] = { leadId, campaignId: null, basis: 'unresolved', state: 'incomplete', issues };
      unresolved += 1;
    }
    for (const i of issues) pushIssue(reportIssues, i.kind, i.count);
  }

  const uniqueLeads = byLeadTouches.size;
  let state: AttributionResultState = 'complete';
  if (uniqueLeads === 0) state = 'missing';
  else if (reportIssues.length > 0) state = 'incomplete';

  return { state, byLead, byCampaign, uniqueLeads, unresolved, issues: reportIssues };
}

// ---------------------------------------------------------------------------
// Campaign influence (intentionally overlapping)
// ---------------------------------------------------------------------------

export interface CampaignInfluence {
  campaignId: string;
  uniqueLeads: number;
}

export interface InfluenceReport {
  state: AttributionResultState;
  campaigns: CampaignInfluence[];
  // Deduplicated people across all campaigns: the ONLY valid denominator for
  // overall acquisition efficiency.
  uniquePeople: number;
  // Sum of per-campaign unique leads. Greater than uniquePeople whenever
  // people belong to several campaigns. Display-labeled as overlapping;
  // never a denominator.
  participationTotal: number;
  // People appearing in more than one campaign.
  peopleInMultipleCampaigns: number;
  // Constant true: influence totals are non-additive by design and every
  // surface must label them as such.
  nonAdditive: true;
  issues: TouchIssue[];
}

// Count campaign influence from deduplicated touches. Membership in several
// campaigns is the point of this report: a person counts in full for each
// campaign that touched them, while uniquePeople stays deduplicated.
export function influenceReport(touches: LeadCampaignTouch[]): InfluenceReport {
  const issues: TouchIssue[] = [];
  const byCampaign = new Map<string, Set<string>>();
  const people = new Set<string>();
  const campaignsPerPerson = new Map<string, Set<string>>();

  for (const t of touches) {
    if (!byCampaign.has(t.campaignId)) byCampaign.set(t.campaignId, new Set());
    byCampaign.get(t.campaignId)!.add(t.leadId);
    people.add(t.leadId);
    if (!campaignsPerPerson.has(t.leadId)) campaignsPerPerson.set(t.leadId, new Set());
    campaignsPerPerson.get(t.leadId)!.add(t.campaignId);
  }

  const campaigns: CampaignInfluence[] = [...byCampaign.entries()]
    .map(([campaignId, set]) => ({ campaignId, uniqueLeads: set.size }))
    .sort((a, b) => b.uniqueLeads - a.uniqueLeads || a.campaignId.localeCompare(b.campaignId));

  const participationTotal = campaigns.reduce((sum, c) => sum + c.uniqueLeads, 0);
  const peopleInMultipleCampaigns = [...campaignsPerPerson.values()].filter(
    (s) => s.size > 1,
  ).length;

  return {
    state: people.size === 0 ? 'missing' : 'complete',
    campaigns,
    uniquePeople: people.size,
    participationTotal,
    peopleInMultipleCampaigns,
    nonAdditive: true,
    issues,
  };
}
