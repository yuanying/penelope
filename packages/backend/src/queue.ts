// The one queue of events (ADR-0002, ADR-0013, docs/events.md): what the
// intake takes in, when each event may be handed to the runner, and what the
// runner has acked.
import type { DatabaseSync } from "node:sqlite";

import type { DeliveredAttachment, DeliveredEvent, Delivery, Event, HeartbeatPayload } from "@penelope/contract";

import { transaction } from "./db.ts";
import type { Attachment, Sources } from "./sources.ts";
import { type AwakeHours, deliveryTimeIn, iso } from "./time.ts";

export type QueueOptions = {
  now: () => number;
  /** The sources whose payload goes into the turn as it is. */
  inline: ReadonlySet<string>;
  /** The delivery of the backend's own sources when their event does not say. `control` is always now. */
  builtinDelivery: Readonly<Record<string, Delivery>>;
  /** A batch is handed over `quietMs` after its last event, and no later than `maxMs` after its first. */
  batch: { quietMs: number; maxMs: number };
  awake: AwakeHours;
  /** An event handed over and not acked within this long is handed over again. */
  redeliverMs: number;
};

export type Accepted = { seq: number; duplicate: boolean };

type Row = {
  seq: number;
  source: string;
  id: string;
  stream: string | null;
  occurred_at: string;
  received_ms: number;
  summary: string;
  delivery: Delivery;
  inline: number;
  payload: string;
  path: string;
  line: number;
  attachments: string | null;
};

export const DEFAULT_TAKE_LIMIT = 100;

export class Queue {
  private readonly db: DatabaseSync;
  private readonly sources: Sources;
  private readonly options: QueueOptions;
  private readonly deliveryTime: (value: string) => string;
  private readonly listeners = new Set<() => void>();

  constructor(db: DatabaseSync, sources: Sources, options: QueueOptions) {
    this.db = db;
    this.sources = sources;
    this.options = options;
    this.deliveryTime = deliveryTimeIn(options.awake.timeZone);
  }

