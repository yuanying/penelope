// The backend's API for the sandbox: the runner and the tools, through the
// Sentinel (docs/sandbox-api.md).

import type { AnswerVia, Delivery, Source } from "./events.ts";
import type { HeartbeatPending } from "./heartbeat.ts";
import type { AgentStatus, ContextUsage } from "./status.ts";

/** Which agent is calling. The main agent is `main`; a sub-agent's is the name its parent gives it. */
export type AgentId = "main" | (string & {});

/**
 * `POST /v1/agents`: a sub-agent was started (`closed: false`) or closed
 * (`closed: true`); the runner sends it again for each open one when it
 * starts. `agent` is the sub-agent's name, never `main`.
 */
export type SubAgentStatus = FromAgent & {
  /** The one line the main agent gave when it started the sub-agent. */
  purpose: string;
  closed: boolean;
};

/** Why a sub-agent stopped: its last words, a failed run, or a run cut by the runner stopping. */
export type SubAgentStopReason = "stopped" | "failed" | "interrupted";

/**
 * The `payload` of the event to the main agent each time a sub-agent stops
 * (`POST /v1/self-events` with the sub-agent as `agent`, `id` `<name>/<n>`).
 */
export type SubAgentNotice = {
  reason: SubAgentStopReason;
  purpose: string;
  /** The whole of its last words; the failure for `failed`; empty when there are none. */
  text: string;
};

/** Every request carries the agent: in the body, or as the `agent` query parameter of a GET. */
export type FromAgent = { agent: AgentId };

/** The lines the backend appended to a file under /sources. 1-based, both ends included. */
export type Appended = { path: string; lines: [from: number, to: number] };

/** A file that came with an event, as it was kept under /sources/<source>/files/. */
export type DeliveredAttachment = {
  path: string;
  /** The media type: from the file's first bytes for PNG, JPEG, GIF and WebP, else as the sender said, else application/octet-stream. */
  mime_type: string;
  /** Bytes. */
  size: number;
};

type DeliveredBase = {
  /** The backend's order. */
  seq: number;
  source: Source;
  id: string;
  stream?: string;
  /** RFC 3339 in the backend's configured time zone, or the stored value if it cannot be converted. */
  occurred_at: string;
  /** RFC 3339, when the backend took it in. */
  received_at: string;
  summary: string;
  delivery: Delivery;
  answer_via?: AnswerVia;
  /** Where its payload was written. */
  appended: Appended;
  /** Files that came with it, under /sources/<source>/files/. */
  attachments?: DeliveredAttachment[];
};

/**
 * An event as `GET /v1/events` hands it over. An inline source's event
 * carries its payload into the turn; any other carries only the summary and
 * where to read it. Only a heartbeat can also carry pending work and status.
 */
export type DeliveredEvent =
  | (DeliveredBase & { inline: true; payload: unknown; pending?: never; status?: never })
  | (DeliveredBase & { inline: false; payload?: never; pending?: HeartbeatPending; status?: AgentStatus });

/** `GET /v1/events?agent=&after=&wait=` */
export type PollResponse = { events: DeliveredEvent[] };

/** `POST /v1/events/ack` */
export type AckRequest = FromAgent & { seqs: number[] };

/** `POST /v1/self-events`: an event to herself (`source: "self"`). */
export type SelfEventRequest = FromAgent & { id: string; summary: string; payload: unknown };

/**
 * How a background job ended (ADR-0030): it exited with a code, was ended by
 * a signal it did not get from the runner, was stopped with `job_stop`, ran
 * past its time limit, or was cut by the runner starting again.
 */
export type JobEndKind = "exited" | "signaled" | "stopped" | "timed-out" | "interrupted";

/**
 * The `payload` of the event to the main agent when a background job ends
 * (`POST /v1/job-events`, `source: "job"`, `id` the job's id).
 */
export type JobEnd = {
  /** The job's id, as `job_start` gave it. */
  job: string;
  command: string;
  cwd: string;
  end: JobEndKind;
  /** For `exited`. */
  exit_code?: number;
  /** For `signaled`, and for `stopped` and `timed-out`: the signal that ended it. */
  signal?: string;
  /** RFC 3339. */
  started_at: string;
  /** RFC 3339. For `interrupted`, when the runner found it cut. */
  ended_at: string;
  /** Whole seconds from start to end. */
  seconds: number;
  /** The file with all of its standard output and standard error. */
  output: string;
  /** The size of that file, in bytes. */
  output_bytes: number;
  /** The end of the output, at most the runner's limit of characters. */
  tail: string;
  /** Whether the output is longer than `tail`. */
  tail_truncated: boolean;
};

/** `POST /v1/job-events`: a background job of the main agent ended (`source: "job"`). */
export type JobEventRequest = FromAgent & { id: string; summary: string; payload: JobEnd };

/** `POST /v1/replies`: a reply to the owner. */
export type ReplyRequest = FromAgent & {
  text: string;
  /** The turn it is sent in (ADR-0038). Without it, the backend takes the main agent's turn under way. */
  turn_id?: string;
  /** The face to show: the Web UI puts the latest one beside the avatar (ADR-0016). */
  expression?: string;
  /** The `seq` of the event it answers. */
  in_reply_to?: number;
  /** Images to show with it, read from files in the sandbox: at most REPLY_IMAGES_MAX (ADR-0032). */
  images?: ReplyImageUpload[];
};
export type ReplyResponse = { id: string };

