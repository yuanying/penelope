import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { DeliveredEvent, SessionRotatedRequest, TurnEndRequest, TurnLine } from "@penelope/contract";

import type { Config } from "../src/config.ts";
import { newSessionFile, writeState } from "../src/pi.ts";
import { FOLDING, foldAskInput } from "../src/prompts.ts";
import { until } from "./fake-backend.ts";
import { MODEL, OTHER_MODEL, PROVIDER, type Answer, type Call, type Script } from "./fake-model.ts";
import { acked, activities, closers, ui, world } from "./world.ts";

function slack(seq: number, delivery: "now" | "batch"): DeliveredEvent {
  return {
    seq,
    source: "slack",
    id: `s-${seq}`,
    stream: "ops",
    occurred_at: "2026-11-14T09:00:00Z",
    received_at: "2026-11-14T09:00:00Z",
    summary: `slack message ${seq}`,
    delivery,
    inline: false,
    appended: { path: "/sources/slack/ops/2026-11-14.jsonl", lines: [seq, seq] },
  };
}

function nightly(seq: number): DeliveredEvent {
  return {
    seq,
    source: "control",
    id: `nightly-${seq}`,
    occurred_at: "2026-11-14T23:00:00Z",
    received_at: "2026-11-14T23:00:00Z",
    summary: "nightly",
    delivery: "now",
    inline: true,
    payload: { kind: "nightly" },
    appended: { path: "/sources/control/2026-11-14.jsonl", lines: [1, 1] },
  };
}

/** The lines of an input's `<events>`, read back as JSON; none when the input is not one. */
function events(input: string): (TurnLine & Record<string, unknown>)[] {
  const block = /^<events>\n([\s\S]*)\n<\/events>$/.exec(input)?.[1];
  return block === undefined ? [] : block.split("\n").map((line) => JSON.parse(line) as TurnLine & Record<string, unknown>);
}

/** Answers the owner with a reply, then stops. */
const replying: Script = (call) =>
  call.lastRole === "user" ? { thinking: "they said hello", calls: [{ tool: "reply", args: { text: "hi", in_reply_to: 1 } }] } : { text: "replied" };

test("an event becomes a turn; the reply, the activities, the turn's end and the ack follow", async () => {
  const { fake, start, calls } = await world();
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));

  // Guards against: the owner's message not reaching the turn as the event it was.
  assert.deepEqual(
    events(calls[0]!.userTexts.at(-1)!).map((line) => [line.seq, line.source, line.text]),
    [[1, "ui", "hello"]],
  );
  const sent = activities(fake);
  const turnId = sent[0]!.turn_id;
  assert.deepEqual(fake.sent("POST", "/v1/replies"), [{ agent: "main", text: "hi", in_reply_to: 1, turn_id: turnId }]);

  assert.deepEqual(
    sent.map((a) => a.kind),
    ["turn_start", "thinking", "tool_call", "tool_result", "message", "turn_end"],
  );
  assert.ok(sent.every((a) => a.turn_id === turnId));
  assert.deepEqual(fake.sent("POST", "/v1/turns/end"), [{ agent: "main", turn_id: turnId, result: "done", seqs: [1] }]);

  const order = fake.order().filter((r) => r === "POST /v1/turns/end" || r === "POST /v1/events/ack");
  assert.deepEqual(order, ["POST /v1/turns/end", "POST /v1/events/ack"]);
});

test("the owner's new model and thinking level apply on the next turn without losing the conversation", async () => {
  const { fake, start, calls } = await world({ turnFold: false });
  await start(() => ({ text: "Received" }));
  fake.push(ui(1, "first"));
  await until(() => acked(fake).includes(1));
  assert.equal(calls[0]?.modelId, MODEL);

  fake.modelSelection = { model: `${PROVIDER}/${OTHER_MODEL}`, thinking: "low" };
  fake.push(ui(2, "second"));
  await until(() => acked(fake).includes(2));
  assert.equal(calls[1]?.modelId, OTHER_MODEL);
  assert.equal(calls[1]?.reasoning, "low");
  assert.deepEqual(calls[1]?.userTexts.flatMap((input) => events(input).map((line) => line.text)), ["first", "second"]);
});

test("the system prompt is hers, with her memory after it", async () => {
  const { fake, start, calls, config } = await world();
  await writeFile(join(config.memoryDir, "always.md"), "毎朝 CI を見る。");
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  // Guards against: a session started without who she is or without her memory.
  assert.ok(calls[0]!.systemPrompt.includes(config.identity.name));
  assert.ok(calls[0]!.systemPrompt.includes(config.identity.role));
  assert.ok(calls[0]!.systemPrompt.includes("毎朝 CI を見る。"));
});

const greetingExtension = (name: string) => `
    export default function (pi) {
      pi.registerTool({
        name: ${JSON.stringify(name)},
        label: "Greet",
        description: "Say hello",
        parameters: { type: "object", properties: {} },
        async execute() {
          return { content: [{ type: "text", text: "Hello" }], details: {} };
        },
      });
    }
  `;

async function writeMemoryExtension(config: Config): Promise<void> {
  const dir = join(config.memoryDir, "extensions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.ts"), greetingExtension("memory_greet"));
}

test("the main session reloads extensions between turns without loading them in the curator", async () => {
  const { fake, start, calls, config } = await world();
  config.imageSkills = [];
  await skills(config.imageSkillsDir, { goals: "Goals of the image." });
  config.ownerExtensionsDir = join(config.home, "..", "owner-extensions");
  const ownerEntries = join(config.ownerExtensionsDir, "extensions");
  await mkdir(ownerEntries, { recursive: true });
  await writeFile(join(ownerEntries, "greet.ts"), greetingExtension("owner_greet"));
  await start((call) => call.userTexts.length === 1 ? { thinking: "first turn thinking", text: "hello" } : { text: "hello" });
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  assert.ok(calls[0]!.tools.includes("owner_greet"));

  await writeMemoryExtension(config);
  await skills(join(config.memoryDir, "skills"), { example: "A new skill in memory." });
  fake.push(ui(2, "hello again"));
  await until(() => acked(fake).includes(2));
  const afterReload = calls.at(-1)!;
  assert.ok(afterReload.tools.includes("owner_greet") && afterReload.tools.includes("memory_greet"));
  assert.match(afterReload.systemPrompt, /A new skill in memory/);
  assert.doesNotMatch(afterReload.systemPrompt, /Goals of the image/, "reload keeps the empty image skill allow-list");
  assert.ok(afterReload.userTexts.some((text) => text.includes('"text":"hello"')), "reload preserves the current session");
  assert.ok(!JSON.stringify(afterReload.messages).includes("first turn thinking"), "folding still applies after reload");

  fake.push(nightly(3));
  await until(() => acked(fake).includes(3));
  const curator = calls.find((call) => isCurator(config, call));
  assert.ok(curator);
  assert.ok(!curator.tools.includes("owner_greet") && !curator.tools.includes("memory_greet"));
});

