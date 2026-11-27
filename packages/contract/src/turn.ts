// What the events of a turn become in its input: one JSON object a line,
// inside `<events>` and `</events>` (docs/events.md, "ターンに入る形").

import type { AnswerVia, Delivery, Source } from "./events.ts";
import type { HeartbeatPending } from "./heartbeat.ts";
import type { AgentId, Appended, DeliveredAttachment } from "./sandbox.ts";
import type { AgentStatus } from "./status.ts";

type TurnLineBase = {
  /** The agent the event is for. Left out, it is `main`, the only agent for now. */
  agent?: AgentId;
  source: Source;
  stream?: string;
};

type TurnEventBase = TurnLineBase & {
  kind?: never;
  /** The backend's order; what `reply`'s `in_reply_to` takes. */
  seq: number;
  delivery: Delivery;
  answer_via?: AnswerVia;
  /** The occurrence time as delivered by the backend. */
  occurred_at: string;
  summary: string;
  /** Files that came with it, under /sources/<source>/files/. */
  attachments?: DeliveredAttachment[];
};

/**
 * One event. An inline event carries its content as `text`; any other
 * carries where its content was appended under /sources. Only a heartbeat
 * can also carry pending work and status.
 */
export type TurnEvent =
  | (TurnEventBase & {
      /** The payload's `text`, or the payload as JSON when it has none. */
      text: string;
      appended?: never;
      pending?: never;
      status?: never;
    })
  | (TurnEventBase & { appended: Appended; text?: never; pending?: HeartbeatPending; status?: AgentStatus });

/** The batched events of one source and stream, handed over together, as one line. */
export type TurnBatch = TurnLineBase & {
  kind: "batch";
  count: number;
  /** The `seq` of each, in order. */
  seqs: number[];
  /** The summaries of the events, in `seq` order, one a line. */
  summary: string;
  /** Where they were appended: per file, with touching ranges merged, in order. */
  appended: Appended[];
  /**
   * What they changed, drawn as text: only for a source drawn with Slack's
   * drawing (ADR-0029). Changes left out to keep under the limit are named
   * in it, and stay in `seqs` and `appended`.
   */
  text?: string;
};

/** One line inside `<events>`. */
export type TurnLine = TurnEvent | TurnBatch;
