import type { RegionKey } from '../constants/regions';

export type StageKey = 'lead' | 'mql';

export type AttributionStageKey =
  | 'hpp'
  | 'opp'
  | 'pursuit'
  | 'closeWon'
  | 'closeLost';

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
  region?: RegionKey | null;
  owner?: string | null;
  lead_source?: string | null;
  current_stage: StageKey;
  marketing_sourced_date?: string | null;
  source_channel_id?: string | null;
  stage_history: StageHistoryEntry[];
  field_locks: Record<string, boolean>;
  source_sfdc: Record<string, unknown>;
  notes?: string | null;
  // Closed set of event-marketing engagement values from SFDC's
  // "Event Activation" field (Pre-Event Meeting, Booth Meeting,
  // Session Attendee, Post-Event Meeting). DB column is TEXT[] NOT
  // NULL with a '{}' default, so an empty array (never undefined) is
  // the canonical "no activations" representation.
  event_activations: string[];
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

export interface Attribution {
  id: string;
  // M7 leaves lead_id null. M8 will add an "associate lead" picker.
  lead_id?: string | null;
  // Shared across stages for the same deal so HPP -> Opp -> Pursuit -> Won
  // all link back to one logical opportunity.
  deal_id?: string | null;
  stage_key: AttributionStageKey;
  // First-touch (primary) channel — the leaf that drives the funnel grid cell.
  channel_id?: string | null;
  year: number;
  period_index: PeriodIndex;
  label?: string | null;     // Deal name, e.g. "Acme Corp"
  account?: string | null;
  amount?: number | null;
  sf_link?: string | null;
  region?: RegionKey | null;
  // ISO date (YYYY-MM-DD) the deal entered THIS stage. Drives velocity
  // computations on the Marketing Funnel: Velocity sub-tab.
  stage_entered_at: string;
  created_at: string;
  updated_at: string;
}

export interface AttributionTouch {
  id: string;
  attribution_id: string;
  touch_order: number;        // 1-indexed
  channel_id?: string | null;
  touched_at?: string | null; // ISO date
  notes?: string | null;
  created_at: string;
}

// One row per (sequence, export_date). Populated by the n8n weekly cron;
// the app never writes here. Region is inferred at read time from
// sequence_name (lib/outreach.ts) so it isn't on the row.
export interface OutreachSnapshot {
  id: string;
  export_date: string;        // ISO date (YYYY-MM-DD)
  week_number: number;
  year: number;
  sequence_id: number;
  sequence_name: string;
  enabled: boolean;
  step_count: number;
  duration_days: number;
  total_sent: number;
  delivered: number;
  bounced: number;
  failed: number;
  opened: number;
  clicked: number;
  replied: number;
  positive_replies: number;
  neutral_replies: number;
  negative_replies: number;
  opted_out: number;
  delivery_rate: number;      // percentage 0-100
  open_rate: number;
  click_rate: number;
  reply_rate: number;
  bounce_rate: number;
  opt_out_rate: number;
  contacted_prospects: number;
  replied_prospects: number;
  prospects_added: number;
  prospects_active: number;
  total_tasks: number;
  overdue_tasks: number;
  outbound_calls: number;
  linkedin_tasks_completed: number;
  created_at: string;
}

// Date-range budget per channel. Multiple rows per channel are
// allowed: each contract / line item gets its own row. The Spend
// report pro-rates each row to the selected period based on the
// overlap of [start_date, end_date] with the period.
export interface CampaignCost {
  id: string;
  channel_id: string;
  amount: number;
  start_date: string;        // ISO date (YYYY-MM-DD), inclusive
  end_date: string;          // ISO date (YYYY-MM-DD), inclusive
  notes: string | null;
  created_at: string;
  updated_at: string;
}