test("an invalid owner extension is reported in the next turn without stopping the main session", async () => {
  const { fake, start, calls, config, logs } = await world();
  config.ownerExtensionsDir = join(config.home, "..", "owner-extensions");
  const entries = join(config.ownerExtensionsDir, "extensions");
  await mkdir(entries, { recursive: true });
  await writeFile(join(entries, "broken.ts"), "export default function (");

  await start(() => ({ text: "hello" }));
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.lastText, /broken\.ts/);
  assert.match(logs.join("\n"), /broken\.ts: Failed to load extension/);
});

test("a memory extension handler that throws does not end the turn and is reported in the next input", async () => {
  const { fake, start, calls, config } = await world();
  const dir = join(config.memoryDir, "extensions");
  await mkdir(dir);
  await writeFile(join(dir, "index.ts"), `
    export default function (pi) {
      pi.on("before_agent_start", () => { throw new Error("broken handler"); });
    }
  `);
  await start(() => ({ text: "hello" }));
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  assert.equal((fake.sent("POST", "/v1/turns/end").at(-1) as TurnEndRequest).result, "done");

  fake.push(ui(2, "hello again"));
  await until(() => acked(fake).includes(2));
  assert.match(calls.at(-1)!.lastText, /handler_error.*before_agent_start: broken handler/);
});

test("a failed first turn with changed memory extensions disables them for the next turn", async () => {
  const { fake, start, calls, config } = await world({ turnFold: false });
  config.ownerExtensionsDir = join(config.home, "..", "owner-extensions");
  await mkdir(config.ownerExtensionsDir);
  await writeFile(join(config.ownerExtensionsDir, "index.ts"), greetingExtension("owner_greet"));
  await start((call) => call.tools.includes("memory_greet") ? { error: "trial failed" } : { text: "hello" });
  fake.push(ui(1, "before change"));
  await until(() => acked(fake).includes(1));
  await writeMemoryExtension(config);
  fake.push(ui(2, "trial"));
  await until(() => acked(fake).includes(2));
  assert.ok(calls.at(-1)!.tools.includes("memory_greet"));
  assert.equal((fake.sent("POST", "/v1/turns/end").at(-1) as TurnEndRequest).result, "failed");

  fake.push(ui(3, "after failure"));
  await until(() => acked(fake).includes(3));
  const recovered = calls.at(-1)!;
  assert.ok(!recovered.tools.includes("memory_greet") && recovered.tools.includes("owner_greet"));
  assert.match(recovered.lastText, /memory_extensions_disabled.*failed/);
});

test("a restart without a completed trial does not load the same memory extensions", async () => {
  const { fake, start, calls, config } = await world();
  await writeMemoryExtension(config);
  const stop = await start(() => ({ text: "hello" }));
  await until(() => fake.received.some((r) => r.path === "/v1/events"));
  await stop();

  await start(() => ({ text: "hello" }));
  fake.push(ui(1, "after restart"));
  await until(() => acked(fake).includes(1));
  assert.ok(!calls[0]!.tools.includes("memory_greet"));
  assert.match(calls[0]!.lastText, /memory_extensions_disabled.*before the first turn finished/);
});

/** Writes skills/<name>/SKILL.md under `dir`, one for each name. */
async function skills(dir: string, described: Record<string, string>): Promise<void> {
  for (const [name, description] of Object.entries(described)) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  }
}

test("the owner's skills are listed beside the memory's, and the owner's wins a name in both", async () => {
  const { fake, start, calls, config } = await world({ ownerSkills: true });
  await skills(config.ownerSkillsDir!, { porkadot: "Porkadot of the owner." });
  await skills(join(config.memoryDir, "skills"), { porkadot: "Her own porkadot.", diary: "Her own diary." });
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  const prompt = calls[0]!.systemPrompt;
  // Guards against: the owner's skills not reaching her, or her own copy of one taking its place.
  assert.ok(prompt.includes(join(config.ownerSkillsDir!, "porkadot", "SKILL.md")));
  assert.ok(prompt.includes("Porkadot of the owner."));
  assert.ok(!prompt.includes("Her own porkadot."));
  assert.ok(prompt.includes("Her own diary."), "the memory's skills are still listed");
});

test("the image's skills are listed, and a name the owner or the memory also has is theirs", async () => {
  const { fake, start, calls, config } = await world({ ownerSkills: true });
  await skills(config.imageSkillsDir, { goals: "Goals of the image.", portrait: "Portrait of the image.", drawing: "Drawing of the image." });
  await skills(config.ownerSkillsDir!, { goals: "Goals of the owner." });
  await skills(join(config.memoryDir, "skills"), { portrait: "Her own portrait." });
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  const prompt = calls[0]!.systemPrompt;
  // Guards against: the image's skills not reaching her, or taking the place of a copy the deployment gives or she wrote.
  assert.ok(prompt.includes("Drawing of the image."));
  assert.ok(prompt.includes("Goals of the owner."));
  assert.ok(!prompt.includes("Goals of the image."));
  assert.ok(prompt.includes("Her own portrait."));
  assert.ok(!prompt.includes("Portrait of the image."));
});

test("an image skill allow-list selects only the named image skills in the main session", async () => {
  const { fake, start, calls, config, logs } = await world({ ownerSkills: true });
  config.imageSkills = ["goals", "missing"];
  await skills(config.imageSkillsDir, { goals: "Goals of the image.", slack: "Slack of the image." });
  await skills(config.ownerSkillsDir!, { example: "A skill of the owner." });
  await skills(join(config.memoryDir, "skills"), { diary: "Her own diary." });
  await start(() => ({ text: "hello" }));
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  const prompt = calls[0]!.systemPrompt;
  assert.match(prompt, /Goals of the image/);
  assert.doesNotMatch(prompt, /Slack of the image/);
  assert.match(prompt, /A skill of the owner/);
  assert.match(prompt, /Her own diary/);
  assert.match(logs.join("\n"), /image skill "missing"/);
});

test("a read-only directory of the owner's skills is read and left as it was", async () => {
  const { fake, start, calls, config } = await world({ ownerSkills: true });
  const dir = config.ownerSkillsDir!;
  await skills(dir, { vmapi: "Vmapi of the owner." });
  const file = join(dir, "vmapi", "SKILL.md");
  const before = { content: await readFile(file, "utf8"), mtime: (await stat(file)).mtimeMs };
  await chmod(file, 0o444);
  await chmod(join(dir, "vmapi"), 0o555);
  await chmod(dir, 0o555);
  closers.push(async () => {
    await chmod(dir, 0o755);
    await chmod(join(dir, "vmapi"), 0o755);
  });
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  // Guards against: a runner that needs to write where the owner's skills are mounted read-only.
  assert.ok(calls[0]!.systemPrompt.includes("Vmapi of the owner."));
  assert.deepEqual(await readdir(dir), ["vmapi"]);
  assert.deepEqual(await readdir(join(dir, "vmapi")), ["SKILL.md"]);
  assert.deepEqual({ content: await readFile(file, "utf8"), mtime: (await stat(file)).mtimeMs }, before);
});

test("a directory of the owner's skills that is not there is passed over", async () => {
  const { fake, start, calls } = await world({ ownerSkills: true });
  await start(replying);
  fake.push(ui(1, "hello"));
  // Guards against: a session that cannot start before the owner's skills are put in place.
  await until(() => acked(fake).includes(1));
  assert.ok(calls.length > 0, "a turn ran");
});

