// The backend serves the Web UI at /; its places and detail pages live in the hash.
import { useCallback, useSyncExternalStore } from "react";

import type { Place } from "./places.tsx";

/** A writer the list of changes is narrowed to; all of them when there is none. */
export type MemoryWriterKind = "daytime" | "night" | "owner";
const WRITERS: readonly string[] = ["daytime", "night", "owner"] satisfies MemoryWriterKind[];
export type RecordPage = { kind: "turn" | "night" | "sub_agent"; id: string };
export type MemoryPage =
  | { kind: "changes"; writer?: MemoryWriterKind }
  | { kind: "change"; id: string; from?: RecordPage }
  /** `source` is the file as it was written; a line is always shown in it. */
  | { kind: "file"; path: string; line?: number; source?: true }
  /** `compare` is the two versions to compare, the older first. */
  | { kind: "history"; path: string; compare?: [older: string, newer: string] }
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
      if (kind === "changes" && !id) {
        const writer = query.get("writer") ?? "";
        return { place: "memory", page: { kind: "changes", ...(WRITERS.includes(writer) ? { writer: writer as MemoryWriterKind } : {}) } };
      }
      if (kind === "changes" && id && rest.length === 0) {
        const origin = /^(turn|night)\/(.+)$/.exec(query.get("from") ?? "");
        return { place: "memory", page: { kind: "change", id: decodeURIComponent(id), ...(origin ? { from: { kind: origin[1] === "turn" ? "turn" : "night", id: origin[2]! } } : {}) } };
      }
      if ((kind === "files" || kind === "history") && id) {
        const file = [id, ...rest].map(decodeURIComponent).join("/");
        const line = Number(query.get("line"));
        const older = query.get("from");
        const newer = query.get("to");
        if (kind === "history") return { place: "memory", page: { kind, path: file, ...(older && newer ? { compare: [older, newer] } : {}) } };
        return { place: "memory", page: { kind: "file", path: file, ...(Number.isSafeInteger(line) && line > 0 ? { line } : query.get("view") === "source" ? { source: true } : {}) } };
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
      case "changes": return `#/memory/changes${page.writer ? `?writer=${page.writer}` : ""}`;
      case "change": return `#/memory/changes/${encodeURIComponent(page.id)}${page.from ? `?${new URLSearchParams({ from: `${page.from.kind}/${page.from.id}` })}` : ""}`;
      case "file":
      case "history": {
        const query = page.kind === "history" ? (page.compare ? `?${new URLSearchParams({ from: page.compare[0], to: page.compare[1] })}` : "")
          : page.line !== undefined ? `?line=${page.line}` : page.source ? "?view=source" : "";
        return `#/memory/${page.kind === "file" ? "files" : "history"}/${page.path.split("/").map(encodeURIComponent).join("/")}${query}`;
      }
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
