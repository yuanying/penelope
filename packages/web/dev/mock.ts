// Serves the personal-page API from fixtures selected by a browser cookie.
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

import { modelRef } from "@penelope/contract";
import type {
  MemoryChangesResponse,
  MemoryCompareResponse,
  MemoryFileResponse,
  MemoryHistoryResponse,
  MemoryOverviewResponse,
  MemorySaveRequest,
  MemorySearchResponse,
  ModelSelection,
  SettingsResponse,
  RecordDayResponse,
  RecordFlowItem,
  RecordNightResponse,
  RecordRow,
  RecordSeenResponse,
  RecordSubAgent,
  RecordSubAgentResponse,
  RecordTurn,
  RecordTurnResponse,
} from "@penelope/contract";

import { diffMemoryText } from "../src/model/memory-diff.ts";
import { memoryDiff, memoryEditLimit, type MemoryScene, memoryTextAt, mockAgentMemoryChange, saveMockMemory } from "./memory.ts";
import { AVATAR_DIR, AVATAR_ICONS, type Scene, scenes } from "./scenes.ts";

const COOKIE = "penelope-dev-scene";
type World = Scene & {
  settings: SettingsResponse;

};

const worlds = new Map<string, World>();

function world(name: string): World {
  let found = worlds.get(name);
  if (found === undefined) {
    const now = Date.now();
    const scene = scenes[name]!.make(now);
    found = {
      ...scene,
      settings: {
        selection: null,
        default: { model: "example/iris-large", thinking: "medium" },
        models: [
          { provider: "example", id: "iris-large", name: "Iris Large", context_window: 256000, thinking_levels: ["off", "low", "medium", "high"] },
          { provider: "example", id: "preview/iris-flash", name: "Iris Flash", context_window: 128000, thinking_levels: ["off", "high"] },
        ],
      },
    };
    worlds.set(name, found);
  }
  return found;
}

function sceneOf(request: IncomingMessage): string {
  const cookie = /(?:^|;\s*)penelope-dev-scene=([^;]+)/.exec(request.headers.cookie ?? "")?.[1];
  return cookie !== undefined && cookie in scenes ? cookie : "default";
}

/**
 * For a request of the page: the header that keeps the scene asked for with
 * ?scene=, which is made again from the start. None when none was asked for.
 */
export function pageScene(url: URL): Record<string, string> {
  const name = url.searchParams.get("scene");
  if (name === null) return {};
  if (!(name in scenes)) {
    console.warn(`no scene "${name}"; the scenes are ${Object.keys(scenes).join(", ")}`);
    return {};
  }
  worlds.delete(name);
  return { "set-cookie": `${COOKIE}=${name}; Path=/; SameSite=Lax` };
}

