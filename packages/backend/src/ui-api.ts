// The backend's API for the Web UI (docs/ui-api.md) and the owner's login
// (ADR-0010). It listens on TCP, reached from outside the Pod; a request from
// the sandbox over the loopback is checked the same way (ADR-0014).
import { randomUUID } from "node:crypto";
import type http from "node:http";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { ICON_TYPES } from "@penelope/avatar";
import type { AgentResponse, PostMessageResponse, PushResponse, RecordKind, RecordResultResponse, RecordUnseenResponse, SchedulesResponse, SubAgentsResponse } from "@penelope/contract";

import { isA2APath } from "./a2a/endpoint.ts";
import type { SubAgents } from "./agents.ts";
import { AssetStoreError, type Assets } from "./assets.ts";
import { type AgentSettings, faceBytes } from "./avatar.ts";
import type { Conversation } from "./conversation.ts";
import type { Feed } from "./feed.ts";
import { type Handler, HttpError, isMultipart, readForm, readJson, sendEmpty, sendError, sendJson } from "./http.ts";
import { CALLBACK_PATH, type GitHubLogin } from "./login/github.ts";
import type { LoginSessions, Session } from "./login/sessions.ts";
import { MEMORY_PATH, memoryRoute } from "./memory-api.ts";
import type { MemoryView } from "./memory-view.ts";
import type { Memory } from "./memory.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PushSubscriptions } from "./push/notifier.ts";
import { webPushSubscriptionOf } from "./push/web-push.ts";
import type { Queue } from "./queue.ts";
import { type ActivityRecord, RecordQueryError } from "./record.ts";
import type { Schedules } from "./schedules.ts";
import type { Attachment } from "./sources.ts";
import { iso } from "./time.ts";
import { AGENT_ICONS_PATH } from "./web.ts";

export const SESSION_COOKIE = "penelope_session";
/** Where the copies the backend keeps of what the agents made are read, by id (ADR-0032). */
export const ASSETS_PATH = "/api/assets/";
/** Where the activity record is read (ADR-0038). */
export const RECORD_PATH = "/api/record";
/** A message with its files: 64 MiB in all by default. */
export const DEFAULT_UI_BYTES = 64 * 1024 * 1024;
const HEARTBEAT_MS = 25_000;
const SUMMARY_LENGTH = 200;
/** A subscription is a URL and two keys. */
const PUSH_BYTES = 16 * 1024;

export type UiOptions = {
  queue: Queue;
  conversation: Conversation;
  /** The copies of the replies' images. */
  assets: Assets;
  /** The sub-agents that are not closed, for `GET /api/agents`. */
  agents: SubAgents;
  /** Her schedules, listed and removed as her own tools do (docs/sandbox-api.md). */
  schedules: Schedules;
  /** The activity record (ADR-0038). */
  record: ActivityRecord;
  memory: Memory;
  memoryView: MemoryView;
  feed: Feed;
  login: GitHubLogin;
  sessions: LoginSessions;
  modelSettings: ModelSettings;
  /** The owner's GitHub user ID. Without one, no one gets in. */
  ownerId: number | undefined;
  /** Where the owner reaches the backend. Cookies are Secure when it is https. */
  publicUrl: string | undefined;
  /** The agent's name and her avatar's faces as they are now, read without a login. */
  agent: () => AgentSettings;
  now: () => number;
  maxBytes?: number;
  /** The Web UI's files, served for everything else. Until it is built, nothing is. */
  web?: Handler;
  /** The A2A routes, including root discovery. Without this handler, those routes return 404. */
  a2a?: Handler;
  /** Web Push: the VAPID public key the browsers subscribe with, and where their subscriptions are kept. Without it, there is none. */
  push?: { publicKey: string; subscriptions: PushSubscriptions };
};

