CREATE TABLE room_members (subject TEXT PRIMARY KEY NOT NULL, room TEXT NOT NULL);
CREATE INDEX members_by_room ON room_members (room);
CREATE TABLE room_events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, room TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX history_by_room ON room_events (room, seq);
CREATE INDEX latest_speech_by_room ON room_events (room, seq DESC) WHERE json_extract(body, '$.kind') = 'speech';
CREATE TABLE pending (
  recipient TEXT NOT NULL,
  event_seq INTEGER NOT NULL REFERENCES room_events(seq),
  expires_ms INTEGER NOT NULL,
  delivery TEXT NOT NULL CHECK (delivery IN ('now', 'batch')),
  answer INTEGER NOT NULL CHECK (answer IN (0, 1)),
  PRIMARY KEY (recipient, event_seq)
);
CREATE INDEX pending_by_expiry ON pending (expires_ms);
CREATE TABLE agent_status (subject TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL);
CREATE TABLE person_profile (subject TEXT PRIMARY KEY NOT NULL, avatar_url TEXT, return_room TEXT, github_user_id INTEGER);
CREATE TABLE person_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  subject TEXT NOT NULL REFERENCES person_profile(subject),
  expires_ms INTEGER NOT NULL
);
CREATE INDEX person_sessions_by_subject ON person_sessions (subject);
PRAGMA user_version = 3;

INSERT INTO room_events VALUES (1, 'e140593c-ffbd-4e37-b685-433193df3c4b', 'living',
  '{"id":"e140593c-ffbd-4e37-b685-433193df3c4b","actor":{"id":"lee","name":"Lee","kind":"person"},"occurred_at":"2026-11-27T09:55:00.000Z","room":{"id":"living","name":"Living"},"kind":"speech","text":"Saved before the upgrade","to":["fern"]}');
INSERT INTO pending VALUES ('system:serviceaccount:example:fern', 1, unixepoch('2026-11-28T09:55:00Z') * 1000, 'now', 1);