test("the connectors' documents are listed in her system prompt, and a broken one is logged", async () => {
  const { fake, start, calls, logs, config } = await world({ connectors: true });
  const dir = config.connectorsDir!;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "github.md"), "---\nname: github\ndescription: GitHub through gh.\nhosts: [api.github.com]\n---\n\nGH_TOKEN\n");
  await writeFile(join(dir, "broken.md"), "# no front matter\n");
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  const prompt = calls[0]!.systemPrompt;
  // Guards against: documents the deployment put in place that never reach her, or one left out without a word.
  assert.ok(prompt.includes("GitHub through gh."));
  assert.ok(prompt.includes(join(dir, "github.md")));
  assert.ok(!prompt.includes(join(dir, "broken.md")));
  assert.ok(logs.some((line) => line.includes(join(dir, "broken.md"))), "the broken one is logged");
});

test("a directory of connectors that is not there is passed over", async () => {
  const { fake, start, calls } = await world({ connectors: true });
  await start(replying);
  fake.push(ui(1, "hello"));
  // Guards against: a session that cannot start before the documents are put in place.
  await until(() => acked(fake).includes(1));
  assert.ok(!calls[0]!.systemPrompt.includes("<connectors>"));
});

test("after a restart the session goes on, and unacked events come again", async () => {
  const { fake, start, calls } = await world();
  const stop = await start(replying);
  fake.push(ui(1, "first"));
  await until(() => acked(fake).includes(1));
  await stop();

  fake.dropAcks.add(2);
  const stopAgain = await start(replying);
  fake.push(ui(2, "second"));
  await until(() => acked(fake).includes(2));
  await stopAgain();
  assert.ok(calls.at(-1)!.userTexts.some((text) => text.includes("first")));

  // The ack of 2 was lost: the next runner gets it again and makes one turn of it.
  const turnsOfSecond = () => calls.filter((c) => c.lastRole === "user" && c.lastText.includes("second")).length;
  assert.equal(turnsOfSecond(), 1);
  fake.dropAcks.clear();
  await start(replying);
  await until(() => acked(fake).filter((seq) => seq === 2).length === 2);
  assert.equal(turnsOfSecond(), 2);
});

test("an event that comes during a turn steers it; the turn acks both", async () => {
  const { fake, start, calls } = await world();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(async (call) => {
    if (call.lastRole === "user" && call.userTexts.length === 1) {
      return { calls: [{ tool: "bash", args: { command: "echo working" } }] };
    }
    if (call.lastRole === "toolResult" && call.userTexts.length === 1) {
      await held;
      return { calls: [{ tool: "bash", args: { command: "echo more" } }] };
    }
    return { text: "done" };
  });
  fake.push(ui(1, "start"));
  await until(() => calls.length >= 2);
  fake.push(ui(2, "and this"));
  await until(() => fake.polledAfter(2));
  release();
  await until(() => acked(fake).includes(2));

  assert.ok(calls.some((c) => c.userTexts.length === 2 && c.userTexts[1]!.includes("and this")));
  // Guards against: the activity record missing what joined the turn as its trigger.
  assert.deepEqual((fake.sent("POST", "/v1/turns/end") as TurnEndRequest[]).map((end) => end.seqs), [[1, 2]]);
  assert.deepEqual(acked(fake).sort(), [1, 2]);
});

test("a batch that comes during a turn follows it", async () => {
  const { fake, start, calls } = await world();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(async (call) => {
    if (call.lastRole === "user" && call.userTexts.length === 1) {
      await held;
      return { text: "first done" };
    }
    return { text: "second done" };
  });
  fake.push(ui(1, "start"));
  await until(() => calls.length >= 1);
  fake.push(slack(2, "batch"));
  fake.push(slack(3, "batch"));
  await until(() => fake.polledAfter(3));
  release();
  await until(() => acked(fake).includes(3));

  const followed = calls.find((c) => c.userTexts.length === 2)!;
  // Guards against: a batch steered into the running turn, or split into one input per event.
  assert.deepEqual(
    events(followed.userTexts[1]!).map((line) => [line.kind, line.source, line.stream, line.seqs]),
    [["batch", "slack", "ops", [2, 3]]],
  );
  assert.deepEqual(acked(fake).sort(), [1, 2, 3]);
});

// Identify the role without depending on the rest of its prompt.
const isCurator = (config: Config, call: Call) =>
  call.systemPrompt.includes(`You are the curator of the memory of ${config.identity.name},`);
const isVerifier = (config: Config, call: Call) =>
  call.systemPrompt.includes(`You are the verifier of the memory of ${config.identity.name},`);
const isReflection = (call: Call) => call.userTexts.at(-1)!.startsWith("This session ends now.");

/** The curator writes INDEX.md, the reflection writes handoff.md, and any other turn answers. */
const nightWrites =
  (config: Config): Script =>
  (call) => {
    if (call.lastRole !== "user") return { text: "ok" };
    if (isCurator(config, call)) {
      return { calls: [{ tool: "write", args: { path: join(config.memoryDir, "INDEX.md"), content: "# index\n" } }] };
    }
    if (isReflection(call)) {
      return { calls: [{ tool: "write", args: { path: join(config.memoryDir, "handoff.md"), content: "明日は版上げ。\n" } }] };
    }
    return { text: "answered" };
  };

test("the nightly event runs reflection, verifier and curator in separate contexts before starting the new session", async () => {
  const { fake, start, calls, config } = await world();
  await start(nightWrites(config));
  fake.push(ui(1, "a day's talk"));
  await until(() => acked(fake).includes(1));
  const sessionsBefore = await readdir(config.sessionDir);
  fake.push(nightly(2));
  await until(() => acked(fake).includes(2));

  assert.equal(await readFile(join(config.memoryDir, "handoff.md"), "utf8"), "明日は版上げ。\n");
  assert.equal(await readFile(join(config.memoryDir, "INDEX.md"), "utf8"), "# index\n");

  const reflection = calls.find(isReflection)!;
  assert.ok(reflection.userTexts.some((text) => text.includes("a day's talk")), "the reflection is in the day's session");
  const verifier = calls.find((c) => isVerifier(config, c))!;
  assert.equal(verifier.userTexts.length, 1, "the verifier starts from an empty context");
  assert.ok(verifier.userTexts[0]!.includes(join(config.sessionDir, sessionsBefore.find((name) => name.endsWith(".jsonl"))!)));
  const curator = calls.find((c) => isCurator(config, c))!;
  assert.equal(curator.userTexts.length, 1, "the curator starts from an empty context");

  // Each turn, including the day's original turn, is reported separately.
  const turnEnds = fake.sent("POST", "/v1/turns/end") as TurnEndRequest[];
  assert.deepEqual(
    turnEnds.map(({ result, seqs, night }) => ({ result, seqs, night })),
    [
      { result: "done", seqs: [1], night: undefined },
      { result: "done", seqs: undefined, night: { seq: 2, stage: "reflection" } },
      { result: "done", seqs: undefined, night: { seq: 2, stage: "verifier" } },
      { result: "done", seqs: undefined, night: { seq: 2, stage: "curator" } },
    ],
  );
  const order = fake.order().filter((r) => r === "POST /v1/sessions/rotated" || r === "POST /v1/events/ack");
  assert.deepEqual(order, ["POST /v1/events/ack", "POST /v1/sessions/rotated", "POST /v1/events/ack"]);
  assert.deepEqual(fake.sent("POST", "/v1/sessions/rotated"), [
    { agent: "main", seq: 2, stages: {
      reflection: { result: "done", turn_id: turnEnds[1]!.turn_id },
      verifier: { result: "done", turn_id: turnEnds[2]!.turn_id },
      curator: { result: "done", turn_id: turnEnds[3]!.turn_id },
      session: { result: "done" },
    } },
  ]);

  // The new session starts empty, with the handoff in its system prompt.
  fake.push(ui(3, "good morning"));
  await until(() => acked(fake).includes(3));
  const morning = calls.at(-1)!;
  assert.equal(morning.userTexts.length, 1);
  assert.ok(morning.systemPrompt.includes("明日は版上げ。"));
  // Guards against: the day's record written over by the new session. Pi names the files; only their number is ours.
  const sessionsAfter = await readdir(config.sessionDir);
  assert.ok(sessionsBefore.every((name) => sessionsAfter.includes(name)), "the day's record is kept");
  assert.equal(sessionsAfter.filter((name) => !sessionsBefore.includes(name) && name.endsWith(".jsonl")).length, 1, "one new record");
});

