// The activity record (ADR-0038, docs/backend.md "活動の記録"): a one-line
// summary of each turn, night and background job beside the activities that
// are a turn's flow; what the UI reads of them (docs/ui-api.md "活動の記録");
// the missed nights, found from the nightly schedule when read; and the
// failures the owner has not seen. The old is removed with time.
import type { DatabaseSync } from "node:sqlite";

import {
  type Activity,
  type AgentId,
  type HeartbeatFailure,
  HEARTBEAT_PENDING_LIMIT,
  type HeartbeatPendingList,
  type JobEnd,
  type NightStages,
  type NightTurnReport,
  type NightTurnStage,
  RECORD_COMMAND_MAX,
  RECORD_FLOW_DAYS,
  RECORD_REASON_MAX,
  RECORD_SUMMARY_DAYS,
  RECORD_TRIGGERS_MAX,
  type RecordDayResponse,
  type RecordFlowItem,
  type RecordJob,
  type RecordKind,
  type RecordMemoryChange,
  type RecordMissedNight,
  type RecordNight,
  type RecordNightResponse,
  type RecordNightStage,
  type RecordRow,
  type RecordSeenResponse,
  type RecordSubAgent,
  type RecordSubAgentResponse,
  type RecordTrigger,
  type RecordTurn,
  type RecordTurnResponse,
  type TurnResult,
} from "@penelope/contract";
import type { Cron } from "croner";

import type { Feed } from "./feed.ts";
import { iso } from "./time.ts";

const DAY_MS = 86_400_000;
/** A night's event is queued within a tick of its time; one not queued a minute after was missed. */
const QUEUE_GRACE_MS = 60_000;
/** Rows removed at a time, so that reads and writes are not held up for long. */
const PRUNE_BATCH = 500;
/** How often the old is removed. */
const PRUNE_EVERY_MS = 3_600_000;
/** How often the number of unseen failures is looked at again: the missed nights change it with time alone. */
const UNSEEN_EVERY_MS = 15_000;
/** Turns of a sub-agent on one page. */
export const SUB_AGENT_PAGE = 20;

/** What the UI asked for that is not there, or not well formed: answered 404 or 400. */
export class RecordQueryError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

export type TurnEnd = {
  turn_id: string;
  result?: TurnResult;
  reason?: string;
  seqs?: number[];
  night?: { seq: number; stage: NightTurnStage };
};

export type DayQuery = { day?: string; timeZone?: string; failed?: boolean; agent?: string; kind?: RecordKind };

type TurnRow = {
  rowid: number;
  turn_id: string;
  agent: string;
  started_at: string | null;
  ended_at: string | null;
  result: TurnResult | null;
  reason: string | null;
  recorded_at: string | null;
  triggers: string;
  trigger_count: number;
  tools: number;
  stage: NightTurnStage | null;
  at: string;
  replies: number;
  night_row: number | null;
};

type NightRow = {
  row: number;
  at: string;
  seq: number | null;
  stages: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  failed: number;
};

type JobRow = {
  id: string;
  command: string;
  started_at: string;
  ended_at: string;
  seconds: number;
  end_kind: JobEnd["end"];
  exit_code: number | null;
  signal: string | null;
  failed: number;
  received_at: string;
};

type SubAgentRow = { agent: string; purpose: string; closed: number; started_at: string | null; updated_at: string; turns: number; failed_turns: number };

const TURN_SELECT = `
  SELECT t.rowid, t.turn_id, t.agent, t.started_at, t.ended_at, t.result, t.reason, t.recorded_at, t.triggers,
         t.trigger_count, t.tools, t.stage, t.at, n.row AS night_row,
         (SELECT count(*) FROM history h WHERE h.turn_id = t.turn_id) AS replies
    FROM turns t LEFT JOIN session_rotations n ON n.seq = t.night_seq`;

const SUB_AGENT_SELECT = `
  SELECT s.agent, s.purpose, s.closed, s.started_at, s.updated_at,
         (SELECT count(*) FROM turns t WHERE t.agent = s.agent) AS turns,
         (SELECT count(*) FROM turns t WHERE t.agent = s.agent AND t.result = 'failed') AS failed_turns
    FROM sub_agents s`;

export class ActivityRecord {
  private readonly db: DatabaseSync;
  private readonly feed: Feed;
  private readonly now: () => number;
  private readonly timeZone: string;
  private readonly nightly: Cron;
  private readonly owner: string;
  private readonly log: (line: string) => void;
  private lastUnseen: number | undefined;

