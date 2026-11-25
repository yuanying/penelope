// Sub-agents (ADR-0022): the main agent starts them with its tools, the runner
// runs them in the background in sessions of their own, and each time one
// stops the main agent gets a `self` event. These tests drive the main agent
// with the scripted model, the way a deployment's model would.
import assert from "node:assert/strict";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { SelfEventRequest, SubAgentStatus, TurnEndRequest, TurnEvent } from "@penelope/contract";

import { formatEvents } from "../src/turn-input.ts";
import { type FakeBackend, until } from "./fake-backend.ts";
import { OTHER_MODEL, PROVIDER, type Answer, type Call, type Script } from "./fake-model.ts";
import { acked, activities, heartbeat, ui, world } from "./world.ts";

const SUB_AGENT_TOOLS = ["subagent_close", "subagent_list", "subagent_send", "subagent_start"];
const MAIN_ONLY_TOOLS = [...SUB_AGENT_TOOLS, "reply", "reply_to_agent", "schedule_add", "schedule_list", "schedule_remove", "self_event", "job_start", "job_list", "job_stop"];

const isMain = (call: Call) => call.tools.includes("subagent_start");

/** The tool call the owner's message names, as JSON in its text. */
function ordered(call: Call): { tool: string; args: Record<string, unknown> } | undefined {
  const block = /^<events>\n([\s\S]*)\n<\/events>$/.exec(call.lastText)?.[1];
  for (const line of block?.split("\n") ?? []) {
    const event = JSON.parse(line) as { source: string; text?: string };
    if (event.source === "ui" && event.text) return JSON.parse(event.text) as { tool: string; args: Record<string, unknown> };
  }
  return undefined;
}

/**
 * The main agent calls the tool the owner's message names, then stops with a
 * line of text; any other event it only notes. The sub-agents answer by `sub`.
 */
function script(sub: Script): Script {
  return (call) => {
    if (!isMain(call)) return sub(call);
    if (call.lastRole !== "user") return { text: "done" };
    const order = ordered(call);
    return order ? { calls: [order] } : { text: "noted" };
  };
}

let seq = 0;

/** Has the main agent call one tool in a turn of its own; the tool's result. */
async function ask(fake: FakeBackend, tool: string, args: Record<string, unknown> = {}): Promise<{ is_error: boolean; output: string }> {
  const n = ++seq + 1000;
  fake.push(ui(n, JSON.stringify({ tool, args })));
  await until(() => acked(fake).includes(n));
  const results = activities(fake).filter((a) => a.kind === "tool_result");
  const last = results.at(-1) as { is_error: boolean; output: string } | undefined;
  assert.ok(last, `a result of ${tool}`);
  return { is_error: last.is_error, output: last.output };
}

/** The notices the backend took. */
const notices = (fake: FakeBackend) => fake.selfEvents;
const statuses = (fake: FakeBackend) => fake.sent("POST", "/v1/agents") as SubAgentStatus[];
const turnEnds = (fake: FakeBackend, agent: string) => (fake.sent("POST", "/v1/turns/end") as TurnEndRequest[]).filter((end) => end.agent === agent);
const subCalls = (calls: Call[], first: string) => calls.filter((call) => !isMain(call) && call.userTexts[0] === first);

function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release };
}

