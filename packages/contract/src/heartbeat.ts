// Unfinished work on a heartbeat only (ADR-0055, docs/events.md).

export const HEARTBEAT_PENDING_LIMIT = 5;

/** Nonempty, with at most HEARTBEAT_PENDING_LIMIT items and the number left out. */
export type HeartbeatPendingList<T> = { items: T[]; omitted: number };

export type HeartbeatA2ATask = {
  sender: string;
  state: "working" | "input-required";
  task_id: string;
  /** RFC 3339, the sender's last message. */
  since: string;
  /** The event of that message; `reply_to_agent` takes it as `in_reply_to`. */
  seq: number;
  summary: string;
};

export type HeartbeatJob = {
  job: string;
  /** RFC 3339. */
  started_at: string;
  command: string;
};

export type HeartbeatSubAgent = {
  name: string;
  purpose: string;
  state: "running" | "waiting";
  /** RFC 3339, when the sub-agent entered this state. */
  since: string;
};

/** `at` is when the backend learned of the failure, RFC 3339. */
export type HeartbeatFailure =
  | { kind: "turn"; at: string; reason?: string }
  | { kind: "job"; at: string; command: string; exit_code?: number };

/** An empty category is omitted; when all are empty, so is `pending`. */
export type HeartbeatPending = {
  a2a_tasks?: HeartbeatPendingList<HeartbeatA2ATask>;
  jobs?: HeartbeatPendingList<HeartbeatJob>;
  subagents?: HeartbeatPendingList<HeartbeatSubAgent>;
  failures?: HeartbeatPendingList<HeartbeatFailure>;
};