  constructor(
    db: DatabaseSync,
    feed: Feed,
    options: { now: () => number; timeZone: string; nightly: Cron; owner?: number; log?: (line: string) => void },
  ) {
    this.db = db;
    this.feed = feed;
    this.now = options.now;
    this.timeZone = options.timeZone;
    this.nightly = options.nightly;
    this.owner = String(options.owner ?? "owner");
    this.log = options.log ?? console.error;
    // Nights before the record began are not counted as missed.
    db.prepare("INSERT OR IGNORE INTO record_state (key, value) VALUES ('since', ?)").run(iso(this.now()));
  }

  // ── What is written ──

  /** The blocks of a turn as they come: its start, its tool calls and its end. */
  activities(agent: AgentId, activities: readonly Activity[]): void {
    for (const activity of activities) {
      const at = normal(activity.at);
      if (activity.kind === "turn_start") {
        // The agent's turn that never ended was cut: the runner could not say so.
        this.db
          .prepare("UPDATE turns SET result = 'stopped', recorded_at = ? WHERE agent = ? AND turn_id <> ? AND ended_at IS NULL AND result IS NULL")
          .run(iso(this.now()), agent, activity.turn_id);
        this.db
          .prepare(
            `INSERT INTO turns (turn_id, agent, started_at, at) VALUES (?, ?, ?, ?)
             ON CONFLICT (turn_id) DO UPDATE SET started_at = coalesce(started_at, excluded.started_at), at = coalesce(started_at, excluded.at)`,
          )
          .run(activity.turn_id, agent, at, at);
        continue;
      }
      this.ensure(activity.turn_id, agent, at);
      if (activity.kind === "tool_call") this.db.prepare("UPDATE turns SET tools = tools + 1 WHERE turn_id = ?").run(activity.turn_id);
      if (activity.kind === "turn_end") this.db.prepare("UPDATE turns SET ended_at = coalesce(ended_at, ?) WHERE turn_id = ?").run(at, activity.turn_id);
    }
  }

  /** The turn is over: how it went and what it was given, when the runner says. */
  turnEnded(agent: AgentId, end: TurnEnd): void {
    const now = iso(this.now());
    this.ensure(end.turn_id, agent, now);
    this.db.prepare("UPDATE turns SET ended_at = coalesce(ended_at, ?) WHERE turn_id = ?").run(now, end.turn_id);
    if (end.result !== undefined) {
      this.db
        .prepare("UPDATE turns SET result = ?, reason = ?, recorded_at = ? WHERE turn_id = ?")
        .run(end.result, end.reason === undefined ? null : oneLine(end.reason), now, end.turn_id);
    }
    if (end.seqs !== undefined) {
      const seqs = [...new Set(end.seqs)];
      this.db
        .prepare("UPDATE turns SET triggers = ?, trigger_count = ? WHERE turn_id = ?")
        .run(JSON.stringify(this.triggersOf(seqs.slice(0, RECORD_TRIGGERS_MAX))), seqs.length, end.turn_id);
    }
    if (end.night !== undefined) {
      this.db.prepare("UPDATE turns SET night_seq = ?, stage = ? WHERE turn_id = ?").run(end.night.seq, end.night.stage, end.turn_id);
    }
    if (end.result === "failed") this.publishUnseen();
  }

  /** The numbers measured after committing a night turn; no paths or contents. */
  nightMemoryChanged({ turn_id, night }: TurnEnd, { files, added, removed, handoff_changed }: RecordMemoryChange): void {
    if (night === undefined) return;
    const change = { files, added, removed, ...(night.stage === "reflection" ? { handoff_changed } : {}) };
    this.db.prepare(
      "UPDATE turns SET memory_change = ? WHERE turn_id = ? AND agent = 'main' AND night_seq = ? AND stage = ? AND memory_change IS NULL",
    ).run(JSON.stringify(change), turn_id, night.seq, night.stage);
  }

