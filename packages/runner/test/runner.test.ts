import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { DeliveredEvent, TurnLine } from "@penelope/contract";

import type { Config } from "../src/config.ts";
import { curatorSystemPrompt, FOLDING, foldAskInput, type Places, reflectionInput } from "../src/prompts.ts";
import { until } from "./fake-backend.ts";
import type { Call, Script } from "./fake-model.ts";
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
  assert.deepEqual(fake.sent("POST", "/v1/replies"), [{ agent: "main", text: "hi", in_reply_to: 1 }]);

  const sent = activities(fake);
  const turnId = sent[0]!.turn_id;
  assert.deepEqual(
    sent.map((a) => a.kind),
    ["turn_start", "thinking", "tool_call", "tool_result", "message", "turn_end"],
  );
  assert.ok(sent.every((a) => a.turn_id === turnId));
  assert.deepEqual(fake.sent("POST", "/v1/turns/end"), [{ agent: "main", turn_id: turnId }]);

  const order = fake.order().filter((r) => r !== "POST /v1/activity" && r !== "POST /v1/replies");
  assert.deepEqual(order, ["POST /v1/turns/end", "POST /v1/events/ack"]);
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
  // Guards against: the image's skills not reaching her, or taking the place of a copy a deployment still gives or she wrote.
  assert.ok(prompt.includes("Drawing of the image."));
  assert.ok(prompt.includes("Goals of the owner."));
  assert.ok(!prompt.includes("Goals of the image."));
  assert.ok(prompt.includes("Her own portrait."));
  assert.ok(!prompt.includes("Portrait of the image."));
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

test("the image's connectors are listed beside the deployment's", async () => {
  const { fake, start, calls, config } = await world({ connectors: true });
  await mkdir(config.imageConnectorsDir, { recursive: true });
  await writeFile(join(config.imageConnectorsDir, "a2a.md"), "---\nname: a2a\ndescription: How the a2a CLI is used.\n---\n");
  await mkdir(config.connectorsDir!, { recursive: true });
  await writeFile(join(config.connectorsDir!, "vmapi.md"), "---\nname: vmapi\ndescription: The VM API.\nhosts: [vm.example.com]\n---\n");
  await start(replying);
  fake.push(ui(1, "hello"));
  await until(() => acked(fake).includes(1));
  const prompt = calls[0]!.systemPrompt;
  // Guards against: one of the two places of documents not reaching her.
  assert.ok(prompt.includes(join(config.imageConnectorsDir, "a2a.md")));
  assert.ok(prompt.includes(join(config.connectorsDir!, "vmapi.md")));
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
  assert.equal(fake.sent("POST", "/v1/turns/end").length, 1);
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

const placesOf = (config: Config): Places => ({ memory: config.memoryDir, sources: config.sourcesDir, home: config.home, imageSkills: config.imageSkillsDir });

// The calls of the night are told apart by the prompts the runner gives, so that
// a change of their wording does not change which call is which.
const isCurator = (config: Config, call: Call) =>
  call.systemPrompt.includes(curatorSystemPrompt(config.identity, placesOf(config)).trimEnd());
const isReflection = (config: Config, call: Call) =>
  !isCurator(config, call) && call.userTexts.at(-1)!.includes(reflectionInput(placesOf(config)));

/** The curator writes INDEX.md, the reflection writes handoff.md, and any other turn answers. */
const nightWrites =
  (config: Config): Script =>
  (call) => {
    if (call.lastRole !== "user") return { text: "ok" };
    if (isCurator(config, call)) {
      return { calls: [{ tool: "write", args: { path: join(config.memoryDir, "INDEX.md"), content: "# index\n" } }] };
    }
    if (isReflection(config, call)) {
      return { calls: [{ tool: "write", args: { path: join(config.memoryDir, "handoff.md"), content: "明日は版上げ。\n" } }] };
    }
    return { text: "answered" };
  };

test("the nightly event runs the reflection, the curator and a new session", async () => {
  const { fake, start, calls, config } = await world();
  await start(nightWrites(config));
  fake.push(ui(1, "a day's talk"));
  await until(() => acked(fake).includes(1));
  const sessionsBefore = await readdir(config.sessionDir);
  fake.push(nightly(2));
  await until(() => acked(fake).includes(2));

  assert.equal(await readFile(join(config.memoryDir, "handoff.md"), "utf8"), "明日は版上げ。\n");
  assert.equal(await readFile(join(config.memoryDir, "INDEX.md"), "utf8"), "# index\n");

  const reflection = calls.find((c) => isReflection(config, c))!;
  assert.ok(reflection.userTexts.some((text) => text.includes("a day's talk")), "the reflection is in the day's session");
  const curator = calls.find((c) => isCurator(config, c))!;
  assert.equal(curator.userTexts.length, 1, "the curator starts from an empty context");

  // Three turns were committed: the day's, the reflection and the curator's.
  assert.equal(fake.sent("POST", "/v1/turns/end").length, 3);
  const order = fake.order().filter((r) => r === "POST /v1/sessions/rotated" || r === "POST /v1/events/ack");
  assert.deepEqual(order, ["POST /v1/events/ack", "POST /v1/sessions/rotated", "POST /v1/events/ack"]);
  assert.deepEqual(fake.sent("POST", "/v1/sessions/rotated"), [{ agent: "main" }]);

  // The new session starts empty, with the handoff in its system prompt.
  fake.push(ui(3, "good morning"));
  await until(() => acked(fake).includes(3));
  const morning = calls.at(-1)!;
  assert.equal(morning.userTexts.length, 1);
  assert.ok(morning.systemPrompt.includes("明日は版上げ。"));
  // Guards against: the day's record written over by the new session. Pi names the files; only their number is ours.
  const sessionsAfter = await readdir(config.sessionDir);
  assert.ok(sessionsBefore.every((name) => sessionsAfter.includes(name)), "the day's record is kept");
  assert.equal(sessionsAfter.filter((name) => !sessionsBefore.includes(name) && name !== "curator").length, 1, "one new record");
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
    if (isReflection(config, call)) {
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