test("night workers get the knowledge purpose and only enduring goal guidance", async () => {
  const { fake, start, calls, config } = await world();
  const purpose = join(config.memoryDir, "PURPOSE.md");
  const goals = join(config.memoryDir, "goals");
  const goal = join(goals, "cluster-health.md");
  const today = join(goals, "today.md");
  await mkdir(goals);
  await writeFile(purpose, "What should be known");
  await writeFile(goal, "# Cluster health\n\n## なぜ\nKeep services available\n\n## 今の様子\nA temporary detail");
  await writeFile(today, "# Today's plan\nA temporary task");
  await start(() => ({ text: "ok" }));
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));

  const verifier = calls.find((call) => isVerifier(config, call))!.systemPrompt;
  const curator = calls.find((call) => isCurator(config, call))!.systemPrompt;
  for (const prompt of [verifier, curator]) {
    assert.ok(prompt.includes(purpose));
    assert.ok(prompt.includes(goal));
    assert.ok(prompt.includes("## なぜ"));
    assert.ok(!prompt.includes(today));
    assert.ok(!prompt.includes("A temporary detail"));
  }
  assert.match(verifier, /missing.*today|today.*missing/i);
  assert.match(curator, /answer.*current|current.*answer/i);
});

test("without a knowledge purpose, night workers get the memory skill but no goal guidance", async () => {
  const { fake, start, calls, config } = await world();
  const skillDir = join(config.memoryDir, "skills", "memory");
  const skill = join(skillDir, "SKILL.md");
  const goals = join(config.memoryDir, "goals");
  const goal = join(goals, "cluster-health.md");
  await mkdir(skillDir, { recursive: true });
  await writeFile(skill, "# Memory");
  await mkdir(goals);
  await writeFile(goal, "# Cluster health\n\n## なぜ\nKeep services available");
  await start(() => ({ text: "ok" }));
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));

  for (const worker of [calls.find((c) => isVerifier(config, c))!, calls.find((c) => isCurator(config, c))!]) {
    assert.ok(worker.systemPrompt.includes(skill));
    assert.ok(!worker.systemPrompt.includes(join(config.memoryDir, "PURPOSE.md")));
    assert.ok(!worker.systemPrompt.includes(goal));
  }
});

test("reflection and curation see the total always-read size, and curation starts with the overage priority", async () => {
  const { fake, start, calls, config } = await world();
  const purpose = "何を知っているべきか。";
  config.promptLayerTargetBytes = 25;
  await writeFile(join(config.memoryDir, "PURPOSE.md"), purpose);
  await writeFile(join(config.memoryDir, "always.md"), "keep\n");
  await start(() => ({ text: "ok" }));
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));

  const reflection = calls.find(isReflection)!;
  const curator = calls.find((call) => isCurator(config, call))!;
  for (const worker of [reflection, curator]) {
    const input = worker.userTexts.at(-1)!;
    assert.ok(input.includes(`PURPOSE.md: ${Buffer.byteLength(purpose)} bytes`));
    assert.ok(input.includes(`total: ${5 + Buffer.byteLength(purpose)} bytes; target: 25 bytes`));
  }
  assert.match(curator.userTexts[0]!.split("\n")[0]!, /^First, shorten.*topics.*links/);
});

test("only the curator gets a map of memory reflecting daytime reads across a restart", async () => {
  const { fake, start, calls, config } = await world();
  const topic = join(config.memoryDir, "topic.md");
  await writeFile(topic, "# Topic\nprivate example body\n");
  await writeFile(join(config.memoryDir, "other.md"), "unopened example body\n");
  const stop = await start((call) => call.lastRole === "user" && (!isCurator(config, call) && !isVerifier(config, call))
    ? { calls: [{ tool: "read", args: { path: isReflection(call) ? join(config.memoryDir, "other.md") : topic } }] }
    : { text: "ok" });
  fake.push(ui(1, "read this"));
  await until(() => acked(fake).includes(1));
  fake.push(nightly(2));
  await until(() => acked(fake).includes(2));
  await stop();
  calls.length = 0;
  await start(() => ({ text: "ok" }));
  fake.push(nightly(3));
  await until(() => acked(fake).includes(3));
  const curator = calls.find((call) => isCurator(config, call))!.userTexts[0]!;
  const verifier = calls.find((call) => isVerifier(config, call))!.userTexts[0]!;
  assert.match(curator, /"topic\.md",29,null,null,"\d{4}-\d{2}-\d{2}",1,0/);
  assert.match(curator, /"other\.md",22,null,null,null,0,0/);
  assert.doesNotMatch(curator, /example body/);
  assert.doesNotMatch(verifier, /# Memory map/);
});

test("the verifier receives the full source time window after missed nights", async () => {
  const { fake, start, calls, config } = await world();
  const began = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const file = await newSessionFile(config);
  const header = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, `${JSON.stringify({ ...header, timestamp: began })}\n`);
  await writeState(config, { file });
  await start(() => ({ text: "ok" }));
  const beforeNight = Date.now();
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));

  const input = calls.find((call) => isVerifier(config, call))!.userTexts[0]!;
  const times: string[] = input.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) ?? [];
  assert.ok(times.includes(began));
  assert.ok(times.some((time) => Date.parse(time) >= beforeNight && Date.parse(time) <= Date.now()));
});

