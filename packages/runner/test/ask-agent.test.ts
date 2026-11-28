import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import type { JobEnd } from "@penelope/contract";

import { Backend } from "../src/backend.ts";
import { Jobs } from "../src/jobs.ts";

const script = fileURLToPath(new URL("../src/ask-agent.ts", import.meta.url));
const connector = `---
a2a:
  - {name: other, label: Other, url: 'https://other.example.com/', token: OTHER_TOKEN}
  - {name: helper, label: ヘルパー, url: 'https://helper.example.com/', token: HELPER_TOKEN}
---
Existing connector documentation.
`;

async function setup(t: TestContext, get: string, send = "console.log(JSON.stringify({task: {id: 'task-1'}}));") {
  const home = await mkdtemp(join(tmpdir(), "ask-agent-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const connectors = join(home, "connectors");
  const calls = join(home, "calls.jsonl");
  const bin = join(home, "bin");
  await mkdir(bin);
  await mkdir(connectors);
  await writeFile(join(connectors, "agents.md"), connector);
  await writeFile(join(bin, "a2a"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'send') { ${send} }
else { ${get} }
`, { mode: 0o755 });
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}`, PENELOPE_CONNECTORS_DIR: connectors,
    HELPER_TOKEN: "test-placeholder", OTHER_TOKEN: "different-placeholder" };
  return {
    home,
    env,
    run: (args: string[], job = "job-1") => spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8", timeout: 5000, cwd: home,
      env: { ...process.env, ...env, PENELOPE_JOB_ID: job },
    }),
    calls: async (): Promise<string[][]> => (await readFile(calls, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    })).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

test("outside a job, the command refuses before contacting a2a and offers a job_start command", async (t) => {
  const { run, calls } = await setup(t, "");
  const result = run(["helper", "Ask about Alice's plan"], "");
  assert.equal(result.status, 2, result.stderr);
  const { command } = JSON.parse(result.stdout.match(/job_start (.+)/)![1]!);
  const recovered = spawnSync("bash", ["-c", `ask-agent() { printf '%s\\n' "$@"; }; ${command}`], { encoding: "utf8" });
  assert.equal(recovered.stdout, "helper\nAsk about Alice's plan\n");
  assert.deepEqual(await calls(), []);
});

test("a display name selects the URL and the token together, then waits for the returned task", async (t) => {
  const { run, calls } = await setup(t, `console.log(JSON.stringify({task: {id: 'task-1', status: {state: 'TASK_STATE_COMPLETED'}}}));`);
  const result = run(["ヘルパー", "--literal message"]);
  assert.equal(result.status, 0, result.stderr);
  const [send, get] = await calls();
  assert.equal(send?.[0], "send");
  assert.ok(send?.includes("--async"));
  assert.deepEqual(get?.slice(0, 2), ["task", "get"]);
  assert.equal(get?.at(-1), "task-1");
  for (const args of [send!, get!]) {
    assert.equal(args[args.indexOf("-a") + 1], "https://helper.example.com/");
    assert.equal(args[args.indexOf("--auth") + 1], "Bearer test-placeholder");
  }
});

test("--file sends a local file that is not an image as a file part, like --image", async (t) => {
  const { home, run, calls } = await setup(t, `console.log(JSON.stringify({task: {id: 'task-1', status: {state: 'TASK_STATE_COMPLETED'}}}));`);
  await writeFile(join(home, "body.csv"), "date,weight\n");
  await writeFile(join(home, "photo.png"), "png");
  const result = run(["helper", "Register this", "--file", "body.csv", "--image", "photo.png"]);
  assert.equal(result.status, 0, result.stderr);
  const [send] = await calls();
  assert.deepEqual(send?.filter((_, i) => send[i - 1] === "--file-part"), [join(home, "body.csv"), join(home, "photo.png")]);
});

test("an ambiguous alias across connector documents does not send anything", async (t) => {
  const { home, run, calls } = await setup(t, "");
  await writeFile(join(home, "connectors", "second.md"), `---\na2a: [{name: third, label: helper}]\n---\n`);
  const result = run(["helper", "hello"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Candidates: .*helper.*third/);
  assert.deepEqual(await calls(), []);
});

test("a question gives a job_start command to answer the same task", async (t) => {
  const { run, calls } = await setup(t, `console.log(JSON.stringify({task: {id: 'task-1', status: {state: 'TASK_STATE_INPUT_REQUIRED', message: {parts: [{text: 'Which branch?'}]}}}}));`);
  const result = run(["helper", "--task", "task-1", "Main"]);
  assert.equal(result.status, 0, result.stderr);
  const [send] = await calls();
  assert.equal(send?.[send.indexOf("--task-id") + 1], "task-1");
  assert.equal(send?.at(-1), "Main");
  assert.match(result.stdout, /Reply:\nWhich branch\?\nAgent: ヘルパー \(helper\)\nState: input-required\nTask ID: task-1\nImages: \[\]\nReply file: .*\/a2a\/task-1\/reply\.md\nRequest file: .*\/a2a\/task-1\/request\.md\nNext: job_start .*--task.*task-1.*<answer>.*\n$/);
});

test("a wait timeout offers to wait again without resending or canceling the task", async (t) => {
  const { run, calls } = await setup(t, "process.exit(5);");
  const result = run(["helper", "--wait", "task-1"]);
  assert.equal(result.status, 5, result.stderr);
  const [get, ...extra] = await calls();
  assert.deepEqual(extra, []);
  assert.deepEqual(get?.slice(0, 2), ["task", "get"]);
  assert.equal(get?.[get.indexOf("--timeout") + 1], "2h");
  assert.match(result.stdout, /State: timed-out\nTask ID: task-1\nImages: \[\]\nReply file: \(none\)\nReason: The remote Task was not canceled\.\nNext: job_start .*--wait.*task-1.*\n$/);
});

test("the job end points to the exact text sent after shell expansion, without including the text", { timeout: 10_000 }, async (t) => {
  const { home, env, calls } = await setup(t, `console.log(JSON.stringify({task: {id: 'task-1', status: {state: 'TASK_STATE_COMPLETED', message: {parts: [{text: 'Done.'}]}}}}));`);
  const message = "  Check Friday's report.\nUse the latest draft.  ";
  await writeFile(join(home, "body.md"), message);
  let finish!: (end: JobEnd) => void;
  const ended = new Promise<JobEnd>((resolve) => (finish = resolve));
  const backend = new Backend({ url: "", token: "", agent: "main" });
  backend.jobEvent = async ({ payload }) => finish(payload);
  const jobs = new Jobs({ home, dir: join(home, "jobs"), backend, log: () => {}, retryMs: 20,
    limits: { max: 1, maxSeconds: 5, tailChars: 4000 } });
  t.after(() => jobs.stop());
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const vars = Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ");
  await jobs.start({ command: `${vars} ${quote(process.execPath)} ${quote(script)} helper "$(<body.md)"` });

  const end = await ended;
  assert.equal(end.exit_code, 0, end.tail);
  const [send] = await calls();
  assert.equal(send?.at(-1), message);
  assert.ok(!JSON.stringify(end).includes("Check Friday's report."));
  const paths = end.tail.match(/Reply file: (.+)\nRequest file: (.+)\n$/);
  assert.ok(paths, end.tail);
  const [, replyFile, requestFile] = paths;
  const dir = join(home, "a2a", "task-1");
  assert.equal(replyFile, join(dir, "reply.md"));
  assert.equal(requestFile, join(dir, "request.md"));
  assert.equal(await readFile(requestFile, "utf8"), message);
  assert.equal((await stat(requestFile)).mode & 0o777, (await stat(replyFile)).mode & 0o777);
});

test("an answer survives a wait timeout without overwriting the original request", async (t) => {
  const { home, run } = await setup(t, "process.exit(5);");
  const dir = join(home, "a2a", "task-1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "request.md"), "Check the report");

  const result = run(["helper", "--task", "task-1", "Use the November report"]);
  assert.equal(result.status, 5, result.stderr);
  assert.ok(result.stdout.includes(`Request file: ${join(dir, "request-2.md")}\n`));
  assert.equal(await readFile(join(dir, "request-2.md"), "utf8"), "Use the November report");
  assert.equal(await readFile(join(dir, "request.md"), "utf8"), "Check the report");
});

test("--wait points to the latest numbered request without saving another one", async (t) => {
  const { home, run } = await setup(t, `console.log(JSON.stringify({task: {id: 'task-1', status: {state: 'TASK_STATE_COMPLETED'}}}));`);
  const dir = join(home, "a2a", "task-1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "request-9.md"), "Use the draft");
  await writeFile(join(dir, "request-10.md"), "Use the final version");

  const result = run(["helper", "--wait", "task-1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Request file: ${join(dir, "request-10.md")}\n`));
  assert.deepEqual((await readdir(dir)).sort(), ["request-10.md", "request-9.md"]);
});

test("a long question leaves its beginning, full reply file and next step in the job tail", async (t) => {
  const question = "Which branch?";
  const details = "x".repeat(4200);
  const task = {
    id: "task-1",
    status: { state: "TASK_STATE_INPUT_REQUIRED", message: { parts: [{ text: question }] } },
    artifacts: [{ parts: [{ text: details }] }],
  };
  const { home, run } = await setup(t, `console.log(${JSON.stringify(JSON.stringify({ task }))});`);
  const result = run(["helper", "--wait", "task-1"]);
  assert.equal(result.status, 0, result.stderr);
  const tail = result.stdout.slice(-4000);
  assert.match(tail, /Reply:\nWhich branch\?\n/);
  assert.match(tail, /\(truncated; read the Reply file\)\nAgent: ヘルパー \(helper\)\nState: input-required\nTask ID: task-1\nImages: \[\]\nReply file: [^\n]+\nNext: job_start .*--task.*task-1.*\n$/);
  assert.ok(!result.stdout.includes(details));
  const replyFile = tail.match(/Reply file: (.+)/)![1]!;
  assert.equal(replyFile, join(home, "a2a", "task-1", "reply.md"));
  assert.equal(await readFile(replyFile, "utf8"), `${question}\n${details}`);
});

test("a2a errors are reported without exposing the bearer value or retrying the send", async (t) => {
  const { run, calls } = await setup(t, "", `console.log(JSON.stringify({error: {message: '403 for test-placeholder'}})); process.exit(1);`);
  const result = run(["helper", "hello"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /403 for \[redacted\]/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-placeholder/);
  assert.deepEqual((await calls()).map(([verb]) => verb), ["send"]);
});
