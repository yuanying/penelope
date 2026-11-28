// Her schedules (docs/sandbox-api.md):
// when one comes due, the backend queues an event.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AgentId, CronPayload, Schedule, ScheduleEntry, ScheduleWhen } from "@penelope/contract";
import { Cron } from "croner";

import { isTime } from "./envelope.ts";
import type { Queue } from "./queue.ts";
import { iso } from "./time.ts";

/** A schedule that cannot be made, answered with 400. */
export class ScheduleError extends Error {}

type Row = { id: string; agent: string; reason: string; cron: string | null; at: string | null; next_ms: number };

function cronOf(expression: string, timeZone: string): Cron {
  try {
    return new Cron(expression, { timezone: timeZone, paused: true, mode: "5-part" });
  } catch (error) {
    throw new ScheduleError(`cron must be a five-field cron expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}


export class Schedules {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  readonly timeZone: string;

  constructor(db: DatabaseSync, { now, timeZone }: { now: () => number; timeZone: string }) {
    this.db = db;
    this.now = now;
    this.timeZone = timeZone;
  }

  create(request: { agent: AgentId; reason: string } & ScheduleWhen): Schedule {
    const { agent, reason } = request;
    let next: number;
    if (request.cron !== undefined) {
      const found = cronOf(request.cron, this.timeZone).nextRun(new Date(this.now()));
      if (!found) throw new ScheduleError("the cron expression never comes due");
      next = found.getTime();
    } else {
      if (!isTime(request.at)) throw new ScheduleError("at must be an RFC 3339 time");
      next = Date.parse(request.at);
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO schedules (id, agent, reason, cron, at, next_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, agent, reason, request.cron ?? null, request.at ?? null, next, iso(this.now()));
    return schedule({ id, agent, reason, cron: request.cron ?? null, at: request.at ?? null, next_ms: next });
  }

  list(agent: AgentId): Schedule[] {
    return this.rows(agent).map(schedule);
  }

  entries(agent: AgentId): ScheduleEntry[] {
    return this.rows(agent).map((row) => {
      const { agent: _agent, ...rest } = schedule(row);
      return { ...rest, next_at: iso(row.next_ms) };
    });
  }

  private rows(agent: AgentId): Row[] {
    return this.db
      .prepare("SELECT id, agent, reason, cron, at, next_ms FROM schedules WHERE agent = ? ORDER BY created_at, id")
      .all(agent) as Row[];
  }

  remove(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes) > 0;
  }

  /** The schedules due at `now`, earliest first. */
  due(now: number): Row[] {
    return this.db
      .prepare("SELECT id, agent, reason, cron, at, next_ms FROM schedules WHERE next_ms <= ? ORDER BY next_ms, id")
      .all(now) as Row[];
  }

  /** After a schedule was queued: a cron one moves to its next run after `now`, a one-time one is gone. */
  fired(row: Row, now: number): void {
    const next = row.cron === null ? null : cronOf(row.cron, this.timeZone).nextRun(new Date(now));
    if (next === null) this.remove(row.id);
    else this.db.prepare("UPDATE schedules SET next_ms = ? WHERE id = ?").run(next.getTime(), row.id);
  }
}

function schedule(row: Row): Schedule {
  const base = { id: row.id, agent: row.agent, reason: row.reason };
  return row.cron !== null ? { ...base, cron: row.cron } : { ...base, at: row.at ?? "" };
}

/** A schedule missed while the backend was down is queued once when it comes back. */
export class Scheduler {
  private readonly schedules: Schedules;
  private readonly queue: Queue;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    schedules: Schedules,
    queue: Queue,
    options: { now: () => number; log?: (line: string) => void },
  ) {
    this.schedules = schedules;
    this.queue = queue;
    this.now = options.now;
    this.log = options.log ?? console.error;
  }

  tick(): void {
    const now = this.now();
    for (const row of this.schedules.due(now)) {
      const payload: CronPayload = { schedule_id: row.id, reason: row.reason };
      const due = iso(row.next_ms);
      if (this.queueEvent({ source: "cron", id: `${row.id}@${due}`, occurred_at: due, summary: row.reason, payload })) {
        this.schedules.fired(row, now);
      }
    }
  }

  start(everyMs = 15_000): () => void {
    this.tick();
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
    return () => clearInterval(this.timer);
  }

  private queueEvent(event: { source: string; id: string; occurred_at: string; summary: string; payload: unknown }): boolean {
    try {
      this.queue.accept(event, { builtin: true });
      return true;
    } catch (error) {
      // Left due; the next tick tries again.
      this.log(`scheduler: ${event.id} not queued: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
}