export function uiHandler(options: UiOptions): Handler {
  const { queue, conversation, assets, agents, schedules, record, memory, memoryView, feed, login, sessions, ownerId, now } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_UI_BYTES;
  const secure = options.publicUrl?.startsWith("https:") ?? false;
  const web = options.web ?? notBuilt;
  const cookie = (value: string, expiresMs: number) => sessionCookie(value, expiresMs, now(), secure);

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://ui");
    const route = `${request.method} ${url.pathname}`;

    if (route === "GET /healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (route === "GET /auth/github/start") {
      const start = login.start();
      if (start.kind === "refused") sendError(response, start.status, start.code);
      else sendEmpty(response, 302, { location: start.location, "cache-control": "no-store" });
      return;
    }
    if (route === `GET ${CALLBACK_PATH}`) {
      const finish = await login.callback(url.searchParams);
      if (finish.kind === "refused") sendError(response, finish.status, finish.code);
      else {
        sendEmpty(response, 302, {
          location: "/",
          "set-cookie": cookie(finish.session.token, finish.session.expiresMs),
          "cache-control": "no-store",
        });
      }
      return;
    }
    if (route === "POST /auth/logout") {
      const token = cookieValue(request);
      if (token !== undefined) sessions.revoke(token);
      sendEmpty(response, 204, { "set-cookie": cookie("", 0) });
      return;
    }

    if (isA2APath(url.pathname)) {
      if (options.a2a === undefined) throw new HttpError(404, "no A2A way in here");
      await options.a2a(request, response);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await web(request, response);
      return;
    }

    // Read without a login: the login screen and the home screen show who
    // she is. Nothing else is here (docs/ui-api.md).
    if (route === "GET /api/agent") {
      const agent = options.agent();
      const ways = (images: Readonly<Record<string, string>>) =>
        Object.fromEntries(Object.entries(images).map(([expression, file]) => [expression, `${AGENT_ICONS_PATH}${encodeURIComponent(expression)}${path.extname(file).toLowerCase()}`]));
      const icons = ways(agent.icons);
      const pngIcons = ways(agent.pngIcons ?? {});
      sendJson(response, 200, {
        name: agent.name,
        ...(Object.keys(icons).length === 0 ? {} : { icons }),
        ...(Object.keys(pngIcons).length === 0 ? {} : { png_icons: pngIcons }),
      } satisfies AgentResponse);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith(AGENT_ICONS_PATH)) {
      let expression = "";
      try {
        expression = decodeURIComponent(url.pathname.slice(AGENT_ICONS_PATH.length));
      } catch {
        // Not a name of any face: answered as one that is not there.
      }
      const agent = options.agent();
      const file = faceFile(agent, expression);
      if (file === undefined) throw new HttpError(404, "no such face");
      let body: Buffer;
      try {
        body = faceBytes(agent, file);
      } catch {
        throw new HttpError(404, "the face cannot be read");
      }
      response.writeHead(200, {
        "content-type": ICON_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": body.length,
        "cache-control": "no-cache",
      });
      response.end(body);
      return;
    }

    const token = cookieValue(request);
    const session: Session | undefined = token === undefined ? undefined : sessions.use(token, ownerId);
    if (!session) throw new HttpError(401, "not signed in");
    // Each use moves the session's end on; the cookie follows it.
    response.setHeader("set-cookie", cookie(session.token, session.expiresMs));

    if (url.pathname.startsWith(ASSETS_PATH)) {
      await sendAsset(assets, url.pathname.slice(ASSETS_PATH.length), request, response);
      return;
    }
    if (url.pathname === MEMORY_PATH || url.pathname.startsWith(`${MEMORY_PATH}/`)) {
      try {
        await memoryRoute(memoryView, memory, url, request, response);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        // The ordinary error handler logs the URL, which can contain private search text.
        throw new HttpError(500, request.method === "POST" ? "memory could not be saved" : "committed memory could not be read");
      }
      return;
    }
    if (url.pathname === RECORD_PATH || url.pathname.startsWith(`${RECORD_PATH}/`)) {
      try {
        await recordRoute(record, memoryView, request, response, url);
      } catch (error) {
        if (error instanceof RecordQueryError) throw new HttpError(error.status, error.message);
        throw error;
      }
      return;
    }

    switch (route) {
      case "POST /api/messages": {
        const { text, attachments } = isMultipart(request)
          ? await messageFromForm(await readForm(request, maxBytes))
          : messageFromJson(await readJson(request, maxBytes));
        if (text === "" && attachments.length === 0) throw new HttpError(400, "a message needs text or files");
        const id = randomUUID();
        // The event and its line of the history are kept together, with the
        // copies of its images, or none of them (ADR-0034).
        let files;
        try {
          files = conversation.ownerMessage({ id, text, files: attachments }, () =>
            queue.accept(
              {
                source: "ui", id, occurred_at: iso(now()), summary: summaryOf(text, attachments.length),
                answer_via: { tool: "reply" }, payload: { text },
              },
              { builtin: true, attachments },
            ),
          );
        } catch (error) {
          if (!(error instanceof AssetStoreError)) throw error;
          throw new HttpError(500, "not sent: the images could not be kept");
        }
        sendJson(response, 202, { id, ...files } satisfies PostMessageResponse);
        return;
      }
      case "GET /api/history": {
        const before = url.searchParams.get("before") ?? undefined;
        let page;
        try {
          page = conversation.page(before);
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
        sendJson(response, 200, page);
        return;
      }
      case "GET /api/agents":
        sendJson(response, 200, { agents: agents.list() } satisfies SubAgentsResponse);
        return;
      case "GET /api/stream":
        stream(feed, request, response);
        return;
      // Only the main agent has schedules. The UI adds none.
      case "GET /api/schedules":
        sendJson(response, 200, { schedules: schedules.entries("main") } satisfies SchedulesResponse);
        return;
      case "GET /api/settings":
        sendJson(response, 200, options.modelSettings.read(), { "cache-control": "no-store" });
        return;
      case "PUT /api/settings":
        sendJson(response, 200, options.modelSettings.save(await readJson(request, 16 * 1024)), { "cache-control": "no-store" });
        return;
      case "GET /api/push":
        sendJson(response, 200, (options.push === undefined ? {} : { web_push: { public_key: options.push.publicKey } }) satisfies PushResponse);
        return;
      case "POST /api/push/subscriptions": {
        if (options.push === undefined) throw new HttpError(503, "web-push-not-configured");
        const subscription = webPushSubscriptionOf(await readJson(request, PUSH_BYTES));
        if (subscription === undefined) throw new HttpError(400, "not a Web Push subscription with an https endpoint and its keys");
        options.push.subscriptions.save({ kind: "web-push", ...subscription });
        sendEmpty(response, 204);
        return;
      }
      case "POST /api/push/subscriptions/delete": {
        const endpoint = ((await readJson(request, PUSH_BYTES)) as { endpoint?: unknown } | null)?.endpoint;
        if (typeof endpoint !== "string") throw new HttpError(400, "endpoint must be a string");
        options.push?.subscriptions.remove(endpoint);
        sendEmpty(response, 204);
        return;
      }
    }
    // Removed as her schedule_remove removes it; she is not told, and finds out with schedule_list.
    const scheduleId = /^\/api\/schedules\/([^/]+)$/.exec(url.pathname)?.[1];
    if (request.method === "DELETE" && scheduleId !== undefined) {
      let id: string;
      try {
        id = decodeURIComponent(scheduleId);
      } catch {
        throw new HttpError(404, "no such schedule");
      }
      if (!schedules.remove(id)) throw new HttpError(404, "no such schedule");
      sendEmpty(response, 204);
      return;
    }
    throw new HttpError(404, "no such path");
  };
}

