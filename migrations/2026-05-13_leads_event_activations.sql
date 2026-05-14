-- Adds event_activations array column to leads for tracking
-- per-contact event-marketing engagement signals from Salesforce.
-- Values come from a closed set: Pre-Event Meeting, Booth Meeting,
-- Session Attendee, Post-Event Meeting. No DB-level CHECK to keep
-- the taxonomy easy to extend; the application validates at import
-- and edit time.

BEGIN;

ALTER TABLE leads
  ADD COLUMN event_activations TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_leads_event_activations
  ON leads USING GIN (event_activations);

COMMIT;
