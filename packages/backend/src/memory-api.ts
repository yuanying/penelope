import type { MemoryWriterFilter } from "@penelope/contract";

import { type Handler, HttpError, sendJson } from "./http.ts";
import type { MemoryView } from "./memory-view.ts";

export const MEMORY_PATH = "/api/memory";

export function memoryRoute(view: MemoryView, url: URL, request: Parameters<Handler>[0], response: Parameters<Handler>[1]): Promise<void> {
  return read();
  async function read() {
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