/** The activity record (docs/ui-api.md "活動の記録"): read only, but for the time the owner opened it. */
async function recordRoute(record: ActivityRecord, memory: MemoryView, request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {
  const rest = url.pathname.slice(RECORD_PATH.length);
  const query = url.searchParams;
  if (rest === "/seen") {
    if (request.method !== "POST") throw new HttpError(405, "only POST");
    sendJson(response, 200, record.seen());
    return;
  }
  if (request.method !== "GET") throw new HttpError(405, "only GET");
  if (rest === "") {
    const kind = query.get("kind") ?? undefined;
    if (kind !== undefined && !RECORD_KINDS.includes(kind)) throw new HttpError(400, "kind must be turn, night, job or sub_agent");
    const failed = query.get("failed") ?? undefined;
    if (failed !== undefined && failed !== "0" && failed !== "1") throw new HttpError(400, "failed must be 0 or 1");
    const day = query.get("day") ?? undefined;
    const timeZone = query.get("tz") ?? undefined;
    const agent = query.get("agent") ?? undefined;
    sendJson(
      response,
      200,
      record.day({
        ...(day === undefined ? {} : { day }),
        ...(timeZone === undefined ? {} : { timeZone }),
        ...(agent === undefined ? {} : { agent }),
        ...(kind === undefined ? {} : { kind: kind as RecordKind }),
        failed: failed === "1",
      }),
    );
    return;
  }
  if (rest === "/unseen") {
    sendJson(response, 200, { unseen: record.unseen() } satisfies RecordUnseenResponse);
    return;
  }
  const parts = rest.slice(1).split("/").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new HttpError(404, "no such path");
    }
  });
  const [kind, id, results, callId] = parts;
  if (kind === "turns" && id && parts.length === 2) {
    const detail = record.turn(id);
    const change = await memory.turnChange(id).catch(() => undefined);
    sendJson(response, 200, { ...detail, ...(change ? { memory_change: change } : {}) });
  } else if (kind === "turns" && id && results === "results" && callId && parts.length === 4) {
    sendJson(response, 200, { output: record.result(id, callId) } satisfies RecordResultResponse);
  } else if (kind === "nights" && id && parts.length === 2) {
    const detail = record.night(id);
    const changes = await memory.nightChanges(detail.night.id).catch(() => []);
    sendJson(response, 200, { ...detail, ...(changes.length ? { memory_changes: changes } : {}) });
  } else if (kind === "sub-agents" && id && parts.length === 2) sendJson(response, 200, record.subAgent(id, query.get("before") ?? undefined));
  else throw new HttpError(404, "no such path");
}

