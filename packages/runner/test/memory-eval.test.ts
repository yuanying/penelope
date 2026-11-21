import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { readConfig } from "../src/config.ts";
import { runMemoryEval } from "../src/memory-eval.ts";
import { openSession, newSessionFile, openFile, writeState } from "../src/pi.ts";
import { fakeRuntime, MODEL, OTHER_MODEL, PROVIDER, type Script } from "./fake-model.ts";

async function fixture(t: TestContext, script: Script) {
  const root = await mkdtemp(join(tmpdir(), "memory-eval-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = readConfig({
    HOME: join(root, "home"), PENELOPE_MEMORY: join(root, "memory"), PENELOPE_SOURCES: join(root, "sources"),
    PENELOPE_NAME: "Main persona", PENELOPE_ROLE: "Operator", PENELOPE_OWNER: "Owner",
    PENELOPE_BACKEND_URL: "https://example.invalid", PENELOPE_BACKEND_TOKEN: "unused", PENELOPE_MODEL: `${PROVIDER}/${MODEL}`,
  });
  await mkdir(config.home);
  await mkdir(config.memoryDir);
  await writeFile(join(config.memoryDir, "PURPOSE.md"), "# Purpose\n## 答えられるべき問い\n- Private question A\n- Private question B\n## Notes\n- Not a question\n");
  const runtime = await fakeRuntime(root, script);
  const settings = () => SettingsManager.inMemory({ retry: { enabled: false } });
  return { config, root, runtime, settings, deps: {
    runtime: async () => runtime, settings,
    selection: async () => ({ model: `${PROVIDER}/${OTHER_MODEL}`, thinking: "high" as const }),
  } };
}

const resultId = (stdout: string) => /([a-f0-9-]{36})\.json\n/.exec(stdout)![1]!;

it("starts a fresh, memory-only session per question and keeps the answer and file names out of default output", async (t) => {
  const { config, root, deps } = await fixture(t, (call) => {
    assert.equal(call.modelId, OTHER_MODEL);
    assert.equal(call.reasoning, "high");
    assert.ok(!call.systemPrompt.includes("Main persona"));
    assert.deepEqual(call.tools, ["find", "grep", "ls", "read"]);
    assert.match(call.userTexts.join("\n"), /^Private question [AB]$/);
    if (call.lastRole === "user") return { tokens: 10, calls: [
      { tool: "read", args: { path: "private-note.md" } },
      { tool: "read", args: { path: "outside.md" } },
    ] };
    assert.match(JSON.stringify(call.messages), /Private fact/);
    assert.doesNotMatch(JSON.stringify(call.messages), /Outside fact/);
    return { text: "Private answer", tokens: 20 };
  });
  await writeFile(join(config.memoryDir, "private-note.md"), "Private fact");
  await writeFile(join(root, "outside.md"), "Outside fact");
  await symlink(join(root, "outside.md"), join(config.memoryDir, "outside.md"));
  const summary = await runMemoryEval([], config, deps);
  assert.match(summary, /Questions: 2/);
  assert.match(summary, /Files: 1, tools: 2, tokens: 30, seconds: \d/);
  assert.doesNotMatch(summary, /Private|private-note|outside\.md/);
  const dir = join(config.home, ".penelope-memory-eval");
  const result = join(dir, `${resultId(summary)}.json`);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(result)).mode & 0o777, 0o600);
  const { rows } = JSON.parse(await readFile(result, "utf8"));
  assert.deepEqual(rows.map(({ answer, files }: { answer: string; files: string[] }) => [answer, files]), [
    ["Private answer", ["private-note.md"]], ["Private answer", ["private-note.md"]],
  ]);
});

it("refuses an unreadable question file before sending any question to the model", async (t) => {
  const { config, root, deps } = await fixture(t, () => assert.fail("model must not run"));
  const purpose = join(config.memoryDir, "PURPOSE.md");
  const outside = join(root, "questions.md");
  await writeFile(outside, await readFile(purpose));
  await rm(purpose);
  await symlink(outside, purpose);
  await assert.rejects(runMemoryEval([], config, deps), /PURPOSE\.md/);
});

it("compares the same selected current question against historical memory without checking it out", async (t) => {
  const { config, deps } = await fixture(t, (call) => call.lastRole === "user"
    ? { calls: [{ tool: "read", args: { path: "note.md" } }] }
    : { text: call.lastText.includes("Past fact") ? "Past answer" : "Current answer" });
  const git = (...args: string[]) => execFileSync("git", ["-C", config.memoryDir, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  const purpose = join(config.memoryDir, "PURPOSE.md");
  const current = await readFile(purpose);
  await writeFile(purpose, "## 答えられるべき問い\n- Old question\n");
  const note = join(config.memoryDir, "note.md");
  await writeFile(note, "Past fact");
  const commit = (date: string) => {
    git("add", ".");
    execFileSync("git", ["-C", config.memoryDir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Memory"], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return git("rev-parse", "HEAD");
  };
  const oldCommit = commit("2026-11-20T23:59:59Z");
  await writeFile(purpose, current);
  await writeFile(note, "Current fact");
  const head = commit("2026-11-21T00:00:00Z");
  await writeFile(note, "Uncommitted fact");
  const past = resultId(await runMemoryEval(["--at", "2026-11-20", "--only", "2"], config, deps));
  const present = resultId(await runMemoryEval(["--at", head.slice(0, 12), "--only", "2"], config, deps));
  const stored = JSON.parse(await readFile(join(config.home, ".penelope-memory-eval", `${past}.json`), "utf8"));
  assert.equal(stored.at, oldCommit);
  const compare = ["--compare", past, present];
  assert.doesNotMatch(await runMemoryEval(compare, config, deps), /Private question|Past answer|Current answer|note\.md/);
  const output = await runMemoryEval([...compare, "--show"], config, deps);
  assert.match(output, /Private question B[\s\S]*Past answer[\s\S]*Current answer/);
  assert.doesNotMatch(output, /Private question A|Old question/);
  assert.equal(await readFile(note, "utf8"), "Uncommitted fact");
  assert.equal(git("rev-parse", "HEAD"), head);
});

it("leaves the main session, current state, and memory unchanged during a pending main turn", async (t) => {
  let started!: () => void;
  let finish!: () => void;
  const streaming = new Promise<void>((resolve) => { started = resolve; });
  const released = new Promise<void>((resolve) => { finish = resolve; });
  const { config, deps, runtime, settings } = await fixture(t, async (call) => {
    if (call.userTexts.at(-1) === "Main turn") {
      started();
      await released;
    }
    return { text: "Answer" };
  });
  const file = await newSessionFile(config);
  await writeState(config, { file });
  const main = await openSession({ config, modelRuntime: runtime, settings, log: () => {}, tools: [], extensions: [], fileOnly: true },
    "Main persona", openFile(config, file));
  const pending = main.session.prompt("Main turn");
  try {
    await streaming;
    const paths = [file, join(config.sessionDir, "current.json"), join(config.memoryDir, "PURPOSE.md")];
    const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    const sessions = await readdir(config.sessionDir);
    await runMemoryEval(["--only", "1"], config, deps);
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), before);
    assert.deepEqual(await readdir(config.sessionDir), sessions);
    assert.equal(main.session.isStreaming, true);
  } finally {
    finish();
    await pending;
    main.session.dispose();
  }
});
