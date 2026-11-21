import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";

import {
  createEditToolDefinition,
  createFindToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Config } from "./config.ts";
import { textLines, textPage } from "./night-text.ts";

type NightPaths = Pick<Config, "memoryDir" | "sourcesDir" | "sessionDir" | "subAgentDir">;
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

/** File tools only: memory is writable; source files and selected transcripts are read-only. */
export function nightTools(config: NightPaths, transcripts?: string[]): ToolDefinition[] {
  return fileTools(config.memoryDir, { config, transcripts });
}

/** The evaluation can read only its private snapshot of memory. */
export function memoryReadTools(memoryDir: string, onRead: (path: string) => void): ToolDefinition[] {
  return fileTools(memoryDir, undefined, onRead);
}

function fileTools(
  memoryDir: string,
  night?: { config: NightPaths; transcripts: string[] | undefined },
  onRead?: (path: string) => void,
): ToolDefinition[] {
  const memory = resolve(memoryDir);
  const { config, transcripts } = night ?? {};
  const sources = config && resolve(config.sourcesDir);
  const sessionRoots = config ? [resolve(config.sessionDir), resolve(config.subAgentDir)] : [];
  if (sources && [sources, ...sessionRoots].some((root) => inside(memory, root) || inside(root, memory))) {
    throw new Error("Memory and original record directories must not overlap.");
  }
  const records = new Set(transcripts?.map((path) => resolve(path)));
  for (const path of records) {
    if (!path.endsWith(".jsonl") || !sessionRoots.some((root) => inside(root, path))) throw new Error("Invalid transcript path.");
  }
  const denied = (path: string) => new Error(`Path is outside the allowed files or is not a plain file or directory: ${path}`);
  const noFollow = constants.O_NOFOLLOW | constants.O_NONBLOCK;

  // Check every component, not just the leaf. There are no link-creation tools.
  // This is a tool-level restriction, not isolation from another same-UID process.
  async function checked(path: string, kind: "file" | "dir", writing = false): Promise<string> {
    const target = resolve(memory, path);
    const root = inside(memory, target) ? memory
      : !writing && transcripts && sources && inside(sources, target) ? sources
      : !writing && kind === "file" && records.has(target) ? target : undefined;
    if (root === undefined) throw denied(target);
    const parts = relative(root, target).split(sep).filter(Boolean);
    if (parts.includes(".git") || (root === memory && parts.length === 0 && kind === "file")) throw denied(target);
    // The next main session can load code from this directory.
    if (writing && parts[0] === "extensions") throw denied(target);
    // Start at the filesystem root to reject symlinks in transcript paths too.
    const absoluteParts = target.split(sep).filter(Boolean);
    let current: string = sep;
    for (const [index, name] of absoluteParts.entries()) {
      current = join(current, name);
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (writing && inside(memory, current) && error.code === "ENOENT") return undefined;
        throw error;
      });
      const file = index === absoluteParts.length - 1 && kind === "file";
      if (info && (file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) throw denied(target);
    }
    return target;
  }

  const readMemory = async (path: string) => readFile(await checked(path, "file", true), { flag: constants.O_RDONLY | noFollow });
  const writeMemory = async (path: string, content: string) => {
    await writeFile(await checked(path, "file", true), content, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow });
  };

  async function* lines(path: string, signal?: AbortSignal): AsyncGenerator<[number, string]> {
    const file = await open(await checked(path, "file"), constants.O_RDONLY | noFollow);
    const input = file.createReadStream({ encoding: "utf8", signal });
    try {
      onRead?.(relative(memory, resolve(memory, path)));
      yield* textLines(input, path.endsWith(".jsonl"));
    } finally {
      input.destroy();
      await file.close();
    }
  }

  async function* walk(dir: string, signal?: AbortSignal): AsyncGenerator<string> {
    const entries = await readdir(await checked(dir, "dir"), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (entry.name === ".git") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(path, signal);
      else if (entry.isFile() && (await lstat(path)).nlink === 1) yield await checked(path, "file");
    }
  }

  // Transcript directories are not readable as directories: searches there
  // visit only the explicitly selected files, without listing their neighbors.
  const recordsUnder = (dir: string) => sessionRoots.some((root) => inside(root, dir))
    ? [...records].filter((path) => path !== dir && inside(dir, path)) : [];

  async function* searchFiles(path: string, signal?: AbortSignal): AsyncGenerator<string> {
    const target = resolve(memory, path);
    const selected = recordsUnder(target);
    if (selected.length > 0) {
      for (const file of selected) {
        signal?.throwIfAborted();
        yield await checked(file, "file");
      }
      return;
    }
    const dir = await checked(target, "dir").catch(() => undefined);
    if (dir === undefined) yield await checked(target, "file");
    else yield* walk(dir, signal);
  }

  // Custom glob avoids Pi's default subprocess and uses the same checked traversal as grep.
  const find = createFindToolDefinition(memory, {
    operations: {
      async exists(path) {
        if (recordsUnder(path).length === 0) await checked(path, "dir");
        return true;
      },
      async glob(pattern, dir, { limit }) {
        const found: string[] = [];
        for await (const file of searchFiles(dir)) {
          if (matchesGlob(pattern.includes(sep) ? relative(dir, file) : basename(file), pattern)) found.push(file);
          if (found.length >= Math.min(limit, 1_001)) break;
        }
        return found;
      },
    },
  });
  find.description = "Find files by glob in an allowed directory. Paths are relative to the search directory; .git and links are excluded.";
  find.promptSnippet = "Find files by name or glob in an allowed directory";

  const tools = [
    defineTool({
      name: "read", label: "read", description: "Read text. Use the reported offset and column to continue, even inside one long line. Embedded image data in JSONL is omitted.",
      parameters: Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Integer({ minimum: 1, description: "Starting line, 1-based (default: 1)." })),
        column: Type.Optional(Type.Integer({ minimum: 1, description: "Starting column on that line, 1-based in UTF-16 code units (default: 1)." })),
        limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum lines per page (default: 100)." })),
      }),
      async execute(_id, { path, offset = 1, column = 1, limit = 100 }, signal) {
        return text(await textPage(lines(path, signal), offset, column, limit));
      },
    }),
    find,
    defineTool({
      name: "grep", label: "grep", description: "Search text for a literal string in an allowed file or directory. Results show file, line and column, including matches inside long JSONL lines.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "File or directory (default: memory)." })),
        pattern: Type.String({ minLength: 1, maxLength: 512 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum matching lines (default: 30)." })),
      }),
      async execute(_id, { path = memory, pattern, limit = 30 }, signal) {
        const results: string[] = [];
        for await (const file of searchFiles(path, signal)) {
          for await (const [line, value] of lines(file, signal)) {
            const index = value.indexOf(pattern);
            if (index < 0) continue;
            if (results.length >= limit) return text(`${results.join("\n")}\n\n[More matches; narrow the search path or pattern.]`);
            const excerpt = value.slice(Math.max(index - 60, 0), index + pattern.length + 60);
            results.push(`${night ? file : relative(memory, file)}:${line}:${index + 1}: ${excerpt}`);
          }
        }
        return text(results.length ? results.join("\n") : "No matches.");
      },
    }),
    ...(night ? [createEditToolDefinition(memory, {
      operations: {
        access: async (path) => { await checked(path, "file", true); },
        readFile: readMemory,
        writeFile: writeMemory,
      },
    }),
    createWriteToolDefinition(memory, {
      operations: {
        mkdir: async (path) => { await mkdir(await checked(path, "dir", true), { recursive: true }); },
        writeFile: writeMemory,
      },
    })] : []),
    defineTool({
      name: "ls", label: "ls", description: transcripts ? "List a directory in memory or the event sources." : "List a directory in memory.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, { path }) {
        const entries = await readdir(await checked(path, "dir"), { withFileTypes: true });
        const names = entries.filter((entry) => entry.name !== ".git" && (entry.isFile() || entry.isDirectory()))
          .map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).sort();
        return { content: [{ type: "text", text: JSON.stringify(names) }], details: undefined };
      },
    }),
  ] as ToolDefinition[];
  if (night && !transcripts) tools.push(...[
    defineTool({
      name: "move", label: "move", description: "Move a memory file to a new path in memory, creating its parent directories.",
      parameters: Type.Object({ from: Type.String(), to: Type.String() }),
      async execute(_id, { from, to }) {
        const source = await checked(from, "file", true);
        const target = await checked(to, "file", true);
        const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        if (existing) throw new Error("The destination already exists.");
        await mkdir(await checked(resolve(target, ".."), "dir", true), { recursive: true });
        await rename(source, target);
        return { content: [{ type: "text", text: "Moved." }], details: undefined };
      },
    }),
    defineTool({
      name: "remove", label: "remove", description: "Remove a file in memory.",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, { path }) {
        await unlink(await checked(path, "file", true));
        return { content: [{ type: "text", text: "Removed." }], details: undefined };
      },
    }),
  ] as ToolDefinition[]);
  return tools;
}
