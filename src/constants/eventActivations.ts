// The four "active" event-activation values from Salesforce's
// "Event Activation" field. Values are case-sensitive and match the
// SFDC export exactly. The CSV cell can be empty or semicolon-
// separated combinations of these. This array is the "counts as
// active" set: a contact with >= 1 of these is an Active Contact on
// the Events dashboard. "Registered" is deliberately NOT here (see
// EVENT_ACTIVATION_ALL) so registration volume shows as a column but
// does not inflate % Active.
export const EVENT_ACTIVATION_VALUES = [
  'Pre-Event Meeting',
  'Booth Meeting',
  'Session Attendee',
  'Post-Event Meeting',
] as const;

export type EventActivation = (typeof EVENT_ACTIVATION_VALUES)[number];

// "Registered" is a tracked value (very common in the SFDC export)
// but is NOT an activation: it means the contact was on the event
// list, not that they engaged. It gets its own column/tile but is
// excluded from Active Contacts / % Active.
export const REGISTERED_ACTIVATION = 'Registered' as const;

// The full set of recognized values: the 4 active types plus
// Registered. Used for parsing, storage, display, and the lead-drawer
// editor. EVENT_ACTIVATION_VALUES stays the "active" subset.
export const EVENT_ACTIVATION_ALL = [
  ...EVENT_ACTIVATION_VALUES,
  REGISTERED_ACTIVATION,
] as const;

export type EventActivationValue = (typeof EVENT_ACTIVATION_ALL)[number];

// Short labels for table columns where space is tight.
export const EVENT_ACTIVATION_SHORT_LABELS: Record<EventActivationValue, string> = {
  'Pre-Event Meeting': 'Pre-Event Mtg',
  'Booth Meeting': 'Booth Mtg',
  'Session Attendee': 'Session',
  'Post-Event Meeting': 'Post-Event Mtg',
  Registered: 'Registered',
};

// Name of the top-level channel that contains the year's event sub-
// channels. The Events sub-tab walks this parent's descendants to
// build the per-event table. Update this when rolling over to the
// next year's events parent (e.g., "2027 - Events").
export const EVENTS_PARENT_CHANNEL_NAME = '2026 - Events';

// Parse the SFDC "Event Activation" CSV cell into a clean array.
// Recognizes the 4 active types plus "Registered". Genuinely unknown
// values are dropped with a console warning. Empty cell returns an
// empty array.
export function parseEventActivations(raw: string): EventActivationValue[] {
  if (!raw || !raw.trim()) return [];
  const parts = raw.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  const valid: EventActivationValue[] = [];
  for (const p of parts) {
    if ((EVENT_ACTIVATION_ALL as readonly string[]).includes(p)) {
      valid.push(p as EventActivationValue);
    } else {
      console.warn(`Unknown event activation value, dropped: ${JSON.stringify(p)}`);
    }
  }
  return valid;
}
