// The backend's API for the Web UI (docs/ui-api.md) and the owner's login
// (ADR-0010). It listens on TCP, reached from outside the Pod; a request from
// the sandbox over the loopback is checked the same way (ADR-0014).
import type http from "node:http";

import path from "node:path";

import { ICON_TYPES } from "@penelope/avatar";
import type { AgentResponse, AgentStatus, RecordKind, RecordResultResponse, RecordUnseenResponse, SchedulesResponse, SubAgent, SubAgentsResponse } from "@penelope/contract";

import { isA2APath } from "./a2a/endpoint.ts";
import { type AgentSettings, faceBytes } from "./avatar.ts";
import { type Handler, HttpError, readJson, sendEmpty, sendError, sendJson } from "./http.ts";
import { CALLBACK_PATH, type GitHubLogin } from "./login/github.ts";
import type { LoginSessions } from "./login/sessions.ts";
import { MEMORY_PATH, memoryRoute } from "./memory-api.ts";
import type { MemoryView } from "./memory-view.ts";
import type { Memory } from "./memory.ts";
import type { ModelSettings } from "./model-settings.ts";
import { type ActivityRecord, RecordQueryError } from "./record.ts";
import type { Schedules } from "./schedules.ts";
import { AGENT_ICONS_PATH } from "./web.ts";

export const SESSION_COOKIE = "penelope_session";
export const RECORD_PATH = "/api/record";

export type UiOptions = {
  /** The activity record (ADR-0038). */
  record: ActivityRecord;
  memory: Memory;
  memoryView: MemoryView;
  login: GitHubLogin;
  sessions: LoginSessions;
  modelSettings: ModelSettings;
  schedules: Schedules;
  readStatus: () => AgentStatus;
  listAgents: () => SubAgent[];
  /** The owner's GitHub user ID. Without one, no one gets in. */
  ownerId: number | undefined;
  /** Where the owner reaches the backend. Cookies are Secure when it is https. */
  publicUrl: string | undefined;
  /** The agent's name and her avatar's faces as they are now, read without a login. */
  agent: () => AgentSettings;
  now: () => number;
  /** The Web UI's files, served for everything else. Until it is built, nothing is. */
  web?: Handler;
  /** The A2A routes, including root discovery. Without this handler, those routes return 404. */
  a2a?: Handler;
};

export function uiHandler(options: UiOptions): Handler {
  const { record, memory, memoryView, login, sessions, ownerId, now } = options;
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
    if (url.pathname.startsWith("/auth/")) throw new HttpError(404, "no such path");
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

    if (ownerId === undefined || request.headers.authorization !== undefined) throw new HttpError(401, "not signed in");
    const token = cookieValue(request);
    const session = token === undefined ? undefined : sessions.use(token, ownerId);
    if (!session) throw new HttpError(401, "not signed in");
    response.setHeader("set-cookie", cookie(session.token, session.expiresMs));

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
      case "GET /api/status":
        sendJson(response, 200, options.readStatus(), { "cache-control": "no-store" });
        return;
      case "GET /api/agents":
        sendJson(response, 200, { agents: options.listAgents() } satisfies SubAgentsResponse, { "cache-control": "no-store" });
        return;
      case "GET /api/schedules":
        sendJson(response, 200, { schedules: options.schedules.entries("main") } satisfies SchedulesResponse, { "cache-control": "no-store" });
        return;
      case "GET /api/settings":
        sendJson(response, 200, options.modelSettings.read(), { "cache-control": "no-store" });
        return;
      case "PUT /api/settings":
        sendJson(response, 200, options.modelSettings.save(await readJson(request, 16 * 1024)), { "cache-control": "no-store" });
        return;
    }
    const scheduleId = /^\/api\/schedules\/([^/]+)$/.exec(url.pathname)?.[1];
    if (request.method === "DELETE" && scheduleId !== undefined) {
      let id: string;
      try {
        id = decodeURIComponent(scheduleId);
      } catch {
        throw new HttpError(404, "no such schedule");
      }
      if (!options.schedules.remove(id)) throw new HttpError(404, "no such schedule");
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
