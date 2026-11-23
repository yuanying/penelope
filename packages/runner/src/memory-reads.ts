import { stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** One date per call referencing the file, or the most recent date if all references aged out. */
export type MemoryRead = { path: string; dates: string[] };

export const NIGHT_REFLECTION = "penelope:night-reflection";

export function memoryPath(root: string, absolute: string): string | undefined {
  const path = relative(root, absolute);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`) || path.split(sep).includes(".git")) return undefined;
  return path;
}

// The sandbox API expects slash-separated paths relative to /memory.
function snapshotPath(path: string): boolean {
  return !/[\\\0]/.test(path) && path.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

function isDay(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date;
}

export function recentReadCutoff(today: string): string {
  const date = new Date(today);
  date.setUTCDate(date.getUTCDate() - 29);
  return date.toISOString().slice(0, 10);
}

/** The entries come from the unfolded main-session record, not the model's current context. */
export async function memoryReads(
  root: string, cwd: string, entries: SessionEntry[], previous: MemoryRead[], today: string,
): Promise<MemoryRead[]> {
  const reads = new Map(previous.map(({ path, dates }) => [path, [...dates]]));
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const files = new Map<string, Promise<boolean>>();
  const isFile = (absolute: string) => {
    let file = files.get(absolute);
    if (!file) {
      file = stat(absolute).then((info) => info.isFile(), () => false);
      files.set(absolute, file);
    }
    return file;
  };
  const locate = (path: string) => resolve(cwd, path.startsWith("~/") ? path.slice(2) : path);
  let reflection = false;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === NIGHT_REFLECTION) {
      reflection = entry.data === true;
      calls.clear();
    }
    if (reflection || entry.type !== "message") continue;
    const { message } = entry;
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") calls.set(part.id, { name: part.name, input: part.arguments });
      }
    } else if (message.role === "toolResult") {
      const call = calls.get(message.toolCallId);
      calls.delete(message.toolCallId);
      if (!call || message.isError) continue;
      const found = new Set<string>();
      const { path, command } = call.input;
      const read = call.name === "read" && typeof path === "string";
      if (read) {
        found.add(locate(path));
      } else {
        let shellSearch: string | undefined;
        if (call.name === "bash" && typeof command === "string") {
          // Pick out plain and quoted words; do not evaluate shell syntax or expansions.
          for (const word of command.matchAll(/(?:^|[\s|&;<>()])(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'|&;<>()]+))(?=$|[\s|&;<>()])/g)) {
            found.add(locate((word[1] ?? word[2] ?? word[3])!));
          }
          shellSearch = /^\s*(rg|grep|fd|find)\s/.exec(command)?.[1];
        }
        if (shellSearch || call.name === "grep" || call.name === "find") {
          let base = locate(typeof path === "string" ? path : ".");
          if (call.name === "grep" && await isFile(base)) base = dirname(base);
          for (const part of message.content) {
            if (part.type !== "text") continue;
            for (const line of part.text.split("\n")) {
              if (!line) continue;
              if (shellSearch) {
                // Shell output is only a hint: take absolute filenames in common search output formats.
                const path = shellSearch === "rg" || shellSearch === "grep" ? line.split(":", 1)[0]! : line;
                if (isAbsolute(path)) found.add(resolve(path));
              } else if (call.name === "grep") {
                // Pi grep prefixes matches (not context lines) with filename:line:.
                const match = /^(.+?):\d+:/.exec(line)?.[1];
                if (match) found.add(resolve(base, match));
              } else if (!line.startsWith("[")) found.add(resolve(base, line));
            }
          }
        }
      }
      const time = Date.parse(entry.timestamp);
      if (!Number.isFinite(time)) continue;
      const day = new Date(time).toISOString().slice(0, 10);
      for (const absolute of found) {
        const path = memoryPath(root, absolute);
        if (!path || (!read && !await isFile(absolute))) continue;
        const dates = reads.get(path) ?? [];
        dates.push(day);
        reads.set(path, dates);
      }
    }
  }
  const cutoff = recentReadCutoff(today);
  const history: MemoryRead[] = [];
  for (const [path, dates] of reads) {
    if (!snapshotPath(path)) continue;
    const valid = dates.filter((date) => isDay(date) && date <= today).sort();
    if (!valid.length) continue;
    const recent = valid.filter((date) => date >= cutoff);
    history.push({ path, dates: recent.length ? recent : valid.slice(-1) });
  }
  return history;
}
