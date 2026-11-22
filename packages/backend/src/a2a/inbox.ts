// What other agents ask her over A2A (ADR-0018, docs/a2a.md): each task in
// SQLite, and each message of a sender an `a2a` event, appended to
// /sources/a2a/<sender>/ like any other. Her reply names the event it answers.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  type A2APayload,
  type A2AReplyRequest,
  type A2AReplyResponse,
  type A2ATaskState,
  type HeartbeatA2ATask,
  HEARTBEAT_PENDING_LIMIT,
  type HeartbeatPendingList,
} from "@penelope/contract";

import type { Assets, CheckedImage, StoredImage } from "../assets.ts";
import { transaction } from "../db.ts";
import type { Queue } from "../queue.ts";
import { type Attachment, uniqueFileName } from "../sources.ts";
import { iso } from "../time.ts";

/** One message's text at most, in UTF-8. */
export const MAX_TEXT_BYTES = 1024 * 1024;
const SUMMARY_LENGTH = 200;
const OPEN = "state IN ('working', 'input-required')";

export type InboxLimits = {
  /** An open task fails when its sender has not written for this long. */
  deadlineMs: number;
  /** A sender's open tasks at most; a request past them is rejected. */
  maxOpenTasks: number;
};

type IncomingMessage = { text: string; messageId: string; contextId?: string; taskId?: string; attachments?: readonly Attachment[] };
type ImageRef = { filename: string; mediaType: string; file: string };
type ResponseImage = Omit<ImageRef, "file"> & { bytes: Buffer };

export type TaskMessage = { role: "sender" | "agent"; messageId: string; text: string; atMs: number; hasImages: boolean };

/** A task as the sender is shown it. */
export type TaskView = {
  taskId: string;
  sender: string;
  contextId: string;
  state: A2ATaskState;
  /** Why it failed or was rejected. */
  reason?: string;
  messages: TaskMessage[];
  responseImages: ResponseImage[];
  updatedMs: number;
};

/**
 * Why a message or a reply was not taken:
 * - `empty`, `too-large`: no text or images, or the text is over 1 MiB.
 * - `unknown-context`: a context not given to this sender, or not the task's.
 * - `not-found`: the task is not the sender's, or not there.
 * - `not-waiting`: the task is open and not asking; anything more is a new task.
 * - `closed`: the task is closed.
 * - `no-such-event`: her reply names no event of a task.
 * - `needs-text`: her question has no text or carries images.
 */
export class InboxRefusal extends Error {
  readonly kind: "empty" | "too-large" | "unknown-context" | "not-found" | "not-waiting" | "closed" | "no-such-event" | "needs-text";
  constructor(kind: InboxRefusal["kind"], message: string) {
    super(message);
    this.name = "InboxRefusal";
    this.kind = kind;
  }
}

type TaskRow = {
  task_id: string;
  sender: string;
  context_id: string;
  state: A2ATaskState;
  reason: string | null;
  updated_ms: number;
};
type MessageRow = { role: "sender" | "agent"; message_id: string; text: string; at_ms: number; has_images: number };

export class Inbox {
  private readonly db: DatabaseSync;
  private readonly queue: Queue;
  private readonly assets: Assets;
  private readonly now: () => number;
  private readonly limits: InboxLimits;

  constructor(db: DatabaseSync, queue: Queue, options: { assets: Assets; now: () => number; limits: InboxLimits }) {
    this.db = db;
    this.queue = queue;
    this.assets = options.assets;
    this.now = options.now;
    this.limits = options.limits;
  }

  /**
   * Takes a sender's message: a new task, or the answer to her question in
   * the task it names. The task and its event are kept together or not at
   * all: when the event cannot be written to /sources, this throws and the
   * sender sends again.
   */
  receive(sender: string, message: IncomingMessage): TaskView {
    if (message.text.trim() === "" && !message.attachments?.length) throw new InboxRefusal("empty", "the message has no text or images");
    if (Buffer.byteLength(message.text) > MAX_TEXT_BYTES) throw new InboxRefusal("too-large", `the text is over ${MAX_TEXT_BYTES} bytes`);
    return transaction(this.db, () => {
      const now = this.now();
      this.expire(now);
      return message.taskId ? this.answer(sender, message.taskId, message, now) : this.open(sender, message, now);
    });
  }

  /** A sender's task, or undefined when it is not theirs or not there. */
  task(sender: string, taskId: string): TaskView | undefined {
    this.expire(this.now());
    const row = this.row(taskId);
    return row && row.sender === sender ? this.view(row) : undefined;
  }