test("a sub-agent runs in the background, and its last words reach the main agent as a self event", async () => {
  const { fake, start, calls, config } = await world();
  const { held, release } = gate();
  await start(
    script(async () => {
      await held;
      return { text: "Found 3 alerts.\nThe details are in ~/agents/alerts/report.md." };
    }),
  );
  const prompt = formatEvents([{ ...ui(1, "Look at the alerts of today."), answer_via: { tool: "reply" } }]);
  const started = await ask(fake, "subagent_start", { name: "alerts", purpose: "Look at the alerts", prompt });
  // Guards against: a start that waits for the sub-agent to finish, so the main agent cannot answer meanwhile.
  assert.equal(started.is_error, false, started.output);
  assert.equal(notices(fake).length, 0, "the main turn ended while the sub-agent was still running");
  assert.deepEqual(statuses(fake), [{ agent: "alerts", purpose: "Look at the alerts", closed: false }]);
  const cwd = join(config.home, "agents", "alerts");
  assert.ok((await stat(cwd)).isDirectory(), "the working directory left out is made in the home");

  const listed = await ask(fake, "subagent_list");
  assert.deepEqual(JSON.parse(listed.output), [{ name: "alerts", state: "running", purpose: "Look at the alerts", cwd }]);

  release();
  await until(() => notices(fake).length === 1);
  assert.deepEqual(notices(fake), [
    {
      agent: "alerts",
      id: "alerts/1",
      summary: "Found 3 alerts.",
      payload: { reason: "stopped", purpose: "Look at the alerts", text: "Found 3 alerts.\nThe details are in ~/agents/alerts/report.md." },
    },
  ]);
  assert.equal(subCalls(calls, prompt).length, 1, "an event quoted in a delegation does not trigger a reminder");

  // Its activities and the end of its turn are sent as its own, the activity's turn_end before the turn's end.
  const own = activities(fake, "alerts");
  assert.deepEqual([own[0]!.kind, own.at(-1)!.kind], ["turn_start", "turn_end"]);
  assert.ok(own.some((a) => a.kind === "message"));
  const turnId = own[0]!.turn_id;
  assert.ok(own.every((a) => a.turn_id === turnId));
  const ends = fake.received.filter((r) => r.path === "/v1/turns/end" && (r.body as { agent: string }).agent === "alerts");
  // A sub-agent's turn takes no events of the queue: it is told without seqs.
  assert.deepEqual(ends.map((r) => r.body), [{ agent: "alerts", turn_id: turnId, result: "done" }]);
  const lastActivity = fake.received.findLastIndex((r) => r.path === "/v1/activity" && (r.body as { agent: string }).agent === "alerts");
  assert.ok(lastActivity < fake.received.indexOf(ends[0]!), "turn_end is sent before the turn's end");

  const after = await ask(fake, "subagent_list");
  assert.equal(JSON.parse(after.output)[0].state, "waiting");
});

test("a sub-agent uses the deployment's saved model on its own turn", async () => {
  const { fake, start, calls } = await world();
  fake.modelSelection = { model: `${PROVIDER}/${OTHER_MODEL}`, thinking: "low" };
  await start(script(() => ({ text: "ready" })));
  await ask(fake, "subagent_start", { name: "model-check", purpose: "Check the model", prompt: "first" });
  await until(() => notices(fake).length === 1);
  assert.equal(subCalls(calls, "first")[0]?.modelId, OTHER_MODEL);
});

test("the sub-agent's tools are Pi's, without the main agent's own", async () => {
  const { fake, start, calls } = await world();
  await start(script(() => ({ text: "ok" })));
  await ask(fake, "subagent_start", { name: "tools", purpose: "p", prompt: "first" });
  await until(() => notices(fake).length === 1);
  const main = calls.find(isMain)!;
  const sub = subCalls(calls, "first")[0]!;
  // Guards against: a sub-agent that can reply to the owner, answer over A2A, schedule, or start sub-agents of its own.
  for (const tool of MAIN_ONLY_TOOLS) assert.ok(main.tools.includes(tool), `the main agent has ${tool}`);
  for (const tool of MAIN_ONLY_TOOLS) assert.ok(!sub.tools.includes(tool), `the sub-agent has no ${tool}`);
  for (const tool of ["bash", "read", "write", "edit", "codemode"]) assert.ok(sub.tools.includes(tool), `the sub-agent has ${tool}`);
});