  /**
   * A night the runner went through. A report of the same night again takes
   * the place of the one before; one without its steps keeps the steps it had.
   * One with no seq is an older runner's: a switch made, the steps unknown.
   */
  nightReported({ seq, stages }: { seq?: number; stages?: NightStages }): void {
    const now = iso(this.now());
    const failed = stages !== undefined && Object.values(stages).some((stage) => stage.result === "failed") ? 1 : 0;
    if (seq === undefined) {
      this.db.prepare("INSERT INTO session_rotations (agent, at, started_at) VALUES ('main', ?, ?)").run(now, now);
      return;
    }
    const kept = stages === undefined ? null : JSON.stringify(this.stagesKept(seq, stages));
    const started = (this.db.prepare("SELECT min(started_at) AS at FROM turns WHERE night_seq = ?").get(seq) as { at: string | null }).at ?? now;
    const scheduled = (this.db.prepare("SELECT occurred_at FROM events WHERE seq = ? AND source = 'control'").get(seq) as { occurred_at: string } | undefined)
      ?.occurred_at;
    const before = this.db.prepare("SELECT row FROM session_rotations WHERE seq = ?").get(seq) as { row: number } | undefined;
    if (before === undefined) {
      this.db
        .prepare("INSERT INTO session_rotations (agent, at, seq, stages, scheduled_at, started_at, failed) VALUES ('main', ?, ?, ?, ?, ?, ?)")
        .run(now, seq, kept, scheduled === undefined ? null : normal(scheduled), started, failed);
    } else if (kept !== null) {
      this.db.prepare("UPDATE session_rotations SET at = ?, stages = ?, started_at = ?, failed = ? WHERE row = ?").run(now, kept, started, failed, before.row);
    }
    if (failed) this.publishUnseen();
  }

  /** Copy counts for this attempt only: an earlier attempt may have reached a stage this one did not. */
  private stagesKept(seq: number, stages: NightStages): RecordNight["stages"] {
    const stage = (key: keyof NightStages, { result, reason, turn_id: turnId }: NightTurnReport): RecordNightStage => {
      const row = turnId === undefined || result === "skipped" ? undefined : this.db.prepare(
        "SELECT memory_change FROM turns WHERE turn_id = ? AND agent = 'main' AND night_seq = ? AND stage = ?",
      ).get(turnId, seq, key) as { memory_change: string | null } | undefined;
      return {
        result,
        ...(reason === undefined ? {} : { reason: oneLine(reason) }),
        ...(row?.memory_change == null ? {} : { memory_change: JSON.parse(row.memory_change) as RecordMemoryChange }),
      };
    };
    const reviewTurn = (turn: NightTurnReport) => ({
      ...stage("curator", turn),
      ...(turn.turn_id === undefined ? {} : { turn_id: turn.turn_id }),
    });
    const { dropped_records } = stages.verifier;
    const { always_read_over_target, review } = stages.curator;
    return {
      reflection: stage("reflection", stages.reflection),
      verifier: { ...stage("verifier", stages.verifier), ...(dropped_records === undefined ? {} : { dropped_records }) },
      curator: {
        ...stage("curator", stages.curator),
        ...(always_read_over_target === undefined ? {} : { always_read_over_target }),
        ...(review === undefined ? {} : { review: { content: reviewTurn(review.content), structure: reviewTurn(review.structure) } }),
      },
      session: stage("session", stages.session),
    };
  }