test("night workers can read event originals but cannot rewrite them or use shell and backend tools", async () => {
  const { fake, start, calls, config } = await world();
  await mkdir(join(config.sourcesDir, "ui"), { recursive: true });
  const original = join(config.sourcesDir, "ui", "2026-11-14.jsonl");
  await writeFile(original, "original event\n");
  const alias = join(config.memoryDir, "alias.md");
  await symlink(original, alias);
  await start((call) => {
    if (!isVerifier(config, call) || call.lastRole !== "user") return { text: "ok" };
    return { calls: [
      { tool: "read", args: { path: original } },
      { tool: "write", args: { path: original, content: "overwritten" } },
      { tool: "write", args: { path: alias, content: "overwritten" } },
    ] };
  });
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));

  const verifier = calls.find((c) => isVerifier(config, c) && c.lastRole === "toolResult")!;
  assert.ok(JSON.stringify(verifier.messages).includes("original event"));
  assert.equal(await readFile(original, "utf8"), "original event\n");
  for (const worker of [verifier, calls.find((c) => isCurator(config, c))!]) {
    assert.ok(worker.tools.length > 0 && worker.tools.every((tool) => ["read", "write", "edit", "ls", "grep", "find", "move", "remove"].includes(tool)));
  }
});

test("the curator sees changes since the previous night across a runner restart", async () => {
  const { fake, start, calls, config } = await world();
  await writeFile(join(config.memoryDir, "removed.md"), "old");
  await writeFile(join(config.memoryDir, "unchanged.md"), "unchanged");
  const stop = await start(() => ({ text: "ok" }));
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));
  await stop();

  await unlink(join(config.memoryDir, "removed.md"));
  await start((call) => isVerifier(config, call) && call.lastRole === "user"
    ? { calls: [{ tool: "write", args: { path: "verified.md", content: "verified" } }] }
    : { text: "ok" });
  fake.push(nightly(2));
  await until(() => acked(fake).includes(2));
  const curator = calls.filter((c) => isCurator(config, c)).at(-1)!;
  assert.match(curator.userTexts[0]!, /\["removed.md","verified.md"\]/);
});

test("after successful verification the next verifier sees daytime edits, not the previous night's curator edits", async () => {
  const { fake, start, calls, config } = await world();
  await start((call) => isCurator(config, call) && call.lastRole === "user"
    ? { calls: [{ tool: "write", args: { path: "curated.md", content: "reorganized at night" } }] }
    : { text: "ok" });
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));
  await writeFile(join(config.memoryDir, "day.md"), "changed during the day");
  fake.push(nightly(2));
  await until(() => acked(fake).includes(2));

  const verifier = calls.filter((call) => isVerifier(config, call)).at(-1)!;
  assert.match(verifier.userTexts[0]!, /Memory paths changed[^\n]+: \["day\.md"\]/);
});

for (const failed of ["verifier", "curator"] as const) {
  test(`only the ${failed} retries the same memory changes after a failed night stage`, async () => {
    const { fake, start, calls, config } = await world();
    const isFailed = failed === "verifier" ? isVerifier : isCurator;
    const isDone = failed === "verifier" ? isCurator : isVerifier;
    let secondNight = false;
    const stop = await start((call) => {
      if (!secondNight) return { text: "ok" };
      if (isFailed(config, call)) return { error: "the model is away" };
      if (isDone(config, call) && call.lastRole === "user") {
        return { calls: [{ tool: "write", args: { path: "worker.md", content: "written by the successful worker" } }] };
      }
      return { text: "ok" };
    });
    fake.push(nightly(1));
    await until(() => acked(fake).includes(1));
    await writeFile(join(config.memoryDir, "day.md"), "changed during the day");
    secondNight = true;
    fake.push(nightly(2));
    await until(() => acked(fake).includes(2));
    await stop();

    calls.length = 0;
    await start(() => ({ text: "ok" }));
    fake.push(nightly(3));
    await until(() => acked(fake).includes(3));
    const failedInput = calls.find((call) => isFailed(config, call))!.userTexts[0]!;
    const doneInput = calls.find((call) => isDone(config, call))!.userTexts[0]!;
    assert.match(failedInput, /\["day\.md","worker\.md"\]/);
    assert.match(doneInput, /Memory paths changed[^\n]+: \[\]/);
  });
}

test("both workers compare against the legacy night baseline on the first night after upgrade", async () => {
  const { fake, start, calls, config } = await world();
  const file = await newSessionFile(config);
  await writeFile(join(config.memoryDir, "new.md"), "new");
  await writeFile(join(config.sessionDir, "current.json"), JSON.stringify({
    file, nightMemory: [{ path: "removed.md", bytes: 3, sha256: "old" }],
  }));
  await start(() => ({ text: "ok" }));
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));
  for (const worker of [isVerifier, isCurator]) {
    assert.match(calls.find((call) => worker(config, call))!.userTexts[0]!, /\["new\.md","removed\.md"\]/);
  }
});

test("after restart the verifier can use the previous originals until verification succeeds", async () => {
  const { fake, start, calls, config } = await world({ turnFold: false });
  const first = await newSessionFile(config);
  await writeState(config, { file: first });
  const stop = await start((call) => {
    if (isVerifier(config, call)) return { error: "the model is away" };
    if (call.lastRole === "user" && call.tools.includes("subagent_start") && call.lastText.includes("original daytime request")) {
      return { calls: [{ tool: "subagent_start", args: { name: "audit", purpose: "audit", prompt: "original sub-agent request" } }] };
    }
    return { text: "ok" };
  });
  fake.push(ui(1, "original daytime request"));
  await until(() => acked(fake).includes(1) && fake.selfEvents.length === 1);
  const dir = join(config.subAgentDir, "audit");
  const sub = join(dir, (await readdir(dir)).find((name) => name.endsWith(".jsonl"))!);
  fake.push(nightly(2));
  await until(() => acked(fake).includes(2));
  await stop();

  calls.length = 0;
  let checkOriginals = true;
  await start((call) => checkOriginals && isVerifier(config, call) && call.lastRole === "user"
    ? { calls: [
      { tool: "grep", args: { path: first, pattern: "original daytime request" } },
      { tool: "grep", args: { path: sub, pattern: "original sub-agent request" } },
    ] }
    : { text: "ok" });
  fake.push(nightly(3));
  await until(() => acked(fake).includes(3));
  const checked = calls.find((call) => isVerifier(config, call) && call.lastRole === "toolResult")!;
  assert.ok(checked.userTexts[0]!.includes(first) && checked.userTexts[0]!.includes(sub));
  const results = checked.messages.filter((message) => message.role === "toolResult").map((message) => JSON.stringify(message));
  assert.match(results[0]!, /original daytime request/);
  assert.match(results[1]!, /original sub-agent request/);

  checkOriginals = false;
  fake.push(nightly(4));
  await until(() => acked(fake).includes(4));
  const later = calls.filter((call) => isVerifier(config, call)).at(-1)!.userTexts[0]!;
  assert.ok(!later.includes(first) && !later.includes(sub));
});

