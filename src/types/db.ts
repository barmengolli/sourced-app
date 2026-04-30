export type StageKey = 'lead' | 'mql';

export type AttributionStageKey = 'hpp' | 'opp' | 'pursuit' | 'closeWon';

export type PeriodIndex = 1 | 2 | 3 | 4;

export interface StageHistoryEntry {
  stage: StageKey;
  entered_at: string;
  edited_by?: string;
  edit_locked?: boolean;
  notes?: string;
}

export interface Lead {
  id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  sfdc_lead_id?: string | null;
  sfdc_contact_id?: string | null;
  hubspot_contact_id?: string | null;
  account?: string | null;
  title?: string | null;
  country?: string | null;
  owner?: string | null;
  lead_source?: string | null;
  current_stage: StageKey;
  marketing_sourced_date?: string | null;
  source_channel_id?: string | null;
  stage_history: StageHistoryEntry[];
  field_locks: Record<string, boolean>;
  source_sfdc: Record<string, unknown>;
  notes?: string | null;
  created_at: string;
  updated_at: string;
  last_synced_at?: string | null;
  last_edited_by?: string | null;
}

export interface Channel {
  id: string;
  name: string;
  parent_channel_id?: string | null;
  display_order: number;
  hidden: boolean;
  created_at: string;
}

export interface FunnelProjection {
  id: string;
  channel_id: string;
  year: number;
  period_index: PeriodIndex;
  stage_key: StageKey | AttributionStageKey;
  projection: number | null;
  edited_at: string;
  edited_by?: string | null;
}

export interface FunnelActual {
  id: string;
  channel_id: string;
  year: number;
  period_index: PeriodIndex;
  stage_key: AttributionStageKey;
  actual: number | null;
  edited_at: string;
  edited_by?: string | null;
}
