// Read committed objects only, never the index or work tree. All user-supplied
// names are validated by the view before being used as literal paths.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { MemoryFileChange, MemoryMove } from "@penelope/contract";

export const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

// Ignore per-path attributes for counts, search and patches. They must not
// depend on the live index or change the meaning of cached past commits.
function noAttributes(object: string): string {
  const format = object.length === 64 ? "sha256" : "sha1";
  return `--attr-source=${createHash(format).update("tree 0\0").digest("hex")}`;
}

export function memoryPath(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !/[\\\0]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

export type TreeFile = { id: string; bytes: number };
export type TreeEntry = TreeFile & { mode: "100644" | "100755" };
export const OWNER_SAVE_SUBJECT = "Owner: save memory file";
export type GitFileChange = MemoryFileChange & { oldBlob?: string; newBlob?: string };
export type GitCommit = {
  id: string;
  parent?: string;
  at: string;
  email: string;
  author: string;
  nightSeq?: number;
  avatarSeed?: true;
  ownerSave?: true;
  turn?: { id: string; agent: string; stage?: "reflection" | "verifier" | "curator" };
  repair?: { moves: MemoryMove[]; turn?: string };
};
export type GitChange = GitCommit & { files: GitFileChange[] };
type LogMode = "commits" | "paths" | "moves" | "counts";

export class MemoryGit {
  private readonly gitDir: string;

  private readonly dir: string;

  constructor(dir: string) { this.dir = dir; this.gitDir = join(dir, ".git"); }

  private run(args: string[], { input, maxBuffer = 64 * 1024 * 1024, noMatch = false, partial = false }: {
    input?: string; maxBuffer?: number; noMatch?: boolean; partial?: boolean;
  } = {}): Promise<{ bytes: Buffer; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      const child = execFile("git", ["--no-pager", "--no-replace-objects", "-c", `safe.directory=${this.dir}`, "-c", "core.bare=true", "-c", "core.attributesFile=/dev/null", `--git-dir=${this.gitDir}`, ...args], {
        // Do not inherit the backend's environment or personal Git config.
        cwd: this.gitDir, encoding: "buffer", maxBuffer, timeout: 30_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1", LC_ALL: "C" },
      }, (error, stdout) => {
        const truncated = error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && partial;
        if (error === null || (error.code === 1 && noMatch) || truncated) resolve({ bytes: stdout, truncated });
        // Git's diagnostics may contain paths, queries, or memory text.
        else reject(new Error("could not read committed memory"));
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }

  async head(): Promise<string | null> {
    if (!existsSync(join(this.gitDir, "HEAD"))) return null;
    const head = (await this.run(["rev-parse", "--verify", "--quiet", "HEAD"], { noMatch: true })).bytes.toString().trim();
    return OBJECT_ID.test(head) ? head : null;
  }

  async tree(id: string, paths: string[] = []): Promise<Map<string, TreeEntry>> {
    const files = new Map<string, TreeEntry>();
    const { bytes } = await this.run(["--literal-pathspecs", "ls-tree", "-r", "-l", "-z", id, "--", ...paths]);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    for (let start = 0, end = bytes.indexOf(0); end !== -1; start = end + 1, end = bytes.indexOf(0, start)) {
      let row: string;
      try { row = decoder.decode(bytes.subarray(start, end)); } catch { continue; }
      const match = /^(100644|100755) blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/.exec(row);
      if (match && memoryPath(match[4])) {
        files.set(match[4], { mode: match[1] === "100755" ? "100755" : "100644", id: match[2]!, bytes: Number(match[3]) });
      }
    }
    return files;
  }

  async firstParent(head: string): Promise<string[]> {
    const { bytes } = await this.run(["rev-list", "--first-parent", head, "--"]);
    return bytes.toString().trimEnd().split("\n");
  }

  commits(head: string, grep: string[] = []): Promise<GitCommit[]> {
    return this.log(head, "commits", grep.length ? ["--fixed-strings", ...grep.map((text) => `--grep=${text}`)] : []);
  }

  paths(head: string, { after, path }: { after?: string; path?: string } = {}): Promise<GitChange[]> {
    return this.log(head, "paths", path === undefined ? [] : ["--full-history"], { after, path });
  }

  selected(ids: string[], mode: Exclude<LogMode, "commits">): Promise<GitChange[]> {
    if (!ids.length) return Promise.resolve([]);
    return this.log(ids[0]!, mode, ["--no-walk=unsorted", "--stdin"], { input: `${ids.join("\n")}\n` });
  }

  private async log(head: string, mode: LogMode, selection: string[], { after, path, input }: {
    after?: string | undefined; path?: string | undefined; input?: string;
  } = {}): Promise<GitChange[]> {
    const diff = mode === "commits" ? ["--no-patch"] : ["--diff-merges=first-parent", "--root", "--raw",
      ...(mode === "paths" ? ["--no-renames"] : ["--find-renames", "-l1000"]), ...(mode === "counts" ? ["--numstat"] : [])];
    const args = [noAttributes(head), "log", "--first-parent", "--no-color", "--no-notes", "--no-show-signature",
      "--no-ext-diff", "--no-textconv", "--no-abbrev", "-z", "--format=%x00%H%x00%P%x00%cI%x00%ae%x00%an%x00%B", ...diff, ...selection,
      ...(input === undefined ? [after === undefined ? head : `${after}..${head}`] : []), "--",
      ...(path === undefined ? [] : [`:(top,literal)${path}`])];
    const output = await this.run(args, input === undefined ? {} : { input });
    return parseLog(output.bytes.toString());
  }

  async blobs(files: TreeFile[]): Promise<Map<string, Buffer>> {
    const found = new Map<string, Buffer>();
    // Batch by known size, not number of files: no process per Markdown file.
    let pending: TreeFile[] = [];
    let size = 0;
    const flush = async () => {
      if (!pending.length) return;
      const ids = pending.map(({ id }) => id);
      const { bytes } = await this.run(["cat-file", "--batch"], { input: `${ids.join("\n")}\n` });
      let offset = 0;
      for (const file of pending) {
        const end = bytes.indexOf(10, offset);
        if (end < 0 || bytes.toString("ascii", offset, end) !== `${file.id} blob ${file.bytes}`) throw new Error("could not read memory blob");
        offset = end + 1 + file.bytes;
        found.set(file.id, bytes.subarray(end + 1, offset));
        offset++;
      }
      pending = [];
      size = 0;
    };
    for (const file of files) {
      if (size + file.bytes > 4 * 1024 * 1024) await flush();
      pending.push(file);
      size += file.bytes;
    }
    await flush();
    return found;
  }

  async sizes(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const { bytes } = await this.run(["cat-file", "--batch-check"], { input: `${ids.join("\n")}\n` });
    return new Map(bytes.toString().split("\n").flatMap((line) => {
      const [id, type, size] = line.split(" ");
      return id && type === "blob" ? [[id, Number(size)] as const] : [];
    }));
  }

  async grep(head: string, query: string, limit: number) {
    return this.run([noAttributes(head), "grep", "--no-color", "-z", "-n", "-I", "-F", `--max-count=${limit + 1}`, "-e", query, head, "--", ":(top,exclude)avatar/**"],
      { noMatch: true, partial: true, maxBuffer: 1024 * 1024 });
  }

  async diffCounts(from: string, to: string, path: string): Promise<{ added: number; removed: number }> {
    const { bytes } = await this.run([noAttributes(to), "diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv",
      "--no-renames", from, to, "--", `:(literal)${path}`]);
    const [added, removed] = bytes.toString().split("\t");
    return { added: Number(added) || 0, removed: Number(removed) || 0 };
  }

  async patch(from: string, to: string) {
    return this.run([noAttributes(to), "-c", "core.quotePath=true", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--no-indent-heuristic", "--diff-algorithm=myers", "--unified=3", from, to, "--"], { partial: true, maxBuffer: 1024 * 1024 });
  }
}

/** NUL framing keeps tabs, newlines and pathspec magic in names unambiguous. */
function parseLog(output: string): GitChange[] {
  const fields = output.split("\0");
  const changes: GitChange[] = [];
  let i = 0;
  while (i < fields.length - 1) {
    if (fields[i++] !== "") throw new Error("unexpected memory history format");
    const [id, parents, date, email, author, message] = fields.slice(i, i += 6) as [string, string, string, string, string, string];
    const parent = parents.split(" ", 1)[0];
    const at = new Date(date).toISOString();
    const files = new Map<string, GitFileChange>();
    while (fields[i]?.startsWith(":") || fields[i]?.startsWith("\n:")) {
      const [oldMode, newMode, oldId, newId, status] = fields[i++]!.trimStart().slice(1).split(" ");
      const source = fields[i++]!;
      const renamed = status?.startsWith("R");
      const path = renamed ? fields[i++]! : source;
      const regular = (mode: string | undefined) => mode === "100644" || mode === "100755";
      const old = regular(oldMode) && memoryPath(source);
      const current = regular(newMode) && memoryPath(path);
      if (!old && !current) continue;
      const file: GitFileChange = { path: current ? path : source, kind: old && current ? renamed ? "moved" : "modified" : current ? "added" : "deleted", added: 0, removed: 0 };
      if (renamed && old && current) file.from = source;
      if (old && oldId) file.oldBlob = oldId;
      if (current && newId) file.newBlob = newId;
      files.set(path, file);
    }
    while (fields[i] && /^\n?(\d+|-)\t(\d+|-)\t/.test(fields[i]!)) {
      const [, added, removed, name] = /^\n?(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i++]!)!;
      // A rename has an empty first path, then the old and new paths separately.
      const path = name === "" ? fields[(i += 2) - 1]! : name!;
      const file = files.get(path);
      if (file) {
        file.added = file.newBlob && added !== "-" ? Number(added) : 0;
        file.removed = file.oldBlob && removed !== "-" ? Number(removed) : 0;
      }
    }
    const change: GitChange = { id, ...(parent ? { parent } : {}), at, email, author, files: [...files.values()] };
    const [subject, ...body] = message.split("\n");
    const turnId = /^Turn (.+)$/.exec(subject ?? "")?.[1];
    const agent = body.find((line) => line.startsWith("Agent: "))?.slice(7);
    if (turnId && agent) {
      const stage = body.find((line) => line.startsWith("Night-stage: "))?.slice(13);
      change.turn = { id: turnId, agent, ...(stage === "reflection" || stage === "verifier" || stage === "curator" ? { stage } : {}) };
    } else if (subject === "Runner: repair memory references") {
      const moves: MemoryMove[] = [];
      for (const line of body) {
        const pair = /^("(?:[^"\\]|\\.)*") → ("(?:[^"\\]|\\.)*")$/.exec(line);
        if (!pair) continue;
        try {
          const from: unknown = JSON.parse(pair[1]!);
          const to: unknown = JSON.parse(pair[2]!);
          if (memoryPath(from) && memoryPath(to)) moves.push({ from, to });
        } catch { /* An invalid pair is not a recorded move. */ }
      }
      const turn = body.find((line) => line.startsWith("Repair-turn: "))?.slice(13);
      change.repair = { moves, ...(turn ? { turn } : {}) };
    }
    if (change.turn || change.repair) {
      const night = body.find((line) => /^Night: [1-9]\d*$/.test(line));
      if (night && Number.isSafeInteger(Number(night.slice(7)))) change.nightSeq = Number(night.slice(7));
    } else if (subject?.startsWith("Avatar ") && body.some((line) => line.startsWith("Copied from "))) {
      change.avatarSeed = true;
    } else if (subject === OWNER_SAVE_SUBJECT) {
      change.ownerSave = true;
    }
    changes.push(change);
  }
  return changes;
}