  /** A read-only look at the oldest unexpired open tasks for a heartbeat. */
  heartbeatTasks(now: number): HeartbeatPendingList<HeartbeatA2ATask> | undefined {
    const rows = this.db.prepare(
      `SELECT t.sender, t.task_id, t.state, t.received_ms, e.seq, e.summary, count(*) OVER () AS total
         FROM a2a_tasks t
         JOIN events e ON e.seq = (
           SELECT m.seq FROM a2a_messages m WHERE m.task_id = t.task_id AND m.seq IS NOT NULL ORDER BY m.row DESC LIMIT 1
         )
        WHERE ${OPEN} AND t.received_ms > ?
        ORDER BY t.received_ms, e.seq LIMIT ?`,
    ).all(now - this.limits.deadlineMs, HEARTBEAT_PENDING_LIMIT) as
      Array<Omit<HeartbeatA2ATask, "since"> & { received_ms: number; total: number }>;
    if (rows.length === 0) return undefined;
    return {
      items: rows.map(({ total: _, received_ms, summary, ...task }) => {
        const chars = Array.from(summary);
        return { ...task, since: iso(received_ms), summary: chars.length > SUMMARY_LENGTH ? `${chars.slice(0, SUMMARY_LENGTH - 1).join("")}…` : summary };
      }),
      omitted: rows[0]!.total - rows.length,
    };
  }

