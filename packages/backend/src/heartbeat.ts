// The heartbeat (ADR-0031): when the awake hours have gone the set minutes
// since her last turn ended, with no turn since, the backend queues one event
// with the unfinished work the backend knows of (ADR-0055).
import type { HeartbeatPayload, HeartbeatPending } from "@penelope/contract";

import type { Inbox } from "./a2a/inbox.ts";
import type { Conversation } from "./conversation.ts";
import type { Queue } from "./queue.ts";
import type { ActivityRecord } from "./record.ts";
import type { Sleepiness } from "./sleepiness.ts";
import { type AwakeHours, iso, tickMs } from "./time.ts";

export class Heartbeat {
  private readonly queue: Queue;
  private readonly conversation: Conversation;
  private readonly inbox: Inbox;
  private readonly record: ActivityRecord;
  private readonly sleepiness: Sleepiness;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly awake: AwakeHours;
  private readonly log: (line: string) => void;
  /** Where the count starts when she has had no turn: when the backend started. */
  private readonly started: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    queue: Queue,
    conversation: Conversation,
    options: { now: () => number; quietMs: number; awake: AwakeHours; inbox: Inbox; record: ActivityRecord; sleepiness: Sleepiness; log?: (line: string) => void },
  ) {
    this.queue = queue;
    this.conversation = conversation;
    this.inbox = options.inbox;
    this.record = options.record;
    this.sleepiness = options.sleepiness;
    this.now = options.now;
    this.quietMs = options.quietMs;
    this.awake = options.awake;
    this.log = options.log ?? console.error;
    this.started = this.now();
  }

  /**
   * Queues a heartbeat when it is due: in the awake hours, the agent waiting
   * for the set time since her last turn ended, and no event waiting to be
   * handed over or acked. The last covers a heartbeat not yet taken, an event
   * about to start a turn, and the nightly switch, whose control event is
   * acked only once the new session has started.
   */
  tick(): void {
    const now = this.now();
    if (!this.awake.isAwake(now)) return;
    const { state, since } = this.conversation.stateOf("main");
    if (state === "thinking") return;
    const from = since === undefined ? this.started : Date.parse(since);
    if (now - from < this.quietMs) return;
    if (this.queue.hasUnacked()) return;
    const at = iso(now);
    const a2a_tasks = this.gather("a2a_tasks", () => this.inbox.heartbeatTasks(now));
    const failures = this.gather("failures", () => this.record.heartbeatFailures(iso(this.queue.lastHeartbeatAt() ?? now - this.quietMs)));
    try {
      const payload: HeartbeatPayload = {
        since: iso(from),
        quiet_minutes: this.quietMs / 60_000,
        status: this.sleepiness.status(now),
        ...(a2a_tasks === undefined && failures === undefined ? {} : {
          pending: { ...(a2a_tasks === undefined ? {} : { a2a_tasks }), ...(failures === undefined ? {} : { failures }) },
        }),
      };
      this.queue.accept(
        { source: "heartbeat", id: `heartbeat@${at}`, occurred_at: at, summary: `no turn for ${quietText(this.quietMs)}`, payload },
        { builtin: true },
      );
    } catch (error) {
      // The next tick tries again.
      this.log(`heartbeat: not queued: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private gather<K extends keyof HeartbeatPending>(kind: K, read: () => HeartbeatPending[K]): HeartbeatPending[K] | undefined {
    try {
      return read();
    } catch (error) {
      this.log(`heartbeat: ${kind} not collected: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Ticks every `everyMs` until stopped: by default as often as the quiet time asks. */
  start(everyMs = tickMs(this.quietMs)): () => void {
    this.tick();
    this.timer = setInterval(() => this.tick(), everyMs);
    this.timer.unref();
    return () => clearInterval(this.timer);
  }
}

/** The quiet time in minutes, or in seconds when it is not whole minutes (the tests'). */
function quietText(ms: number): string {
  const [count, unit] = ms % 60_000 === 0 ? [ms / 60_000, "minute"] : [Math.round(ms / 1_000), "second"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}