test("the verifier drops and logs unverified records beyond the configured UTC day window", async () => {
  const { fake, start, calls, config, logs } = await world();
  const expired = await newSessionFile(config);
  const retained = await newSessionFile(config);
  const file = await newSessionFile(config);
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const record = (main: string, daysAgo: number) => ({ main, started: at(daysAgo + 1), ended: at(daysAgo), subAgents: [] });
  config.nightCarryDays = 2;
  await writeFile(join(config.sessionDir, "current.json"), JSON.stringify({
    file, unverifiedRecords: [record(expired, 3), record(retained, 2)],
  }));
  await start((call) => isVerifier(config, call) && call.lastRole === "user"
    ? { calls: [{ tool: "read", args: { path: expired, limit: 1 } }] }
    : { text: "ok" });
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));
  const verifier = calls.find((call) => isVerifier(config, call) && call.lastRole === "toolResult")!;
  const input = verifier.userTexts[0]!;
  assert.ok(input.includes(file) && input.includes(retained) && !input.includes(expired));
  assert.ok(verifier.messages.some((message) => message.role === "toolResult" && message.isError));
  assert.ok(logs.some((line) => line.includes("dropped 1 unverified daytime record")));
});

test("a nightly event that comes again after the switch only tells and acks", async () => {
  const { fake, start, calls, config } = await world();
  fake.dropAcks.add(1);
  const stop = await start(nightWrites(config));
  fake.push(nightly(1));
  await until(() => fake.sent("POST", "/v1/sessions/rotated").length === 1 && acked(fake).includes(1));
  await stop();
  const made = calls.length;

  fake.dropAcks.clear();
  await start(nightWrites(config));
  await until(() => fake.sent("POST", "/v1/sessions/rotated").length === 2);
  await until(() => acked(fake).filter((seq) => seq === 1).length === 2);
  assert.equal(calls.length, made);
  // Guards against: the steps of the night told again as if it had been run again.
  assert.deepEqual(fake.sent("POST", "/v1/sessions/rotated")[1], { agent: "main", seq: 1 });
});

test("a verifier's turn that fails is recorded without skipping the curator or new session", async () => {
  const { fake, start, config } = await world();
  await start((call) => isVerifier(config, call) ? { error: "the model is away" } : nightWrites(config)(call));
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));
  const stages = (fake.sent("POST", "/v1/sessions/rotated") as SessionRotatedRequest[])[0]?.stages;
  assert.equal(stages?.verifier.result, "failed");
  assert.deepEqual([stages?.curator.result, stages?.session.result], ["done", "done"]);
});

test("a curator's turn that fails is told as its step, and the night goes on to a new session", async () => {
  const { fake, start, config } = await world();
  await start((call) => (call.lastRole === "user" && isCurator(config, call) ? { error: "the model is away" } : nightWrites(config)(call)));
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));
  const stages = (fake.sent("POST", "/v1/sessions/rotated") as SessionRotatedRequest[])[0]?.stages;
  assert.equal(stages?.curator.result, "failed");
  assert.match(stages?.curator.reason ?? "", /the model is away/);
  assert.deepEqual([stages?.reflection.result, stages?.session.result], ["done", "done"]);
});

test("a new session that cannot be opened is told as the night's last step, and the night is run again", async () => {
  const { fake, start, calls, config } = await world();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(async (call) => {
    if (call.lastRole === "user" && isCurator(config, call)) await held;
    return nightWrites(config)(call);
  });
  fake.push(nightly(1));
  await until(() => calls.some((c) => isCurator(config, c)));
  // No new session file can be written: the curator's place is made first, so that only hers fails.
  await mkdir(join(config.sessionDir, "curator"), { recursive: true });
  await chmod(config.sessionDir, 0o555);
  closers.push(() => chmod(config.sessionDir, 0o755));
  release();
  await until(() => fake.sent("POST", "/v1/sessions/rotated").length === 1);
  const [first] = fake.sent("POST", "/v1/sessions/rotated") as SessionRotatedRequest[];
  assert.equal(first!.stages?.session.result, "failed");
  assert.ok(first!.stages?.session.reason);
  assert.ok(!acked(fake).includes(1), "the nightly event is not acked");

  await chmod(config.sessionDir, 0o755);
  await until(() => acked(fake).includes(1));
  const rotations = fake.sent("POST", "/v1/sessions/rotated") as SessionRotatedRequest[];
  assert.equal(rotations.length, 2);
  assert.deepEqual(rotations[1]!.stages?.session, { result: "done" });
});

test("an event that comes during the switch waits for the new session", async () => {
  const { fake, start, calls, config } = await world();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(async (call) => {
    if (call.lastRole === "user" && isCurator(config, call)) await held;
    return nightWrites(config)(call);
  });
  fake.push(nightly(1));
  await until(() => calls.some((c) => isCurator(config, c)));
  fake.push(ui(2, "late message"));
  await until(() => fake.polledAfter(2));
  release();
  await until(() => acked(fake).includes(2));
  const late = calls.find((c) => c.userTexts.at(-1)!.includes("late message"))!;
  assert.ok(!isCurator(config, late));
  assert.equal(late.userTexts.length, 1);
});

test("a turn whose model request fails ends as failed, with the reason", async () => {
  const { fake, start } = await world();
  await start(() => ({ error: "the model is away" }));
  fake.push(ui(1, "hello"));
  await until(() => fake.sent("POST", "/v1/turns/end").length === 1);
  const [end] = fake.sent("POST", "/v1/turns/end") as TurnEndRequest[];
  assert.equal(end!.result, "failed");
  assert.match(end!.reason ?? "", /the model is away/);
});

test("a redelivered event after a restart brings the previous model error to the agent", async () => {
  const { fake, start, calls } = await world();
  fake.dropAcks.add(1);
  const stop = await start(() => ({ error: `Too many images. ${"x".repeat(5_000)}` }));
  fake.push(ui(1, "look again"));
  await until(() => acked(fake).includes(1));
  await stop();

  fake.dropAcks.delete(1);
  await start(() => ({ text: "I can see the error now" }));
  await until(() => acked(fake).filter((seq) => seq === 1).length === 2);
  const input = calls.at(-1)!.lastText;
  assert.match(input, /"seq":1/);
  assert.match(input, /previous model request failed.*Too many images\./i);
  assert.ok(input.length < 2_000, "a long provider error does not crowd out the event");
});

test("a turn cut by the runner stopping ends as stopped", async () => {
  const { fake, start, calls } = await world();
  const stop = await start(() => new Promise<Answer>(() => {}));
  fake.push(ui(1, "hello"));
  await until(() => calls.length === 1);
  await stop();
  assert.deepEqual((fake.sent("POST", "/v1/turns/end") as TurnEndRequest[]).map((end) => end.result), ["stopped"]);
});

