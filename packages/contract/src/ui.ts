// The backend's API for the Web UI and iPhone (docs/ui-api.md).

import type { Source } from "./events.ts";
import type { Activity, AgentId, JobEndKind, MemoryMove, NightLayerOverTarget, NightReviewPhase, NightStageResult, NightTurnStage, ScheduleWhen, SubAgentStatus, TurnResult } from "./sandbox.ts";

/** `GET /auth/app/start` query (separate from the backend's PKCE with GitHub). */
export type AppLoginQuery = { code_challenge: string; code_challenge_method: "S256" };
/** `POST /auth/app/token` body. */
export type AppTokenRequest = { code: string; code_verifier: string; device_name: string };
export type AppTokenResponse = { token: string; expires_at: string };

/** Web settings metadata. Never includes the token or its hash. */
export type AppDevice = { id: string; name: string; created_at: string; expires_at: string };
/** `GET /api/app/devices`. */
export type AppDevicesResponse = { devices: AppDevice[] };

/** `POST /api/messages` (JSON, or multipart with files). */
export type PostMessageRequest = { text: string };
/**
 * The id of the `ui` event the message became, with what the history keeps of
 * its files: the same as its line of the history.
 */
export type PostMessageResponse = { id: string } & OwnerFiles;

/** The event a reply answers: where it came from and its one line. Never its payload. */
export type Trigger = { source: Source; summary: string };

/**
 * An image the backend copied when a reply carried it (ADR-0032), or when the
 * owner sent it with a message (ADR-0034). Its bytes are
 * `GET /api/assets/<id>`, and never change.
 */
export type ReplyImage = {
  id: string;
  /** PNG, JPEG, GIF or WebP, from its first bytes. */
  mime_type: string;
  /** Bytes. */
  size: number;
  /** The name of the file it was copied from, without its directory. */
  name: string;
};

/**
 * A file the owner sent that the backend keeps no copy of: what is not an
 * image it copies (ADR-0034). Only its name and size are kept.
 */
export type OwnerFile = {
  /** The name the browser gave, without its directory. */
  name: string;
  /** Bytes. */
  size: number;
};

/** What the history keeps of the files of one of the owner's messages, in the order sent. */
export type OwnerFiles = {
  /** The images copied (ADR-0034). Missing when there are none. */
  images?: ReplyImage[];
  /** The other files, by name. Missing when there are none. */
  files?: OwnerFile[];
};

/** One line of the conversation. */
export type HistoryEntry =
  | ({ kind: "owner"; id: string; at: string; text: string; agent?: never } & OwnerFiles)
  | {
      kind: "agent";
      id: string;
      at: string;
      text: string;
      agent: AgentId;
      expression?: string;
      trigger?: Trigger;
      /** The turn it was sent in, for the activity record (ADR-0038). Missing when the backend does not know it. */
      turn_id?: string;
      /** The images it carries, in the order sent. Missing when there are none. */
      images?: ReplyImage[];
    };

/** `GET /api/history?before=`: newest first. `before` is the cursor of the next, older page. */
export type HistoryResponse = { entries: HistoryEntry[]; before?: string };

/** `POST /api/history/read`: the history message seen, including this message. */
export type ReadHistoryRequest = { through: string };

/** The main agent's status for the deployments list (ADR-0066). */
export type SummaryState =
  | { kind: "waiting" }
  | { kind: "thinking" }
  | { kind: "tool"; tool: string }
  /** Reserved until Sentinel supports approvals. */
  | { kind: "approval"; pending: number };

/** The data of a `summary` event on `GET /api/summary/stream`. */
export type AgentSummary = {
  state: SummaryState;
  last_message: Pick<HistoryEntry, "kind" | "at" | "text"> | null;
  unread: number;
  unseen_failures: number;
};

/** Whether an agent is in a turn or waiting for events. */
export type AgentState = "thinking" | "waiting";

/** One server-sent event of `GET /api/stream`: `event` is its name, `data` its JSON. */
export type StreamEvent =
  | { event: "reply"; data: Extract<HistoryEntry, { kind: "agent" }> }
  | { event: "activity"; data: { agent: AgentId; activity: Activity } }
  | { event: "state"; data: { agent: AgentId; state: AgentState } }
  /** A sub-agent was started or closed. */
  | { event: "agent"; data: SubAgentStatus }
  /** The number of failures the owner has not seen changed (ADR-0038). */
  | { event: "record"; data: RecordUnseenResponse };

/** One sub-agent that is not closed, as `GET /api/agents` lists it. */
export type SubAgent = {
  agent: AgentId;
  purpose: string;
  state: AgentState;
  /** RFC 3339: when the runner first said it was started. */
  started_at: string;
  /** RFC 3339: since when it is in `state`; when it was started if it has had no turn. */
  state_since: string;
};