  /** The end of a background job, as its event carries it; one not of that shape is left out of the record. */
  jobEnded(id: string, payload: unknown): void {
    const job = payload as Partial<JobEnd> | null;
    if (
      typeof job !== "object" || job === null ||
      typeof job.command !== "string" || typeof job.started_at !== "string" || typeof job.ended_at !== "string" ||
      !Number.isSafeInteger(job.seconds) || typeof job.end !== "string"
    ) {
      this.log(`record: the end of job ${id} is not of the shape of a job's end; left out`);
      return;
    }
    const failed = job.end === "timed-out" || job.end === "signaled" || (job.end === "exited" && (job.exit_code ?? 0) !== 0);
    const added = this.db
      .prepare(
        `INSERT OR IGNORE INTO record_jobs (id, command, started_at, ended_at, seconds, end_kind, exit_code, signal, failed, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        job.command.slice(0, RECORD_COMMAND_MAX),
        normal(job.started_at),
        normal(job.ended_at),
        job.seconds!,
        job.end,
        Number.isSafeInteger(job.exit_code) ? job.exit_code! : null,
        typeof job.signal === "string" ? job.signal : null,
        failed ? 1 : 0,
        iso(this.now()),
      );
    if (failed && Number(added.changes) > 0) this.publishUnseen();
  }

  /** The turn a reply belongs to: the one the runner names, else the main agent's turn under way. */
  replyTurn(turnId: string | undefined): string | undefined {
    if (turnId !== undefined) return turnId;
    const row = this.db.prepare("SELECT turn_id FROM turns WHERE agent = 'main' AND ended_at IS NULL AND result IS NULL ORDER BY at DESC LIMIT 1").get() as
      | { turn_id: string }
      | undefined;
    return row?.turn_id;
  }

  /** The newest failures learned of after the previous heartbeat, apart from the night's work. */
  heartbeatFailures(since: string): HeartbeatPendingList<HeartbeatFailure> | undefined {
    const rows = this.db.prepare(
      `WITH failures AS (
         SELECT 'turn' AS kind, recorded_at AS at, reason, NULL AS command, NULL AS exit_code, rowid AS tie
           FROM turns WHERE result = 'failed' AND night_seq IS NULL AND recorded_at > ?
         UNION ALL
         SELECT 'job', received_at, NULL, command, exit_code, rowid
           FROM record_jobs WHERE failed = 1 AND received_at > ?
       )
       SELECT kind, at, substr(reason, 1, 200) AS reason, command, exit_code, count(*) OVER () AS total
         FROM failures ORDER BY at DESC, kind, tie DESC LIMIT ?`,
    ).all(since, since, HEARTBEAT_PENDING_LIMIT) as Array<{
      kind: HeartbeatFailure["kind"]; at: string; reason: string | null; command: string | null; exit_code: number | null; total: number;
    }>;
    if (rows.length === 0) return undefined;
    return {
      items: rows.map(({ kind, at, reason, command, exit_code }) =>
        kind === "turn"
          ? { kind, at, ...(reason === null ? {} : { reason }) }
          : { kind, at, command: command!.split("\n", 1)[0]!, ...(exit_code === null ? {} : { exit_code }) }
      ),
      omitted: rows[0]!.total - rows.length,
    };
  }

  // ── What the UI reads ──

  /** One day of the record, newest first, narrowed as asked; with the next older day that has rows. */
  day(query: DayQuery): RecordDayResponse {
    const timeZone = query.timeZone ?? this.timeZone;
    if (!isTimeZone(timeZone)) throw new RecordQueryError(400, "tz must be an IANA time zone");
    const day = query.day ?? dayOf(this.now(), timeZone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new RecordQueryError(400, "day must be YYYY-MM-DD");
    const from = startOfDay(day, timeZone);
    const to = startOfDay(nextDay(day), timeZone);
    const rows = this.rows(from, to, query).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const { turns, failures } = this.counts(iso(from), iso(to));
    const before = this.latestBefore(from, query);
    const agents = (this.db.prepare("SELECT agent FROM sub_agents ORDER BY rowid").all() as Array<{ agent: string }>).map((row) => row.agent);
    return { day, rows, turns, failures, ...(before === undefined ? {} : { before: dayOf(before, timeZone) }), agents };
  }

  turn(turnId: string): RecordTurnResponse {
    const row = this.db.prepare(`${TURN_SELECT} WHERE t.turn_id = ?`).get(turnId) as TurnRow | undefined;
    if (row === undefined) throw new RecordQueryError(404, "no such turn");
    const blocks = this.db.prepare("SELECT body FROM activities WHERE turn_id = ? AND agent = ? ORDER BY row").all(turnId, row.agent) as Array<{ body: string }>;
    const flow: RecordFlowItem[] = [];
    for (const { body } of blocks) {
      const activity = JSON.parse(body) as Activity;
      if (activity.kind === "turn_start" || activity.kind === "turn_end") continue;
      if (activity.kind === "tool_result") {
        const { output, ...rest } = activity;
        flow.push({ ...rest, lines: output === "" ? 0 : output.split("\n").length, bytes: Buffer.byteLength(output) });
      } else {
        flow.push(activity);
      }
    }
    const expired = flow.length === 0 && Date.parse(row.at) < this.now() - RECORD_FLOW_DAYS * DAY_MS;
    const replies = (this.db.prepare("SELECT row, id, at, text FROM history WHERE turn_id = ? ORDER BY row").all(turnId) as Array<{ row: number; id: string; at: string; text: string }>).map(
      ({ row: line, id, at, text }) => ({ id, at, text, history_before: String(line + 1) }),
    );
    return { turn: turnOf(row), flow, expired, replies };
  }

  /** The whole output of one tool's result in a turn. */
  result(turnId: string, callId: string): string {
    const row = this.db
      .prepare("SELECT body FROM activities WHERE turn_id = ? AND kind = 'tool_result' AND json_extract(body, '$.call_id') = ? ORDER BY row LIMIT 1")
      .get(turnId, callId) as { body: string } | undefined;
    if (row === undefined) throw new RecordQueryError(404, "no such result");
    return (JSON.parse(row.body) as { output: string }).output;
  }

  night(id: string): RecordNightResponse {
    const row = /^\d+$/.test(id) ? (this.db.prepare("SELECT row, at, seq, stages, scheduled_at, started_at, failed FROM session_rotations WHERE row = ?").get(Number(id)) as NightRow | undefined) : undefined;
    if (row === undefined) throw new RecordQueryError(404, "no such night");
    const night = nightOf(row);
    const turns: RecordNightResponse["turns"] = {};
    const review = night.stages.curator.review;
    if (row.seq !== null) {
      for (const stage of ["reflection", "verifier", "curator"] as const) {
        if (stage === "curator" && review !== undefined) continue;
        const turn = this.db.prepare(`${TURN_SELECT} WHERE t.night_seq = ? AND t.stage = ? ORDER BY t.at DESC LIMIT 1`).get(row.seq, stage) as TurnRow | undefined;
        if (turn !== undefined) turns[stage] = turnOf(turn);
      }
      if (review !== undefined) {
        const find = this.db.prepare(`${TURN_SELECT} WHERE t.turn_id = ? AND t.agent = 'main' AND t.night_seq = ? AND t.stage = 'curator'`);
        for (const phase of ["content", "structure"] as const) {
          const { turn_id } = review[phase];
          if (turn_id === undefined) continue;
          const turn = find.get(turn_id, row.seq) as TurnRow | undefined;
          if (turn !== undefined) turns[phase] = turnOf(turn);
        }
        const last = turns.structure ?? turns.content;
        if (last !== undefined) turns.curator = last;
      }
    }
    return { night, turns };
  }

  subAgent(name: string, before?: string): RecordSubAgentResponse {
    const row = this.db.prepare(`${SUB_AGENT_SELECT} WHERE s.agent = ?`).get(name) as SubAgentRow | undefined;
    if (row === undefined) throw new RecordQueryError(404, "no such sub-agent");
    let below = Number.MAX_SAFE_INTEGER;
    if (before !== undefined) {
      if (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before))) throw new RecordQueryError(400, "before is not a cursor of this list");
      below = Number(before);
    }
    const rows = this.db.prepare(`${TURN_SELECT} WHERE t.agent = ? AND t.rowid < ? ORDER BY t.rowid DESC LIMIT ?`).all(name, below, SUB_AGENT_PAGE + 1) as TurnRow[];
    const page = rows.slice(0, SUB_AGENT_PAGE);
    return {
      sub_agent: subAgentOf(row),
      turns: page.map(turnOf),
      ...(rows.length > SUB_AGENT_PAGE ? { before: String(page.at(-1)!.rowid) } : {}),
    };
  }

  /** The failures, missed nights too, the backend learned of after the owner last opened the record. */
  unseen(): number {
    const since = this.state(`seen:${this.owner}`) ?? this.state("since")!;
    const count = (sql: string) => (this.db.prepare(sql).get(since) as { n: number }).n;
    const turns = count(
      `SELECT count(*) AS n FROM turns t WHERE t.result = 'failed' AND t.recorded_at > ?
         AND NOT EXISTS (SELECT 1 FROM session_rotations n WHERE n.seq = t.night_seq)`,
    );
    const nights = count("SELECT count(*) AS n FROM session_rotations WHERE failed = 1 AND at > ?");
    const jobs = count("SELECT count(*) AS n FROM record_jobs WHERE failed = 1 AND received_at > ?");
    // A missed night is known at most two nights after it was due.
    const missed = this.missed(Date.parse(since) - 2 * this.nightGap(), this.now()).filter((night) => night.failed_at > since).length;
    return turns + nights + jobs + missed;
  }

  /** The owner opened the record: what was unseen until now, and when she had opened it before. */
  seen(): RecordSeenResponse {
    const previous = this.state(`seen:${this.owner}`) ?? this.state("since")!;
    const unseen = this.unseen();
    this.db
      .prepare("INSERT INTO record_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(`seen:${this.owner}`, iso(this.now()));
    this.publishUnseen();
    return { unseen, previous_seen_at: previous };
  }

  // ── Kept up with time ──

  /**
   * Removes the flow of turns older than its days and the summaries older
   * than theirs, a few rows at a time, letting other work in between.
   */
  async prune(): Promise<void> {
    const flow = iso(this.now() - RECORD_FLOW_DAYS * DAY_MS);
    const summary = iso(this.now() - RECORD_SUMMARY_DAYS * DAY_MS);
    const steps: Array<[string, string]> = [
      ["DELETE FROM activities WHERE row IN (SELECT row FROM activities WHERE at < ? LIMIT ?)", flow],
      ["DELETE FROM turns WHERE rowid IN (SELECT rowid FROM turns WHERE at < ? LIMIT ?)", summary],
      ["DELETE FROM session_rotations WHERE row IN (SELECT row FROM session_rotations WHERE at < ? LIMIT ?)", summary],
      ["DELETE FROM record_jobs WHERE rowid IN (SELECT rowid FROM record_jobs WHERE ended_at < ? LIMIT ?)", summary],
      ["DELETE FROM sub_agents WHERE rowid IN (SELECT rowid FROM sub_agents WHERE closed = 1 AND updated_at < ? LIMIT ?)", summary],
    ];
    for (const [sql, cutoff] of steps) {
      for (;;) {
        const removed = Number(this.db.prepare(sql).run(cutoff, PRUNE_BATCH).changes);
        if (removed < PRUNE_BATCH) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }

  /** Removes the old now and every hour, and sends the number of unseen failures down the feed when it changes. */
  start(): () => void {
    let pruning = false;
    const prune = () => {
      if (pruning) return;
      pruning = true;
      this.prune()
        .catch((error: unknown) => this.log(`record: the old could not be removed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => (pruning = false));
    };
    prune();
    const pruneTimer = setInterval(prune, PRUNE_EVERY_MS);
    const unseenTimer = setInterval(() => this.publishUnseen(), UNSEEN_EVERY_MS);
    pruneTimer.unref();
    unseenTimer.unref();
    this.lastUnseen = this.unseenOrUndefined();
    return () => {
      clearInterval(pruneTimer);
      clearInterval(unseenTimer);
    };
  }

  /** Sends the number down the feed when it is not what was sent last. */
  publishUnseen(): void {
    const unseen = this.unseenOrUndefined();
    if (unseen === undefined || unseen === this.lastUnseen) return;
    this.lastUnseen = unseen;
    this.feed.publish({ event: "record", data: { unseen } });
  }

  // ── Inside ──

  private unseenOrUndefined(): number | undefined {
    try {
      return this.unseen();
    } catch (error) {
      this.log(`record: the unseen failures could not be counted: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private state(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM record_state WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  /** A row for a turn heard of before its start (the start was not sent), placed at `at`. */
  private ensure(turnId: string, agent: AgentId, at: string): void {
    this.db.prepare("INSERT OR IGNORE INTO turns (turn_id, agent, at) VALUES (?, ?, ?)").run(turnId, agent, at);
  }

  /** The events of the queue the seqs name, in the order given; a seq it does not know is left out. */
  private triggersOf(seqs: readonly number[]): RecordTrigger[] {
    const find = this.db.prepare("SELECT seq, source, stream, summary FROM events WHERE seq = ?");
    const found: RecordTrigger[] = [];
    for (const seq of seqs) {
      const row = find.get(seq) as { seq: number; source: string; stream: string | null; summary: string } | undefined;
      if (row !== undefined) found.push({ seq: row.seq, source: row.source, ...(row.stream === null ? {} : { stream: row.stream }), summary: row.summary });
    }
    return found;
  }

  /** The rows of [from, to), narrowed as asked. */
  private rows(from: number, to: number, query: DayQuery): RecordRow[] {
    const [a, b] = [iso(from), iso(to)];
    const { kind, agent, failed } = query;
    const main = agent === undefined || agent === "main";
    const rows: RecordRow[] = [];
    if (kind === undefined || kind === "turn") {
      const turns = this.db
        .prepare(
          `${TURN_SELECT} WHERE t.at >= ? AND t.at < ? AND n.row IS NULL
             ${agent === undefined ? "AND ? IS NULL" : "AND t.agent = ?"} ${failed ? "AND t.result = 'failed'" : ""}`,
        )
        .all(a, b, agent ?? null) as TurnRow[];
      rows.push(...turns.map(turnOf));
    }
    if (main && (kind === undefined || kind === "night")) {
      const nights = this.db
        .prepare(
          `SELECT row, at, seq, stages, scheduled_at, started_at, failed FROM session_rotations
            WHERE coalesce(started_at, at) >= ? AND coalesce(started_at, at) < ? ${failed ? "AND failed = 1" : ""}`,
        )
        .all(a, b) as NightRow[];
      rows.push(...nights.map(nightOf));
      rows.push(...this.missed(from, Math.min(to, this.now())));
    }
    if (main && (kind === undefined || kind === "job")) {
      const jobs = this.db.prepare(`SELECT * FROM record_jobs WHERE ended_at >= ? AND ended_at < ? ${failed ? "AND failed = 1" : ""}`).all(a, b) as JobRow[];
      rows.push(...jobs.map(jobOf));
    }
    // A closed sub-agent is not a failure, and is no row of the main agent's.
    if (!failed && agent !== "main" && (kind === undefined || kind === "sub_agent")) {
      const closed = this.db
        .prepare(`${SUB_AGENT_SELECT} WHERE s.closed = 1 AND s.updated_at >= ? AND s.updated_at < ? ${agent === undefined ? "AND ? IS NULL" : "AND s.agent = ?"}`)
        .all(a, b, agent ?? null) as SubAgentRow[];
      rows.push(...closed.map(subAgentOf));
    }
    return rows;
  }

  /** The whole day's turns and failures, not narrowed. A missed night is not counted. */
  private counts(a: string, b: string): { turns: number; failures: number } {
    const turns = this.db
      .prepare(
        `SELECT count(*) AS n, coalesce(sum(t.result = 'failed'), 0) AS failed FROM turns t
          WHERE t.at >= ? AND t.at < ? AND NOT EXISTS (SELECT 1 FROM session_rotations n WHERE n.seq = t.night_seq)`,
      )
      .get(a, b) as { n: number; failed: number };
    const nights = this.db
      .prepare("SELECT count(*) AS n FROM session_rotations WHERE failed = 1 AND coalesce(started_at, at) >= ? AND coalesce(started_at, at) < ?")
      .get(a, b) as { n: number };
    const jobs = this.db.prepare("SELECT count(*) AS n FROM record_jobs WHERE failed = 1 AND ended_at >= ? AND ended_at < ?").get(a, b) as { n: number };
    return { turns: turns.n, failures: turns.failed + nights.n + jobs.n };
  }

  /** The time of the latest row before `from` that the narrowing keeps. */
  private latestBefore(from: number, query: DayQuery): number | undefined {
    const a = iso(from);
    const { kind, agent, failed } = query;
    const main = agent === undefined || agent === "main";
    const found: string[] = [];
    const latest = (sql: string, ...values: Array<string | null>) => {
      const row = this.db.prepare(sql).get(a, ...values) as { at: string | null };
      if (row.at !== null) found.push(row.at);
    };
    if (kind === undefined || kind === "turn") {
      latest(
        `SELECT max(t.at) AS at FROM turns t WHERE t.at < ? AND NOT EXISTS (SELECT 1 FROM session_rotations n WHERE n.seq = t.night_seq)
           ${agent === undefined ? "AND ? IS NULL" : "AND t.agent = ?"} ${failed ? "AND t.result = 'failed'" : ""}`,
        agent ?? null,
      );
    }
    if (main && (kind === undefined || kind === "night")) {
      latest(`SELECT max(coalesce(started_at, at)) AS at FROM session_rotations WHERE coalesce(started_at, at) < ? ${failed ? "AND failed = 1" : ""}`);
      const missed = this.missed(Date.parse(this.state("since")!), from).at(-1);
      if (missed !== undefined) found.push(missed.at);
    }
    if (main && (kind === undefined || kind === "job")) latest(`SELECT max(ended_at) AS at FROM record_jobs WHERE ended_at < ? ${failed ? "AND failed = 1" : ""}`);
    if (!failed && agent !== "main" && (kind === undefined || kind === "sub_agent")) {
      latest(`SELECT max(updated_at) AS at FROM sub_agents WHERE closed = 1 AND updated_at < ? ${agent === undefined ? "AND ? IS NULL" : "AND agent = ?"}`, agent ?? null);
    }
    if (found.length === 0) return undefined;
    return Date.parse(found.reduce((a, b) => (a > b ? a : b)));
  }

  /**
   * The nights due in [from, to) since the record began that were not
   * switched: no control event was queued for one a minute after it was due,
   * or one was and no report of it came before the next night was due.
   */
  private missed(from: number, to: number): RecordMissedNight[] {
    const start = Math.max(from, Date.parse(this.state("since")!));
    const now = this.now();
    const event = this.db.prepare("SELECT seq FROM events WHERE source = 'control' AND id = ?");
    const reported = this.db.prepare("SELECT 1 FROM session_rotations WHERE seq = ?");
    const reportedBetween = this.db.prepare("SELECT 1 FROM session_rotations WHERE seq IS NULL AND at >= ? AND at < ? LIMIT 1");
    const missed: RecordMissedNight[] = [];
    let due = this.nightly.nextRun(new Date(start - 1));
    while (due !== null && due.getTime() < to) {
      const dueMs = due.getTime();
      const next = this.nightly.nextRun(due);
      const nextMs = next?.getTime() ?? Infinity;
      const queued = event.get(`nightly@${iso(dueMs)}`) as { seq: number } | undefined;
      const known = queued !== undefined && reported.get(queued.seq) !== undefined;
      // An older runner reports with no seq: a report before the next night is the night's.
      const knownByTime = !known && reportedBetween.get(iso(dueMs), iso(nextMs === Infinity ? now : nextMs)) !== undefined;
      const decided = queued === undefined ? dueMs + QUEUE_GRACE_MS : nextMs;
      if (!known && !knownByTime && decided <= now) {
        missed.push({ kind: "missed_night", id: `missed@${iso(dueMs)}`, at: iso(dueMs), scheduled_at: iso(dueMs), failed_at: iso(decided) });
      }
      due = next;
    }
    return missed;
  }

  /** The time between two nights. */
  private nightGap(): number {
    const [first, second] = this.nightly.nextRuns(2, new Date(this.now()));
    return first && second ? second.getTime() - first.getTime() : DAY_MS;
  }
}

function turnOf(row: TurnRow): RecordTurn {
  const seconds = row.started_at !== null && row.ended_at !== null ? Math.max(0, Math.round((Date.parse(row.ended_at) - Date.parse(row.started_at)) / 1000)) : undefined;
  return {
    kind: "turn",
    id: row.turn_id,
    at: row.at,
    agent: row.agent,
    ...(row.started_at === null ? {} : { started_at: row.started_at }),
    ...(row.ended_at === null ? {} : { ended_at: row.ended_at }),
    ...(seconds === undefined ? {} : { seconds }),
    result: row.result ?? (row.ended_at === null ? "running" : "unknown"),
    ...(row.reason === null ? {} : { reason: row.reason }),
    triggers: JSON.parse(row.triggers) as RecordTrigger[],
    trigger_count: row.trigger_count,
    tools: row.tools,
    replies: row.replies,
    ...(row.night_row === null || row.stage === null ? {} : { night: { id: String(row.night_row), stage: row.stage } }),
    ...(row.result === "failed" && row.recorded_at !== null ? { failed_at: row.recorded_at } : {}),
  };
}

const UNKNOWN: RecordNightStage = { result: "unknown" };

function nightOf(row: NightRow): RecordNight {
  // A report with no steps still says the switch was made.
  const stored = row.stages === null ? undefined : JSON.parse(row.stages) as Omit<RecordNight["stages"], "verifier"> & { verifier?: RecordNightStage };
  const stages: RecordNight["stages"] = stored === undefined
    ? { reflection: UNKNOWN, verifier: UNKNOWN, curator: UNKNOWN, session: { result: "done" } }
    : { ...stored, verifier: stored.verifier ?? { result: "skipped" } };
  const started = row.started_at ?? row.at;
  return {
    kind: "night",
    id: String(row.row),
    at: started,
    ...(row.scheduled_at === null ? {} : { scheduled_at: row.scheduled_at }),
    started_at: started,
    ended_at: row.at,
    seconds: Math.max(0, Math.round((Date.parse(row.at) - Date.parse(started)) / 1000)),
    result: row.stages === null ? "unknown" : row.failed ? "failed" : "done",
    stages,
    ...(row.failed ? { failed_at: row.at } : {}),
  };
}

function jobOf(row: JobRow): RecordJob {
  return {
    kind: "job",
    id: row.id,
    at: row.ended_at,
    command: row.command,
    started_at: row.started_at,
    ended_at: row.ended_at,
    seconds: row.seconds,
    end: row.end_kind,
    ...(row.exit_code === null ? {} : { exit_code: row.exit_code }),
    ...(row.signal === null ? {} : { signal: row.signal }),
    ...(row.failed ? { failed_at: row.received_at } : {}),
  };
}

function subAgentOf(row: SubAgentRow): RecordSubAgent {
  return {
    kind: "sub_agent",
    id: row.agent,
    at: row.closed ? row.updated_at : (row.started_at ?? row.updated_at),
    agent: row.agent,
    purpose: row.purpose,
    ...(row.started_at === null ? {} : { started_at: row.started_at }),
    ...(row.closed ? { closed_at: row.updated_at } : {}),
    turns: row.turns,
    failed_turns: row.failed_turns,
  };
}

/** The first line, cut to the limit. */
function oneLine(text: string): string {
  const first = text.trim().split("\n", 1)[0]!.trim();
  return first.length > RECORD_REASON_MAX ? `${first.slice(0, RECORD_REASON_MAX)}…` : first;
}

/** The same instant written as the backend writes times, so that they sort as text. */
function normal(at: string): string {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? at : iso(ms);
}

function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `YYYY-MM-DD` of the instant in the time zone. */
function dayOf(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** How far the time zone's clock is ahead of UTC at the instant. */
function offsetAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second")) - Math.floor(ms / 1000) * 1000;
}

/** The instant the day begins in the time zone. */
function startOfDay(day: string, timeZone: string): number {
  const utc = Date.parse(`${day}T00:00:00Z`);
  const guess = utc - offsetAt(utc, timeZone);
  return utc - offsetAt(guess, timeZone);
}
