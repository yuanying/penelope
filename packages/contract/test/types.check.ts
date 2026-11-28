// Type tests for the contract. They have no runtime part: `npm run typecheck`
// is the test. Each `satisfies` is a value the contract must accept, and each
// `@ts-expect-error` is one it must reject (tsc fails if the error goes away).

import type {
  A2APayload,
  A2AReplyRequest,
  A2AReplyResponse,
  AckRequest,
  Activity,
  ActivityRequest,
  ControlPayload,
  CronPayload,
  DeliveredEvent,
  ErrorBody,
  Event,
  PollResponse,
  Schedule,
  ScheduleListResponse,
  ScheduleRequest,
  SelfEventRequest,
  SessionRotatedRequest,
  SourcesLine,
  SubAgentNotice,
  SubAgentStatus,
  TurnBatch,
  TurnEndRequest,
  TurnEvent,
  TurnLine,
} from "../src/index.ts";

// --- The envelope (docs/events.md) ---

export const minimal = {
  source: "alertmanager",
  id: "a-1",
  occurred_at: "2026-11-14T09:00:00Z",
  summary: "1 alert firing",
  payload: { anything: ["goes", 1, null] },
} satisfies Event;

export const slack = {
  source: "slack",
  id: "C0123:1731574800.000100",
  occurred_at: "2026-11-14T09:00:00Z",
  summary: "#ops: a mention",
  stream: "ops",
  delivery: "now",
  payload: { type: "message", ts: "1731574800.000100" },
} satisfies Event;

// @ts-expect-error delivery is "now" or "batch"
export const badDelivery = { ...minimal, delivery: "later" } satisfies Event;

// @ts-expect-error summary is required
export const noSummary = { source: "x", id: "1", occurred_at: "t", payload: 1 } satisfies Event;

export const nightly = { kind: "nightly" } satisfies ControlPayload;
// @ts-expect-error the only control event so far is nightly
export const badControl = { kind: "reboot" } satisfies ControlPayload;

export const line = {
  seq: 12,
  received_at: "2026-11-14T09:00:01Z",
  occurred_at: "2026-11-14T09:00:00Z",
  source: "slack",
  stream: "ops",
  id: "C0123:1731574800.000100",
  summary: "#ops: a mention",
  attachments: ["/sources/slack/files/12-diagram.png"],
  payload: { type: "message", ts: "1731574800.000100" },
} satisfies SourcesLine;
// @ts-expect-error a line carries the backend's seq
export const lineWithoutSeq = { ...minimal, received_at: "t" } satisfies SourcesLine;

export const fired = { schedule_id: "s-1", reason: "look at the CI again" } satisfies CronPayload;

// --- The sandbox's API (docs/sandbox-api.md) ---

export const notice = {
  seq: 12,
  source: "slack",
  id: "C0123:1731574800.000100",
  stream: "ops",
  occurred_at: "2026-11-14T09:00:00Z",
  received_at: "2026-11-14T09:00:01Z",
  summary: "#ops: a mention",
  delivery: "now",
  inline: false,
  appended: { path: "/sources/slack/ops/2026-11-14.jsonl", lines: [3, 3] },
} satisfies DeliveredEvent;

export const inlineUi = {
  seq: 13,
  source: "ui",
  id: "m-1",
  occurred_at: "2026-11-14T09:01:00Z",
  received_at: "2026-11-14T09:01:00Z",
  summary: "hello",
  delivery: "now",
  inline: true,
  payload: { text: "hello" },
  appended: { path: "/sources/ui/2026-11-14.jsonl", lines: [1, 1] },
  attachments: [{ path: "/sources/ui/files/13-screenshot.png", mime_type: "image/png", size: 48213 }],
} satisfies DeliveredEvent;

// @ts-expect-error a handed-over attachment carries its type and size, not only its path
export const bareAttachment = { ...inlineUi, attachments: ["/sources/ui/files/13-screenshot.png"] } satisfies DeliveredEvent;

// @ts-expect-error an inline event carries its payload
export const inlineWithoutPayload = { ...notice, inline: true } satisfies DeliveredEvent;

// @ts-expect-error an event that is not inline does not carry its payload
export const noticeWithPayload = { ...notice, payload: {} } satisfies DeliveredEvent;

export const poll = { events: [notice, inlineUi] } satisfies PollResponse;
export const emptyPoll = { events: [] } satisfies PollResponse;

export const ack = { agent: "main", seqs: [12, 13] } satisfies AckRequest;
// @ts-expect-error every request names its agent
export const ackWithoutAgent = { seqs: [12] } satisfies AckRequest;

export const self = {
  agent: "main",
  id: "child-7-done",
  summary: "the child finished the review",
  payload: { result: "ok" },
} satisfies SelfEventRequest;

const at = "2026-11-14T09:01:02Z";
export const activities = [
  { kind: "turn_start", at, turn_id: "t-1" },
  { kind: "thinking", at, turn_id: "t-1", text: "..." },
  { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "ls" } },
  { kind: "tool_result", at, turn_id: "t-1", call_id: "c-1", is_error: false, output: "a\nb\n" },
  { kind: "message", at, turn_id: "t-1", text: "done" },
  { kind: "turn_end", at, turn_id: "t-1" },
] satisfies Activity[];