/** `GET /api/agents`: the sub-agents that are not closed. */
export type SubAgentsResponse = { agents: SubAgent[] };

/**
 * One of her schedules, as `GET /api/schedules` lists it: what her
 * `schedule_list` lists, and when it comes due next (RFC 3339).
 */
export type ScheduleEntry = { id: string; reason: string; next_at: string } & ScheduleWhen;

/** `GET /api/schedules`: her schedules, in the order she made them. */
export type SchedulesResponse = { schedules: ScheduleEntry[] };

/** `GET /api/agent`, read without a login: what the UI shows of the agent. */
export type AgentResponse = {
  /** The agent's name, from the backend's settings. */
  name: string;
  /** Where each face of her avatar is served, by expression, when an avatar is chosen. */
  icons?: Record<string, string>;
  /** Where the PNG of each face that has one is served, by expression: for Slack's icon_url. */
  png_icons?: Record<string, string>;
};

/**
 * `GET /api/push`: the kinds of notice the backend can send, with what a
 * browser needs to subscribe. A kind is missing when the deployment does not
 * set it up (ADR-0027).
 */
export type PushResponse = {
  /** Web Push: the VAPID public key, uncompressed P-256 in base64url. */
  web_push?: { public_key: string };
};

/**
 * `POST /api/push/subscriptions`: one place to send the notices to. The first
 * kind is Web Push, the browser's `PushSubscription.toJSON()`; the same
 * endpoint again replaces the keys it had.
 */
