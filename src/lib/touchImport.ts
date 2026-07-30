// touchImport.ts: pure campaign-touch import logic (Bite 4D of the lead
// multi-attribution program, docs/lead-multi-attribution-program.md).
//
// Every Funnel Import row ALSO produces a campaign-touch candidate for
// lead_campaign_touches. This module holds all decisions as pure functions:
// per-row extraction (touches are per ROW, never collapsed by email: a
// multi-campaign person keeps one touch per membership), the edit-lock date
// precedence, the upsert-key choice mirroring the 4A dedupeTouches contract
// and the 4C indexes, and the seed-supersession decision. IO lives in
// src/hooks/touchImportApply.ts. Nothing here reads the clock, the network,
// or the database. `raw` carries campaign-related values only: never the
// full contact row, no emails, names, or other PII.

import type { ColumnMapping } from './csv';
import { parseSfdcDate, readMapped } from './csv';

// Matches the 4C natural-key index sentinel: COALESCE(touch_date,
// DATE '0001-01-01'), which is how the dedupeTouches 'unknown' bucket is
// expressed in storage.
export const TOUCH_DATE_SENTINEL = '0001-01-01';

export const MISSING_IDENTITY_WARNING =
  'Campaign Member ID / Campaign ID not mapped; campaign touches were not recorded for this import.';

// ---------------------------------------------------------------------------
// Channel ancestry (Bite 4D.1)
// ---------------------------------------------------------------------------

// child channel id -> parent channel id (null at the root), built by the
// apply layer from the channels table.
export type ChannelParentMap = Record<string, string | null>;

