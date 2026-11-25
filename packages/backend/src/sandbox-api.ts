// The backend's API for the sandbox (docs/sandbox-api.md). It listens only
// on a Unix socket that the backend and the Sentinel mount; the Sentinel
// puts the real token in place of the sandbox's surrogate (ADR-0014).
import { createHash, timingSafeEqual } from "node:crypto";
import type http from "node:http";

import { A2A_BODY_MAX_BYTES, A2A_IMAGE_MAX_BYTES, A2A_IMAGES_MAX, type Activity, type AgentId, type DeliveredEvent, isSubAgentName, type MemoryMove, type NightStages, type NightTurnReport, type ScheduleWhen } from "@penelope/contract";

import { type Inbox, InboxRefusal } from "./a2a/inbox.ts";
import type { SubAgents } from "./agents.ts";
import { AssetStoreError, checkImages, ImageRefusal } from "./assets.ts";
import type { Conversation } from "./conversation.ts";
import { isTime } from "./envelope.ts";
import { type Handler, HttpError, readJson, sendEmpty, sendJson } from "./http.ts";
import { memoryPath } from "./memory-git.ts";
import { readSnapshot } from "./memory-record.ts";
import type { MemoryView } from "./memory-view.ts";
import { type Memory, MemoryCommitError } from "./memory.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { Queue } from "./queue.ts";
import type { ActivityRecord, TurnEnd } from "./record.ts";
import { ScheduleError, type Schedules } from "./schedules.ts";
import { iso } from "./time.ts";

/** The longest a poll waits. */
export const MAX_WAIT_SECONDS = 60;
/** Replies and activity carry tool output, so the limit is generous. */
export const DEFAULT_SANDBOX_BYTES = 16 * 1024 * 1024;
/** A reply carries up to four images of 10 MiB in base64 (ADR-0032). */
export const DEFAULT_REPLY_BYTES = 64 * 1024 * 1024;

export type SandboxOptions = {
  /** The real token. Without one, every request is refused. */
  token: string | undefined;
  queue: Queue;
  conversation: Conversation;
  /** What the runner said of each sub-agent. */
  agents: SubAgents;
  schedules: Schedules;
  memory: Memory;
  memoryView: MemoryView;
  /** The tasks other agents sent over A2A, which her replies close or ask in. */
  inbox: Inbox;
  /** The activity record (ADR-0038). */
  record: ActivityRecord;
  modelSettings: ModelSettings;
  now: () => number;
  maxBytes?: number;
  /** The limit of a reply's body, which carries its images. */
  maxReplyBytes?: number;
  log?: (line: string) => void;
};