test("more words go on in the same session; a closed sub-agent takes none, and its name is not used again", async () => {
  const { fake, start, calls, config } = await world();
  await start(script((call) => ({ text: call.lastText.includes("more") ? "the second answer" : "the first answer" })));
  await ask(fake, "subagent_start", { name: "repo", purpose: "Fix the build", prompt: "Fix the build." });
  await until(() => notices(fake).length === 1);

  const sent = await ask(fake, "subagent_send", { name: "repo", text: "more, please" });
  assert.equal(sent.is_error, false, sent.output);
  await until(() => notices(fake).length === 2);
  assert.deepEqual(notices(fake)[1], {
    agent: "repo",
    id: "repo/2",
    summary: "the second answer",
    payload: { reason: "stopped", purpose: "Fix the build", text: "the second answer" },
  });
  // Guards against: a continuation that starts a session afresh, without what came before.
  const second = subCalls(calls, "Fix the build.").at(-1)!;
  assert.deepEqual(second.userTexts, ["Fix the build.", "more, please"]);

  const closed = await ask(fake, "subagent_close", { name: "repo" });
  assert.equal(closed.is_error, false, closed.output);
  assert.deepEqual(statuses(fake).at(-1), { agent: "repo", purpose: "Fix the build", closed: true });
  assert.deepEqual(JSON.parse((await ask(fake, "subagent_list")).output), []);
  assert.equal((await ask(fake, "subagent_send", { name: "repo", text: "more" })).is_error, true);
  const again = await ask(fake, "subagent_start", { name: "repo", purpose: "again", prompt: "again" });
  assert.equal(again.is_error, true);
  assert.match(again.output, /repo/);

  // The record and the working directory are kept.
  const record = JSON.parse(await readFile(join(config.subAgentDir, "repo", "agent.json"), "utf8"));
  assert.equal(record.state, "closed");
  assert.equal(record.stops, 2);
  assert.ok((await stat(join(config.home, "agents", "repo"))).isDirectory());
});

test("the tools refuse what ADR-0022 refuses, with the reason", async () => {
  const { fake, start, config } = await world();
  const { held, release } = gate();
  await start(
    script(async () => {
      await held;
      return { text: "ok" };
    }),
  );
  const refused = async (tool: string, args: Record<string, unknown>, reason: RegExp) => {
    const result = await ask(fake, tool, args);
    assert.equal(result.is_error, true, `${tool} ${JSON.stringify(args)}: ${result.output}`);
    assert.match(result.output, reason);
  };
  const base = { purpose: "p", prompt: "go" };
  await refused("subagent_start", { ...base, name: "main" }, /main/);
  await refused("subagent_start", { ...base, name: "Big" }, /lowercase/);
  await refused("subagent_start", { ...base, name: "a/b" }, /lowercase/);
  await refused("subagent_start", { ...base, name: "nocwd", cwd: join(config.home, "missing") }, /missing/);
  await refused("subagent_start", { ...base, name: "norole", role: "reviewer" }, /reviewer\.md/);
  await refused("subagent_start", { ...base, name: "badrole", role: "../always" }, /role/);
  await mkdir(join(config.memoryDir, "agents"), { recursive: true });
  await writeFile(join(config.memoryDir, "agents", "broken.md"), "no front matter here\n");
  await refused("subagent_start", { ...base, name: "broken", role: "broken" }, /broken\.md/);
  await refused("subagent_send", { name: "nobody", text: "hi" }, /nobody/);
  await refused("subagent_close", { name: "nobody" }, /nobody/);
  // None of those was started.
  assert.deepEqual(statuses(fake), []);

  await ask(fake, "subagent_start", { ...base, name: "busy" });
  await refused("subagent_start", { ...base, name: "busy" }, /busy/);
  await refused("subagent_send", { name: "busy", text: "hi" }, /running/);
  release();
  await until(() => notices(fake).length === 1);
});