export type PushSubscriptionRequest = {
  kind: "web-push";
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/** `POST /api/push/subscriptions/delete`: stop sending to this endpoint. */
export type PushUnsubscribeRequest = { endpoint: string };

/**
 * What one notice of a reply carries, whatever the kind it is sent by: what
 * the Web Push is, as JSON, after it is decrypted.
 */
export type Notice = {
  /** The id of the reply, as in the history. */
  id: string;
  /** The agent's name, from the backend's settings. */
  agent: string;
  /** The head of the reply, cut short (docs/ui-api.md, "知らせ"). */
  text: string;
  expression?: string;
  /** How many images the reply has, when it has any (ADR-0032). */
  images?: number;
};

// ── The activity record (ADR-0038, docs/ui-api.md "活動の記録") ──

/** One event a turn was given, as the backend's queue has it. */
export type RecordTrigger = { seq: number; source: Source; stream?: string; summary: string };

/**
 * How a turn went: as the runner said (`done`, `failed`, `stopped`),
 * `running` while it is under way, or `unknown` when it ended and the runner
 * did not say (an older runner, or a turn from before the record).
 */
export type RecordTurnResult = TurnResult | "running" | "unknown";

/** The fields of every row. `at` is where it stands in the list, newest first. */
type RecordRowBase = {
  id: string;
  /** RFC 3339. */
  at: string;
  /**
   * RFC 3339, only on a row that is a failure (or a missed night): when the
   * backend learned of it. A failure after the owner last opened the record
   * is new to her.
   */
  failed_at?: string;
};

/** One turn of the main agent or of a sub-agent. `id` is its `turn_id`; `at` is its start. */
export type RecordTurn = RecordRowBase & {
  kind: "turn";
  agent: AgentId;
  /** Missing when its start was not heard of. */
  started_at?: string;
  /** Missing while it runs, and for a turn cut with no end. */
  ended_at?: string;
  /** Whole seconds from its start to its end, when both are known. */
  seconds?: number;
  result: RecordTurnResult;
  /** Why it failed (or was stopped), in one line, when the runner said. */
  reason?: string;
  /**
   * The events it was given, in the order handed, at most RECORD_TRIGGERS_MAX.
   * Empty for a sub-agent's turn (its work came from the main agent), a turn
   * of the nightly switch, and a turn whose events are unknown.
   */
  triggers: RecordTrigger[];
  /** How many events it was given in all: may be more than `triggers` holds. */
  trigger_count: number;
  /** How many tools it called. */
  tools: number;
  /** How many replies it sent to the owner. */
  replies: number;
  /** For a turn of the nightly switch: the night's row and the step. */
  night?: { id: string; stage: NightTurnStage };
};

/** Counts from the backend's memory commit, not from the runner's stage result. */
export type RecordMemoryChange = {
  files: number;
  added: number;
  removed: number;
  /** Only on reflection: whether the root handoff.md changed. */
  handoff_changed?: boolean;
};

/** One step of a night: `unknown` when the runner did not say. */
export type RecordNightStage = {
  result: NightStageResult | "unknown";
  reason?: string;
  /** Missing when not measured, which is distinct from zero changes. */
  memory_change?: RecordMemoryChange;
};

/**
 * One nightly switch the runner reported. `failed` when a step failed, even
 * if later steps were made; `unknown` when it said nothing of the steps.
 * `at` is its start: its first turn's, else when it was reported.
 */
export type RecordNight = RecordRowBase & {
  kind: "night";
  /** RFC 3339: the time it was due, when its control event is known. */
  scheduled_at?: string;
  started_at: string;
  /** When the runner reported it. */
  ended_at: string;
  seconds: number;
  result: "done" | "failed" | "unknown";
  stages: {
    reflection: RecordNightStage;
    verifier: RecordNightStage & { dropped_records?: number };
    curator: RecordNightStage & {
      always_read_over_target?: NightLayerOverTarget;
      review?: Record<NightReviewPhase, RecordNightStage & { turn_id?: string }>;
    };
    session: RecordNightStage;
  };
};

/** A night that was due and was not switched (ADR-0038). It has no page of its own. `at` is when it was due. */
export type RecordMissedNight = RecordRowBase & {
  kind: "missed_night";
  scheduled_at: string;
  failed_at: string;
};

/** The end of a background job (ADR-0030). It has no page of its own. `at` is its end. */
export type RecordJob = RecordRowBase & {
  kind: "job";
  /** The head of its command, at most RECORD_COMMAND_MAX characters. */
  command: string;
  started_at: string;
  ended_at: string;
  seconds: number;
  end: JobEndKind;
  exit_code?: number;
  signal?: string;
};

/** A sub-agent. `id` and `agent` are its name; in the list only closed ones, `at` when it was closed. */
export type RecordSubAgent = RecordRowBase & {
  kind: "sub_agent";
  agent: AgentId;
  purpose: string;
  /** When it was started, when the backend heard of it. */
  started_at?: string;
  /** Missing while it is not closed. */
  closed_at?: string;
  /** How many turns it had, and how many of them failed. */
  turns: number;
  failed_turns: number;
};

export type RecordRow = RecordTurn | RecordNight | RecordMissedNight | RecordJob | RecordSubAgent;

/** The kinds the list can be narrowed to. `night` takes the missed nights too. */
export type RecordKind = "turn" | "night" | "job" | "sub_agent";

/**
 * `GET /api/record?day=&tz=&failed=&agent=&kind=`: one day of the record,
 * newest first, narrowed as asked. `before` is the next older day that has
 * rows the same narrowing keeps; missing on the last.
 */
export type RecordDayResponse = {
  /** `YYYY-MM-DD` in the time zone asked for. */
  day: string;
  rows: RecordRow[];
  /** The whole day's numbers, not narrowed: its turns, and its failures (not counting missed nights). */
  turns: number;
  failures: number;
  before?: string;
  /** Every sub-agent the record knows, by name, for narrowing by agent. */
  agents: string[];
};

/** One block of a turn's flow: as the activity it was, but a tool's result carries only its size. */
export type RecordFlowItem =
  | Exclude<Activity, { kind: "turn_start" | "turn_end" | "tool_result" }>
  | {
      kind: "tool_result";
      at: string;
      turn_id: string;
      call_id: string;
      is_error: boolean;
      /** Lines and bytes (UTF-8) of its output; the output is `GET /api/record/turns/<id>/results/<call_id>`. */
      lines: number;
      bytes: number;
    };

/** A reply the turn sent, with where it stands in the conversation. */
export type RecordReply = {
  id: string;
  at: string;
  text: string;
  /** A `before` for `GET /api/history` whose page starts with this reply. */
  history_before: string;
};

/** `GET /api/record/turns/<id>` */
export type RecordTurnResponse = {
  turn: RecordTurn;
  /** The committed memory change, when still reachable. */
  memory_change?: MemoryChange;
  /** Its blocks in order. Empty when `expired`. */
  flow: RecordFlowItem[];
  /** Whether its flow is gone with time (30 days), only the summary left. */
  expired: boolean;
  replies: RecordReply[];
};

/** `GET /api/record/turns/<id>/results/<call_id>`: the whole output of one tool's result. */
export type RecordResultResponse = { output: string };

/** `GET /api/record/nights/<id>`: the night, its stage turns and the individual weekly review turns. */
// Memory (docs/ui-api.md). IDs are full Git object IDs.
export type MemoryNightStage = NightTurnStage | NightReviewPhase;
export type MemoryWriter =
  | { kind: "daytime"; agent: string; turn_id?: string; trigger?: RecordTrigger }
  | { kind: "night"; stage: MemoryNightStage; turn_id?: string; night_id?: string; night_seq?: number }
  | { kind: "system"; operation: "reference_repair" | "avatar_seed"; night_id?: string; turn_id?: string; night_seq?: number }
  | { kind: "owner" | "unknown" };

export type MemoryCounts = { files: number; added: number; removed: number };
export type MemoryChange = MemoryCounts & { id: string; at: string; writer: MemoryWriter; paths: string[] };
export type MemoryFileChange = { path: string; kind: "added" | "deleted" | "modified" | "moved"; from?: string; added: number; removed: number };
export type MemoryChangeResponse = { change: MemoryChange; files: MemoryFileChange[]; moves: MemoryMove[] };
export type MemoryNight = MemoryCounts & {
  id: string; at: string; ended_at: string; changes: MemoryChangeResponse[];
};
export type MemoryReadCount = { count_30_days: number; last_day: string | null };
export type MemoryFile = {
  path: string; bytes: number; always_read: boolean; reads: MemoryReadCount | null;
  last_change: MemoryLastChange | null;
};
export type MemoryLastChange = { id: string; at: string; writer: MemoryWriter };
export type MemoryBrokenLink = { path: string; line: number; destination: string };
export type MemoryOverviewResponse = {
  head: string | null;
  can_edit: boolean;
  files: MemoryFile[];
  always_read: { bytes: number; target_bytes: number; file_limit_bytes: number; over_target_nights: string[] };
  broken_links: MemoryBrokenLink[];
  links_incomplete: boolean;
  last_night: MemoryNight | null;
};
export type MemoryFileResponse = {
  head: string; file: MemoryFile; history_count: number; broken_links: MemoryBrokenLink[];
  edit: { max_bytes: number } | null;
  moved_from?: string; kind: "markdown" | "text" | "image" | "unavailable"; text?: string; image_url?: string;
};
export type MemoryWriterFilter = "all" | "daytime" | "night" | "owner";
export type MemoryChangesResponse = {
  head: string | null;
  days: Array<{ day: string; changes: number; files: number; items: MemoryChange[] }>;
  next?: string;
};
export type MemoryHistoryResponse = { head: string | null; changes: MemoryChange[]; next?: string };
export type MemoryDiffLine =
  | { kind: "context"; old_line: number; new_line: number; text: string }
  | { kind: "added"; new_line: number; text: string }
  | { kind: "removed"; old_line: number; text: string };
export type MemoryFileDiff =
  | { kind: "text"; hunks: Array<{ old_start: number; new_start: number; lines: MemoryDiffLine[] }>; truncated: boolean }
  | { kind: "image" | "binary" | "too_large" };
/** To restore an older body, send it as `text` with the current file's `head` as `base_head`. */
export type MemorySaveRequest = { path: string; base_head: string; text: string };
export type MemorySaveResponse =
  | { kind: "saved"; head: string; id: string }
  | { kind: "unchanged"; head: string }
  | { kind: "head_conflict"; head: string; exists: boolean; last_change: MemoryLastChange | null; diff: MemoryFileDiff }
  | { kind: "worktree_conflict"; head: string }
  | { kind: "file_not_editable" }
  | { kind: "text_too_large"; max_bytes: number }
  | { kind: "prompt_file_limit"; max_bytes: number }
  | { kind: "editing_disabled" };
export type MemoryCompareResponse = { from: string; to: string; changes: number; added: number; removed: number; diff: MemoryFileDiff };
export type MemorySearchResponse = {
  head: string | null; files: Array<{ path: string; lines: Array<{ line: number; text: string }> }>;
  line_limit: number; truncated: boolean;
};

export type RecordNightResponse = {
  night: RecordNight;
  /** Each committed change in the order it was made, including reference repairs. */
  memory_changes?: MemoryChange[];
  turns: Partial<Record<NightTurnStage | NightReviewPhase, RecordTurn>>;
};

/** `GET /api/record/sub-agents/<name>?before=`: the sub-agent and its turns, newest first, in pages. */
export type RecordSubAgentResponse = {
  sub_agent: RecordSubAgent;
  turns: RecordTurn[];
  before?: string;
};

/** `GET /api/record/unseen`, and the `record` event of the stream. */
export type RecordUnseenResponse = {
  /** The failures, missed nights too, the backend learned of after the owner last opened the record. */
  unseen: number;
};

/** `POST /api/record/seen`: what was unseen until now, and when she had opened it before. */
export type RecordSeenResponse = {
  unseen: number;
  /** RFC 3339. The first time, when the record began: the failures after it are the unseen ones. */
  previous_seen_at: string;
};
