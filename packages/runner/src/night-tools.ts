import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Config } from "./config.ts";

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

/** File tools only: memory is writable; source files and selected transcripts are read-only. */
export function nightTools(config: Config, transcripts?: string[]): ToolDefinition[] {
  const memory = resolve(config.memoryDir);
  const sources = resolve(config.sourcesDir);
  const sessionRoots = [resolve(config.sessionDir), resolve(config.subAgentDir)];
  if ([sources, ...sessionRoots].some((root) => inside(memory, root) || inside(root, memory))) {
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
      : !writing && transcripts && inside(sources, target) ? sources
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
  const tools = [
    createReadToolDefinition(memory, {
      operations: {
        access: async (path) => { await checked(path, "file"); },
        readFile: async (path) => readFile(await checked(path, "file"), { flag: constants.O_RDONLY | noFollow }),
        async *createReadStream(path, { signal }) {
          const file = await open(await checked(path, "file"), constants.O_RDONLY | noFollow);
          try {
            yield* file.createReadStream({ signal });
          } finally {
            await file.close();
          }
        },
      },
    }),
    createEditToolDefinition(memory, {
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
    }),
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
  if (!transcripts) tools.push(...[
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
