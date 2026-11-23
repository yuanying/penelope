import type { MemorySaveRequest, MemorySaveResponse, MemoryWriterFilter } from "@penelope/contract";

import { type Handler, HttpError, readBody, sendJson } from "./http.ts";
import { memoryPath, OBJECT_ID } from "./memory-git.ts";
import { MEMORY_TEXT_BYTES, type MemoryView } from "./memory-view.ts";
import type { Memory } from "./memory.ts";

export const MEMORY_PATH = "/api/memory";

const SAVE_STATUS: Record<MemorySaveResponse["kind"], number> = {
  saved: 200, unchanged: 200, head_conflict: 409, worktree_conflict: 409,
  file_not_editable: 422, text_too_large: 422, prompt_file_limit: 422, editing_disabled: 403,
};

// A byte of text can take six bytes in JSON (e.g. "\\u000a"), plus path and framing.
const SAVE_BODY_BYTES = 6 * MEMORY_TEXT_BYTES + 32 * 1024;

async function saveRequest(request: Parameters<Handler>[0]): Promise<MemorySaveRequest> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "memory saves need application/json");
  }
  const bytes = await readBody(request, SAVE_BODY_BYTES);
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, "the body is not UTF-8 JSON"); }
  if (!input || typeof input !== "object") throw new HttpError(400, "invalid memory save");
  const { path, base_head, text } = input as Partial<MemorySaveRequest>;
  if (!memoryPath(path) || Buffer.byteLength(path) > 4096 || Buffer.from(path).toString() !== path ||
      typeof base_head !== "string" || !OBJECT_ID.test(base_head) ||
      typeof text !== "string" || text.includes("\0") || Buffer.from(text).toString() !== text) {
    throw new HttpError(400, "invalid path, base_head or text");
  }
  return { path, base_head, text };
}

export function memoryRoute(view: MemoryView, memory: Memory, url: URL, request: Parameters<Handler>[0], response: Parameters<Handler>[1]): Promise<void> {
  return routeRequest();
  async function routeRequest() {
    if (url.pathname === `${MEMORY_PATH}/save`) {
      if (request.method !== "POST") throw new HttpError(405, "only POST");
      const result = await memory.save(await saveRequest(request), view);
      sendJson(response, SAVE_STATUS[result.kind], result);
      return;
    }
    if (request.method !== "GET") throw new HttpError(405, "only GET");
    const query = url.searchParams;
    const path = () => query.get("path") ?? "";
    const head = query.get("head") ?? undefined;
    const before = query.get("before") ?? undefined;
    const tz = query.get("tz") ?? undefined;
    const route = url.pathname.slice(MEMORY_PATH.length);
    switch (route) {
      case "": sendJson(response, 200, await view.overview(tz)); return;
      case "/file": sendJson(response, 200, await view.file(path(), head)); return;
      case "/history": sendJson(response, 200, await view.history(path(), { head, before })); return;
      case "/compare": sendJson(response, 200, await view.compare(path(), query.get("from") ?? "", query.get("to") ?? "")); return;
      case "/search": sendJson(response, 200, await view.search(query.get("q") ?? "", head)); return;
      case "/changes": {
        const writer = (query.get("writer") ?? "all") as MemoryWriterFilter;
        sendJson(response, 200, await view.changes({ head, before, tz, writer }));
        return;
      }
      case "/image": {
        const { bytes, mime } = await view.image(path(), head);
        response.writeHead(200, {
          "content-type": mime, "content-length": bytes.length, "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(bytes);
        return;
      }
    }
    const match = /^\/changes\/([^/]+)(\/diff)?$/.exec(route);
    if (!match) throw new HttpError(404, "no such memory path");
    const id = match[1]!;
    sendJson(response, 200, match[2] ? await view.diff(id, path()) : await view.change(id));
  }
}