  /**
   * Takes an event in. One already taken with the same source and id is
   * dropped and answered with its seq. The event is kept only once its line
   * and its attachments are written to /sources; when they cannot be, this
   * throws and nothing of it is kept, so the source sends it again.
   *
   * `builtin` marks the backend's own sources (ui, cron, a2a, self, control, heartbeat),
   * whose delivery defaults to the backend's setting instead of batch.
   */
  accept(event: Event, { builtin = false, attachments = [] }: { builtin?: boolean; attachments?: readonly Attachment[] } = {}): Accepted {
    const accepted = transaction(this.db, () => {
      const known = this.db.prepare("SELECT seq FROM events WHERE source = ? AND id = ?").get(event.source, event.id) as
        | { seq: number }
        | undefined;
      if (known) return { seq: known.seq, duplicate: true };

      const now = this.options.now();
      const delivery = this.deliveryOf(event, builtin);
      const inline = event.source !== "heartbeat" && this.options.inline.has(event.source);
      // The row comes first for its seq; the files are named after it.
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO events (source, id, stream, occurred_at, received_ms, summary, delivery, inline, payload, path, line, due_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, ?)`,
        )
        .run(
          event.source,
          event.id,
          event.stream ?? null,
          event.occurred_at,
          now,
          event.summary,
          delivery,
          inline ? 1 : 0,
          JSON.stringify(event.payload ?? null),
          delivery === "now" ? now : null,
        );
      const seq = Number(lastInsertRowid);
      const saved = this.sources.saveAttachments(event.source, seq, attachments);
      const appended = this.sources.append({
        seq,
        received_at: iso(now),
        occurred_at: event.occurred_at,
        source: event.source,
        ...(event.stream === undefined ? {} : { stream: event.stream }),
        id: event.id,
        summary: event.summary,
        ...(saved.length === 0 ? {} : { attachments: saved.map((file) => file.path) }),
        payload: event.payload,
      });
      this.db
        .prepare("UPDATE events SET path = ?, line = ?, attachments = ? WHERE seq = ?")
        .run(appended.path, appended.lines[0], saved.length === 0 ? null : JSON.stringify(saved), seq);
      return { seq, duplicate: false };
    });
    if (!accepted.duplicate) this.changed();
    return accepted;
  }

  /**
   * The events to hand over now, in seq order, marked as handed over. They
   * are the ones due and not acked that are either
   *
   * - never handed over yet (whatever `after` says: a batch is handed over
   *   after later now events, so its seqs can be below what the runner has),
   * - handed over with a seq above `after` (the runner says it has not got
   *   them, as after a restart with `after` 0), or
   * - handed over longer ago than the redelivery time without an ack.
   */
  take({ after, limit = DEFAULT_TAKE_LIMIT }: { after: number; limit?: number }): DeliveredEvent[] {
    return transaction(this.db, () => {
      const now = this.options.now();
      this.releaseBatch(now);
      const rows = this.db
        .prepare(
          `SELECT seq, source, id, stream, occurred_at, received_ms, summary, delivery, inline, payload, path, line, attachments
           FROM events
           WHERE acked_ms IS NULL AND due_ms IS NOT NULL AND due_ms <= ?
             AND (delivered_ms IS NULL OR seq > ? OR delivered_ms <= ?)
           ORDER BY seq LIMIT ?`,
        )
        .all(now, after, now - this.options.redeliverMs, limit) as Row[];
      const mark = this.db.prepare("UPDATE events SET delivered_ms = ? WHERE seq = ?");
      for (const row of rows) mark.run(now, row.seq);
      return rows.map((row) => delivered(row, this.deliveryTime(row.occurred_at)));
    });
  }

  /** Marks the events as done. Unknown and already acked seqs are ignored. */
  ack(seqs: readonly number[]): void {
    const now = this.options.now();
    transaction(this.db, () => {
      const mark = this.db.prepare("UPDATE events SET acked_ms = ? WHERE seq = ? AND acked_ms IS NULL");
      for (const seq of seqs) mark.run(now, seq);
    });
  }

  /**
   * The earliest time something may become ready to hand over without a new
   * event coming in: the end of the held batch, or an ack falling overdue.
   */
  nextWakeAt(): number | undefined {
    const times: number[] = [];
    const batchEnd = this.batchEnd();
    if (batchEnd !== undefined) times.push(batchEnd);
    const { oldest } = this.db
      .prepare("SELECT MIN(delivered_ms) AS oldest FROM events WHERE acked_ms IS NULL AND delivered_ms IS NOT NULL")
      .get() as { oldest: number | null };
    if (oldest !== null) times.push(oldest + this.options.redeliverMs);
    return times.length === 0 ? undefined : Math.min(...times);
  }

  /**
   * Whether an event is due and not acked: one waiting to be handed over, or
   * handed over and its turn not over yet. A batch still held is not.
   */
  hasUnacked(): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE acked_ms IS NULL AND due_ms IS NOT NULL LIMIT 1").get() !== undefined;
  }

  /** When the last heartbeat entered the queue, even if it was not handed over yet. */
  lastHeartbeatAt(): number | undefined {
    const row = this.db.prepare("SELECT received_ms FROM events WHERE source = 'heartbeat' ORDER BY seq DESC LIMIT 1").get() as
      | { received_ms: number }
      | undefined;
    return row?.received_ms;
  }

  /** Calls `listener` whenever a new event is taken in. Returns the way to stop. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private deliveryOf(event: Event, builtin: boolean): Delivery {
    if (builtin && (event.source === "control" || event.source === "heartbeat")) return "now";
    if (event.delivery !== undefined) return event.delivery;
    return builtin ? (this.options.builtinDelivery[event.source] ?? "now") : "batch";
  }

  /**
   * When the batch being held is handed over: `quietMs` after its last event,
   * no later than `maxMs` after its first, and if that falls outside the
   * awake hours, when they next start.
   */
  private batchEnd(): number | undefined {
    const { first, last } = this.db
      .prepare("SELECT MIN(received_ms) AS first, MAX(received_ms) AS last FROM events WHERE delivery = 'batch' AND due_ms IS NULL")
      .get() as { first: number | null; last: number | null };
    if (first === null || last === null) return undefined;
    const { quietMs, maxMs } = this.options.batch;
    const end = Math.min(last + quietMs, first + maxMs);
    const { awake } = this.options;
    return awake.isAwake(end) ? end : awake.nextStart(end);
  }

  /**
   * Releases the held batch when it is due, or when a now event is about to
   * be handed over for the first time: the batch then goes with it, whatever
   * the time, so that the turn sees what led up to it.
   */
  private releaseBatch(now: number): void {
    const end = this.batchEnd();
    if (end === undefined) return;
    const nowWaiting = this.db
      .prepare("SELECT 1 FROM events WHERE delivery = 'now' AND delivered_ms IS NULL AND acked_ms IS NULL LIMIT 1")
      .get();
    if (end <= now || nowWaiting !== undefined) {
      this.db.prepare("UPDATE events SET due_ms = ? WHERE delivery = 'batch' AND due_ms IS NULL").run(now);
    }
  }
}

function delivered(row: Row, occurred_at: string): DeliveredEvent {
  const base = {
    seq: row.seq,
    source: row.source,
    id: row.id,
    ...(row.stream === null ? {} : { stream: row.stream }),
    occurred_at,
    received_at: iso(row.received_ms),
    summary: row.summary,
    delivery: row.delivery,
    appended: { path: row.path, lines: [row.line, row.line] as [number, number] },
    ...(row.attachments === null ? {} : { attachments: JSON.parse(row.attachments) as DeliveredAttachment[] }),
  };
  if (row.source === "heartbeat") {
    const pending = (JSON.parse(row.payload) as HeartbeatPayload | null)?.pending;
    return { ...base, inline: false, ...(pending === undefined ? {} : { pending }) };
  }
  return row.inline === 1 ? { ...base, inline: true, payload: JSON.parse(row.payload) } : { ...base, inline: false };
}
