// The backend's state: one SQLite file (ADR-0002). The schema is new, not
// natsumi's, and grows by migrations from the first version on.
import { DatabaseSync } from "node:sqlite";

/**
 * Each entry moves the schema one version on; `PRAGMA user_version` is the
 * number of entries applied. Entries are only ever appended, never edited.
 */
export const MIGRATIONS: readonly string[] = [
  `
  -- The queue. Times are milliseconds since the epoch.
  CREATE TABLE events (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT NOT NULL,
    id           TEXT NOT NULL,
    stream       TEXT,
    occurred_at  TEXT NOT NULL,
    received_ms  INTEGER NOT NULL,
    summary      TEXT NOT NULL,
    delivery     TEXT NOT NULL CHECK (delivery IN ('now', 'batch')),
    inline       INTEGER NOT NULL,
    payload      TEXT NOT NULL,
    path         TEXT NOT NULL,
    line         INTEGER NOT NULL,
    attachments  TEXT,
    -- When it may be handed over: at once for now, when its batch ends for batch.
    due_ms       INTEGER,
    delivered_ms INTEGER,
    acked_ms     INTEGER,
    UNIQUE (source, id)
  );
  CREATE INDEX events_open ON events (seq) WHERE acked_ms IS NULL;

  -- The conversation: the owner's messages and the replies.
  CREATE TABLE history (
    row         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL CHECK (kind IN ('owner', 'agent')),
    agent       TEXT,
    at          TEXT NOT NULL,
    text        TEXT NOT NULL,
    expression  TEXT,
    in_reply_to INTEGER
  );

  -- What the turns did, block by block.
  CREATE TABLE activities (
    row     INTEGER PRIMARY KEY AUTOINCREMENT,
    agent   TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    kind    TEXT NOT NULL,
    at      TEXT NOT NULL,
    body    TEXT NOT NULL
  );

  CREATE TABLE schedules (
    id         TEXT PRIMARY KEY,
    agent      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    cron       TEXT,
    at         TEXT,
    next_ms    INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE session_rotations (
    row   INTEGER PRIMARY KEY AUTOINCREMENT,
    agent TEXT NOT NULL,
    at    TEXT NOT NULL
  );

  -- The owner's logins. Only the SHA-256 of a token is kept.
  CREATE TABLE login_sessions (
    session_id     TEXT PRIMARY KEY,
    token_hash     TEXT NOT NULL UNIQUE,
    github_user_id INTEGER NOT NULL,
    created_ms     INTEGER NOT NULL,
    expires_ms     INTEGER NOT NULL,
    revoked_ms     INTEGER
  );
  `,
  `
  -- The tasks other agents sent over A2A (docs/a2a.md). Times are milliseconds since the epoch.
  CREATE TABLE a2a_tasks (
    task_id     TEXT PRIMARY KEY,
    sender      TEXT NOT NULL,
    context_id  TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('working', 'input-required', 'completed', 'failed', 'rejected')),
    -- Why it failed or was rejected, as the sender is told.
    reason      TEXT,
    created_ms  INTEGER NOT NULL,
    -- The sender's last message: the deadline counts from it.
    received_ms INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
  );
  CREATE INDEX a2a_tasks_open ON a2a_tasks (sender) WHERE state IN ('working', 'input-required');

  -- The messages of each task, the sender's and hers, in order.
  CREATE TABLE a2a_messages (
    row        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL REFERENCES a2a_tasks (task_id),
    role       TEXT NOT NULL CHECK (role IN ('sender', 'agent')),
    message_id TEXT NOT NULL,
    text       TEXT NOT NULL,
    at_ms      INTEGER NOT NULL,
    -- The event a sender's message became; her reply names it.
    seq        INTEGER UNIQUE
  );
  CREATE INDEX a2a_messages_task ON a2a_messages (task_id, row);
  `,
  `
  -- The sub-agents (ADR-0022): the last of POST /v1/agents for each name.
  CREATE TABLE sub_agents (
    agent      TEXT PRIMARY KEY,
    purpose    TEXT NOT NULL,
    closed     INTEGER NOT NULL CHECK (closed IN (0, 1)),
    -- When the runner first said it was started (closed false).
    started_at TEXT,
    updated_at TEXT NOT NULL
  );

  -- An agent's state is its last turn_start or turn_end: found by this.
  CREATE INDEX activities_turns ON activities (agent, row) WHERE kind IN ('turn_start', 'turn_end');
  `,
  `
  -- Where the notices of the replies go (ADR-0027): one row per endpoint, the
  -- keys of its kind as JSON. Times are milliseconds since the epoch.
  CREATE TABLE push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL CHECK (kind IN ('web-push')),
    endpoint   TEXT NOT NULL UNIQUE,
    keys       TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  );
  `,
  `
  -- What the agents made, copied by the backend (ADR-0032): for now the images
  -- of the replies, each tied to its reply. The bytes are a file under the
  -- assets directory, named by the file column. They are never removed.
  CREATE TABLE assets (
    row        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL CHECK (kind IN ('image')),
    mime_type  TEXT NOT NULL,
    size       INTEGER NOT NULL,
    name       TEXT NOT NULL,
    file       TEXT NOT NULL,
    agent      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- The reply it was sent with, and its place among that reply's images.
    reply_id   TEXT REFERENCES history (id),
    position   INTEGER
  );
  CREATE INDEX assets_reply ON assets (reply_id, position) WHERE reply_id IS NOT NULL;
  `,
  `
  -- The owner's images are copied too (ADR-0034): a copy belongs to a line of
  -- the history, a reply or one of the owner's messages, and an owner's copy
  -- has no agent. SQLite cannot loosen NOT NULL in place, so the table is
  -- made again with the rows it had.
  CREATE TABLE assets_next (
    row        INTEGER PRIMARY KEY AUTOINCREMENT,
    id         TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL CHECK (kind IN ('image')),
    mime_type  TEXT NOT NULL,
    size       INTEGER NOT NULL,
    name       TEXT NOT NULL,
    file       TEXT NOT NULL,
    -- The agent that made it; NULL for what the owner sent.
    agent      TEXT,
    created_at TEXT NOT NULL,
    -- The line of the history it was sent with, and its place among that line's images.
    message_id TEXT REFERENCES history (id),
    position   INTEGER
  );
  INSERT INTO assets_next (row, id, kind, mime_type, size, name, file, agent, created_at, message_id, position)
    SELECT row, id, kind, mime_type, size, name, file, agent, created_at, reply_id, position FROM assets;
  DROP TABLE assets;
  ALTER TABLE assets_next RENAME TO assets;
  CREATE INDEX assets_message ON assets (message_id, position) WHERE message_id IS NOT NULL;

  -- The owner's files that are not copied: their names and sizes, as JSON.
  ALTER TABLE history ADD COLUMN files TEXT;
  `,
  `
  -- The activity record (ADR-0038): one row a turn, beside the activities
  -- that are its flow. Times are RFC 3339 in UTC, as the activities have them.
  CREATE TABLE turns (
    turn_id       TEXT PRIMARY KEY,
    agent         TEXT NOT NULL,
    started_at    TEXT,
    ended_at      TEXT,
    -- As the runner said; NULL while it runs, or when it ended and the runner did not say.
    result        TEXT CHECK (result IN ('done', 'failed', 'stopped')),
    reason        TEXT,
    -- When the backend learned the result.
    recorded_at   TEXT,
    -- The events it was given, as JSON, and how many in all.
    triggers      TEXT NOT NULL DEFAULT '[]',
    trigger_count INTEGER NOT NULL DEFAULT 0,
    tools         INTEGER NOT NULL DEFAULT 0,
    -- A turn of the nightly switch: the seq of its control event and the step.
    night_seq     INTEGER,
    stage         TEXT CHECK (stage IN ('reflection', 'curator')),
    -- Where it stands in the list: its start, else the first that was heard of it.
    at            TEXT NOT NULL
  );
  CREATE INDEX turns_at ON turns (at);
  CREATE INDEX turns_agent ON turns (agent, at);
  CREATE INDEX turns_open ON turns (agent) WHERE ended_at IS NULL AND result IS NULL;
  CREATE INDEX turns_night ON turns (night_seq, stage) WHERE night_seq IS NOT NULL;
  CREATE INDEX turns_failed ON turns (recorded_at) WHERE result = 'failed';

  -- The turns from before the record, made from their activities; their result is unknown.
  INSERT INTO turns (turn_id, agent, started_at, ended_at, tools, at)
    SELECT turn_id, min(agent),
           min(CASE WHEN kind = 'turn_start' THEN at END),
           max(CASE WHEN kind = 'turn_end' THEN at END),
           sum(kind = 'tool_call'),
           coalesce(min(CASE WHEN kind = 'turn_start' THEN at END), min(at))
      FROM activities GROUP BY turn_id;
  -- One with no end that a later turn of the same agent followed was cut.
  UPDATE turns SET result = 'stopped'
   WHERE ended_at IS NULL AND EXISTS (SELECT 1 FROM turns later WHERE later.agent = turns.agent AND later.at > turns.at);

  -- A turn's flow is read by its turn, and the old is removed by its time.
  CREATE INDEX activities_turn ON activities (turn_id, row);
  CREATE INDEX activities_at ON activities (at);

  -- The turn a reply was sent in. Those from before are tied to the main agent's turn they fell in.
  ALTER TABLE history ADD COLUMN turn_id TEXT;
  UPDATE history SET turn_id = (
    SELECT t.turn_id FROM turns t
     WHERE t.agent = 'main' AND t.started_at <= history.at AND (t.ended_at IS NULL OR t.ended_at >= history.at)
     ORDER BY t.started_at DESC LIMIT 1)
   WHERE kind = 'agent';
  CREATE INDEX history_turn ON history (turn_id) WHERE turn_id IS NOT NULL;

  -- The nightly switches: the seq of the night's control event, its steps as
  -- JSON, when it was due and started, and whether a step failed. A row from
  -- before has none of them.
  ALTER TABLE session_rotations ADD COLUMN seq INTEGER;
  ALTER TABLE session_rotations ADD COLUMN stages TEXT;
  ALTER TABLE session_rotations ADD COLUMN scheduled_at TEXT;
  ALTER TABLE session_rotations ADD COLUMN started_at TEXT;
  ALTER TABLE session_rotations ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX session_rotations_seq ON session_rotations (seq) WHERE seq IS NOT NULL;
  CREATE INDEX session_rotations_at ON session_rotations (coalesce(started_at, at));

  -- The ends of the background jobs, one line each (ADR-0030).
  CREATE TABLE record_jobs (
    id          TEXT PRIMARY KEY,
    command     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT NOT NULL,
    seconds     INTEGER NOT NULL,
    end_kind    TEXT NOT NULL,
    exit_code   INTEGER,
    signal      TEXT,
    failed      INTEGER NOT NULL,
    received_at TEXT NOT NULL
  );
  CREATE INDEX record_jobs_ended ON record_jobs (ended_at);
  INSERT OR IGNORE INTO record_jobs (id, command, started_at, ended_at, seconds, end_kind, exit_code, signal, failed, received_at)
    SELECT id, substr(json_extract(payload, '$.command'), 1, 200), json_extract(payload, '$.started_at'),
           json_extract(payload, '$.ended_at'), json_extract(payload, '$.seconds'), json_extract(payload, '$.end'),
           json_extract(payload, '$.exit_code'), json_extract(payload, '$.signal'),
           json_extract(payload, '$.end') IN ('timed-out', 'signaled')
             OR (json_extract(payload, '$.end') = 'exited' AND coalesce(json_extract(payload, '$.exit_code'), 0) <> 0),
           strftime('%Y-%m-%dT%H:%M:%fZ', received_ms / 1000.0, 'unixepoch')
      FROM events
     WHERE source = 'job' AND json_valid(payload)
       AND json_type(payload, '$.command') = 'text' AND json_type(payload, '$.started_at') = 'text'
       AND json_type(payload, '$.ended_at') = 'text' AND json_type(payload, '$.seconds') = 'integer'
       AND json_type(payload, '$.end') = 'text';

  -- When the record began, and when the owner last opened it.
  CREATE TABLE record_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- The owner's settings, one selection for the entire deployment (ADR-0043).
  CREATE TABLE model_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    model     TEXT NOT NULL,
    thinking  TEXT NOT NULL
  );
  `,
  `
  -- Widen the nightly stage check, preserving previous turns and their indexes.
  CREATE TABLE turns_next (
    turn_id       TEXT PRIMARY KEY,
    agent         TEXT NOT NULL,
    started_at    TEXT,
    ended_at      TEXT,
    result        TEXT CHECK (result IN ('done', 'failed', 'stopped')),
    reason        TEXT,
    recorded_at   TEXT,
    triggers      TEXT NOT NULL DEFAULT '[]',
    trigger_count INTEGER NOT NULL DEFAULT 0,
    tools         INTEGER NOT NULL DEFAULT 0,
    night_seq     INTEGER,
    stage         TEXT CHECK (stage IN ('reflection', 'verifier', 'curator')),
    at            TEXT NOT NULL
  );
  INSERT INTO turns_next SELECT turn_id, agent, started_at, ended_at, result, reason,
    recorded_at, triggers, trigger_count, tools, night_seq, stage, at FROM turns;
  DROP TABLE turns;
  ALTER TABLE turns_next RENAME TO turns;
  CREATE INDEX turns_at ON turns (at);
  CREATE INDEX turns_agent ON turns (agent, at);
  CREATE INDEX turns_open ON turns (agent) WHERE ended_at IS NULL AND result IS NULL;
  CREATE INDEX turns_night ON turns (night_seq, stage) WHERE night_seq IS NOT NULL;
  CREATE INDEX turns_failed ON turns (recorded_at) WHERE result = 'failed';
  `,
  `
  -- Counts from the memory commit of a night turn (ADR-0044). NULL when not measured.
  ALTER TABLE turns ADD COLUMN memory_change TEXT;
  `,
  `
  -- Inbound images live in /sources; history keeps only their presence.
  ALTER TABLE a2a_messages ADD COLUMN has_images INTEGER NOT NULL DEFAULT 0;
  -- Outbound images: ordered references to files in the backend's assets directory.
  ALTER TABLE a2a_tasks ADD COLUMN response_images TEXT;
  `,
  `
  -- A rotation's final committed memory version. NULL means it was not captured.
  ALTER TABLE session_rotations ADD COLUMN memory_head TEXT;
  -- Only the most recent complete snapshot, ordered by the rotation event.
  CREATE TABLE memory_reads (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    seq INTEGER NOT NULL,
    snapshot TEXT NOT NULL
  );
  `,
  `
  -- Optional answer route (ADR-0060). Existing events have no route.
  ALTER TABLE events ADD COLUMN answer_via TEXT;
  `,
];

/** Opens the file (or `:memory:`) and brings its schema up to date. */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version > MIGRATIONS.length) {
    throw new Error(`the database is at schema ${version}, newer than this backend's ${MIGRATIONS.length}`);
  }
  for (let next = version; next < MIGRATIONS.length; next++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[next]!);
      db.exec(`PRAGMA user_version = ${next + 1}`);
    });
  }
}

/**
 * Runs `work` in one transaction: all of it is kept, or none of it if it
 * throws. Inside another transaction it is a savepoint of it, kept or dropped
 * with the outer one, so that parts that take their own transaction can be put
 * together into one.
 */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  const inner = db.isTransaction;
  const name = `inner_${++savepoints}`;
  db.exec(inner ? `SAVEPOINT ${name}` : "BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec(inner ? `RELEASE ${name}` : "COMMIT");
    return result;
  } catch (error) {
    db.exec(inner ? `ROLLBACK TO ${name}; RELEASE ${name}` : "ROLLBACK");
    throw error;
  }
}

let savepoints = 0;