/** Answers what the backend answers outside the UI's files; false for anything else. */
export async function handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/") && !path.startsWith("/auth/") && path !== "/manifest.webmanifest") return false;
  const method = request.method ?? "GET";
  const w = world(sceneOf(request));
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const empty = (status = 204) => {
    response.writeHead(status);
    response.end();
  };

  if (path === "/manifest.webmanifest") {
    response.writeHead(200, { "content-type": "application/manifest+json" });
    response.end(JSON.stringify({ name: w.agent.name, short_name: w.agent.name, start_url: "/", scope: "/", display: "standalone", icons: [{ src: "/icon.svg", type: "image/svg+xml", sizes: "any" }] }));
    return true;
  }
  // There is no login: signing out only shows the login screen, and its button comes back signed in.
  if (method === "POST" && path === "/auth/logout") return (empty(), true);
  if (path === "/auth/github/start") {
    response.writeHead(302, { location: "/" });
    response.end();
    return true;
  }
  if (method === "GET" && path === "/api/agent") return (json(200, w.agent), true);
  const face = /^\/api\/agent\/icons\/([a-z]+)(?:\.svg)?$/.exec(path)?.[1];
  if (method === "GET" && face !== undefined && w.agent.icons?.[face] !== undefined) {
    // The avatar's own picture of the face when it has one; a drawn face otherwise.
    const file = AVATAR_ICONS[face] === undefined ? undefined : join(AVATAR_DIR, AVATAR_ICONS[face]);
    if (file !== undefined && file.startsWith(AVATAR_DIR) && existsSync(file)) {
      response.writeHead(200, { "content-type": ICON_TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(readFileSync(file));
      return true;
    }
    response.writeHead(200, { "content-type": "image/svg+xml" });
    response.end(faceOf(face));
    return true;
  }
  if (method === "GET" && path === "/api/status") return (json(200, w.status ?? { sleep: { state: "awake" }, sleepiness: 0, awake_seconds: 0, mood: null }), true);
  if (method === "GET" && path === "/api/agents") return (json(200, { agents: w.agents ?? [] }), true);
  if (method === "GET" && path === "/api/schedules") return (json(200, { schedules: w.schedules ?? [] }), true);
  if (method === "DELETE" && path.startsWith("/api/schedules/")) {
    const i = w.schedules?.findIndex((schedule) => schedule.id === path.slice("/api/schedules/".length)) ?? -1;
    if (i < 0) return (json(404, { error: "no such schedule" }), true);
    w.schedules!.splice(i, 1);
    return (empty(), true);
  }
  if (method === "GET" && path === "/api/settings") return (json(200, w.settings), true);
  if (method === "PUT" && path === "/api/settings") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const selection = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelSelection;
    const model = w.settings.models.find((m) => modelRef(m) === selection.model);
    if (!model?.thinking_levels.includes(selection.thinking)) return (json(400, { error: "unavailable model or thinking level" }), true);
    w.settings.selection = selection;
    return (json(200, w.settings), true);
  }
  if (method === "POST" && path === "/api/dev/memory/change" && w.memory && mockAgentMemoryChange(w.memory, url.searchParams.has("remove"))) return (empty(), true);
  if (method === "POST" && path === "/api/dev/memory/finish" && w.memory?.editing?.worktreeBusy) {
    w.memory.editing.worktreeBusy = false;
    return (empty(), true);
  }
  if (path === "/api/memory" || path.startsWith("/api/memory/")) {
    response.setHeader("cache-control", "no-store");
    if (method === "POST" && path === "/api/memory/save") {
      if (!request.headers["content-type"]?.startsWith("application/json")) return (json(415, { error: "expected JSON" }), true);
      const body = await readMemorySave(request);
      if (!body) return (json(400, { error: "invalid save request" }), true);
      const answer = saveMockMemory(w.memory, body);
      return (json(answer.status, answer.body), true);
    }
    if (method !== "GET") return (json(405, { error: "method not allowed" }), true);
    if (path === "/api/memory/image" && url.searchParams.get("path") === "avatar/sample.png" && w.memory?.overview.files.some((f) => f.path === "avatar/sample.png")) {
      response.writeHead(200, { "content-type": "image/png", "x-content-type-options": "nosniff", "cache-control": "no-store" });
      response.end(SAMPLE_IMAGE);
      return true;
    }
    const answer = memory(w.memory, url);
    return (answer === undefined ? json(404, { error: "not found" }) : json(200, answer), true);
  }
  if (path.startsWith("/api/record")) {
    const answer = record(w, method, url);
    if (answer !== undefined) return (json(200, answer), true);
  }
  console.warn(`the mock does not answer ${method} ${path}${url.search}`);
  json(404, { error: "not in the mock" });
  return true;
}

/** Newest first. A page's cursor is the id of the line it starts with, as the record's history_before is. */
const SAMPLE_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxQ0YAAAAABJRU5ErkJggg==", "base64");
const EMPTY_MEMORY: MemoryOverviewResponse = { head: null, can_edit: false, files: [], broken_links: [], links_incomplete: false, last_night: null, always_read: { bytes: 0, target_bytes: 16384, file_limit_bytes: 65536, over_target_nights: [] } };
const MEMORY_PAGE = 50;

async function readMemorySave(request: IncomingMessage): Promise<MemorySaveRequest | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= 6 * 1024 * 1024 + 32768) chunks.push(chunk);
  }
  if (size > 6 * 1024 * 1024 + 32768) return;
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<MemorySaveRequest> | null;
    if (typeof body?.path === "string" && typeof body.base_head === "string" && typeof body.text === "string" && !body.text.includes("\0")) {
      return { path: body.path, base_head: body.base_head, text: body.text };
    }
  } catch { /* Not JSON. */ }
}

