import type { Lead } from '../types/db';

export type EditableLeadField =
  | 'first_name'
  | 'last_name'
  | 'account'
  | 'title'
  | 'country'
  | 'region'
  | 'owner'
  | 'lead_source'
  | 'current_stage'
  | 'marketing_sourced_date'
  | 'source_channel_id'
  | 'notes'
  | 'event_activations';

export const EDITABLE_LEAD_FIELDS: EditableLeadField[] = [
  'first_name',
  'last_name',
  'account',
  'title',
  'country',
  'region',
  'owner',
  'lead_source',
  'current_stage',
  'marketing_sourced_date',
  'source_channel_id',
  'event_activations',
  'notes',
];

export const LOCKABLE_LEAD_FIELDS: ReadonlySet<EditableLeadField> = new Set(
  EDITABLE_LEAD_FIELDS,
);

export type LeadFieldKind =
  | 'text'
  | 'date'
  | 'stage'
  | 'channel'
  | 'region'
  | 'longText'
  | 'eventActivations';

export const LEAD_FIELD_LABELS: Record<EditableLeadField, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  account: 'Account',
  title: 'Title',
  country: 'Country',
  region: 'Region',
  owner: 'Owner',
  lead_source: 'Lead source',
  current_stage: 'Stage',
  marketing_sourced_date: 'Marketing sourced date',
  source_channel_id: 'Source channel',
  notes: 'Notes',
  event_activations: 'Event Activation',
};

export const LEAD_FIELD_KIND: Record<EditableLeadField, LeadFieldKind> = {
  first_name: 'text',
  last_name: 'text',
  account: 'text',
  title: 'text',
  country: 'text',
  region: 'region',
  owner: 'text',
  lead_source: 'text',
  current_stage: 'stage',
  marketing_sourced_date: 'date',
  source_channel_id: 'channel',
  notes: 'longText',
  event_activations: 'eventActivations',
};

export function isEditableLeadField(k: string): k is EditableLeadField {
  return (EDITABLE_LEAD_FIELDS as string[]).includes(k);
}

// Compile-time guard: every EditableLeadField must be a real key on Lead.
type _AssertSubset = EditableLeadField extends keyof Lead ? true : never;
const _assert: _AssertSubset = true;
void _assert;
