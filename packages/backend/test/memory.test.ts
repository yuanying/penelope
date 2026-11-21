import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { Memory } from "../src/memory.ts";
import { tempDir } from "./support.ts";

const author = { name: "penelope-backend", email: "backend@penelope.invalid" };

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", `safe.directory=${dir}`, ...args], { cwd: dir, encoding: "utf8" });
}

describe("the memory", () => {
  it("makes the repository when /memory has none yet", async (t) => {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, "always.md"), "# always\n");
    const memory = new Memory(dir, author);
    assert.equal(await memory.commit({ agent: "main", turnId: "t-1" }), "committed");
    assert.equal(git(dir, "ls-files"), "always.md\n");
  });

  it("makes the repository in an empty .git, the mount point a Pod gives it", async (t) => {
    const dir = tempDir(t);
    mkdirSync(path.join(dir, ".git"));
    writeFileSync(path.join(dir, "always.md"), "# always\n");
    const memory = new Memory(dir, author);
    assert.equal(await memory.commit({ agent: "main", turnId: "t-1" }), "committed");
    assert.equal(git(dir, "ls-files"), "always.md\n");
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim(), "main");
  });

  it("commits what changed as it is, as the backend, saying which turn", async (t) => {
    const dir = tempDir(t);
    const memory = new Memory(dir, author);
    writeFileSync(path.join(dir, "always.md"), "# always\n");
    mkdirSync(path.join(dir, "diary"));
    writeFileSync(path.join(dir, "diary/2026-11-14.md"), "today\n");
    await memory.commit({ agent: "main", turnId: "t-1" });
    rmSync(path.join(dir, "always.md"));
    writeFileSync(path.join(dir, "diary/2026-11-14.md"), "today, later\n");
    writeFileSync(path.join(dir, "notes.bin"), Buffer.from([0, 1, 2]));
    assert.equal(await memory.commit({ agent: "main", turnId: "t-2" }), "committed");

    assert.equal(git(dir, "log", "-1", "--format=%an <%ae>%n%s%n%b").trim(), [
      "penelope-backend <backend@penelope.invalid>",
      "Turn t-2",
      "Agent: main",
    ].join("\n"));
    assert.equal(git(dir, "show", "--name-status", "--format=", "HEAD").trim(), [
      "D\talways.md",
      "M\tdiary/2026-11-14.md",
      "A\tnotes.bin",
    ].join("\n"));
  });

  it("identifies writes by a night worker in the memory history", async (t) => {
    const dir = tempDir(t);
    writeFileSync(path.join(dir, "topic.md"), "current\n");
    await new Memory(dir, author).commit({ agent: "main", turnId: "v-1", nightWorker: "verifier" });
    assert.equal(git(dir, "log", "-1", "--format=%(trailers:key=Night-stage,valueonly)").trim(), "verifier");
  });

  it("counts binary files in the first night commit without counting them as text lines", async (t) => {
    const dir = tempDir(t);
    const memory = new Memory(dir, author);
    writeFileSync(path.join(dir, "notes.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(dir, "handoff.md"), "one\ntwo\n");
    writeFileSync(path.join(dir, "notes\n\t.md"), "three\n");
    let measured: unknown;
    await memory.commit({ agent: "main", turnId: "r-1", onChange: (change) => { measured = change; } });
    assert.deepEqual(measured, { files: 3, added: 3, removed: 0, handoff_changed: true });
  });

  it("makes no commit when nothing changed", async (t) => {
    const dir = tempDir(t);
    const memory = new Memory(dir, author);
    writeFileSync(path.join(dir, "always.md"), "# always\n");
    await memory.commit({ agent: "main", turnId: "t-1" });
    assert.equal(await memory.commit({ agent: "main", turnId: "t-2" }), "clean");
    assert.equal(git(dir, "rev-list", "--count", "HEAD").trim(), "1");
  });

  it("makes no commit in a new repository with nothing in it", async (t) => {
    const memory = new Memory(tempDir(t), author);
    assert.equal(await memory.commit({ agent: "main", turnId: "t-1" }), "clean");
  });

  it("commits one turn after another when two ends come at once", async (t) => {
    const dir = tempDir(t);
    const memory = new Memory(dir, author);
    writeFileSync(path.join(dir, "a.md"), "a\n");
    const first = memory.commit({ agent: "main", turnId: "t-1" });
    const second = memory.commit({ agent: "main", turnId: "t-2" });
    assert.deepEqual(await Promise.all([first, second]), ["committed", "clean"]);
  });

  // The avatar's copy at the start does not take in what the owner or a turn left uncommitted.
  it("commits only the paths it is given, leaving the rest for the next turn", async (t) => {
    const dir = tempDir(t);
    const memory = new Memory(dir, author);
    mkdirSync(path.join(dir, "avatar"));
    writeFileSync(path.join(dir, "avatar/avatar.json"), "{}");
    writeFileSync(path.join(dir, "always.md"), "# always\n");
    assert.equal(await memory.commitPaths(["avatar"], ["Avatar iris"]), "committed");
    assert.equal(git(dir, "ls-files"), "avatar/avatar.json\n");
    assert.equal(git(dir, "status", "--porcelain"), "?? always.md\n");
  });

  it("fails, saying why, when git fails", async (t) => {
    const dir = path.join(tempDir(t), "not-there");
    await assert.rejects(new Memory(dir, author).commit({ agent: "main", turnId: "t-1" }));
  });
});
