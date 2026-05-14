// Closed set of event-activation values from Salesforce's
// "Event Activation" field. Values are case-sensitive and match the
// SFDC export exactly. The CSV cell can be empty or
// semicolon-separated combinations of these.
export const EVENT_ACTIVATION_VALUES = [
  'Pre-Event Meeting',
  'Booth Meeting',
  'Session Attendee',
  'Post-Event Meeting',
] as const;

export type EventActivation = (typeof EVENT_ACTIVATION_VALUES)[number];

// Short labels for table columns where space is tight.
export const EVENT_ACTIVATION_SHORT_LABELS: Record<EventActivation, string> = {
  'Pre-Event Meeting': 'Pre-Event Mtg',
  'Booth Meeting': 'Booth Mtg',
  'Session Attendee': 'Session',
  'Post-Event Meeting': 'Post-Event Mtg',
};

// Name of the top-level channel that contains the year's event sub-
// channels. The Events sub-tab walks this parent's descendants to
// build the per-event table. Update this when rolling over to the
// next year's events parent (e.g., "2027 - Events").
export const EVENTS_PARENT_CHANNEL_NAME = '2026 - Events';

// Parse the SFDC "Event Activation" CSV cell into a clean array.
// Unknown values are dropped with a console warning. Empty cell
// returns an empty array.
export function parseEventActivations(raw: string): EventActivation[] {
  if (!raw || !raw.trim()) return [];
  const parts = raw.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  const valid: EventActivation[] = [];
  for (const p of parts) {
    if ((EVENT_ACTIVATION_VALUES as readonly string[]).includes(p)) {
      valid.push(p as EventActivation);
    } else {
      console.warn(`Unknown event activation value, dropped: ${JSON.stringify(p)}`);
    }
  }
  return valid;
}