export function sandboxHandler(options: SandboxOptions): Handler {
  const { queue, conversation, agents, schedules, memory, memoryView, inbox, record, now } = options;
  const log = options.log ?? console.error;
  const maxBytes = options.maxBytes ?? DEFAULT_SANDBOX_BYTES;
  const maxReplyBytes = options.maxReplyBytes ?? DEFAULT_REPLY_BYTES;
  const expected = options.token === undefined || options.token === "" ? undefined : digest(options.token);

  // What is kept for the record never refuses what it is kept from (ADR-0038).
  const keep = (work: () => void) => {
    try {
      work();
    } catch (error) {
      log(`record: not kept: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://sandbox");
    if (!authorized(request, expected)) throw new HttpError(401, "the token is not the backend's");
    const route = `${request.method} ${url.pathname}`;
    const body = () => readJson(request, maxBytes).then(object);

    if (url.pathname === "/v1/events") {
      if (request.method !== "GET") throw new HttpError(405, "only GET");
      mainOnly(agentOf(url.searchParams.get("agent")), "takes events");
      const after = integer(url.searchParams.get("after") ?? "0", "after");
      const wait = Math.min(integer(url.searchParams.get("wait") ?? "0", "wait"), MAX_WAIT_SECONDS);
      const events = await poll(queue, after, wait * 1000, response, now);
      sendJson(response, 200, { events });
      return;
    }

    switch (route) {
      case "GET /v1/model-settings": {
        mainOnly(agentOf(url.searchParams.get("agent")), "reads the saved model selection");
        sendJson(response, 200, { selection: options.modelSettings.selection() });
        return;
      }
      case "PUT /v1/model-settings": {
        const report = withAgent(await body());
        mainOnly(report.agent, "reports model availability");
        options.modelSettings.report(report);
        sendJson(response, 200, { selection: options.modelSettings.selection() });
        return;
      }
      case "POST /v1/events/ack": {
        const { seqs } = withAgent(await body());
        if (!Array.isArray(seqs) || !seqs.every((seq) => Number.isSafeInteger(seq))) {
          throw new HttpError(400, "seqs must be a list of integers");
        }
        queue.ack(seqs as number[]);
        sendEmpty(response, 204);
        return;
      }
      case "POST /v1/self-events": {
        const request = withAgent(await body());
        const { id, summary, payload } = request;
        if (typeof id !== "string" || id === "") throw new HttpError(400, "id must be a non-empty string");
        if (typeof summary !== "string") throw new HttpError(400, "summary must be a string");
        if (!("payload" in request)) throw new HttpError(400, "payload is required");
        // A sub-agent's events go under its own stream, /sources/self/<name>/.
        const stream = request.agent === "main" ? {} : { stream: request.agent };
        queue.accept({ source: "self", id, ...stream, occurred_at: iso(now()), summary, payload }, { builtin: true });
        sendEmpty(response, 202);
        return;
      }
      case "POST /v1/job-events": {
        // The end of one of her background jobs (ADR-0030): a source of its own, so that its inline setting is its own.
        const request = withAgent(await body());
        mainOnly(request.agent, "has background jobs");
        const { id, summary, payload } = request;
        if (typeof id !== "string" || id === "") throw new HttpError(400, "id must be a non-empty string");
        if (typeof summary !== "string") throw new HttpError(400, "summary must be a string");
        if (!("payload" in request)) throw new HttpError(400, "payload is required");
        queue.accept({ source: "job", id, occurred_at: iso(now()), summary, payload }, { builtin: true });
        keep(() => record.jobEnded(id, payload));
        sendEmpty(response, 202);
        return;
      }
      case "POST /v1/replies": {
        const { agent, text, expression, in_reply_to, images, turn_id } = withAgent(object(await readJson(request, maxReplyBytes)));
        mainOnly(agent, "replies to the owner");
        if (turn_id !== undefined && (typeof turn_id !== "string" || turn_id === "")) throw new HttpError(400, "turn_id must be a non-empty string");
        if (typeof text !== "string") throw new HttpError(400, "text must be a string");
        if (expression !== undefined && typeof expression !== "string") throw new HttpError(400, "expression must be a string");
        if (in_reply_to !== undefined && !Number.isSafeInteger(in_reply_to)) throw new HttpError(400, "in_reply_to must be a seq");
        // Any image that does not pass refuses the whole reply, its text too (ADR-0032).
        let checked;
        try {
          checked = checkImages(images);
        } catch (error) {
          if (error instanceof ImageRefusal) throw new HttpError(400, `not sent: ${error.message}`);
          throw error;
        }
        let turn: string | undefined;
        keep(() => (turn = record.replyTurn(turn_id as string | undefined)));
        let reply;
        try {
          reply = conversation.reply(
            {
              agent,
              text,
              ...(expression === undefined ? {} : { expression: expression as string }),
              ...(in_reply_to === undefined ? {} : { in_reply_to: in_reply_to as number }),
              ...(turn === undefined ? {} : { turn_id: turn }),
            },
            checked,
          );
        } catch (error) {
          if (!(error instanceof AssetStoreError)) throw error;
          log(`replies: ${error.message}`);
          throw new HttpError(500, "not sent: the images could not be kept");
        }
        sendJson(response, 201, reply);
        return;
      }
      case "POST /v1/a2a/replies": {
        const { agent, in_reply_to, state, text, images } = withAgent(object(await readJson(request, A2A_BODY_MAX_BYTES)));
        mainOnly(agent, "answers A2A tasks");
        if (!Number.isSafeInteger(in_reply_to)) throw new HttpError(400, "in_reply_to must be the seq of an a2a event");
        if (state !== "completed" && state !== "input-required") throw new HttpError(400, "state must be completed or input-required");
        if (text !== undefined && typeof text !== "string") throw new HttpError(400, "text must be a string");
        try {
          const checked = checkImages(images, A2A_IMAGES_MAX, A2A_IMAGE_MAX_BYTES);
          sendJson(response, 200, inbox.reply({ in_reply_to: in_reply_to as number, state, ...(text === undefined ? {} : { text }) }, checked));
        } catch (error) {
          if (error instanceof ImageRefusal) throw new HttpError(400, `not sent: ${error.message}`);
          if (error instanceof InboxRefusal) {
            throw new HttpError(error.kind === "no-such-event" ? 404 : error.kind === "closed" ? 409 : 400, error.message);
          }
          if (error instanceof AssetStoreError) {
            log(`a2a replies: ${error.message}`);
            throw new HttpError(500, "not sent: the images could not be kept");
          }
          throw error;
        }
        return;
      }
      case "POST /v1/activity": {
        const { agent, activities } = withAgent(await body());
        if (!Array.isArray(activities)) throw new HttpError(400, "activities must be a list");
        const blocks = activities.map(activity);
        conversation.activities(agent, blocks);
        keep(() => record.activities(agent, blocks));
        sendEmpty(response, 204);
        return;
      }
      case "POST /v1/turns/end": {
        const request = withAgent(await body());
        const end = turnEnd(request);
        const { agent } = request;
        const turn_id = end.turn_id;
        keep(() => record.turnEnded(agent, end));
        conversation.turnEnded(agent);
        try {
          const night = agent === "main" ? end.night : undefined;
          await memory.commit({
            agent, turnId: turn_id,
            ...(night === undefined ? {} : { night,
              onChange: (change) => {
                if (change === undefined) log("memory: nightly change counts not measured");
                else keep(() => record.nightMemoryChanged(end, change));
              },
            }),
          });
        } catch (error) {
          const detail = error instanceof MemoryCommitError ? error.message : "unclassified (affected=unknown)";
          log(`memory: a turn could not be committed: ${detail}`);
          throw new HttpError(500, "/memory could not be committed");
        }
        sendEmpty(response, 204);
        return;
      }
      case "POST /v1/memory/repairs": {
        const { agent, paths, moves, night } = withAgent(await body());
        mainOnly(agent, "commits memory reference repairs");
        if (!Array.isArray(paths) || !paths.length || !paths.every((path) => memoryPath(path) && /\.md$/i.test(path))) {
          throw new HttpError(400, "paths must be a nonempty list of memory-relative Markdown paths");
        }
        if (!Array.isArray(moves) || !moves.length) throw new HttpError(400, "moves must be a nonempty list");
        const mapping = moves.map((value): MemoryMove => {
          const { from, to } = object(value);
          if (!memoryPath(from) || !memoryPath(to) || from === to) {
            throw new HttpError(400, "each move needs distinct memory-relative from and to paths");
          }
          return { from, to };
        });
        let trailers: string[] = [];
        if (night !== undefined) {
          const { seq, turn_id } = object(night);
          if (!positiveInteger(seq) || !turnId(turn_id)) throw new HttpError(400, "night needs the control seq and the curator turn_id");
          trailers = [`Night-stage: reference-repair\nNight: ${seq}\nRepair-turn: ${turn_id}`];
        }
        try {
          await memory.commitPaths([...new Set<string>(paths)], [
            "Runner: repair memory references",
            mapping.map(({ from, to }) => `${JSON.stringify(from)} → ${JSON.stringify(to)}`).join("\n"),
            ...trailers,
          ]);
        } catch {
          log("memory: reference repairs could not be committed");
          throw new HttpError(500, "/memory reference repairs could not be committed");
        }
        sendEmpty(response, 204);
        return;
      }
      case "POST /v1/agents": {
        const { agent, purpose, closed } = withAgent(await body());
        if (agent === "main") throw new HttpError(400, "agent must be a sub-agent's name, not main");
        if (typeof purpose !== "string") throw new HttpError(400, "purpose must be a string");
        if (typeof closed !== "boolean") throw new HttpError(400, "closed must be a boolean");
        agents.record({ agent, purpose, closed });
        sendEmpty(response, 204);
        return;
      }
      case "GET /v1/schedules": {
        const agent = mainOnly(agentOf(url.searchParams.get("agent")), "has schedules");
        sendJson(response, 200, { schedules: schedules.list(agent) });
        return;
      }
      case "POST /v1/schedules": {
        const { agent, reason, cron, at } = withAgent(await body());
        mainOnly(agent, "has schedules");
        if (typeof reason !== "string") throw new HttpError(400, "reason must be a string");
        let when: ScheduleWhen;
        if (typeof cron === "string" && at === undefined) when = { cron };
        else if (typeof at === "string" && cron === undefined) when = { at };
        else throw new HttpError(400, "a schedule has either cron or at, as a string");
        try {
          sendJson(response, 201, schedules.create({ agent, reason, ...when }));
        } catch (error) {
          if (error instanceof ScheduleError) throw new HttpError(400, error.message);
          throw error;
        }
        return;
      }
      case "POST /v1/sessions/rotated": {
        const { agent, seq, stages, memory_reads } = withAgent(await body());
        mainOnly(agent, "has a nightly switch");
        if (seq !== undefined && !positiveInteger(seq)) throw new HttpError(400, "seq must be the seq of the night's control event");
        if (stages !== undefined && seq === undefined) throw new HttpError(400, "stages come with the seq of their night");
        if (memory_reads !== undefined && stages === undefined) throw new HttpError(400, "memory_reads comes with the night's stages");
        const steps = stages === undefined ? undefined : nightStages(stages);
        const reads = memory_reads === undefined ? undefined : readSnapshot(memory_reads);
        const head = steps === undefined ? undefined : await memoryView.head().catch(() => {
          log("memory: final night version could not be read");
          return undefined;
        });
        keep(() => record.nightReported({ ...(seq === undefined ? {} : { seq }), ...(steps === undefined ? {} : { stages: steps }) }));
        try {
          if (seq !== undefined && head !== undefined) memoryView.reports.saveNightHead(seq, head);
          if (seq !== undefined && reads !== undefined) memoryView.reports.saveReads(seq, reads);
        } catch {
          log("memory: nightly snapshot could not be kept");
        }
        void memory.maintain(now()).catch(() => log("memory: repository maintenance failed"));
        log(`session: the nightly switch${seq === undefined ? "" : ` of ${String(seq)}`} was reported${steps === undefined ? "" : ` (${steps.reflection.result}, ${steps.verifier.result}, ${steps.curator.result}, ${steps.session.result})`}`);
        sendEmpty(response, 204);
        return;
      }
    }

    const scheduleId = /^\/v1\/schedules\/([^/]+)$/.exec(url.pathname)?.[1];
    if (scheduleId !== undefined) {
      if (request.method !== "DELETE") throw new HttpError(405, "only DELETE");
      mainOnly(agentOf(url.searchParams.get("agent")), "has schedules");
      if (!schedules.remove(decodeURIComponent(scheduleId))) throw new HttpError(404, "no such schedule");
      sendEmpty(response, 204);
      return;
    }
    const known = ["/v1/events/ack", "/v1/self-events", "/v1/job-events", "/v1/agents", "/v1/replies", "/v1/a2a/replies", "/v1/activity", "/v1/turns/end", "/v1/memory/repairs", "/v1/schedules", "/v1/sessions/rotated"];
    if (known.includes(url.pathname)) throw new HttpError(405, "not this method");
    throw new HttpError(404, "no such path");
  };
}

/**
 * Long-polls the queue: the events due now, or the first ones to come within
 * `waitMs`, or none. It wakes for a new event, for a batch falling due and
 * for an ack falling overdue, and stops when the caller goes away.
 */
async function poll(
  queue: Queue,
  after: number,
  waitMs: number,
  response: http.ServerResponse,
  now: () => number,
): Promise<DeliveredEvent[]> {
  const deadline = now() + waitMs;
  let gone = false;
  response.once("close", () => (gone = true));
  for (;;) {
    if (gone) return [];
    const events = queue.take({ after });
    const left = deadline - now();
    if (events.length > 0 || left <= 0) return events;
    const wake = queue.nextWakeAt();
    // At least a little sleep, so that a wake time already past cannot spin.
    const sleep = wake === undefined ? left : Math.min(left, Math.max(100, wake - now()));
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        stop();
        response.off("close", done);
        resolve();
      };
      const timer = setTimeout(done, sleep);
      const stop = queue.onChange(done);
      response.once("close", done);
    });
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

function authorized(request: http.IncomingMessage, expected: Buffer | undefined): boolean {
  if (expected === undefined) return false;
  const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "");
  return match !== null && timingSafeEqual(digest(match[1]!), expected);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "the body must be a JSON object");
  return value as Record<string, unknown>;
}

/** `main`, or a sub-agent's name of the shape of the contract: it may become a directory under /sources. */
function agentOf(value: unknown): AgentId {
  if (value !== "main" && !isSubAgentName(value)) {
    throw new HttpError(400, "agent must be main or a sub-agent's name: lower-case letters, digits and '-', up to 63");
  }
  return value;
}

/** Sub-agents talk only to the main agent: what it alone does is refused to them (ADR-0022). */
function mainOnly(agent: AgentId, what: string): AgentId {
  if (agent !== "main") throw new HttpError(400, `only main ${what}, not the sub-agent ${agent}`);
  return agent;
}

function withAgent(body: Record<string, unknown>): Record<string, unknown> & { agent: AgentId } {
  return { ...body, agent: agentOf(body.agent) };
}

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, `${name} must be a whole number`);
  return Number(value);
}

/** One block of a turn, checked to be one of the kinds of the contract. */
function activity(value: unknown): Activity {
  const block = object(value);
  const { kind, at, turn_id } = block;
  const bad = (why: string) => new HttpError(400, `an activity ${why}`);
  if (!isTime(at)) throw bad("needs at as an RFC 3339 time");
  if (typeof turn_id !== "string" || turn_id === "") throw bad("needs a turn_id");
  const text = (field: string) => {
    if (typeof block[field] !== "string") throw bad(`of kind ${String(kind)} needs ${field} as a string`);
    return block[field];
  };
  const base = { at, turn_id };
  switch (kind) {
    case "turn_start":
    case "turn_end":
      return { ...base, kind };
    case "thinking":
    case "message":
      return { ...base, kind, text: text("text") };
    case "tool_call":
      if (!("arguments" in block)) throw bad("of kind tool_call needs arguments");
      return { ...base, kind, call_id: text("call_id"), name: text("name"), arguments: block.arguments };
    case "tool_result":
      if (typeof block.is_error !== "boolean") throw bad("of kind tool_result needs is_error as a boolean");
      return { ...base, kind, call_id: text("call_id"), is_error: block.is_error, output: text("output") };
    default:
      throw bad("kind must be turn_start, thinking, tool_call, tool_result, message or turn_end");
  }
}

function turnId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.trim() === value && !/[\0\r\n]/.test(value);
}

/** The end of a turn: its id, and what the runner said of it for the record (ADR-0038). */
function turnEnd(body: Record<string, unknown>): TurnEnd {
  const { turn_id, result, reason, seqs, night } = body;
  if (!turnId(turn_id)) throw new HttpError(400, "turn_id must be a nonempty single-line identifier");
  if (result !== undefined && result !== "done" && result !== "failed" && result !== "stopped") throw new HttpError(400, "result must be done, failed or stopped");
  if (reason !== undefined && typeof reason !== "string") throw new HttpError(400, "reason must be a string");
  if (seqs !== undefined && (!Array.isArray(seqs) || !seqs.every((seq) => Number.isSafeInteger(seq)))) throw new HttpError(400, "seqs must be a list of integers");
  let step: TurnEnd["night"];
  if (night !== undefined) {
    const { seq, stage } = object(night);
    if (!positiveInteger(seq)) throw new HttpError(400, "night needs the seq of its control event");
    if (stage !== "reflection" && stage !== "verifier" && stage !== "curator") throw new HttpError(400, "night's stage must be reflection, verifier or curator");
    step = { seq, stage };
  }
  return {
    turn_id,
    ...(result === undefined ? {} : { result }),
    ...(reason === undefined ? {} : { reason }),
    ...(seqs === undefined ? {} : { seqs: seqs as number[] }),
    ...(step === undefined ? {} : { night: step }),
  };
}

/** The steps of a night; older runners do not have a verifier. */
function nightStages(value: unknown): NightStages {
  const stages = object(value);
  const stage = (value: unknown, name: string): NightTurnReport => {
    const { result, reason, turn_id } = object(value);
    if (result !== "done" && result !== "failed" && result !== "skipped") throw new HttpError(400, `stages.${name}.result must be done, failed or skipped`);
    if (reason !== undefined && typeof reason !== "string") throw new HttpError(400, `stages.${name}.reason must be a string`);
    if (name !== "session" && turn_id !== undefined && (typeof turn_id !== "string" || turn_id === "")) {
      throw new HttpError(400, `stages.${name}.turn_id must be a non-empty string`);
    }
    return { result, ...(reason === undefined ? {} : { reason }), ...(name !== "session" && typeof turn_id === "string" ? { turn_id } : {}) };
  };
  const verifier = stages.verifier === undefined ? {} : object(stages.verifier);
  const curator = object(stages.curator);
  const { dropped_records } = verifier;
  if (dropped_records !== undefined && !positiveInteger(dropped_records)) {
    throw new HttpError(400, "stages.verifier.dropped_records must be a positive integer");
  }
  const over = curator.always_read_over_target === undefined ? undefined : object(curator.always_read_over_target);
  const review = curator.review === undefined ? undefined : object(curator.review);
  let always_read_over_target: NightStages["curator"]["always_read_over_target"];
  if (over !== undefined) {
    const { total_bytes, target_bytes } = over;
    if (!positiveInteger(total_bytes) || !positiveInteger(target_bytes) || total_bytes <= target_bytes) {
      throw new HttpError(400, "stages.curator.always_read_over_target needs integer bytes above a positive target");
    }
    always_read_over_target = { total_bytes, target_bytes };
  }
  return {
    reflection: stage(stages.reflection, "reflection"),
    verifier: stages.verifier === undefined ? { result: "skipped" } : {
      ...stage(verifier, "verifier"),
      ...(dropped_records === undefined ? {} : { dropped_records }),
    },
    curator: {
      ...stage(curator, "curator"),
      ...(always_read_over_target === undefined ? {} : { always_read_over_target }),
      ...(review === undefined ? {} : { review: {
        content: stage(review.content, "curator.review.content"),
        structure: stage(review.structure, "curator.review.structure"),
      } }),
    },
    session: stage(stages.session, "session"),
  };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