// True when channelId IS ancestorId or sits anywhere below it in the
// channels tree. General ancestor walk (the taxonomy is two levels today)
// with a cycle guard so corrupt parentage can never hang an import.
export function isChannelOrDescendant(
  channelId: string | null,
  ancestorId: string | null,
  channelParents: ChannelParentMap,
): boolean {
  if (!channelId || !ancestorId) return false;
  const visited = new Set<string>();
  let cursor: string | null = channelId;
  while (cursor) {
    if (cursor === ancestorId) return true;
    if (visited.has(cursor)) return false; // cycle guard
    visited.add(cursor);
    cursor = channelParents[cursor] ?? null;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-row extraction
// ---------------------------------------------------------------------------

export interface TouchRowInput {
  email: string; // lowercased; joins the row to its imported lead
  campaignMemberId: string | null;
  campaignId: string | null;
  parentCampaign: string | null;
  subCampaign: string | null;
  // The report's Member First Associated Date (ISO), before lock precedence.
  reportTouchDate: string | null;
}

export interface TouchExtraction {
  rows: TouchRowInput[];
  // True when at least one of the two identity columns is mapped. When
  // false, NO touch is written and the import summary shows
  // MISSING_IDENTITY_WARNING; the lead import proceeds unchanged.
  identityMapped: boolean;
  withMemberId: number;
  withCampaignIdOnly: number;
  withoutIdentity: number;
}

export function extractTouchRows(
  rows: Record<string, string>[],
  mapping: ColumnMapping,
): TouchExtraction {
  const identityMapped = Boolean(mapping.campaign_member_id || mapping.campaign_id);
  const out: TouchRowInput[] = [];
  let withMemberId = 0;
  let withCampaignIdOnly = 0;
  let withoutIdentity = 0;
  for (const row of rows) {
    const email = readMapped(row, mapping.email)?.toLowerCase();
    if (!email) continue; // consistent with the lead import's empty-email skip
    const campaignMemberId = readMapped(row, mapping.campaign_member_id) ?? null;
    const campaignId = readMapped(row, mapping.campaign_id) ?? null;
    if (campaignMemberId) withMemberId += 1;
    else if (campaignId) withCampaignIdOnly += 1;
    else withoutIdentity += 1;
    out.push({
      email,
      campaignMemberId,
      campaignId,
      parentCampaign: readMapped(row, mapping.parent_campaign) ?? null,
      subCampaign: readMapped(row, mapping.sub_campaign) ?? null,
      reportTouchDate: parseSfdcDate(readMapped(row, mapping.marketing_sourced_date)),
    });
  }
  return { rows: out, identityMapped, withMemberId, withCampaignIdOnly, withoutIdentity };
}

// ---------------------------------------------------------------------------
// Candidate building with the edit-lock date precedence
// ---------------------------------------------------------------------------

export interface TouchLeadContext {
  leadId: string;
  sourceChannelId: string | null;
  marketingSourcedDate: string | null;
  // leads.field_locks.marketing_sourced_date === true
  sourcedDateLocked: boolean;
}

export interface TouchCandidate {
  leadId: string;
  campaignMemberId: string | null;
  campaignId: string | null;
  channelId: string | null;
  touchDate: string | null;
  parentCampaign: string | null;
  subCampaign: string | null;
  raw: Record<string, unknown>;
}

// The touch date is the report's date EXCEPT when this touch sits on the
// lead's primary channel OR any descendant of it (a parent-level primary
// with a child-level membership is the same channel family) AND Marketing
// locked marketing_sourced_date: the manually corrected date is
// authoritative (it must keep winning when Bite 4E starts counting from
// touches), and the report's raw date is preserved in raw.sfdc_touch_date.
// Unrelated-channel touches always use the report date, locked or not.
export function buildTouchCandidate(
  input: TouchRowInput,
  lead: TouchLeadContext,
  channelId: string | null,
  channelParents: ChannelParentMap = {},
): TouchCandidate {
  const raw: Record<string, unknown> = {
    parent_campaign: input.parentCampaign,
    sub_campaign: input.subCampaign,
    campaign_member_id: input.campaignMemberId,
    campaign_id: input.campaignId,
  };
  let touchDate = input.reportTouchDate;
  const onPrimaryChannel = isChannelOrDescendant(
    channelId,
    lead.sourceChannelId,
    channelParents,
  );
  if (onPrimaryChannel && lead.sourcedDateLocked) {
    touchDate = lead.marketingSourcedDate;
    raw.sfdc_touch_date = input.reportTouchDate;
  }
  return {
    leadId: lead.leadId,
    campaignMemberId: input.campaignMemberId,
    campaignId: input.campaignId,
    channelId,
    touchDate,
    parentCampaign: input.parentCampaign,
    subCampaign: input.subCampaign,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Upsert planning (keys mirror dedupeTouches and the 4C indexes)
// ---------------------------------------------------------------------------

export type TouchUpsertKey =
  | { kind: 'member'; key: string }
  | { kind: 'natural'; key: string }
  | { kind: 'skip_no_identity' };

export function touchUpsertKey(candidate: TouchCandidate): TouchUpsertKey {
  if (candidate.campaignMemberId?.trim()) {
    return { kind: 'member', key: `cm::${candidate.campaignMemberId.trim()}` };
  }
  if (candidate.campaignId?.trim()) {
    return {
      kind: 'natural',
      key: naturalKey(candidate.leadId, candidate.campaignId, candidate.touchDate),
    };
  }
  return { kind: 'skip_no_identity' };
}

function naturalKey(leadId: string, campaignId: string, touchDate: string | null): string {
  return `nk::${leadId}|${campaignId.trim()}|${touchDate ?? TOUCH_DATE_SENTINEL}`;
}

// The columns the import maintains on an existing touch row. lead_id and
// source are never patched; raw refreshes whenever anything else changes.
const PATCHABLE = ['campaign_member_id', 'campaign_id', 'channel_id', 'touch_date', 'parent_campaign', 'sub_campaign'] as const;

export interface ExistingTouchLite {
  id: string;
  lead_id: string;
  campaign_member_id: string | null;
  campaign_id: string | null;
  channel_id: string | null;
  touch_date: string | null;
  parent_campaign: string | null;
  sub_campaign: string | null;
  source: string;
}

export interface NewTouchRow {
  lead_id: string;
  campaign_member_id: string | null;
  campaign_id: string | null;
  channel_id: string | null;
  touch_date: string | null;
  parent_campaign: string | null;
  sub_campaign: string | null;
  source: 'import';
  raw: Record<string, unknown>;
}

export interface TouchPlan {
  inserts: NewTouchRow[];
  updates: { id: string; patch: Record<string, unknown> }[];
  unchanged: number;
  skippedNoIdentity: number;
  duplicateRowsCollapsed: number;
  // Seed rows (source='backfill') superseded by an identity-carrying touch
  // on the same (lead, channel).
  seedDeleteIds: string[];
}

function candidateValue(c: TouchCandidate, column: (typeof PATCHABLE)[number]): string | null {
  switch (column) {
    case 'campaign_member_id':
      return c.campaignMemberId;
    case 'campaign_id':
      return c.campaignId;
    case 'channel_id':
      return c.channelId;
    case 'touch_date':
      return c.touchDate;
    case 'parent_campaign':
      return c.parentCampaign;
    case 'sub_campaign':
      return c.subCampaign;
  }
}

// Decide inserts, updates, no-ops, and seed supersession for one import
// batch against the lead's existing touches. Idempotent by construction:
// planning the same candidates against the rows a previous plan produced
// yields zero inserts, zero updates, zero deletes.
export function planTouchUpserts(
  candidates: TouchCandidate[],
  existing: ExistingTouchLite[],
  channelParents: ChannelParentMap = {},
): TouchPlan {
  const byMember = new Map<string, ExistingTouchLite>();
  const byNatural = new Map<string, ExistingTouchLite>();
  const seedByLeadChannel = new Map<string, ExistingTouchLite>();
  for (const row of existing) {
    if (row.source === 'backfill') {
      if (row.channel_id) seedByLeadChannel.set(`${row.lead_id}|${row.channel_id}`, row);
      continue;
    }
    if (row.campaign_member_id?.trim()) {
      byMember.set(`cm::${row.campaign_member_id.trim()}`, row);
    } else if (row.campaign_id?.trim()) {
      byNatural.set(naturalKey(row.lead_id, row.campaign_id, row.touch_date), row);
    }
  }

  const plan: TouchPlan = {
    inserts: [],
    updates: [],
    unchanged: 0,
    skippedNoIdentity: 0,
    duplicateRowsCollapsed: 0,
    seedDeleteIds: [],
  };
  const seenKeys = new Set<string>();
  const seedDeletes = new Set<string>();

  for (const candidate of candidates) {
    const key = touchUpsertKey(candidate);
    if (key.kind === 'skip_no_identity') {
      plan.skippedNoIdentity += 1;
      continue;
    }
    if (seenKeys.has(key.key)) {
      plan.duplicateRowsCollapsed += 1;
      continue;
    }
    seenKeys.add(key.key);

    // Member-id candidates that predate the Id columns may exist as
    // natural-key rows: match those too and upgrade them to Id-keyed,
    // instead of inserting a duplicate.
    let match: ExistingTouchLite | undefined;
    if (key.kind === 'member') {
      match = byMember.get(key.key);
      if (!match && candidate.campaignId?.trim()) {
        match = byNatural.get(
          naturalKey(candidate.leadId, candidate.campaignId, candidate.touchDate),
        );
      }
    } else {
      match = byNatural.get(key.key);
    }

    if (match) {
      const patch: Record<string, unknown> = {};
      for (const column of PATCHABLE) {
        const next = candidateValue(candidate, column);
        if ((match[column] ?? null) !== (next ?? null)) patch[column] = next;
      }
      if (Object.keys(patch).length > 0) {
        patch.raw = candidate.raw;
        plan.updates.push({ id: match.id, patch });
      } else {
        plan.unchanged += 1;
      }
    } else {
      plan.inserts.push({
        lead_id: candidate.leadId,
        campaign_member_id: candidate.campaignMemberId,
        campaign_id: candidate.campaignId,
        channel_id: candidate.channelId,
        touch_date: candidate.touchDate,
        parent_campaign: candidate.parentCampaign,
        sub_campaign: candidate.subCampaign,
        source: 'import',
        raw: candidate.raw,
      });
    }

    // Seed supersession, descendant-aware (Bite 4D.1): an identity-
    // carrying touch on channel C supersedes the same lead's backfill seed
    // on C or any ANCESTOR of C (a coarse parent-level seed is superseded
    // by its precise child-level membership). Applies on insert, update,
    // AND no-op re-observation so any import self-cleans; only campaign-
    // identified touches ever supersede (identity-less rows were skipped
    // above). Walk up with a cycle guard.
    if (candidate.channelId) {
      const visited = new Set<string>();
      let cursor: string | null = candidate.channelId;
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const seed = seedByLeadChannel.get(`${candidate.leadId}|${cursor}`);
        if (seed) seedDeletes.add(seed.id);
        cursor = channelParents[cursor] ?? null;
      }
    }
  }

  plan.seedDeleteIds = [...seedDeletes];
  return plan;
}
