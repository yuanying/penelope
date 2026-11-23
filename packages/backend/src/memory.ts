// The commits of /memory (ADR-0006): at the end of each turn the backend
// commits what changed, as it is, with no checks. Only the backend writes
// `.git`; the sandbox mounts it read-only.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { MemorySaveRequest, MemorySaveResponse, NightTurnStage, RecordMemoryChange } from "@penelope/contract";

import { OBJECT_ID, OWNER_SAVE_SUBJECT } from "./memory-git.ts";
import type { MemoryView } from "./memory-view.ts";
import { replaceMemoryFile } from "./memory-worktree.ts";

const run = promisify(execFile);

export type Author = { name: string; email: string };

export class Memory {
  private readonly dir: string;
  private readonly author: Author;
  /** Commits run one after another; a turn's end waits for the one before. */
  private last: Promise<unknown> = Promise.resolve();
  /** Called after each commit that made one. */
  private readonly listeners: (() => void)[] = [];

  constructor(dir: string, author: Author) {
    this.dir = dir;
    this.author = author;
  }

  /** Commits everything that changed in the work tree. `clean` when nothing did. */
  commit({ agent, turnId, night, onChange }: {
    agent: string; turnId: string; night?: { stage: NightTurnStage; seq: number };
    onChange?: (change: RecordMemoryChange | undefined) => void;
  }): Promise<"committed" | "clean"> {
    return this.queue(async () => {
      const message = [`Turn ${turnId}`, `Agent: ${agent}`];
      if (night) message.push(`Night-stage: ${night.stage}\nNight: ${night.seq}`);
      const result = await this.commitNow(message);
      if (onChange !== undefined) {
        // Measure before another queued commit can move HEAD. A failed
        // measurement is not a failed commit, and its git output is private.
        onChange(result === "clean"
          ? { files: 0, added: 0, removed: 0, handoff_changed: false }
          : await this.committedChange().catch(() => undefined));
      }
      return result;
    });
  }

  /** Commits what changed under `paths` only, with the paragraphs of `message`. */
  commitPaths(paths: string[], message: string[]): Promise<"committed" | "clean"> {
    return this.queue(() => this.commitNow(message, paths));
  }

  save(request: MemorySaveRequest, view: MemoryView): Promise<MemorySaveResponse> {
    return this.queue<MemorySaveResponse>(async () => {
      const plan = await view.planSave(request);
      if (plan.kind !== "write") return plan;
      const { head, file, original, body, author } = plan;
      const executable = file.mode === "100755";
      const conflict = { kind: "worktree_conflict", head } as const;
      if (!replaceMemoryFile(this.dir, request.path, original, executable)) return conflict;
      if (body.equals(original)) return { kind: "unchanged", head };

      // Build a tree from HEAD, not the shared index or work tree. The owner
      // commit contains exactly the submitted bytes, even if the sandbox
      // starts another write after replacement, and no filters transform it.
      const scratch = await mkdtemp(path.join(this.dir, ".git", "owner-save-"));
      try {
        const git = (args: string[], input?: Buffer) => this.runGit(args, { index: path.join(scratch, "index"), author, input });
        const oid = async (args: string[], input?: Buffer) => {
          const id = (await git(args, input)).stdout.trim();
          if (!OBJECT_ID.test(id)) throw new Error("memory save did not produce an object id");
          return id;
        };
        await git(["read-tree", head]);
        const blob = await oid(["hash-object", "-w", "--stdin"], body);
        await git(["update-index", "--cacheinfo", `${file.mode},${blob},${request.path}`]);
        const tree = await oid(["write-tree"]);
        const id = await oid(["commit-tree", tree, "-p", head, "-m", OWNER_SAVE_SUBJECT]);
        if (!replaceMemoryFile(this.dir, request.path, original, executable, body)) return conflict;
        await this.git("update-ref", "-m", OWNER_SAVE_SUBJECT, "HEAD", id, head);
        // Bring just this path in the shared index up to the new HEAD.
        await this.git("reset", "--quiet", "--no-refresh", id, "--", `:(literal)${request.path}`);
        return { kind: "saved", head: id, id };
      } finally { await rm(scratch, { recursive: true, force: true }); }
    }, (result) => result.kind === "saved");
  }

  /** `listener` is called after each commit that made one. */
  afterCommit(listener: () => void): void {
    this.listeners.push(listener);
  }

  private queue<T>(commit: () => Promise<T>, madeCommit: (result: T) => boolean = (result) => result === "committed"): Promise<T> {
    const next = this.last.then(commit, commit);
    this.last = next.catch(() => {});
    return next.then((result) => {
      if (madeCommit(result)) for (const listener of this.listeners) listener();
      return result;
    });
  }

  private async commitNow(message: string[], paths: string[] = []): Promise<"committed" | "clean"> {
    // A Pod mounts .git on its own, so it can be there and empty: a repository has its HEAD.
    if (!existsSync(path.join(this.dir, ".git", "HEAD"))) await this.git("init", "--quiet", "--initial-branch=main");
    const only = paths.length === 0 ? [] : ["--", ...paths.map((name) => `:(literal)${name}`)];
    await this.git("add", "--all", ...only);
    const { stdout } = await this.git("status", "--porcelain", ...only);
    if (stdout === "") return "clean";
    await this.git("commit", "--quiet", "--no-verify", ...message.flatMap((paragraph) => ["--message", paragraph]), ...only);
    return "committed";
  }

  private async committedChange(): Promise<RecordMemoryChange> {
    const { stdout } = await this.git("diff-tree", "--root", "--no-commit-id", "-r", "--numstat", "-z",
      "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD");
    const change = { files: 0, added: 0, removed: 0, handoff_changed: false };
    // numstat uses NUL between files, with tabs only separating the two
    // counts from the name. A binary file uses "-" for both counts.
    for (const entry of stdout.split("\0")) {
      if (entry === "") continue;
      const first = entry.indexOf("\t");
      const second = entry.indexOf("\t", first + 1);
      const added = entry.slice(0, first);
      const removed = entry.slice(first + 1, second);
      change.files++;
      change.added += added === "-" ? 0 : Number(added);
      change.removed += removed === "-" ? 0 : Number(removed);
      change.handoff_changed ||= entry.slice(second + 1) === "handoff.md";
    }
    return change;
  }

  /**
   * git in /memory, with nothing taken from the backend's own git
   * configuration: the files belong to the sandbox's user, so the directory
   * is named safe; there are no hooks, no signing and no editor.
   */
  private git(...args: string[]) { return this.runGit(args); }

  private runGit(args: string[], { index, author, input }: { index?: string; author?: Author; input?: Buffer } = {}) {
    const child = run(
      "git",
      [
        "-c",
        `safe.directory=${this.dir}`,
        "-c",
        `user.name=${this.author.name}`,
        "-c",
        `user.email=${this.author.email}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: this.dir,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
          ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
          ...(author === undefined ? {} : { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email }),
        },
      },
    );
    if (input !== undefined) {
      child.child.stdin?.on("error", () => {});
      child.child.stdin?.end(input);
    }
    return child;
  }
}