test("the images of the owner's message go into the turn as images", async () => {
  const { fake, start, calls, config } = await world();
  await mkdir(join(config.sourcesDir, "ui", "files"), { recursive: true });
  const png = join(config.sourcesDir, "ui", "files", "1-shot.png");
  // A 1x1 PNG.
  await writeFile(png, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082", "hex"));
  await start(replying);
  fake.push({ ...ui(1, "look"), attachments: [{ path: png, mime_type: "image/png", size: 70 }] });
  await until(() => acked(fake).includes(1));
  assert.deepEqual(calls[0]!.lastImages, ["image/png"]);
  assert.ok(calls[0]!.lastText.includes(png), "the path is in the text too");
});

for (const limited of [true, false]) {
  test(limited ? "only the newest image is sent when the provider limits images" : "a provider without a limit receives all images", async () => {
    const { fake, start, calls, config } = await world({ turnFold: false });
    await mkdir(config.agentDir, { recursive: true });
    await writeFile(join(config.agentDir, "models.json"), JSON.stringify({
      providers: { [limited ? PROVIDER : "other"]: { maxImagesPerRequest: 1 } },
    }));
    const old = join(config.home, "old.png");
    const read = join(config.home, "read.png");
    const recent = join(config.home, "recent.png");
    for (const path of [old, read, recent]) {
      await writeFile(path, Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082", "hex"));
    }
    await start((call) => call.lastText.includes("read another")
      ? { calls: [{ tool: "read", args: { path: read } }] }
      : { text: "seen" });
    fake.push({ ...ui(1, "first"), attachments: [{ path: old, mime_type: "image/png", size: 70 }] });
    await until(() => acked(fake).includes(1));
    fake.push(ui(2, "read another"));
    await until(() => acked(fake).includes(2));
    fake.push({ ...ui(3, "last"), attachments: [{ path: recent, mime_type: "image/png", size: 70 }] });
    await until(() => acked(fake).includes(3));

    const request = calls.at(-1)!;
    const images = request.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === "image") : []);
    assert.equal(images.length, limited ? 1 : 3);
    if (limited) {
      assert.deepEqual(request.lastImages, ["image/png"]);
      assert.ok(request.userTexts.some((text) => text.includes(`Image omitted from the model request. Read ${JSON.stringify(old)}`)));
      const toolResult = request.messages.find((message) => message.role === "toolResult");
      assert.ok(toolResult?.content.some((part) => part.type === "text" && part.text.includes(`Read ${JSON.stringify(read)}`)));
      const [session] = (await readdir(config.sessionDir)).filter((file) => file.endsWith(".jsonl"));
      const transcript = await readFile(join(config.sessionDir, session!), "utf8");
      assert.equal(transcript.match(/"type":"image"/g)?.length, 3, "the recorded images are still present");
    }
  });
}

test("an event handled already is dropped when it comes again", async () => {
  const { fake, start, calls } = await world();
  await start(replying);
  fake.dropAcks.add(1);
  fake.push(ui(1, "once"));
  await until(() => acked(fake).includes(1));
  // The backend hands it over again, as it does when an ack is lost.
  await until(() => fake.polledAfter(1, 2));
  assert.equal(calls.filter((c) => c.lastRole === "user" && c.lastText.includes("once")).length, 1);
});

test("a now that comes with batched events steers the turn together with them", async () => {
  const { fake, start, calls } = await world();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(async (call) => {
    if (call.lastRole === "user" && call.userTexts.length === 1) {
      return { calls: [{ tool: "bash", args: { command: "echo working" } }] };
    }
    if (call.lastRole === "toolResult" && call.userTexts.length === 1) {
      await held;
      return { calls: [{ tool: "bash", args: { command: "echo more" } }] };
    }
    return { text: "done" };
  });
  fake.push(ui(1, "start"));
  await until(() => calls.length >= 2);
  // One poll hands over the stream and the mention after it, as the backend does.
  fake.push(slack(2, "batch"));
  fake.push(slack(3, "now"));
  await until(() => fake.polledAfter(3));
  release();
  await until(() => acked(fake).includes(3) && acked(fake).includes(2));

  const steered = calls.find((c) => c.userTexts.length === 2)!;
  // Guards against: the batch left behind the now, which then reaches her without the stream before it.
  assert.deepEqual(
    events(steered.userTexts[1]!).map((line) => [line.kind ?? "event", line.seq ?? line.seqs]),
    [
      ["event", 3],
      ["batch", [2]],
    ],
  );
  assert.equal(fake.sent("POST", "/v1/turns/end").length, 1);
});

// ── Folding ended turns ──

// The request is told apart by the text the runner sends, not by its wording.
const isAsk = (text: string) => text.includes(foldAskInput());
const asks = (calls: Call[]) => calls.filter((c) => c.lastRole === "user" && isAsk(c.lastText));
const firstCallOf = (calls: Call[], text: string) => calls.find((c) => c.lastRole === "user" && c.lastText.includes(text))!;

/** Works with the shell and stops without a word; answers the request before folding. */
const silent: Script = (call) => {
  if (call.lastRole === "user" && isAsk(call.lastText)) return { text: "The pods were all up." };
  if (call.lastRole === "user") return { thinking: "check", calls: [{ tool: "bash", args: { command: "echo pods-output" } }] };
  return {};
};

test("a turn that ends without her own text is asked once; then it is folded", async () => {
  const { fake, start, calls, logs } = await world();
  await start(silent);
  fake.push(ui(1, "pods?"));
  await until(() => acked(fake).includes(1));
  assert.equal(asks(calls).length, 1);
  assert.equal(fake.sent("POST", "/v1/turns/end").length, 1, "the request is part of the turn");

  fake.push(ui(2, "thanks"));
  await until(() => acked(fake).includes(2));
  assert.equal(asks(calls).length, 2, "each turn without text is asked once");
  const next = firstCallOf(calls, "thanks");
  const sent = JSON.stringify(next.messages);
  assert.ok(sent.includes("pods?"), "the event stays");
  // Guards against: folding rewriting the events, which stay as the <events> she was given.
  assert.deepEqual(
    events(next.userTexts[0]!).map((line) => [line.seq, line.text]),
    [[1, "pods?"]],
  );
  assert.ok(sent.includes("The pods were all up."), "her answer stays");
  assert.ok(sent.includes("echo pods-output"), "the call stays as a line");
  assert.ok(!sent.includes("pods-output\\n"), "the output goes");
  assert.ok(!isAsk(next.userTexts.join("\n")), "the request goes");
  assert.ok(!sent.includes('"check"'), "the thinking goes");

  // Guards against: the numbers of ADR-0015 missing from the runner's log, or the log carrying what the turns said.
  // The words of the line are the runner's; only the three numbers of each turn are looked at.
  const counts = logs.filter((line) => /folded/.test(line) && /compaction/.test(line));
  assert.equal(counts.length, 2, "one line a turn");
  assert.match(counts[0]!, /folded\D*0\b.*asked\D*yes.*compactions?\D*0\b/);
  assert.match(counts[1]!, /folded\D*1\b.*asked\D*yes.*compactions?\D*0\b/);
  assert.ok(counts.every((line) => !line.includes("pods?") && !line.includes("pods-output")), "no text of the turns");
});