function memory(scene: MemoryScene | undefined, url: URL): unknown {
  const parts = url.pathname.split("/").slice(3);
  const { searchParams: q } = url;
  const overview = scene?.overview ?? EMPTY_MEMORY;
  const head = q.get("head") ?? overview.head;
  const path = q.get("path") ?? "";
  const allChanges = (scene?.changes ?? []).map((entry) => entry.change);
  const at = head === overview.head ? 0 : scene?.editing ? allChanges.findIndex((c) => c.id === head) : -1;
  if (at < 0) return;
  const changes = allChanges.slice(at);
  const versions = changes.filter((c) => c.paths.includes(path));
  const before = q.get("before");
  const page = <T extends { id: string },>(items: T[]) => {
    const start = before === null ? 0 : items.findIndex((item) => item.id === before) + 1;
    const data = items.slice(start, start + MEMORY_PAGE);
    return { data, ...(start + MEMORY_PAGE < items.length ? { next: data.at(-1)!.id } : {}) };
  };
  if (!parts.length) return overview;
  if (parts[0] === "file") {
    const file = overview.files.find((f) => f.path === path);
    if (!head || !file || !scene) return;
    const image = path.startsWith("avatar/");
    const text = scene.editing ? memoryTextAt(scene, path, head) : scene.text[path];
    if (!image && text === undefined) return;
    const moved = overview.last_night?.changes.flatMap((c) => c.moves).find((move) => move.to === path);
    return {
      head, file: text === undefined ? file : { ...file, bytes: Buffer.byteLength(text) },
      edit: overview.can_edit && !image ? { max_bytes: memoryEditLimit(scene, file) } : null,
      history_count: versions.length, broken_links: overview.broken_links.filter((link) => link.path === path), ...(moved ? { moved_from: moved.from } : {}),
      ...(image ? { kind: "image", image_url: `/api/memory/image?${new URLSearchParams({ path, head })}` } : { kind: "markdown", text: text! }),
    } satisfies MemoryFileResponse;
  }
  if (parts[0] === "changes" && parts.length === 1) {
    const writer = q.get("writer") ?? "all";
    const matches = changes.filter((c) => writer === "all" || c.writer.kind === writer || (writer === "night" && c.writer.kind === "system" && c.writer.operation === "reference_repair"));
    const { data, ...cursor } = page(matches);
    const iso = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", ...(q.has("tz") ? { timeZone: q.get("tz")! } : {}) });
    const dayOf = (c: { at: string }) => iso.format(new Date(c.at));
    const days = [...new Set(data.map(dayOf))].map((day) => {
      const all = matches.filter((c) => dayOf(c) === day);
      return { day, items: data.filter((c) => dayOf(c) === day), changes: all.length, files: new Set(all.flatMap((c) => c.paths)).size };
    });
    return { head, days, ...cursor } satisfies MemoryChangesResponse;
  }
  if (parts[0] === "changes") {
    const change = scene?.changes.find((c) => c.change.id === parts[1]);
    if (parts.length === 2) return change;
    if (parts[2] === "diff" && change?.files.some((f) => f.path === path)) return scene?.editing?.diffs.get(change.change.id) ?? memoryDiff(path);
  }
  if (parts[0] === "history") {
    const { data, ...cursor } = page(versions);
    return { head, changes: data, ...cursor } satisfies MemoryHistoryResponse;
  }
  if (parts[0] === "compare") {
    const from = q.get("from") ?? "";
    const to = q.get("to") ?? "";
    const oldest = versions.findIndex((c) => c.id === from);
    const newest = versions.findIndex((c) => c.id === to);
    if (newest < 0 || oldest <= newest) return;
    if (scene?.editing && !path.startsWith("avatar/")) {
      const { diff, added = 0, removed = 0 } = diffMemoryText(memoryTextAt(scene, path, from) ?? "", memoryTextAt(scene, path, to) ?? "");
      return { from, to, changes: oldest - newest, diff, added, removed } satisfies MemoryCompareResponse;
    }
    const diff = memoryDiff(path);
    const lines = diff.kind === "text" ? diff.hunks.flatMap((h) => h.lines) : [];
    return { from, to, changes: oldest - newest, diff, added: lines.filter((l) => l.kind === "added").length, removed: lines.filter((l) => l.kind === "removed").length } satisfies MemoryCompareResponse;
  }
  if (parts[0] === "search") {
    const query = q.get("q");
    if (!query) return;
    let hits = 0;
    const files = Object.entries(scene?.text ?? {}).flatMap(([path, text]) => {
      const lines = text.split("\n").flatMap((text, i) => text.includes(query) && ++hits <= 100 ? [{ line: i + 1, text }] : []);
      return lines.length ? [{ path, lines }] : [];
    });
    return { head, files, truncated: hits > 100, line_limit: 100 } satisfies MemorySearchResponse;
  }
}

