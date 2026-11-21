import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { marked } from "marked";

import { memoryPath, recentReadCutoff, type MemoryRead } from "./memory-reads.ts";
import type { MemoryFile } from "./night-memory.ts";

const run = promisify(execFile);
type Dates = { changed?: string; night?: string };
type Section = [heading: string, lines: number];

/** Read only commit dates, the night-stage trailer and NUL-delimited paths, newest first. */
async function commitDates(root: string, paths: Set<string>): Promise<Map<string, Dates>> {
  const dates = new Map<string, Dates>();
  if (paths.size === 0) return dates;
  const result = await run("git", ["-C", root, "-c", `safe.directory=${root}`, "--git-dir=.git",
    "log", "--first-parent", "--no-renames", "--name-only", "-z",
    "--format=%x00%cI%x00%(trailers:key=Night-stage,valueonly,separator=%x2C)%x00", "HEAD", "--"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1" },
    maxBuffer: 8 * 1024 * 1024, timeout: 5_000,
  }).catch(() => undefined);
  // An empty, unreadable or unusually large history does not suppress the working-tree map.
  if (!result) return dates;
  const fields = result.stdout.split("\0");
  let day: string | undefined;
  let night = false;
  for (let i = 0; i < fields.length - 1; i++) {
    const field = fields[i]!;
    if (field === "") {
      day = new Date(fields[++i]!).toISOString().slice(0, 10);
      const stage = fields[++i];
      night = stage === "verifier" || stage === "curator";
      i++; // The format terminator; Git adds a newline before the first path.
      if (fields[i + 1]?.startsWith("\n")) fields[i + 1] = fields[i + 1]!.slice(1);
    } else if (paths.has(field) && day) {
      const entry = dates.get(field) ?? {};
      entry.changed ??= day;
      if (night) entry.night ??= day;
      dates.set(field, entry);
    }
  }
  return dates;
}

function localTarget(root: string, source: string, href: string): string | undefined {
  const urlPath = href.split(/[?#]/, 1)[0]!;
  if (!urlPath || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(urlPath)) return undefined;
  try {
    return memoryPath(root, resolve(root, dirname(source), decodeURIComponent(urlPath)));
  } catch {
    return undefined;
  }
}

async function markdownShape(root: string, path: string): Promise<{ sections: Section[]; links: string[] }> {
  const sections: Section[] = [];
  const links: string[] = [];
  if (!/\.md$/i.test(path)) return { sections, links };
  const body = await readFile(join(root, path), "utf8").catch(() => undefined);
  if (body === undefined) return { sections, links };
  const tokens = marked.lexer(body);
  let firstLine = 1;
  let sectionAt = 0;
  for (const token of tokens) {
    if (token.type === "heading") {
      if (sectionAt) sections.at(-1)![1] = firstLine - sectionAt;
      sectionAt = firstLine;
      const label = token.text.replace(/\s+/g, " ").trim();
      sections.push([label.length > 80 ? `${label.slice(0, 79)}…` : label, 0]);
    }
    firstLine += token.raw.split("\n").length - 1;
  }
  if (sectionAt) sections.at(-1)![1] = firstLine - sectionAt + Number(!body.endsWith("\n"));
  marked.walkTokens(tokens, (token) => {
    if (token.type === "link" || token.type === "image") {
      const target = localTarget(root, path, token.href);
      if (target !== undefined) links.push(target);
    }
  });
  return { sections, links };
}

/** One compact row per file; group filenames by directory without dropping any files. */
export async function memoryMap(root: string, files: MemoryFile[], reads: MemoryRead[], today: string): Promise<string> {
  const paths = new Set(files.map(({ path }) => path));
  const dirs = new Set([""]);
  for (const path of paths) {
    for (let dir = dirname(path); dir !== "." && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
  }
  const dates = commitDates(root, paths);
  const inbound = new Map<string, number>();
  const shapes = new Map<string, { sections: Section[]; broken: Set<string> }>();
  for (const path of paths) {
    const { sections, links } = await markdownShape(root, path);
    const broken = new Set<string>();
    for (const target of links) {
      if (target === path) continue;
      if (paths.has(target)) inbound.set(target, (inbound.get(target) ?? 0) + 1);
      else if (!dirs.has(target)) broken.add(target);
    }
    shapes.set(path, { sections, broken });
  }
  const history = await dates;
  const byPath = new Map(reads.map(({ path, dates }) => [path, dates]));
  const since = recentReadCutoff(today);
  const groups = new Map<string, string[]>();
  for (const { path, bytes } of files) {
    const dir = dirname(path);
    const group = groups.get(dir) ?? [];
    const readDates = byPath.get(path) ?? [];
    const { sections, broken } = shapes.get(path)!;
    group.push(JSON.stringify([basename(path), bytes, history.get(path)?.changed ?? null, history.get(path)?.night ?? null,
      readDates.at(-1) ?? null, readDates.filter((date) => date >= since && date <= today).length,
      inbound.get(path) ?? 0, sections, [...broken]]));
    groups.set(dir, group);
  }
  return [
    "# Memory map",
    "Directories and filenames are relative to the memory root. Each row has [file, bytes, last committed change, last night-worker write, last daytime reference, daytime references in 30 days, incoming links, headings with line counts, broken link targets]. References are a usage estimate, not an exact read count. Dates are UTC; null means unknown or not recorded. Zero incoming links means no links from other files.",
    ...[...groups].map(([dir, rows]) => `${JSON.stringify(dir === "." ? "./" : `${dir}/`)}\n${rows.join("\n")}`),
  ].join("\n\n");
}
