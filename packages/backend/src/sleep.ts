import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ControlPayload, PresenceNotes, SleepResponse, WakePayload } from "@penelope/contract";

import { transaction } from "./db.ts";
import type { Queue } from "./queue.ts";
import type { Sleepiness } from "./sleepiness.ts";
import { dayIn, iso } from "./time.ts";

const REVIEW_MS = 7 * 86_400_000;
const CHECK_MS = 15_000;

type SleepRow = {
  control_seq: number;
  requested_ms: number;
  wake_ms: number;
  completed_ms: number | null;
  woken_ms: number | null;
};

export type SleepLimits = { threshold: number; defaultMs: number; maxMs: number };

export function latestSleep(db: DatabaseSync): SleepRow | undefined {
  return db.prepare("SELECT * FROM sleeps ORDER BY control_seq DESC LIMIT 1").get() as SleepRow | undefined;
}

export class SleepRefusal extends Error {
  readonly status: 400 | 409;

  constructor(status: 400 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

type Options = {
  now: () => number;
  timeZone: string;
  limits: SleepLimits;
  notes: (now: number, since: number) => PresenceNotes;
  log: (line: string) => void;
};

export class Sleep {
  private readonly db: DatabaseSync;
  private readonly queue: Queue;
  private readonly sleepiness: Sleepiness;
  private readonly options: Options;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(db: DatabaseSync, queue: Queue, sleepiness: Sleepiness, options: Options) {
    this.db = db;
    this.queue = queue;
    this.sleepiness = sleepiness;
    this.options = options;
  }

  request(wake: number, by: "agent" | "safety_net" = "agent"): SleepResponse {
    const now = this.options.now();
    if (!Number.isFinite(wake) || wake <= now) throw new SleepRefusal(400, "wake_at must be in the future");
    this.advanceWake(now);
    const last = latestSleep(this.db);
    const active = last?.woken_ms === null ? last : undefined;
    const wakeMs = Math.min(wake, (active?.requested_ms ?? now) + this.options.limits.maxMs);
    if (active !== undefined) {
      if (active.completed_ms !== null) throw new SleepRefusal(409, "already asleep");
      if (wakeMs <= now) throw new SleepRefusal(409, "the original request has reached the maximum duration");
      this.db.prepare("UPDATE sleeps SET wake_ms = ? WHERE control_seq = ?").run(wakeMs, active.control_seq);
    } else {
      const payload: ControlPayload = { kind: "nightly" };
      const review = this.db.prepare(`
        SELECT at FROM session_rotations
        WHERE json_extract(stages, '$.curator.result') = 'done'
          AND json_type(stages, '$.curator.review') = 'object'
        ORDER BY at DESC LIMIT 1
      `).get() as { at: string } | undefined;
      if (review === undefined || now - Date.parse(review.at) >= REVIEW_MS) {
        payload.review_date = dayIn(now, this.options.timeZone);
      }
      transaction(this.db, () => {
        const { seq } = this.queue.accept({
          source: "control", id: `sleep@${randomUUID()}`, occurred_at: iso(now), summary: "the nightly switch for sleep", payload,
        }, { builtin: true });
        this.db.prepare("INSERT INTO sleeps (control_seq, requested_ms, requested_by, wake_ms) VALUES (?, ?, ?, ?)")
          .run(seq, now, by, wakeMs);
      });
    }
    this.arm();
    return { wake_at: iso(wakeMs), clamped: wakeMs < wake };
  }

  completed(seq: number): void {
    this.db.prepare("UPDATE sleeps SET completed_ms = ? WHERE control_seq = ? AND completed_ms IS NULL")
      .run(this.options.now(), seq);
  }

  // Runs on startup, at the wake deadline, and after an ordinary turn's context report.
  tick(): void {
    const now = this.options.now();
    try {
      this.advanceWake(now);
      const status = this.sleepiness.status(now);
      if (status.sleep.state === "awake" && status.sleepiness > this.options.limits.threshold) {
        this.request(now + this.options.limits.defaultMs, "safety_net");
      }
    } catch (error) {
      this.options.log(`sleep: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  start(): () => void {
    this.running = true;
    this.tick();
    this.arm();
    return () => {
      this.running = false;
      clearTimeout(this.timer);
    };
  }

  private advanceWake(now: number): void {
    const last = latestSleep(this.db);
    if (last?.woken_ms === null && last.wake_ms <= now) {
      transaction(this.db, () => {
        this.db.prepare("UPDATE sleeps SET woken_ms = ? WHERE control_seq = ?").run(now, last.control_seq);
        this.sleepiness.reset();
        this.queue.releaseHeldBatch(now);
      });
    }

    const unsent = this.db.prepare(`
      SELECT control_seq, requested_ms, wake_ms, woken_ms FROM sleeps WHERE woken_ms IS NOT NULL AND wake_notice_seq IS NULL ORDER BY control_seq
    `).all() as Array<Pick<SleepRow, "control_seq" | "requested_ms" | "wake_ms"> & { woken_ms: number }>;
    for (const { control_seq, requested_ms, wake_ms, woken_ms } of unsent) {
      try {
        transaction(this.db, () => {
          const payload: WakePayload = { sleep_seq: control_seq, wake_at: iso(wake_ms), ...this.options.notes(now, requested_ms) };
          const { seq } = this.queue.accept({
            source: "wake", id: `wake@${control_seq}`, occurred_at: iso(woken_ms), summary: "woke up", payload,
          }, { builtin: true });
          this.db.prepare("UPDATE sleeps SET wake_notice_seq = ? WHERE control_seq = ?").run(seq, control_seq);
        });
      } catch (error) {
        this.options.log(`sleep: wake notice not queued: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  }

  private arm(): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    const last = latestSleep(this.db);
    const untilWake = last?.woken_ms === null ? last.wake_ms - this.options.now() : CHECK_MS;
    this.timer = setTimeout(() => {
      this.tick();
      this.arm();
    }, Math.min(CHECK_MS, untilWake > 0 ? untilWake : 1_000));
    this.timer.unref();
  }
}