test("Slack's changes are drawn into the turn, and stay drawn once it is folded", async () => {
  // Guards against: Slack's events reaching the turn as raw payloads, or the drawn text lost when the turn is folded (ADR-0029, ADR-0015).
  const { fake, start, calls, config } = await world({ slackSources: ["slack"] });
  const channel = { id: "C0DEV", name: "dev", type: "channel" };
  const message = (ts: string, text: string) => ({ type: "message", workspace: "work", channel, ts, user: { id: "U0ALICE", name: "alice" }, own: false, mention: true, text });
  const lines = [
    { seq: 1, received_at: "2026-11-16T09:00:00Z", occurred_at: "2026-11-16T09:00:00Z", source: "slack", stream: "work.dev", id: "work/C0DEV/1", summary: "work #dev alice: the deploy failed", payload: message("1794819600.000100", "the deploy failed") },
    { seq: 2, received_at: "2026-11-16T09:01:00Z", occurred_at: "2026-11-16T09:01:00Z", source: "slack", stream: "work.dev", id: "work/C0DEV/2", summary: "work #dev alice: can you look?", payload: message("1794819660.000100", "can you look?") },
  ];
  await mkdir(join(config.sourcesDir, "slack", "work.dev"), { recursive: true });
  await writeFile(join(config.sourcesDir, "slack", "work.dev", "2026-11-16.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  await start(silent);
  const mention = lines[1]!;
  fake.push({ ...mention, delivery: "now", inline: true, appended: { path: join(config.sourcesDir, "slack/work.dev/2026-11-16.jsonl"), lines: [2, 2] } });
  await until(() => acked(fake).includes(2));

  fake.push(ui(3, "thanks"));
  await until(() => acked(fake).includes(3));
  const next = firstCallOf(calls, "thanks");
  const [line] = events(next.userTexts[0]!);
  assert.equal(line!.seq, 2);
  assert.match(line!.text as string, /^work #dev \(channel C0DEV, stream work\.dev\)\n/);
  assert.match(line!.text as string, /\(earlier\): "the deploy failed"/, "what led up to it is drawn from /sources");
  assert.match(line!.text as string, /alice \[1794819660\.000100\]: can you look\?/);
  assert.ok(next.systemPrompt.includes("slackctl"));
});

test("no tool runs in the answer to the request before folding", async () => {
  const { fake, start, calls, config } = await world();
  const touched = join(config.home, "touched");
  await start((call) => {
    if (call.lastRole === "user" && isAsk(call.lastText)) {
      return { text: "noted", calls: [{ tool: "bash", args: { command: `touch ${touched}` } }] };
    }
    return silent(call);
  });
  fake.push(ui(1, "pods?"));
  await until(() => acked(fake).includes(1));
  await assert.rejects(readFile(touched));
  const answered = calls.indexOf(asks(calls)[0]!);
  assert.equal(calls.length, answered + 1, "the answer ends with the refused call");
});

test("a turn with her own text is not asked", async () => {
  const { fake, start, calls } = await world();
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  assert.equal(asks(calls).length, 0);
});

function heartbeat(seq: number): DeliveredEvent {
  return {
    seq,
    source: "heartbeat",
    id: `heartbeat@2026-11-14T10:00:00.000Z`,
    occurred_at: "2026-11-14T10:00:00.000Z",
    received_at: "2026-11-14T10:00:00.000Z",
    summary: "no turn for 60 minutes",
    delivery: "now",
    inline: false,
    appended: { path: "/sources/heartbeat/2026-11-14.jsonl", lines: [seq, seq] },
  };
}

/** Stops at once: no tool, no word. */
const idle: Script = (call) => (call.lastRole === "user" && isAsk(call.lastText) ? { text: "nothing" } : {});

test("a heartbeat turn that calls no tool is not asked (ADR-0031)", async () => {
  const { fake, start, calls, logs } = await world();
  await start(idle);
  fake.push(heartbeat(1));
  await until(() => acked(fake).includes(1));
  assert.equal(asks(calls).length, 0);
  assert.equal(calls.length, 1, "one call to the model, not two");
  assert.ok(logs.some((line) => /folded\D*0\b.*asked\D*no/.test(line)));
});

test("a heartbeat turn that calls a tool is asked as any other", async () => {
  const { fake, start, calls } = await world();
  await start(silent);
  fake.push(heartbeat(1));
  await until(() => acked(fake).includes(1));
  assert.equal(asks(calls).length, 1);
});

test("a turn of a heartbeat and other events is asked as any other", async () => {
  const { fake, start, calls } = await world();
  await start(idle);
  fake.push(slack(1, "batch"));
  fake.push(heartbeat(2));
  await until(() => acked(fake).includes(1) && acked(fake).includes(2));
  assert.equal(asks(calls).length, 1);
});

test("a heartbeat turn another event joins is asked as any other", async () => {
  const { fake, start, calls } = await world();
  let pushed = false;
  await start((call) => {
    if (call.lastRole === "user" && isAsk(call.lastText)) return { text: "noted" };
    // The owner's message steers in while the heartbeat's turn runs.
    if (!pushed) {
      pushed = true;
      fake.push(ui(2, "are you there?"));
      return until(() => fake.polledAfter(2)).then(() => ({ thinking: "wait" }));
    }
    return {};
  });
  fake.push(heartbeat(1));
  await until(() => acked(fake).includes(1) && acked(fake).includes(2));
  assert.equal(fake.sent("POST", "/v1/turns/end").length, 1, "the message joined the heartbeat's turn");
  assert.equal(asks(calls).length, 1);
});

test("the reflection of the night is not asked", async () => {
  const { fake, start, calls, config } = await world();
  await start((call) => {
    // The reflection writes and then stops without a word of its own.
    if (isReflection(call)) {
      if (call.lastRole === "user") return { calls: [{ tool: "write", args: { path: join(config.memoryDir, "handoff.md"), content: "明日。\n" } }] };
      return {};
    }
    return nightWrites(config)(call);
  });
  fake.push(nightly(1));
  await until(() => acked(fake).includes(1));
  assert.equal(asks(calls).length, 0);
});

test("with folding off, nothing is asked or folded", async () => {
  const { fake, start, calls } = await world({ turnFold: false });
  await start(silent);
  fake.push(ui(1, "pods?"));
  await until(() => acked(fake).includes(1));
  fake.push(ui(2, "thanks"));
  await until(() => acked(fake).includes(2));
  assert.equal(asks(calls).length, 0);
  const sent = JSON.stringify(firstCallOf(calls, "thanks").messages);
  assert.ok(sent.includes("pods-output\\n"), "the output is still there");
  assert.ok(sent.includes('"check"'), "the thinking is still there");
  assert.ok(!calls[0]!.systemPrompt.includes(FOLDING), "the system prompt says nothing of folding");
});

test("what came before the turn just ended is sent as it was", async () => {
  const { fake, start, calls } = await world();
  await start(silent);
  for (const [seq, text] of [
    [1, "first"],
    [2, "second"],
    [3, "third"],
  ] as const) {
    fake.push(ui(seq, text));
    await until(() => acked(fake).includes(seq));
  }
  const second = firstCallOf(calls, "second").messages;
  const third = firstCallOf(calls, "third").messages;
  assert.deepEqual(third.slice(0, second.length), second);
  assert.ok(third.length < second.length + 6, "the second turn is folded too");
});

test("folding goes on after a restart", async () => {
  const { fake, start, calls } = await world();
  const stop = await start(silent);
  fake.push(ui(1, "first"));
  await until(() => acked(fake).includes(1));
  await stop();
  await start(silent);
  fake.push(ui(2, "second"));
  await until(() => acked(fake).includes(2));
  const sent = JSON.stringify(firstCallOf(calls, "second").messages);
  assert.ok(sent.includes("echo pods-output"), "the call of the first turn stays as a line");
  assert.ok(!sent.includes("pods-output\\n"), "its output goes");
});