test("the sub-agent's system prompt has its purpose and place, and the role's body or default.md's after it", async () => {
  const { fake, start, calls, config } = await world();
  const agents = join(config.memoryDir, "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(join(agents, "default.md"), "---\nname: default\ndescription: Without a role.\n---\n\nDEFAULT-BODY\n");
  await writeFile(join(agents, "reviewer.md"), "---\nname: reviewer\ndescription: Reviews.\n---\n\nREVIEWER-BODY\n");
  await writeFile(join(config.memoryDir, "always.md"), "ALWAYS-OF-HERS\n");
  const work = join(config.home, "src", "repo");
  await mkdir(work, { recursive: true });
  await start(script(() => ({ text: "ok" })));

  await ask(fake, "subagent_start", { name: "plain", purpose: "PURPOSE-PLAIN", prompt: "plain" });
  await ask(fake, "subagent_start", { name: "review", purpose: "PURPOSE-REVIEW", prompt: "review", role: "reviewer", cwd: work });
  await until(() => notices(fake).length === 2);

  const plain = subCalls(calls, "plain")[0]!.systemPrompt;
  assert.ok(plain.includes("PURPOSE-PLAIN"));
  assert.ok(plain.includes(join(config.home, "agents", "plain")));
  assert.ok(plain.includes("DEFAULT-BODY"));
  assert.ok(!plain.includes("description: Without a role."), "the front matter is not in the prompt");
  // Guards against: her personality and memory reaching the sub-agent.
  assert.ok(!plain.includes("ALWAYS-OF-HERS"));
  const review = subCalls(calls, "review")[0]!.systemPrompt;
  assert.ok(review.includes("REVIEWER-BODY"));
  assert.ok(!review.includes("DEFAULT-BODY"));
  assert.ok(review.includes(work));
});

test("without default.md the sub-agent starts with the fixed part alone, and the start says so", async () => {
  const { fake, start, calls } = await world();
  await start(script(() => ({ text: "ok" })));
  const started = await ask(fake, "subagent_start", { name: "bare", purpose: "p", prompt: "bare" });
  assert.equal(started.is_error, false, started.output);
  assert.match(started.output, /default\.md/);
  await until(() => notices(fake).length === 1);
  assert.equal(subCalls(calls, "bare").length, 1);
});

test("a sub-agent's turns are not folded, and no turn of it is asked before folding", async () => {
  const { fake, start, calls } = await world();
  await start(
    script((call) => {
      if (call.lastText.includes("again")) return { text: "the second" };
      return call.lastRole === "user" ? { calls: [{ tool: "bash", args: { command: "echo SUB-OUT-$((1 + 1))" } }] } : {};
    }),
  );
  await ask(fake, "subagent_start", { name: "nofold", purpose: "p", prompt: "first" });
  await until(() => notices(fake).length === 1);
  // A run with no words of its own: the notice says it stopped, with no text.
  assert.deepEqual(notices(fake)[0]!.payload, { reason: "stopped", purpose: "p", text: "" });
  assert.equal(notices(fake)[0]!.summary, "stopped");

  await ask(fake, "subagent_send", { name: "nofold", text: "again" });
  await until(() => notices(fake).length === 2);
  const sub = calls.filter((call) => !isMain(call));
  // Guards against: the sub-agent's earlier run folded away, or the fold request becoming its last words.
  assert.ok(JSON.stringify(sub.at(-1)!.messages).includes("SUB-OUT-2"), "the tool's output of the first run is still sent");
  assert.ok(!sub.some((call) => call.userTexts.some((text) => text.includes("about to be folded"))));
  assert.deepEqual(notices(fake)[1]!.payload, { reason: "stopped", purpose: "p", text: "the second" });
});

test("a failed run is told to the main agent, and more words try again", async () => {
  const { fake, start } = await world();
  let fail = true;
  await start(script(() => (fail ? { error: "the model is away" } : { text: "back" })));
  await ask(fake, "subagent_start", { name: "flaky", purpose: "p", prompt: "go" });
  await until(() => notices(fake).length === 1);
  const notice = notices(fake)[0]!;
  assert.equal((notice.payload as { reason: string }).reason, "failed");
  assert.match((notice.payload as { text: string }).text, /the model is away/);
  assert.equal(notice.id, "flaky/1");
  const [failed] = turnEnds(fake, "flaky");
  assert.equal(failed!.result, "failed");
  assert.match(failed!.reason ?? "", /the model is away/);

  fail = false;
  assert.equal((await ask(fake, "subagent_send", { name: "flaky", text: "try again" })).is_error, false);
  await until(() => notices(fake).length === 2);
  assert.deepEqual(notices(fake)[1]!.payload, { reason: "stopped", purpose: "p", text: "back" });
});

test("closing a running sub-agent cancels its run, and no notice follows", async () => {
  const { fake, start } = await world();
  await start(script(() => new Promise<Answer>(() => {})));
  await ask(fake, "subagent_start", { name: "long", purpose: "p", prompt: "wait forever" });
  await until(() => activities(fake, "long").length > 0);
  const closed = await ask(fake, "subagent_close", { name: "long" });
  assert.equal(closed.is_error, false, closed.output);
  assert.deepEqual(statuses(fake).at(-1), { agent: "long", purpose: "p", closed: true });
  await until(() => activities(fake, "long").some((a) => a.kind === "turn_end"));
  assert.deepEqual(notices(fake), []);
  await until(() => turnEnds(fake, "long").length === 1);
  assert.equal(turnEnds(fake, "long")[0]!.result, "stopped");
});

test("after a restart, a sub-agent that was running is waiting, interrupted, and goes on from its record", async () => {
  const { fake, start, calls } = await world();
  const stop = await start(script(() => new Promise<Answer>(() => {})));
  await ask(fake, "subagent_start", { name: "cut", purpose: "p", prompt: "the first request" });
  await until(() => calls.some((call) => !isMain(call)));
  const turnId = activities(fake, "cut")[0]!.turn_id;
  await stop();
  assert.deepEqual(notices(fake), [], "no notice while the runner stops");

  await start(script((call) => ({ text: call.lastText.includes("go on") ? "resumed" : "?" })));
  await until(() => notices(fake).length === 1);
  assert.deepEqual(notices(fake)[0], { agent: "cut", id: "cut/1", summary: "interrupted", payload: { reason: "interrupted", purpose: "p", text: "" } });
  // Its status is sent again, and the cut turn is ended for the UI and the commit.
  assert.deepEqual(statuses(fake), [
    { agent: "cut", purpose: "p", closed: false },
    { agent: "cut", purpose: "p", closed: false },
  ]);
  const ended = activities(fake, "cut").filter((a) => a.kind === "turn_end");
  assert.deepEqual(ended.map((a) => a.turn_id), [turnId]);
  assert.deepEqual(turnEnds(fake, "cut").map((end) => [end.turn_id, end.result]), [[turnId, "stopped"]]);
  assert.equal(JSON.parse((await ask(fake, "subagent_list")).output)[0].state, "waiting");

  await ask(fake, "subagent_send", { name: "cut", text: "go on" });
  await until(() => notices(fake).length === 2);
  assert.equal(notices(fake)[1]!.id, "cut/2");
  const last = calls.filter((call) => !isMain(call)).at(-1)!;
  assert.deepEqual(last.userTexts, ["the first request", "go on"]);
});

test("a heartbeat shows a legacy waiting sub-agent with the record's last modification time", async () => {
  const { fake, start, calls, config } = await world({ turnFold: false });
  const dir = join(config.subAgentDir, "legacy");
  const path = join(dir, "agent.json");
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify({
    name: "legacy", purpose: "Check alerts", cwd: config.home, session: join(dir, "session.jsonl"), state: "waiting", stops: 1, pending: [],
  }));
  const modified = new Date("2026-11-14T09:00:00.000Z");
  await utimes(path, modified, modified);

  await start(() => ({ text: "noted" }));
  fake.push(heartbeat(1));
  await until(() => acked(fake).includes(1));
  const line = JSON.parse(calls[0]!.lastText.split("\n")[1]!) as TurnEvent;
  assert.deepEqual(line.pending?.subagents, {
    items: [{ name: "legacy", purpose: "Check alerts", state: "waiting", since: modified.toISOString() }], omitted: 0,
  });
});

test("a notice the backend did not take is sent again with the same id, after a restart too", async () => {
  const { fake, start } = await world();
  const tries = (id: string) => (fake.sent("POST", "/v1/self-events") as SelfEventRequest[]).filter((n) => n.id === id).length;
  fake.failSelfEvents = 2;
  const stop = await start(script(() => ({ text: "the result" })));
  await ask(fake, "subagent_start", { name: "retry", purpose: "p", prompt: "go" });
  await until(() => notices(fake).length === 1);
  // Guards against: a notice lost when the backend is away for a moment, or sent again as a new event.
  assert.equal(tries("retry/1"), 3);

  // One the backend never took before the runner stopped is sent by the next runner.
  fake.failSelfEvents = 1_000_000;
  await ask(fake, "subagent_send", { name: "retry", text: "more" });
  await until(() => tries("retry/2") >= 2);
  await stop();
  fake.failSelfEvents = 0;
  await start(script(() => ({ text: "the result" })));
  await until(() => notices(fake).length === 2);
  assert.deepEqual(notices(fake).map((n) => n.id), ["retry/1", "retry/2"]);
});
