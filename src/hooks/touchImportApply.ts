// touchImportApply.ts: IO layer for the Bite 4D campaign-touch import.
//
// Runs AFTER the lead bulk sync so every touch row can resolve its lead
// (fresh from the database, with field_locks and the primary channel) and
// its channel. All decisions are made by the pure functions in
// src/lib/touchImport.ts; this file only reads and writes rows. Seeds are
// superseded in the same apply path, so every future import self-cleans.

import { supabase } from '../lib/supabase';
import type { Lead } from '../types/db';
import { resolveChannelHierarchy } from './useLeads';
import type { SfdcSync } from '../lib/leadSync';
import {
  buildTouchCandidate,
  planTouchUpserts,
} from '../lib/touchImport';
import type {
  ChannelParentMap,
  ExistingTouchLite,
  TouchCandidate,
  TouchLeadContext,
  TouchRowInput,
} from '../lib/touchImport';

const CHUNK = 100;
const LOOKUP_CHUNK = 500;

export interface TouchImportResult {
  attempted: number;
  newTouches: number;
  updatedTouches: number;
  unchanged: number;
  seedsSuperseded: number;
  skippedNoIdentity: number;
  duplicateRowsCollapsed: number;
  rowsWithoutLead: number;
  errors: string[];
}

export function emptyTouchImportResult(): TouchImportResult {
  return {
    attempted: 0,
    newTouches: 0,
    updatedTouches: 0,
    unchanged: 0,
    seedsSuperseded: 0,
    skippedNoIdentity: 0,
    duplicateRowsCollapsed: 0,
    rowsWithoutLead: 0,
    errors: [],
  };
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function applyTouchImport(rows: TouchRowInput[]): Promise<TouchImportResult> {
  const result = emptyTouchImportResult();
  result.attempted = rows.length;
  if (rows.length === 0) return result;

  // 1. Resolve channels for EVERY distinct (parent, sub) pair in the file,
  // not just the pairs that survived lead coalescing: a multi-campaign
  // person's second membership may name a channel no lead candidate carries.
  const pairByKey = new Map<string, SfdcSync>();
  for (const row of rows) {
    const sub = row.subCampaign?.trim();
    if (!sub) continue;
    const key = `${row.parentCampaign?.trim() ?? ''}|${sub}`;
    if (!pairByKey.has(key)) {
      pairByKey.set(key, {
        email: '',
        values: {},
        parentChannelName: row.parentCampaign ?? undefined,
        subChannelName: row.subCampaign ?? undefined,
      });
    }
  }
  const pairSyncs = [...pairByKey.values()];
  await resolveChannelHierarchy(pairSyncs);
  const channelByPair = new Map<string, string | null>();
  for (const [key, sync] of pairByKey) {
    channelByPair.set(key, sync.values.source_channel_id ?? null);
  }

  // Child -> parent map over the whole channels tree (Bite 4D.1): the
  // descendant-aware supersession and locked-date decisions need ancestry,
  // and a seed may sit on a parent no touch row names directly.
  const channelParents: ChannelParentMap = {};
  {
    const { data, error } = await supabase
      .from('channels')
      .select('id, parent_channel_id');
    if (error) throw error;
    for (const row of (data ?? []) as { id: string; parent_channel_id: string | null }[]) {
      channelParents[row.id] = row.parent_channel_id;
    }
  }

  // 2. Fetch the imported leads fresh (locks and primary channel included).
  const emails = [...new Set(rows.map((r) => r.email))];
  const leadByEmail = new Map<string, TouchLeadContext>();
  for (const slice of chunked(emails, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from('leads')
      .select('id, email, source_channel_id, marketing_sourced_date, field_locks')
      .in('email', slice);
    if (error) throw error;
    for (const lead of (data ?? []) as Pick<
      Lead,
      'id' | 'email' | 'source_channel_id' | 'marketing_sourced_date' | 'field_locks'
    >[]) {
      leadByEmail.set(lead.email.toLowerCase(), {
        leadId: lead.id,
        sourceChannelId: lead.source_channel_id ?? null,
        marketingSourcedDate: lead.marketing_sourced_date ?? null,
        sourcedDateLocked: lead.field_locks?.marketing_sourced_date === true,
      });
    }
  }

  // 3. Build candidates (edit-lock date precedence happens here).
  const candidates: TouchCandidate[] = [];
  for (const row of rows) {
    const lead = leadByEmail.get(row.email);
    if (!lead) {
      // The lead sync reported its own error for this email; count and move on.
      result.rowsWithoutLead += 1;
      continue;
    }
    const sub = row.subCampaign?.trim();
    const channelId = sub
      ? (channelByPair.get(`${row.parentCampaign?.trim() ?? ''}|${sub}`) ?? null)
      : null;
    candidates.push(buildTouchCandidate(row, lead, channelId, channelParents));
  }

  // 4. Fetch existing touches for the affected leads.
  const leadIds = [...new Set(candidates.map((c) => c.leadId))];
  const existing: ExistingTouchLite[] = [];
  for (const slice of chunked(leadIds, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from('lead_campaign_touches')
      .select(
        'id, lead_id, campaign_member_id, campaign_id, channel_id, touch_date, parent_campaign, sub_campaign, source',
      )
      .in('lead_id', slice);
    if (error) throw error;
    existing.push(...((data ?? []) as ExistingTouchLite[]));
  }

  // 5. Pure plan, then execute.
  const plan = planTouchUpserts(candidates, existing, channelParents);
  result.skippedNoIdentity = plan.skippedNoIdentity;
  result.unchanged = plan.unchanged;
  result.duplicateRowsCollapsed = plan.duplicateRowsCollapsed;

  for (const slice of chunked(plan.inserts, CHUNK)) {
    const { error } = await supabase.from('lead_campaign_touches').insert(slice);
    if (error) {
      result.errors.push(`insert failed for ${slice.length} touch(es): ${error.message}`);
    } else {
      result.newTouches += slice.length;
    }
  }

  for (const slice of chunked(plan.updates, CHUNK)) {
    const settled = await Promise.allSettled(
      slice.map(({ id, patch }) =>
        supabase.from('lead_campaign_touches').update(patch).eq('id', id),
      ),
    );
    settled.forEach((outcome, idx) => {
      if (outcome.status === 'fulfilled' && !outcome.value.error) {
        result.updatedTouches += 1;
      } else {
        const message =
          outcome.status === 'fulfilled'
            ? outcome.value.error!.message
            : outcome.reason instanceof Error
              ? outcome.reason.message
              : 'update failed';
        result.errors.push(`touch update ${slice[idx].id} failed: ${message}`);
      }
    });
  }

  for (const slice of chunked(plan.seedDeleteIds, CHUNK)) {
    const { error } = await supabase.from('lead_campaign_touches').delete().in('id', slice);
    if (error) {
      result.errors.push(`seed supersession failed for ${slice.length} row(s): ${error.message}`);
    } else {
      result.seedsSuperseded += slice.length;
    }
  }

  return result;
}
