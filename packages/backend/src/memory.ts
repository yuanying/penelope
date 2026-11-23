// The commits of /memory (ADR-0006): at the end of each turn the backend
// commits what changed, as it is, with no checks. Only the backend writes
// `.git`; the sandbox mounts it read-only.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { NightTurnStage, RecordMemoryChange } from "@penelope/contract";

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

  /** `listener` is called after each commit that made one. */
  afterCommit(listener: () => void): void {
    this.listeners.push(listener);
  }

  private queue(commit: () => Promise<"committed" | "clean">): Promise<"committed" | "clean"> {
    const next = this.last.then(commit, commit);
    this.last = next.catch(() => {});
    return next.then((result) => {
      if (result === "committed") for (const listener of this.listeners) listener();
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
  private git(...args: string[]) {
    return run(
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
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
      },
    );
  }
}
