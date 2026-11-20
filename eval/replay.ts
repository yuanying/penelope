import assert from "node:assert/strict";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mock } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { readConfig } from "../packages/runner/src/config.ts";
import { Runner } from "../packages/runner/src/runner.ts";
import { fakeRuntime, MODEL, PROVIDER, type Script } from "../packages/runner/test/fake-model.ts";
import { answer } from "./answer.ts";
import { ReplayBackend } from "./replay-backend.ts";
import { createPiRuntime } from "./runtime.ts";
import { days } from "./scenario.ts";
import { score } from "./scoring.ts";

const [, , mode, label, revision, run] = process.argv;
const started = performance.now();
const root = resolve("replay");
const home = join(root, "home");
const memoryDir = join(root, "memory");
const sourcesDir = join(root, "sources");
const receiptFile = join(home, "terminal-receipt.txt");
const fake = { provider: PROVIDER, id: MODEL };
const requireEnv = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in live mode`);
  return value;
};
const authPath = process.env.EVAL_PI_AUTH;
delete process.env.EVAL_PI_AUTH;
const ref = mode === "live" ? {
  provider: authPath ? requireEnv("EVAL_PROVIDER") : process.env.EVAL_PROVIDER || "eval-live",
  id: requireEnv("EVAL_MODEL"),
} : fake;
const chat = mode === "live" && !authPath ? {
  baseUrl: requireEnv("EVAL_BASE_URL"), apiKey: requireEnv("EVAL_API_KEY"),
} : undefined;
delete process.env.EVAL_API_KEY;
const piAuth = mode === "live" ? authPath : undefined;
if (mode === "live" && ref.provider === PROVIDER) throw new Error("EVAL_PROVIDER is reserved by the scripted model");

let daytime: { inputs: string[]; output: string; file: string; note: string; step: number } | undefined;
let answering = false;
let smokeAnswerRead = false;
// Daytime is a fixed transcript of real Pi tool calls in both modes. The
// built-in read result, not the request or note, contains the terminal seal.
const script: Script = (call) => {
  if (daytime) {
    const path = daytime.inputs[daytime.step++];
    if (path) return { calls: [{ tool: "read", args: { path } }] };
    if (call.lastText.includes(daytime.output)) {
      return { calls: [{ tool: "write", args: { path: join(memoryDir, daytime.file), content: daytime.note } }] };
    }
    return { text: "Pickup notes updated." };
  }
  if (mode === "live") return { error: "The live model was not selected" };
  if (answering) {
    if (call.lastRole === "user") return { calls: [{ tool: "read_memory", args: { path: "signoff-current.md" } }] };
    smokeAnswerRead = call.lastText.includes("SIGNOFF-36");
    return { text: "{}" };
  }
  return { text: "Scripted night response; no memory changes." };
};

for (const dir of [home, memoryDir, sourcesDir]) await mkdir(dir, { recursive: true });
await writeFile(join(memoryDir, "personality.md"), "You keep the records of a fictional sample-crate depot.\n");
const config = readConfig({
  HOME: home, PENELOPE_MEMORY: memoryDir, PENELOPE_SOURCES: sourcesDir,
  PENELOPE_BACKEND_URL: "http://unused.invalid", PENELOPE_BACKEND_TOKEN: "unused",
  PENELOPE_NAME: "Marlo", PENELOPE_ROLE: "a sample-crate depot clerk", PENELOPE_OWNER: "the depot lead",
  PENELOPE_IMAGE_SKILLS: "", PENELOPE_MODEL: `${ref.provider}/${ref.id}`, PENELOPE_THINKING: process.env.EVAL_THINKING ?? "off",
});
const thinking = config.thinkingLevel ?? "off";
const runtime = piAuth ? await createPiRuntime(piAuth, ref) : await fakeRuntime(root, script);
if (piAuth) {
  // Keep the exact same daytime script alongside Pi's native model provider.
  const scripted = await fakeRuntime(root, script);
  const provider = scripted.getRegisteredProviderConfig(PROVIDER);
  if (!provider) throw new Error("Scripted model provider is missing");
  runtime.registerProvider(PROVIDER, provider);
  await runtime.setRuntimeApiKey(PROVIDER, "unused").catch(() => {
    throw new Error("Could not register the scripted daytime model in Pi OAuth mode");
  });
}
if (chat) {
  runtime.registerProvider(ref.provider, {
    name: ref.provider,
    api: "openai-completions",
    baseUrl: chat.baseUrl,
    models: [{ id: ref.id, name: ref.id, reasoning: thinking !== "off", input: ["text"],
      compat: { thinkingFormat: "openai", supportsReasoningEffort: true },
      thinkingLevelMap: { xhigh: "xhigh" },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 4096 }],
  });
  await runtime.setRuntimeApiKey(ref.provider, chat.apiKey);
}
const backend = new ReplayBackend(memoryDir, sourcesDir);
await backend.seed();
const runner = new Runner({
  config, backend, modelRuntime: runtime,
  settings: () => SettingsManager.inMemory({ retry: { enabled: false } }),
  // Runner logs can include raw provider errors. Keep those out of OAuth runs.
  ...(piAuth ? { log: () => {} } : {}),
});
const controller = new AbortController();
const timeout = setTimeout(async () => {
  console.error(`${label} run ${run}: replay exceeded 30 minutes`);
  controller.abort();
  await runtime.settleCredentialWrites();
  process.exit(1);
}, 30 * 60_000);
const nights: { date: string; elapsedSeconds: number; stages: unknown }[] = [];
const running = runner.run(controller.signal);
// An early runner exit must fail the replay, not leave it waiting for an ack.
async function ack(delivery: Promise<void>) {
  await Promise.race([delivery, running.then(() => { throw new Error("Runner stopped before acknowledging the event"); })]);
}
try {
  const wallClock = Date.now;
  mock.timers.enable({ apis: ["Date"], now: Date.parse(`${days[0]!.date}T09:00:00Z`) });
  // The runner needs the fictional calendar, but Pi compares token expiry and
  // lock freshness using Date.now(). Never move that clock into the future.
  Date.now = wallClock;
  for (const day of days) {
    backend.selection = { model: `${fake.provider}/${fake.id}`, thinking: "off" };
    const dawn = Date.parse(`${day.date}T09:00:00Z`);
    for (const [index, { receipt, source, id, summary, text, file, note }] of day.records.entries()) {
      mock.timers.setTime(dawn + index * 60_000);
      if (receipt) await writeFile(receiptFile, receipt);
      daytime = {
        inputs: [join(sourcesDir, source, `${day.date}.jsonl`), ...(receipt ? [receiptFile] : [])],
        output: receipt ?? text, file, note, step: 0,
      };
      backend.toolResults = [];
      await ack(backend.deliver(source, id, summary, { text }));
      assert.equal(backend.ends.at(-1)?.result, "done", `Daytime turn ${id}`);
      for (const original of receipt ? [text, receipt] : [text]) {
        assert.ok(backend.toolResults.some((r) => !r.is_error && r.output.includes(original)), `Original tool result for ${id}`);
      }
      assert.equal(await readFile(join(memoryDir, file), "utf8"), note);
      if (receipt) await unlink(receiptFile);
    }
    daytime = undefined;

    mock.timers.setTime(Date.parse(`${day.date}T23:00:00Z`));
    backend.selection = { model: `${ref.provider}/${ref.id}`, thinking };
    const nightStart = performance.now();
    const previous = backend.rotations.length;
    await ack(backend.deliver("control", `nightly@${new Date().getTime()}`, "the nightly switch", { kind: "nightly" }));
    assert.equal(backend.rotations.length, previous + 1, `Missing rotation on ${day.date}`);
    const { stages } = backend.rotations.at(-1)!;
    assert.ok(stages, `Missing stage results on ${day.date}`);
    for (const [name, stage] of Object.entries(stages)) {
      assert.equal(stage.result, "done", `Night ${day.date}: ${name}${piAuth ? "" : `: ${stage.reason ?? ""}`}`);
    }
    nights.push({ date: day.date, elapsedSeconds: (performance.now() - nightStart) / 1000, stages });
  }
} catch (error) {
  clearTimeout(timeout);
  throw error;
} finally {
  mock.timers.reset();
  controller.abort();
  await runtime.settleCredentialWrites();
  await running.catch((error: unknown) => {
    clearTimeout(timeout);
    if (piAuth) throw new Error("The replay runner failed in Pi OAuth mode");
    throw error;
  });
}
try {
  answering = true;
  const raw = await answer(runtime, ref, thinking, memoryDir, home, config.agentDir);
  if (mode === "fake") assert.ok(smokeAnswerRead, "The fresh answer session must be able to read the last daytime note from memory");
  console.log(JSON.stringify({ kind: "run", label, revision, run: Number(run), mode, model: `${ref.provider}/${ref.id}`, thinking, elapsedSeconds: (performance.now() - started) / 1000,
    nights, answer: raw, score: score(raw) }));
} catch (error) {
  if (piAuth) throw new Error("The answer turn failed in Pi OAuth mode");
  throw error;
} finally {
  clearTimeout(timeout);
  await runtime.settleCredentialWrites();
}