  /** How many open tasks a sender has. */
  openCount(sender: string): number {
    this.expire(this.now());
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE sender = ? AND ${OPEN}`).get(sender) as { n: number }).n;
  }

  /**
   * Her reply in the task of the event `in_reply_to`: `completed` closes it,
   * the text optional; `input-required` asks the sender the text.
   */
  reply(reply: Omit<A2AReplyRequest, "agent" | "images">, images: readonly CheckedImage[] = []): A2AReplyResponse {
    const text = reply.text?.trim() ? reply.text : undefined;
    if (reply.state === "input-required" && (text === undefined || images.length > 0)) {
      throw new InboxRefusal("needs-text", "a question needs its text and cannot carry images");
    }
    let stored: StoredImage[] = [];
    try {
      return transaction(this.db, () => {
        const now = this.now();
        this.expire(now);
        const found = this.db
          .prepare("SELECT t.task_id, t.sender, t.context_id, t.state, t.reason, t.updated_ms FROM a2a_messages m JOIN a2a_tasks t USING (task_id) WHERE m.seq = ?")
          .get(reply.in_reply_to) as TaskRow | undefined;
        if (!found) throw new InboxRefusal("no-such-event", `the event ${reply.in_reply_to} is not a message of an A2A task`);
        if (found.state !== "working" && found.state !== "input-required") {
          throw new InboxRefusal("closed", `the task is ${found.state}${found.reason ? `: ${found.reason}` : ""}`);
        }

        // Write the copies before recording any reference to them. They do
        // not have UI asset rows: only the sender's Task can reach them.
        if (images.length > 0) stored = this.assets.write(images);
        const names = new Set<string>();
        const refs: ImageRef[] = stored.map((image) => ({
          file: image.file,
          filename: uniqueFileName(image.name, names),
          mediaType: image.mime_type,
        }));
        if (text !== undefined || refs.length > 0) {
          this.insertMessage(found.task_id, { role: "agent", message_id: randomUUID(), text: text ?? "", at_ms: now, has_images: Number(refs.length > 0) }, null);
        }
        this.db.prepare("UPDATE a2a_tasks SET state = ?, updated_ms = ?, response_images = ? WHERE task_id = ?")
          .run(reply.state, now, refs.length ? JSON.stringify(refs) : null, found.task_id);
        return { task_id: found.task_id, state: reply.state };
      });
    } catch (error) {
      this.assets.discard(stored);
      throw error;
    }
  }

  private open(sender: string, message: IncomingMessage, now: number): TaskView {
    let contextId: string = randomUUID();
    if (message.contextId) {
      const known = this.db.prepare("SELECT 1 FROM a2a_tasks WHERE sender = ? AND context_id = ? LIMIT 1").get(sender, message.contextId);
      if (!known) throw new InboxRefusal("unknown-context", "the context is not one given to this sender");
      contextId = message.contextId;
    }
    const taskId = randomUUID();
    const open = (this.db.prepare(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE sender = ? AND ${OPEN}`).get(sender) as { n: number }).n;
    const rejected = open >= this.limits.maxOpenTasks;
    const reason = rejected ? `${open} tasks of this sender are open, the most it may have; send again once one is closed` : null;
    this.db
      .prepare("INSERT INTO a2a_tasks (task_id, sender, context_id, state, reason, created_ms, received_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(taskId, sender, contextId, rejected ? "rejected" : "working", reason, now, now, now);
    // A rejected request is kept for the sender to read, and never reaches her.
    const seq = rejected ? null : this.event(sender, { kind: "request", task_id: taskId, context_id: contextId, message_id: message.messageId, text: message.text }, now, message.attachments);
    this.insertMessage(taskId, senderMessage(message, now), seq);
    return this.view(this.row(taskId)!);
  }

  private answer(sender: string, taskId: string, message: IncomingMessage, now: number): TaskView {
    const row = this.row(taskId);
    if (!row || row.sender !== sender) throw new InboxRefusal("not-found", "no such task");
    if (message.contextId && message.contextId !== row.context_id) throw new InboxRefusal("unknown-context", "the context is not the task's");
    if (row.state === "working") throw new InboxRefusal("not-waiting", "the task is not waiting for an answer; send anything more as a new task");
    if (row.state !== "input-required") throw new InboxRefusal("closed", `the task is ${row.state}`);
    this.db.prepare("UPDATE a2a_tasks SET state = 'working', received_ms = ?, updated_ms = ? WHERE task_id = ?").run(now, now, taskId);
    const seq = this.event(sender, { kind: "answer", task_id: taskId, context_id: row.context_id, message_id: message.messageId, text: message.text }, now, message.attachments);
    this.insertMessage(taskId, senderMessage(message, now), seq);
    return this.view(this.row(taskId)!);
  }

  /** The `a2a` event of a sender's message, written to /sources; its seq. Throws when it cannot be written. */
  private event(sender: string, payload: A2APayload, now: number, attachments: readonly Attachment[] = []): number {
    const messages = (this.db.prepare("SELECT COUNT(*) AS n FROM a2a_messages WHERE task_id = ?").get(payload.task_id) as { n: number }).n;
    const first = payload.text.trim().split("\n", 1)[0]!.trim() || "Images attached";
    const { seq } = this.queue.accept(
      {
        source: "a2a",
        stream: sender,
        id: `${payload.task_id}/${messages + 1}`,
        occurred_at: iso(now),
        summary: first.length > SUMMARY_LENGTH ? `${first.slice(0, SUMMARY_LENGTH)}…` : first,
        payload,
      },
      { builtin: true, attachments },
    );
    return seq;
  }

  /** Fails the open tasks whose sender has not written within the deadline. */
  private expire(now: number): void {
    const hours = Math.round(this.limits.deadlineMs / 3_600_000);
    this.db
      .prepare(`UPDATE a2a_tasks SET state = 'failed', reason = ?, updated_ms = ? WHERE ${OPEN} AND received_ms <= ?`)
      .run(`no answer within ${hours} hours of the sender's last message`, now, now - this.limits.deadlineMs);
  }

  private insertMessage(taskId: string, message: MessageRow, seq: number | null): void {
    this.db
      .prepare("INSERT INTO a2a_messages (task_id, role, message_id, text, at_ms, seq, has_images) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(taskId, message.role, message.message_id, message.text, message.at_ms, seq, message.has_images);
  }

  private row(taskId: string): TaskRow | undefined {
    return this.db.prepare("SELECT task_id, sender, context_id, state, reason, updated_ms FROM a2a_tasks WHERE task_id = ?").get(taskId) as TaskRow | undefined;
  }

  private view(row: TaskRow): TaskView {
    const messages = this.db.prepare("SELECT role, message_id, text, at_ms, has_images FROM a2a_messages WHERE task_id = ? ORDER BY row").all(row.task_id) as MessageRow[];
    const stored = row.state === "completed"
      ? this.db.prepare("SELECT response_images FROM a2a_tasks WHERE task_id = ?").get(row.task_id) as { response_images: string | null }
      : undefined;
    return {
      taskId: row.task_id,
      sender: row.sender,
      contextId: row.context_id,
      state: row.state,
      ...(row.reason === null ? {} : { reason: row.reason }),
      messages: messages.map((m) => ({ role: m.role, messageId: m.message_id, text: m.text, atMs: m.at_ms, hasImages: m.has_images === 1 })),
      responseImages: this.readImages(stored?.response_images),
      updatedMs: row.updated_ms,
    };
  }

  private readImages(value: string | null | undefined): ResponseImage[] {
    if (!value) return [];
    try {
      const refs = JSON.parse(value) as ImageRef[];
      return refs.map(({ file, filename, mediaType }) => ({ filename, mediaType, bytes: this.assets.read(file) }));
    } catch (cause) {
      throw new Error("the task's artifact images could not be read", { cause });
    }
  }
}

function senderMessage(message: IncomingMessage, now: number): MessageRow {
  return { role: "sender", message_id: message.messageId, text: message.text, at_ms: now, has_images: Number(Boolean(message.attachments?.length)) };
}
