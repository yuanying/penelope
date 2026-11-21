// Her schedules (docs/sandbox-api.md) and the nightly switch (ADR-0007):
// when one comes due, the backend queues an event.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AgentId, ControlPayload, CronPayload, Schedule, ScheduleEntry, ScheduleWhen } from "@penelope/contract";
import { Cron } from "croner";

import { isTime } from "./envelope.ts";
import type { Queue } from "./queue.ts";
import { dayIn, iso, tickMs } from "./time.ts";

/** A schedule that cannot be made, answered with 400. */
export class ScheduleError extends Error {}

type Row = { id: string; agent: string; reason: string; cron: string | null; at: string | null; next_ms: number };

/**
 * A five-field cron expression in the time zone, or with `seconds` one of six
 * fields whose first is the second. Throws ScheduleError when it is not one.
 */
export function cronOf(expression: string, timeZone: string, { seconds = false } = {}): Cron {
  try {
    return new Cron(expression, { timezone: timeZone, paused: true, mode: seconds ? "5-or-6-parts" : "5-part" });
  } catch (error) {
    const fields = seconds ? "five- or six-field" : "five-field";
    throw new ScheduleError(`cron must be a ${fields} cron expression: ${error instanceof Error ? error.message : String(error)}`);
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

  /** The same schedules as `list`, each with when it comes due next, for the UI. */
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

/**
 * Queues the events of the schedules that came due and the nightly control
 * event. A run missed while the backend was down is queued once when it is
 * back; a missed nightly switch is not made up, the next one is the next
 * night's.
 */
export class Scheduler {
  private readonly schedules: Schedules;
  private readonly queue: Queue;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly nightly: Cron;
  private readonly timeZone: string;
  private readonly reviewWeekday: number;
  private nextNightly: number | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    schedules: Schedules,
    queue: Queue,
    options: { now: () => number; timeZone: string; nightly: string; reviewWeekday?: number; log?: (line: string) => void },
  ) {
    this.schedules = schedules;
    this.queue = queue;
    this.now = options.now;
    this.log = options.log ?? console.error;
    // A field of seconds is for the tests, to have a night come in seconds.
    this.timeZone = options.timeZone;
    this.reviewWeekday = options.reviewWeekday ?? 0;
    this.nightly = cronOf(options.nightly, this.timeZone, { seconds: true });
    this.nextNightly = this.nightly.nextRun(new Date(this.now()))?.getTime();
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
    if (this.nextNightly !== undefined && this.nextNightly <= now) {
      const due = iso(this.nextNightly);
      const reviewDate = this.reviewDate(this.nextNightly);
      const payload: ControlPayload = { kind: "nightly", ...(reviewDate ? { review_date: reviewDate } : {}) };
      if (this.queueEvent({ source: "control", id: `nightly@${due}`, occurred_at: due, summary: "the nightly switch", payload })) {
        this.nextNightly = this.nightly.nextRun(new Date(now))?.getTime();
      }
    }
  }

  /** Mark the first scheduled occurrence on the review weekday, even if the cron runs more than once a day. */
  private reviewDate(due: number): string | undefined {
    const day = dayIn(due, this.timeZone);
    if (new Date(`${day}T00:00:00Z`).getUTCDay() !== this.reviewWeekday) return undefined;
    const [previous] = this.nightly.previousRuns(1, new Date(due));
    return previous && dayIn(previous.getTime(), this.timeZone) === day ? undefined : day;
  }

  /** Ticks every `everyMs` until stopped: by default as often as the nights come for. */
  start(everyMs = tickMs(this.nightlyGapMs())): () => void {
    this.tick();
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
    return () => clearInterval(this.timer);
  }

  /** The time between the next two nights. */
  private nightlyGapMs(): number {
    const [first, second] = this.nightly.nextRuns(2, new Date(this.now()));
    return first && second ? second.getTime() - first.getTime() : Infinity;
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
