// touchDrilldown.ts: pure selection logic for the Bite 4E funnel-grid
// drilldown. Clicking a Lead or MQL actual lists the underlying TOUCHES
// (memberships), not just leads: a lead appearing via two touches in the
// inspected scope appears once per touch. Undated touches cannot bucket
// into any period, so they are excluded from counts but surfaced in a
// separate undated group whenever their channel is inspected, never
// silently dropped.

import type { Lead, LeadCampaignTouchRow, PeriodIndex } from '../types/db';
import type { RegionKey } from '../constants/regions';
import { matchesRegionFilter } from './regionFilter';
import { quarterOfIsoDate } from './dates';
import { mqlEventDates, type PeriodFilter } from './compute';

export interface TouchDrilldownEntry {
  touchId: string;
  leadId: string;
  account: string | null;
  region: string | null;
  channelId: string;
  // Lead stage: the touch date (null only in the undated group). MQL
  // stage: the touch date of the membership row backing the count.
  touchDate: string | null;
  // MQL stage only: the qualification event date the entry counts under.
  mqlEventDate?: string;
  parentCampaign: string | null;
  subCampaign: string | null;
  // 'backfill' rows are the preserved historical seeds; everything else
  // came through the importer or a future sync.
  source: LeadCampaignTouchRow['source'];
}

export interface TouchDrilldown {
  // Entries that count in the inspected cell, in stable date order.
  counted: TouchDrilldownEntry[];
  // Same-channel touches that cannot bucket into any period (lead stage
  // only; memberships still count for MQL).
  undated: TouchDrilldownEntry[];
}

export interface TouchDrilldownInput {
  touches: LeadCampaignTouchRow[];
  leads: Lead[];
  // The clicked channel plus every descendant (the grid cell is a rollup).
  channelIds: ReadonlySet<string>;
  stage: 'lead' | 'mql';
  year: number;
  filter: PeriodFilter;
  regions?: Set<RegionKey>;
}

function inPeriod(iso: string | null, year: number, filter: PeriodFilter): boolean {
  const bucket = quarterOfIsoDate(iso);
  if (!bucket || bucket.year !== year) return false;
  if (filter === 'year') return true;
  return `Q${bucket.quarter as PeriodIndex}` === filter;
}

export function computeTouchDrilldown(input: TouchDrilldownInput): TouchDrilldown {
  const { touches, leads, channelIds, stage, year, filter, regions } = input;
  const leadById = new Map(leads.map((l) => [l.id, l] as const));

  const entry = (t: LeadCampaignTouchRow, lead: Lead): TouchDrilldownEntry => ({
    touchId: t.id,
    leadId: t.lead_id,
    account: lead.account ?? null,
    region: lead.region ?? null,
    channelId: t.channel_id!,
    touchDate: t.touch_date,
    parentCampaign: t.parent_campaign,
    subCampaign: t.sub_campaign,
    source: t.source,
  });

  const scoped = touches.filter((t) => {
    if (!t.channel_id || !channelIds.has(t.channel_id)) return false;
    const lead = leadById.get(t.lead_id);
    if (!lead) return false;
    return matchesRegionFilter(lead.region, regions);
  });

  if (stage === 'lead') {
    const counted: TouchDrilldownEntry[] = [];
    const undated: TouchDrilldownEntry[] = [];
    for (const t of scoped) {
      const lead = leadById.get(t.lead_id)!;
      if (t.touch_date === null) {
        undated.push(entry(t, lead));
      } else if (inPeriod(t.touch_date, year, filter)) {
        counted.push(entry(t, lead));
      }
    }
    counted.sort((a, b) => (a.touchDate ?? '').localeCompare(b.touchDate ?? ''));
    return { counted, undated };
  }

  // MQL stage: one entry per (qualification event in period) x (membership
  // touch in scope). Undated membership touches still back MQL counts, so
  // they appear in counted with a null touchDate, not in the undated group.
  const counted: TouchDrilldownEntry[] = [];
  const touchesByLead = new Map<string, LeadCampaignTouchRow[]>();
  for (const t of scoped) {
    const arr = touchesByLead.get(t.lead_id) ?? [];
    arr.push(t);
    touchesByLead.set(t.lead_id, arr);
  }
  for (const [leadId, leadTouches] of touchesByLead) {
    const lead = leadById.get(leadId)!;
    // One membership per distinct channel, mirroring the count.
    const byChannel = new Map<string, LeadCampaignTouchRow>();
    for (const t of leadTouches) {
      if (!byChannel.has(t.channel_id!)) byChannel.set(t.channel_id!, t);
    }
    for (const iso of mqlEventDates(lead)) {
      if (!inPeriod(iso, year, filter)) continue;
      for (const t of byChannel.values()) {
        counted.push({ ...entry(t, lead), mqlEventDate: iso });
      }
    }
  }
  counted.sort(
    (a, b) =>
      (a.mqlEventDate ?? '').localeCompare(b.mqlEventDate ?? '') ||
      (a.touchDate ?? '').localeCompare(b.touchDate ?? ''),
  );
  return { counted, undated: [] };
}