/** One image of a reply, as the runner read it from a file in the sandbox. */
export type ReplyImageUpload = {
  /** The file's name, without its directory. */
  name: string;
  /** The file's bytes, in base64. */
  data: string;
};

type ActivityBase = { at: string; turn_id: string };

/** One closed block of a turn. Sent block by block, not token by token. */
export type Activity =
  | (ActivityBase & { kind: "turn_start" })
  | (ActivityBase & { kind: "thinking"; text: string })
  | (ActivityBase & { kind: "tool_call"; call_id: string; name: string; arguments: unknown })
  | (ActivityBase & { kind: "tool_result"; call_id: string; is_error: boolean; output: string })
  | (ActivityBase & { kind: "message"; text: string })
  | (ActivityBase & { kind: "turn_end" });

/** `POST /v1/activity` */
export type ActivityRequest = FromAgent & { activities: Activity[] };

/**
 * How a turn ended (ADR-0038): it ran to its end, it failed, or the runner
 * cut it (the runner stopping, a sub-agent closed while it ran). Only
 * `failed` is a failure.
 */
export type TurnResult = "done" | "failed" | "stopped";

/** The steps of the nightly switch that are turns (ADR-0007). */
export type NightTurnStage = "reflection" | "verifier" | "curator";

export interface MemoryMove {
  from: string;
  to: string;
}

/** `POST /v1/memory/repairs`: commit the runner's reference edits, not the worker's turn. */
export interface MemoryRepairRequest {
  agent: AgentId;
  paths: string[];
  moves: MemoryMove[];
  /** The curator turn that made these moves and its nightly control event. */
  night?: { seq: number; turn_id: string };
}

/**
 * `POST /v1/turns/end`: the turn is over; the backend commits /memory. The
 * rest is for the activity record (ADR-0038); a runner that leaves it out
 * makes a turn whose result and trigger are unknown.
 */
export type TurnEndRequest = FromAgent & {
  turn_id: string;
  result?: TurnResult;
  /** For `failed`: why, in one line. May come with `stopped`. */
  reason?: string;
  /** The `seq` of every event handed into the turn, steers and follow-ups too, in the order handed. */
  seqs?: number[];
  /** For a turn of the nightly switch: the `seq` of its control event, and which step it is. */
  night?: { seq: number; stage: NightTurnStage };
  context?: ContextUsage;
};

/** When a schedule comes due: a cron expression, or one time (RFC 3339). */
export type ScheduleWhen = { cron: string; at?: never } | { at: string; cron?: never };

/** `POST /v1/schedules` */
export type ScheduleRequest = FromAgent & { reason: string } & ScheduleWhen;

/** One schedule, as `POST` answers and `GET /v1/schedules` lists. */
export type Schedule = { id: string; agent: AgentId; reason: string } & ScheduleWhen;
export type ScheduleListResponse = { schedules: Schedule[] };

/** What became of one step of the nightly switch: done, failed, or not made because an earlier one stopped it. */
export type NightStageResult = "done" | "failed" | "skipped";

export type NightStage = {
  result: NightStageResult;
  /** For `failed`: why, in one line. */
  reason?: string;
};

/** For a stage with a turn, its ID ties the result to the backend's memory commit. */
export type NightTurnReport = NightStage & { turn_id?: string };

export type NightReviewPhase = "content" | "structure";
export type NightLayerOverTarget = { total_bytes: number; target_bytes: number };

/** The four steps of a night (ADR-0044); a weekly review is still one curator step. */
export type NightStages = {
  reflection: NightTurnReport;
  verifier: NightTurnReport & { dropped_records?: number };
  curator: NightTurnReport & {
    always_read_over_target?: NightLayerOverTarget;
    review?: Record<NightReviewPhase, NightTurnReport>;
  };
  session: NightStage;
};

/**
 * `POST /v1/sessions/rotated`: the runner went through the nightly switch of
 * the control event `seq`, and how each step went (ADR-0038). Sent each time
 * the steps are run, also when one stopped them; sent with `seq` alone when
 * the event came again after its switch was made. A runner that sends
 * neither has switched to a new session, the steps unknown.
 */
export type SessionRotatedRequest = FromAgent & { seq?: number; stages?: NightStages; memory_reads?: MemoryReadsSnapshot };

/** One complete daytime read snapshot at rotation, with UTC dates and no memory text. */
export type MemoryReadsSnapshot = { day: string; files: Array<{ path: string; dates: string[] }> };

/** Where a task an agent sent over A2A is (docs/a2a.md). `working` and `input-required` are open. */
export type A2ATaskState = "working" | "input-required" | "completed" | "failed" | "rejected";

/**
 * `POST /v1/a2a/replies`: her answer in the task of the `a2a` event `in_reply_to`.
 * `completed` closes the task with optional text and images. `input-required`
 * asks a text question and keeps the task open for its answer.
 */
export type A2AReplyRequest = FromAgent & {
  in_reply_to: number;
  state: "completed" | "input-required";
  text?: string;
  /** File copies read by the runner, for completed replies only (ADR-0047). */
  images?: ReplyImageUpload[];
};
export type A2AReplyResponse = { task_id: string; state: A2ATaskState };
