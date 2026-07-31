// leadTouchHistory.ts: pure selector for a single lead's campaign-touch
// history (Bite 4F, lead drawer). Read-only projection of
// lead_campaign_touches into display rows: channel name, date, provenance,
// source, the primary-channel marker, and the corrected-date indicator the
// 4D importer leaves behind in raw.sfdc_touch_date when Marketing's locked
// marketing_sourced_date won over the report's date.

import type { Channel, LeadCampaignTouchRow } from '../types/db';

export interface LeadTouchHistoryEntry {
  touchId: string;
  channelId: string | null;
  channelName: string;
  // The date this membership counts under (already the corrected date when
  // an edit lock applied, per the 4D precedence).
  touchDate: string | null;
  parentCampaign: string | null;
  subCampaign: string | null;
  source: LeadCampaignTouchRow['source'];
  // True when this touch sits on the lead's primary source channel.
  isPrimaryChannel: boolean;
  // Set when the 4D importer replaced the report's date with Marketing's
  // locked correction; carries the ORIGINAL SFDC date for the tooltip.
  correctedFromSfdcDate: string | null;
}

export interface LeadTouchHistoryInput {
  touches: LeadCampaignTouchRow[];
  leadId: string;
  primaryChannelId: string | null;
  channels: Channel[];
}

function rawSfdcDate(raw: Record<string, unknown> | null | undefined): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as Record<string, unknown>).sfdc_touch_date;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

// Newest membership first; undated touches sort last (they cannot bucket
// into any period but are still real memberships and must stay visible).
export function computeLeadTouchHistory(
  input: LeadTouchHistoryInput,
): LeadTouchHistoryEntry[] {
  const { touches, leadId, primaryChannelId, channels } = input;
  const nameById = new Map(channels.map((c) => [c.id, c.name] as const));

  const entries = touches
    .filter((t) => t.lead_id === leadId)
    .map((t): LeadTouchHistoryEntry => {
      const corrected = rawSfdcDate(t.raw);
      return {
        touchId: t.id,
        channelId: t.channel_id,
        channelName: t.channel_id
          ? (nameById.get(t.channel_id) ?? 'Unknown channel')
          : 'No channel',
        touchDate: t.touch_date,
        parentCampaign: t.parent_campaign,
        subCampaign: t.sub_campaign,
        source: t.source,
        isPrimaryChannel:
          t.channel_id !== null &&
          primaryChannelId !== null &&
          t.channel_id === primaryChannelId,
        // Only meaningful when it actually differs from the stored date.
        correctedFromSfdcDate: corrected && corrected !== t.touch_date ? corrected : null,
      };
    });

  entries.sort((a, b) => {
    if (a.touchDate === null && b.touchDate === null) return 0;
    if (a.touchDate === null) return 1;
    if (b.touchDate === null) return -1;
    return b.touchDate.localeCompare(a.touchDate);
  });
  return entries;
}
