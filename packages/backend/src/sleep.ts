import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ControlPayload, PresenceNotes, SleepResponse, WakePayload } from "@penelope/contract";

import { transaction } from "./db.ts";
import type { Queue } from "./queue.ts";
import type { Sleepiness } from "./sleepiness.ts";
import { dayIn, deliveryTimeIn, iso } from "./time.ts";

const REVIEW_DAYS = 7;
const CHECK_MS = 15_000;

type SleepRow = {
  control_seq: number;
  requested_ms: number;
  wake_ms: number;
  completed_ms: number | null;
  woken_ms: number | null;
};

export type SleepLimits = { threshold: number; defaultMs: number; maxMs: number };

export function currentSleep(db: DatabaseSync):
  | { state: "awake"; wokenMs?: number }
  | { state: "falling_asleep" | "asleep"; controlSeq: number; requestedMs: number; wakeMs: number } {
  const last = db.prepare("SELECT * FROM sleeps ORDER BY control_seq DESC LIMIT 1").get() as SleepRow | undefined;
  if (!last) return { state: "awake" };
  if (last.woken_ms !== null) return { state: "awake", wokenMs: last.woken_ms };
  return {
    state: last.completed_ms === null ? "falling_asleep" : "asleep",
    controlSeq: last.control_seq, requestedMs: last.requested_ms, wakeMs: last.wake_ms,
  };
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
  private readonly deliveryTime: (value: string) => string;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(db: DatabaseSync, queue: Queue, sleepiness: Sleepiness, options: Options) {
    this.db = db;
    this.queue = queue;
    this.sleepiness = sleepiness;
    this.options = options;
    this.deliveryTime = deliveryTimeIn(options.timeZone);
  }

  request(wake: number, by: "agent" | "safety_net" = "agent"): SleepResponse {
    const now = this.options.now();
    if (!Number.isFinite(wake) || wake <= now) throw new SleepRefusal(400, "wake_at must be in the future");
    this.advanceWake(now);
    const current = currentSleep(this.db);
    if (current.state === "asleep") throw new SleepRefusal(409, "already asleep");
    const wakeMs = Math.min(wake, (current.state === "falling_asleep" ? current.requestedMs : now) + this.options.limits.maxMs);
    if (current.state === "falling_asleep") {
      if (wakeMs <= now) throw new SleepRefusal(409, "the original request has reached the maximum duration");
      this.db.prepare("UPDATE sleeps SET wake_ms = ? WHERE control_seq = ?").run(wakeMs, current.controlSeq);
    } else {
      const payload: ControlPayload = { kind: "nightly" };
      const day = dayIn(now, this.options.timeZone);
      const { previous } = this.db.prepare(`
        SELECT MAX(json_extract(e.payload, '$.review_date')) AS previous
        FROM session_rotations r JOIN events e ON e.seq = r.seq
        WHERE e.source = 'control' AND json_extract(r.stages, '$.curator.result') = 'done'
          AND json_type(r.stages, '$.curator.review') = 'object'
      `).get() as { previous: string | null };
      // Compare date labels in UTC, so local midnight and DST do not change the day count.
      if (previous === null || (Date.parse(day) - Date.parse(previous)) / 86_400_000 >= REVIEW_DAYS) {
        payload.review_date = day;
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
    return { wake_at: this.deliveryTime(iso(wakeMs)), duration_seconds: Math.ceil((wakeMs - now) / 1_000), clamped: wakeMs < wake };
  }

  completed(seq: number): void {
    transaction(this.db, () => {
      if (!this.db.prepare("SELECT 1 FROM sleeps WHERE control_seq = ? AND completed_ms IS NULL").get(seq)) return;
      // All requests made before this report are satisfied by the new session.
      const completed = this.db.prepare("UPDATE sleeps SET completed_ms = ? WHERE completed_ms IS NULL RETURNING control_seq")
        .all(this.options.now()) as { control_seq: number }[];
      this.queue.ack(completed.map(({ control_seq }) => control_seq));
      if (currentSleep(this.db).state === "awake") this.sleepiness.reset();
    });
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
    const current = currentSleep(this.db);
    if (current.state !== "awake" && current.wakeMs <= now) {
      transaction(this.db, () => {
        this.db.prepare("UPDATE sleeps SET woken_ms = ? WHERE control_seq = ?").run(now, current.controlSeq);
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
    const current = currentSleep(this.db);
    const untilWake = current.state === "awake" ? CHECK_MS : current.wakeMs - this.options.now();
    this.timer = setTimeout(() => {
      this.tick();
      this.arm();
    }, Math.min(CHECK_MS, untilWake > 0 ? untilWake : 1_000));
    this.timer.unref();
  }
}