// ── The activity record ──

type RecordAnswer = RecordDayResponse | RecordTurnResponse | { output: string } | RecordNightResponse | RecordSubAgentResponse | { unseen: number } | RecordSeenResponse;

function record(w: World, method: string, url: URL): RecordAnswer | undefined {
  const parts = url.pathname.split("/").slice(3).map(decodeURIComponent);
  if (method === "GET" && parts.length === 0) return recordDay(w, url.searchParams);
  if (method === "GET" && parts[0] === "unseen" && parts.length === 1) return { unseen: w.unseen };
  if (method === "POST" && parts[0] === "seen" && parts.length === 1) {
    const answer = { unseen: w.unseen, previous_seen_at: w.previousSeenAt };
    w.unseen = 0;
    w.previousSeenAt = new Date().toISOString();
    return answer;
  }
  if (method !== "GET") return undefined;
  const turns = [...w.record.filter((row): row is RecordTurn => row.kind === "turn"), ...w.nightTurns];
  if (parts[0] === "turns") {
    const turn = turns.find((t) => t.id === parts[1]);
    if (turn === undefined) return undefined;
    if (parts.length === 2) {
      const memory_change = w.memory?.changes.find(({ change: { writer } }) => "turn_id" in writer && writer.turn_id === turn.id)?.change;
      return { turn, flow: flowOf(turn), expired: false, ...(memory_change ? { memory_change } : {}) };
    }
    if (parts.length === 4 && parts[2] === "results") {
      const call = flowOf(turn).find((item) => item.kind === "tool_call" && item.call_id === parts[3]);
      return call?.kind === "tool_call" ? { output: outputOf(call.arguments) } : undefined;
    }
    return undefined;
  }
  if (parts[0] === "nights" && parts.length === 2) {
    const night = w.record.find((row) => row.kind === "night" && row.id === parts[1]);
    if (night?.kind !== "night") return undefined;
    const nightTurns = Object.fromEntries(turns.flatMap((turn) => turn.night?.id === night.id ? [[turn.night.stage, turn]] : []));
    const review = night.stages.curator.review;
    if (review !== undefined) {
      for (const phase of ["content", "structure"] as const) {
        const turn = w.nightTurns.find(({ id }) => id === review[phase].turn_id);
        if (turn !== undefined) nightTurns[phase] = turn;
      }
    }
    const last = w.memory?.overview.last_night;
    const memory_changes = last?.id === night.id ? last.changes.map(({ change }) => change) : undefined;
    return { night, turns: nightTurns, ...(memory_changes ? { memory_changes } : {}) };
  }
  if (parts[0] === "sub-agents" && parts.length === 2) {
    const name = parts[1]!;
    const sub_agent = w.record.find((row): row is RecordSubAgent => row.kind === "sub_agent" && row.agent === name);
    const own = turns.filter((t) => t.agent === name).sort(newestFirst);
    return sub_agent === undefined ? undefined : { sub_agent, turns: own };
  }
  return undefined;
}

const newestFirst = (a: { at: string }, b: { at: string }) => Date.parse(b.at) - Date.parse(a.at);

