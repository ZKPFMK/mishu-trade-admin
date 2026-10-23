ALTER TABLE event_conflicts ADD COLUMN resolved_at timestamptz;
ALTER TABLE event_conflicts ADD COLUMN resolved_by text REFERENCES operators(id);
ALTER TABLE event_conflicts ADD COLUMN resolution_note text;
CREATE UNIQUE INDEX event_conflict_digest ON event_conflicts(application_id,event_id,incoming_digest);
