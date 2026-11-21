import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { MemoryMove } from "@penelope/contract";
import { parse, postprocess, preprocess } from "micromark";
import { decodeString } from "micromark-util-decode-string";

import { memoryPath } from "./memory-reads.ts";

/** Successful file operations from one night-worker turn, grouped by the file that moved. */
export class MemoryMoves {
  readonly history = new Map<string, string[]>();

  move(from: string, to: string): void {
    const history = this.history.get(from) ?? [];
    this.history.delete(from);
    this.history.set(to, [...history, from]);
  }

  remove(path: string): void {
    this.history.delete(path);
  }
}

const barePathFiles = new Set(["personality.md", "always.md", "handoff.md", "PURPOSE.md", "INDEX.md"]);
const noFollow = constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Preserve the raw query/fragment, including Markdown escapes or character references. */
function splitDestination(raw: string): [path: string, suffix: string] {
  for (const match of raw.matchAll(/\\[\\?#]|&(?:#[\da-z]+|[a-z][\da-z]*);|[?#]/gi)) {
    if (/^[?#]$/.test(decodeString(match[0]))) return [raw.slice(0, match.index), raw.slice(match.index)];
  }
  return [raw, ""];
}

function decodePath(raw: string): string | undefined {
  const path = decodeString(raw);
  if (!path || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)) return undefined;
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

function encodePath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)
    .replace(/[()]/g, (c) => c === "(" ? "%28" : "%29")).join("/");
}

function repairBody(
  body: string, repairLink: (raw: string) => string, repairBare: (text: string) => string,
): string {
  // Micromark supplies source spans. Work on the original text rather than
  // rendering Markdown again; its parser skips a leading BOM in the offsets.
  const bom = body.startsWith("\uFEFF") ? 1 : 0;
  const text = body.slice(bom);
  const events = postprocess(parse().document().write(preprocess()(text, undefined, true)));
  let output = body.slice(0, bom);
  let cursor = 0;
  let protectedUntil = 0;
  for (const [event, token] of events) {
    if (event !== "enter") continue;
    const { type, start: { offset: start }, end: { offset: end } } = token;
    if (type === "link" || type === "image" || type === "definition" || type === "autolink") {
      if (start >= protectedUntil) {
        output += text.slice(cursor, protectedUntil) + repairBare(text.slice(protectedUntil, start));
        cursor = start;
      }
      protectedUntil = Math.max(protectedUntil, end);
    } else if (type === "resourceDestinationString" || type === "definitionDestinationString") {
      output += text.slice(cursor, start) + repairLink(text.slice(start, end));
      cursor = end;
    }
  }
  return output + text.slice(cursor, protectedUntil) + repairBare(text.slice(protectedUntil));
}

function bareRepair(relocated: ReadonlyMap<string, string>, roots: string[], exists: Set<string>): (text: string) => string {
  const replacements = new Map<string, string>();
  for (const [from, to] of relocated) {
    if (exists.has(from)) continue;
    for (const prefix of ["", "./", ...roots.map((root) => `${root}/`)]) replacements.set(prefix + from, prefix + to);
  }
  if (!replacements.size) return (text) => text;
  const paths = [...replacements.keys()].sort((a, b) => b.length - a.length)
    .map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // Avoid suffixes of longer paths, words, and URLs. A final sentence period
  // is allowed, but not a dot followed by another path character (e.g. .bak).
  const pathChar = String.raw`[\p{L}\p{N}\p{M}_~/%+@=:#?&\\-]`;
  const url = String.raw`(?:[a-zA-Z][\da-zA-Z+.-]*:|//)[^\s<>\x60"']+`;
  const pattern = new RegExp(String.raw`(?<![.])(?<!${pathChar})(?:${url}|(?:${paths})(?!${pathChar}|\.+${pathChar}))`, "gu");
  return (text) => text.replace(pattern, (old) => replacements.get(old) ?? old);
}

/** Repair only the destinations that can be resolved from this turn's moves. */
export async function repairMemoryReferences(root: string, moves: MemoryMoves, onError: (error: unknown) => void): Promise<{
  paths: string[]; moves: MemoryMove[];
}> {
  if (!moves.history.size) return { paths: [], moves: [] };
  root = resolve(root);
  const roots = [...new Set([root, "/memory"])];
  const exists = new Set([""]);
  const files = new Set<string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      // An existing entry wins even if it is a symlink; never follow it for edits.
      exists.add(path);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.add(path);
    }
  }
  await walk("");

  const relocated = new Map<string, string>();
  const ambiguous = new Set<string>();
  const mapping: MemoryMove[] = [];
  for (const [to, history] of moves.history) {
    if (!files.has(to)) continue;
    for (const from of new Set(history)) {
      if (relocated.has(from)) ambiguous.add(from);
      relocated.set(from, to);
      if (from !== to) mapping.push({ from, to });
    }
  }
  for (const from of ambiguous) relocated.delete(from);
  if (!mapping.length) return { paths: [], moves: [] };
  const repairBare = bareRepair(relocated, roots, exists);
  const paths: string[] = [];
  for (const source of files) {
    if (!/\.md$/i.test(source)) continue;
    const previous = moves.history.get(source)?.[0] ?? source;
    const repairLink = (raw: string): string => {
      const [rawPath, suffix] = splitDestination(raw);
      const path = decodePath(rawPath);
      if (!path) return raw;
      const prefix = isAbsolute(path) ? roots.find((r) => path.startsWith(`${r}/`)) : undefined;
      if (isAbsolute(path) && prefix === undefined) return raw;
      const current = memoryPath(root, prefix === undefined
        ? resolve(root, dirname(source), path) : resolve(root, path.slice(prefix.length + 1)));
      if (current !== undefined && exists.has(current)) return raw;
      const old = prefix === undefined ? memoryPath(root, resolve(root, dirname(previous), path)) : current;
      if (old === undefined || ambiguous.has(old)) return raw;
      const target = relocated.get(old) ?? (exists.has(old) ? old : undefined);
      if (target === undefined || target === current) return raw;
      const rel = relative(dirname(source), target) || ".";
      const rewritten = prefix !== undefined ? `${prefix}/${target}` : path.startsWith("./") && !rel.startsWith("../") ? `./${rel}` : rel;
      return encodePath(rewritten) + (path.endsWith("/") ? "/" : "") + suffix;
    };
    try {
      const file = join(root, source);
      const input = await open(file, constants.O_RDONLY | noFollow);
      let original: Buffer;
      try {
        if (!(await input.stat()).isFile()) continue;
        original = await input.readFile();
      } finally {
        await input.close();
      }
      const body = original.toString("utf8");
      if (!original.equals(Buffer.from(body))) continue; // Not UTF-8; never transcode it.
      const updated = repairBody(body, repairLink, barePathFiles.has(source) ? repairBare : (text) => text);
      if (updated === body) continue;
      const output = await open(file, constants.O_RDWR | noFollow);
      try {
        const info = await output.stat();
        if (!info.isFile() || info.nlink !== 1 || !(await output.readFile()).equals(original)) {
          throw new Error(`Markdown is not a plain, unchanged file: ${JSON.stringify(source)}`);
        }
        const bytes = Buffer.from(updated);
        let position = 0;
        while (position < bytes.length) {
          const { bytesWritten } = await output.write(bytes, position, bytes.length - position, position);
          if (bytesWritten === 0) throw new Error(`Could not write ${JSON.stringify(source)}`);
          position += bytesWritten;
        }
        await output.truncate(bytes.length);
        paths.push(source);
      } finally {
        await output.close();
      }
    } catch (error) {
      onError(error);
    }
  }
  return { paths: paths.sort(), moves: mapping };
}
