// touchDrilldown.ts: pure selection logic for the Bite 4E funnel-grid
// drilldown. Clicking a Lead or MQL actual lists the underlying TOUCHES
// (memberships), not just leads: a lead appearing via two touches in the
// inspected scope appears once per touch. Lead rows use the CampaignMember
// touch date. MQL rows use the same effective stage-activity date as the
// grid: a witnessed transition date, or the touch date for a first-observed
// MQL baseline. Undated touches cannot bucket into any period, so they are
// excluded from counts but surfaced separately, never silently dropped.

import type { Lead, LeadCampaignTouchRow, PeriodIndex } from '../types/db';
import type { RegionKey } from '../constants/regions';
import { matchesRegionFilter } from './regionFilter';
import { quarterOfIsoDate } from './dates';
import { mqlActivityDateForTouch, type PeriodFilter } from './compute';

export interface TouchDrilldownEntry {
  touchId: string;
  leadId: string;
  account: string | null;
  region: string | null;
  channelId: string;
  // CampaignMember date. It is the Lead activity date and remains useful
  // provenance for MQL rows whose stage activity happened later.
  touchDate: string | null;
  // MQL stage only: the effective date that placed this membership in the
  // selected reporting period. It is the witnessed transition date, or the
  // touch date when the first observation was already an MQL baseline.
  mqlActivityDate?: string;
  parentCampaign: string | null;
  subCampaign: string | null;
  // 'backfill' rows are the preserved historical seeds; everything else
  // came through the importer or a future sync.
  source: LeadCampaignTouchRow['source'];
}

export interface TouchDrilldown {
  // Entries that count in the inspected cell, in stable date order.
  counted: TouchDrilldownEntry[];
  // Same-channel touches that cannot bucket into any period.
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

  // MQL stage: one row per membership whose effective MQL activity date is in
  // the selected period. This mirrors computeGrid exactly; the drilldown must
  // never show a Q1 row underneath a Q3 MQL total. Undated touches cannot
  // establish an activity date, including for first-observed baselines.
  const counted: TouchDrilldownEntry[] = [];
  const undated: TouchDrilldownEntry[] = [];
  for (const t of scoped) {
    const lead = leadById.get(t.lead_id)!;
    const activityDate = mqlActivityDateForTouch(lead, t.touch_date);
    if (!activityDate) {
      if (t.touch_date === null) undated.push(entry(t, lead));
      continue;
    }
    const candidate = {
      ...entry(t, lead),
      mqlActivityDate: activityDate,
    };
    if (inPeriod(activityDate, year, filter)) counted.push(candidate);
  }
  counted.sort(
    (a, b) =>
      (a.mqlActivityDate ?? '').localeCompare(b.mqlActivityDate ?? '') ||
      (a.touchDate ?? '').localeCompare(b.touchDate ?? ''),
  );
  return { counted, undated };
}