const RECORD_KINDS: readonly string[] = ["turn", "night", "job", "sub_agent"] satisfies RecordKind[];

/**
 * The bytes of one copy, as its type. A copy never changes, so the browser
 * may keep it as long as it likes; it is the owner's, so only her browser.
 */
async function sendAsset(assets: Assets, rest: string, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  let id = "";
  try {
    id = decodeURIComponent(rest);
  } catch {
    // Not an id of any copy: answered as one that is not there.
  }
  const found = id === "" || id.includes("/") ? undefined : assets.get(id);
  if (found === undefined) throw new HttpError(404, "no such asset");
  if (request.method !== "GET") throw new HttpError(405, "only GET");
  let body: Buffer;
  try {
    body = await readFile(found.file);
  } catch {
    throw new HttpError(404, "the asset cannot be read");
  }
  response.writeHead(200, {
    "content-type": found.mime_type,
    "content-length": body.length,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

/** Server-sent events until the browser goes away, a comment now and then to keep the line open. */
function stream(feed: Feed, request: http.IncomingMessage, response: http.ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": stream\n\n");
  const lastEventId = request.headers["last-event-id"];
  const stop = feed.subscribe(typeof lastEventId === "string" ? lastEventId : undefined, (id, event) => {
    response.write(`id: ${id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  });
  const heartbeat = setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS);
  response.once("close", () => {
    clearInterval(heartbeat);
    stop();
  });
}

function messageFromJson(body: unknown): { text: string; attachments: Attachment[] } {
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw new HttpError(400, "text must be a string");
  return { text, attachments: [] };
}

async function messageFromForm(form: FormData): Promise<{ text: string; attachments: Attachment[] }> {
  const text = form.get("text") ?? "";
  if (typeof text !== "string") throw new HttpError(400, "text must be a field, not a file");
  const attachments: Attachment[] = [];
  for (const file of form.getAll("file")) {
    if (typeof file === "string") throw new HttpError(400, "a file part must be a file");
    attachments.push({ name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) });
  }
  return { text, attachments };
}

/** The first line of the text, cut short; or how many files came when there is no text. */
function summaryOf(text: string, files: number): string {
  const first = text.split("\n", 1)[0]!.trim();
  if (first !== "") return first.length > SUMMARY_LENGTH ? `${first.slice(0, SUMMARY_LENGTH)}…` : first;
  return files === 1 ? "1 file" : `${files} files`;
}

function cookieValue(request: http.IncomingMessage): string | undefined {
  const values = (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`))
    .map((part) => part.slice(SESSION_COOKIE.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

/** The Set-Cookie line of the session: ends at `expiresMs`, or is cleared when that is 0. */
function sessionCookie(value: string, expiresMs: number, now: number, secure: boolean): string {
  const maxAge = expiresMs === 0 ? 0 : Math.max(0, Math.round((expiresMs - now) / 1000));
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    `Expires=${new Date(expiresMs).toUTCString()}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
  ].join("; ");
}

/** Where the Web UI's files will be served from (P6b). */
const notBuilt: Handler = async (_request, response) => {
  sendError(response, 404, "the Web UI is not built yet");
};

/**
 * The image of a face, named as it is or with the extension of its image
 * after it, and its PNG with .png after it (docs/ui-api.md): Slack wants an
 * icon's URL to end in one.
 */
function faceFile(agent: AgentSettings, name: string): string | undefined {
  const { icons } = agent;
  if (Object.hasOwn(icons, name)) return icons[name];
  const extension = path.extname(name);
  const face = name.slice(0, name.length - extension.length);
  if (extension === ".png" && agent.pngIcons !== undefined && Object.hasOwn(agent.pngIcons, face)) return agent.pngIcons[face];
  if (extension === "" || !Object.hasOwn(icons, face)) return undefined;
  const file = icons[face]!;
  return path.extname(file).toLowerCase() === extension ? file : undefined;
}