function recordDay(w: World, query: URLSearchParams): RecordDayResponse {
  const tz = query.get("tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const dayOf = (at: string | number) => format.format(new Date(at));
  const day = query.get("day") ?? dayOf(Date.now());
  const agent = query.get("agent");
  const kind = query.get("kind");
  const kept = (row: RecordRow) =>
    (query.get("failed") !== "1" || row.failed_at !== undefined) &&
    (agent === null || (agent === "main" ? !("agent" in row) || row.agent === "main" : (row.kind === "turn" || row.kind === "sub_agent") && row.agent === agent)) &&
    (kind === null || row.kind === kind || (kind === "night" && row.kind === "missed_night"));
  const whole = w.record.filter((row) => dayOf(row.at) === day);
  const older = [...new Set(w.record.filter(kept).map((row) => dayOf(row.at)))].filter((d) => d < day).sort();
  const names = new Set(w.record.flatMap((row) => (row.kind === "sub_agent" || (row.kind === "turn" && row.agent !== "main") ? [row.agent] : [])));
  return {
    day,
    rows: whole.filter(kept).sort(newestFirst),
    turns: whole.filter((row) => row.kind === "turn").length,
    failures: whole.filter((row) => row.failed_at !== undefined).length,
    ...(older.length === 0 ? {} : { before: older.at(-1)! }),
    agents: [...names].sort(),
  };
}

const COMMANDS = ["cat /memory/always.md", "ls /sources", "rg -n 予定 /memory/routines", "git -C /memory log --oneline -5", "curl -s https://api.example.com/v1/status", "date"];

/** A made-up flow as long as the turn says: a thought, its tools and their results, and a last thought. */
function flowOf(turn: RecordTurn): RecordFlowItem[] {
  const start = Date.parse(turn.started_at ?? turn.at);
  const at = (i: number) => new Date(start + i * 3000).toISOString();
  const what = turn.triggers[0]?.summary ?? (turn.night ? `夜の${{ reflection: "振り返り", verifier: "照合", curator: "整理" }[turn.night.stage]}をする` : "頼まれたことを進める");
  const flow: RecordFlowItem[] = [{ kind: "thinking", at: at(0), turn_id: turn.id, text: `${what.slice(0, 60)}${what.length > 60 ? "…" : ""}\n\nまず手もとの記録を確かめる。` }];
  for (let i = 1; i <= turn.tools; i++) {
    const call_id = `call-${i}`;
    const args = { command: COMMANDS[(i - 1) % COMMANDS.length]! };
    const output = outputOf(args);
    flow.push({ kind: "tool_call", at: at(2 * i - 1), turn_id: turn.id, call_id, name: "bash", arguments: args });
    flow.push({
      kind: "tool_result",
      at: at(2 * i),
      turn_id: turn.id,
      call_id,
      is_error: turn.result === "failed" && i === turn.tools,
      lines: output.split("\n").length,
      bytes: Buffer.byteLength(output),
    });
  }
  flow.push({ kind: "thinking", at: at(2 * turn.tools + 1), turn_id: turn.id, text: turn.result === "failed" ? `続けられない: ${turn.reason ?? "理由は不明"}` : "分かったことをまとめて伝える。" });
  return flow;
}

function outputOf(args: unknown): string {
  const command = (args as { command?: string }).command ?? "";
  return [`$ ${command}`, ...Array.from({ length: 12 }, (_, i) => `line ${i + 1}: 開発用のモックの出力 (${command.split(" ")[0]})`)].join("\n");
}

/** One of her faces, drawn: enough to see the avatar change with what she says. */
const ICON_TYPES: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" };

function faceOf(face: string): string {
  const colors: Record<string, string> = {
    neutral: "#a9c1dc",
    happy: "#f3c96b",
    laughing: "#f2a65a",
    surprised: "#b7a3e0",
    thinking: "#9fd0c0",
    worried: "#c8b78a",
    sad: "#8fa7c7",
    sleepy: "#c4c4d6",
    angry: "#e48a7a",
  };
  const mouths: Record<string, string> = {
    happy: "M36 62 Q50 74 64 62",
    laughing: "M34 60 Q50 80 66 60 Z",
    surprised: "M44 66 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0",
    thinking: "M40 66 L60 62",
    worried: "M38 68 Q50 62 62 68",
    sad: "M38 70 Q50 60 62 70",
    sleepy: "M42 66 L58 66",
    angry: "M38 70 Q50 62 62 70",
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${colors[face] ?? colors.neutral}"/><circle cx="36" cy="44" r="5" fill="#333"/><circle cx="64" cy="44" r="5" fill="#333"/><path d="${mouths[face] ?? "M40 64 L60 64"}" stroke="#333" stroke-width="4" fill="none" stroke-linecap="round"/></svg>`;
}