// @ts-expect-error a tool call names its tool
export const toolCallWithoutName = { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", arguments: {} } satisfies Activity;
// @ts-expect-error tokens are not sent one by one
export const token = { kind: "token", at, turn_id: "t-1", text: "a" } satisfies Activity;

export const activityRequest = { agent: "main", activities } satisfies ActivityRequest;
export const turnEnd = { agent: "main", turn_id: "t-1" } satisfies TurnEndRequest;

export const byCron = { agent: "main", reason: "every morning", cron: "0 9 * * *" } satisfies ScheduleRequest;
export const byTime = { agent: "main", reason: "once", at: "2026-11-15T09:00:00Z" } satisfies ScheduleRequest;
// @ts-expect-error a schedule is a cron expression or a time, not both
export const both = { agent: "main", reason: "x", cron: "0 9 * * *", at } satisfies ScheduleRequest;
// @ts-expect-error a schedule needs one of them
export const neither = { agent: "main", reason: "x" } satisfies ScheduleRequest;

export const schedule = { id: "s-1", agent: "main", reason: "every morning", cron: "0 9 * * *" } satisfies Schedule;
export const schedules = { schedules: [schedule] } satisfies ScheduleListResponse;

export const rotated = { agent: "main" } satisfies SessionRotatedRequest;

export const started = { agent: "review-pr-22", purpose: "review PR 22", closed: false } satisfies SubAgentStatus;
export const closed = { ...started, closed: true } satisfies SubAgentStatus;
// @ts-expect-error a sub-agent's status names its purpose
export const noPurpose = { agent: "review-pr-22", closed: false } satisfies SubAgentStatus;
// @ts-expect-error a sub-agent is closed or not
export const notSaid = { agent: "review-pr-22", purpose: "x" } satisfies SubAgentStatus;

export const stopped = { reason: "stopped", purpose: "review PR 22", text: "Two comments.\nFirst, ..." } satisfies SubAgentNotice;
export const failed = { reason: "failed", purpose: "review PR 22", text: "the model's API did not answer" } satisfies SubAgentNotice;
export const interrupted = { reason: "interrupted", purpose: "review PR 22", text: "" } satisfies SubAgentNotice;
// @ts-expect-error the reasons are stopped, failed and interrupted
export const done = { reason: "done", purpose: "x", text: "" } satisfies SubAgentNotice;
// @ts-expect-error the notice carries the text, empty when there is none
export const noText = { reason: "interrupted", purpose: "x" } satisfies SubAgentNotice;

export const subAgentStopped = {
  agent: "review-pr-22",
  id: "review-pr-22/1",
  summary: "Two comments.",
  payload: stopped,
} satisfies SelfEventRequest;

export const error = { error: "seqs must be a list of integers" } satisfies ErrorBody;

// --- The input of a turn (docs/events.md, "ターンに入る形") ---

export const turnNotice = {
  seq: 12,
  source: "slack",
  stream: "ops",
  delivery: "now",
  occurred_at: "2026-11-14T09:00:00Z",
  summary: "#ops: a mention",
  appended: { path: "/sources/slack/ops/2026-11-14.jsonl", lines: [3, 3] },
} satisfies TurnEvent;

export const turnInline = {
  seq: 13,
  source: "ui",
  delivery: "now",
  occurred_at: "2026-11-14T09:01:00Z",
  summary: "hello",
  text: "hello",
  attachments: [{ path: "/sources/ui/files/13-screenshot.png", mime_type: "image/png", size: 48213 }],
} satisfies TurnEvent;

export const turnBatch = {
  kind: "batch",
  source: "slack",
  stream: "ops",
  count: 2,
  seqs: [20, 22],
  summary: "message 20\nmessage 22",
  appended: [{ path: "/sources/slack/ops/2026-11-14.jsonl", lines: [4, 5] }],
} satisfies TurnBatch;

export const turnLines = [turnNotice, turnInline, turnBatch, { ...turnNotice, agent: "main" }] satisfies TurnLine[];

// @ts-expect-error an event carries its text or where it was appended, not both
export const turnBoth = { ...turnNotice, text: "hello" } satisfies TurnEvent;
const { appended: _appended, ...appendedLeftOut } = turnNotice;
// @ts-expect-error an event carries one of them
export const turnNeither = appendedLeftOut satisfies TurnEvent;
// @ts-expect-error a batch names the seq of each event in it
export const batchWithoutSeqs = { ...turnBatch, seqs: undefined } satisfies TurnBatch;
// @ts-expect-error a single event is not a batch
export const eventAsBatch = { ...turnNotice, kind: "batch" } satisfies TurnLine;

// --- A2A (docs/a2a.md) ---

export const a2aRequest = {
  kind: "request",
  task_id: "t-1",
  context_id: "c-1",
  message_id: "m-1",
  text: "Look at the cluster's alerts.",
} satisfies A2APayload;

export const a2aClose = { agent: "main", in_reply_to: 12, state: "completed", text: "Done." } satisfies A2AReplyRequest;
export const a2aCloseQuietly = { agent: "main", in_reply_to: 12, state: "completed" } satisfies A2AReplyRequest;
export const a2aAsk = { agent: "main", in_reply_to: 12, state: "input-required", text: "Which namespace?" } satisfies A2AReplyRequest;
// @ts-expect-error her reply closes or asks; the backend fails and rejects tasks
export const a2aFail = { agent: "main", in_reply_to: 12, state: "failed" } satisfies A2AReplyRequest;
// @ts-expect-error the reply names the event it answers
export const a2aNoEvent = { agent: "main", state: "completed" } satisfies A2AReplyRequest;

export const a2aReplied = { task_id: "t-1", state: "completed" } satisfies A2AReplyResponse;
