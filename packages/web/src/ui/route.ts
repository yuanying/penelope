// The backend serves the Web UI at /; its places and detail pages live in the hash.
import { useCallback, useSyncExternalStore } from "react";

import type { Place } from "./places.tsx";

export type RecordPage = { kind: "turn" | "night" | "sub_agent"; id: string };
export type MemoryPage =
  | { kind: "changes" }
  | { kind: "change"; id: string; from?: RecordPage }
  | { kind: "file"; path: string; line?: number }
  | { kind: "history"; path: string }
  | { kind: "search"; q: string };

export type Route =
  | { place: "talk"; reply?: { id: string; before: string } }
  | { place: "log"; page?: RecordPage }
  | { place: "memory"; page?: MemoryPage }
  | { place: Exclude<Place, "talk" | "log" | "memory"> };

const NAMES: Record<Place, string> = { talk: "talk", log: "record", memory: "memory", events: "events", settings: "settings" };
const PAGES: Record<RecordPage["kind"], string> = { turn: "turns", night: "nights", sub_agent: "sub-agents" };

export function parseRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  const [name, kind, id, ...rest] = path.split("/");
  const query = new URLSearchParams(search);
  if (name === "memory") {
    const q = query.get("q");
    try {
      if (q) return { place: "memory", page: { kind: "search", q } };
      if (kind === "changes" && !id) return { place: "memory", page: { kind: "changes" } };
      if (kind === "changes" && id && rest.length === 0) {
        const origin = /^(turn|night)\/(.+)$/.exec(query.get("from") ?? "");
        return { place: "memory", page: { kind: "change", id: decodeURIComponent(id), ...(origin ? { from: { kind: origin[1] === "turn" ? "turn" : "night", id: origin[2]! } } : {}) } };
      }
      if ((kind === "files" || kind === "history") && id) {
        const file = [id, ...rest].map(decodeURIComponent).join("/");
        const line = Number(query.get("line"));
        return { place: "memory", page: kind === "history" ? { kind, path: file } : { kind: "file", path: file, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) } };
      }
    } catch {
      // A malformed escape is not a file address.
    }
    return { place: "memory" };
  }
  if (name === "record") {
    const page = (Object.keys(PAGES) as Array<RecordPage["kind"]>).find((k) => PAGES[k] === kind);
    if (page !== undefined && id !== undefined && id !== "" && rest.length === 0) {
      try {
        return { place: "log", page: { kind: page, id: decodeURIComponent(id) } };
      } catch {
        return { place: "log" };
      }
    }
    return { place: "log" };
  }
  if (name === "events" || name === "settings") return { place: name };
  const reply = query.get("reply");
  const before = query.get("before");
  return reply !== null && before !== null ? { place: "talk", reply: { id: reply, before } } : { place: "talk" };
}

export function hashOf(route: Route): string {
  if (route.place === "log" && route.page !== undefined) return `#/record/${PAGES[route.page.kind]}/${encodeURIComponent(route.page.id)}`;
  if (route.place === "talk" && route.reply !== undefined) return `#/talk?${new URLSearchParams({ reply: route.reply.id, before: route.reply.before })}`;
  if (route.place === "memory" && route.page !== undefined) {
    const page = route.page;
    switch (page.kind) {
      case "search": return `#/memory?${new URLSearchParams({ q: page.q })}`;
      case "changes": return "#/memory/changes";
      case "change": return `#/memory/changes/${encodeURIComponent(page.id)}${page.from ? `?${new URLSearchParams({ from: `${page.from.kind}/${page.from.id}` })}` : ""}`;
      case "file":
      case "history":
        return `#/memory/${page.kind === "file" ? "files" : "history"}/${page.path.split("/").map(encodeURIComponent).join("/")}${page.kind === "file" && page.line !== undefined ? `?line=${page.line}` : ""}`;
    }
  }
  return `#/${NAMES[route.place]}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The route of the address now, and a way to go to another. */
export function useRoute(): [Route, (route: Route) => void] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const go = useCallback((route: Route) => {
    window.location.hash = hashOf(route);
  }, []);
  return [parseRoute(hash), go];
}
