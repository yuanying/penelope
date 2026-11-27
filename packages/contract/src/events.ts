// The event envelope and what the intake answers (docs/events.md).

import type { HeartbeatPending } from "./heartbeat.ts";

/** The sources the backend has itself. Plugins in receivers add their own names. */
export type BuiltinSource = "ui" | "cron" | "a2a" | "self" | "job" | "control" | "heartbeat";

export const EVENT_PATH_SEGMENT = /^[a-z0-9_-][a-z0-9._-]{0,127}$/;

/** Where an event came from. Also the first directory under /sources. */
export type Source = BuiltinSource | (string & {});

/**
 * When the event reaches a turn. `now`: at once, steering a running turn or
 * starting one, even outside the awake hours. `batch`: the backend holds it
 * and hands it over with the others later, after a running turn rather than
 * into it. Only the source's side decides it.
 */
export type Delivery = "now" | "batch";

/** An optional hint for answering an event, not a destination or a grant of permission. */
export type AnswerVia = { tool: string; command?: never } | { command: string; tool?: never };

/** What a source sends to the intake. */
export type Event = {
  /** The source's name. */
  source: Source;
  /** Given by the source. Unique together with `source`; the key that drops duplicates. */
  id: string;
  /** RFC 3339. */
  occurred_at: string;
  /** One line, for people and the model. */
  summary: string;
  /**
   * Where under /sources/<source>/ it is written (a Slack channel, say).
   * `source` and `stream` are path segments: lower-case letters, digits, `.`,
   * `_` and `-`, not starting with `.`. Anything else is answered with 400.
   */
  stream?: string;
  /** Left out, it is the source's default (batch for receivers' plugins). */
  delivery?: Delivery;
  answer_via?: AnswerVia;
  /** The source's content as it is, any JSON. The backend appends it to /sources as part of one line. */
  payload: unknown;
};

/**
 * One line of /sources/<source>[/<stream>]/<YYYY-MM-DD>.jsonl: the envelope's
 * fields beside the payload, which is written as it came.
 */
export type SourcesLine = {
  seq: number;
  received_at: string;
  /** The original occurrence time as stored, not the time as formatted for delivery. */
  occurred_at: string;
  source: Source;
  stream?: string;
  id: string;
  summary: string;
  answer_via?: AnswerVia;
  /** Files that came with it, under /sources/<source>/files/. */
  attachments?: string[];
  payload: unknown;
};

/** The payload of a `control` event. The runner handles it; it never enters her turn. */
export type ControlPayload = { kind: "nightly"; /** Scheduled local date, only for weekly review. */ review_date?: string };

/** The payload of a `cron` event: one of her schedules came due. */
export type CronPayload = { schedule_id: string; reason: string };

/**
 * The payload of a `heartbeat` event (ADR-0031): the awake hours went
 * `quiet_minutes` with no turn, counted from `since` (when her last turn
 * ended, or when the backend started if she has had none). A fraction only
 * when the tests set the quiet time in seconds.
 */
export type HeartbeatPayload = { since: string; quiet_minutes: number; pending?: HeartbeatPending };

/** The body of every 4xx and 5xx answer of the backend. */
export type ErrorBody = { error: string };

/**
 * The payload of an `a2a` event: a message another agent sent over A2A
 * (docs/a2a.md). `request` opens a task; `answer` is the agent's answer to her
 * question in a task that was `input-required`. The stream is the sender's name.
 */
/** Images, if present, live in the event's attachments, not this payload. */
export type A2APayload = {
  kind: "request" | "answer";
  task_id: string;
  context_id: string;
  message_id: string;
  text: string;
};
