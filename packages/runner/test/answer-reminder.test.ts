import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import type { TurnEndRequest } from "@penelope/contract";

import { foldAskInput } from "../src/prompts.ts";
import { until } from "./fake-backend.ts";
import { acked, ui, world } from "./world.ts";

const reminder = (text: string) => text.includes("No send attempt was seen");
const answer_via = { tool: "reply" };

test("a reminder stays in the same turn, runs only once, and gives new events the next turn", async () => {
  const { fake, start, calls, logs } = await world();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await start(async (call) => {
    if (reminder(call.lastText)) {
      await held;
      return { text: "No reply needed." };
    }
    return { text: "Private draft" };
  });
  fake.push({ ...ui(1, "Private request"), answer_via });
  try {
    await until(() => calls.some((call) => reminder(call.lastText)));
    assert.deepEqual(fake.sent("POST", "/v1/turns/end"), []);
    assert.deepEqual(acked(fake), []);
    fake.push(ui(2, "next turn"));
    await until(() => fake.polledAfter(2));
  } finally {
    release();
  }
  await until(() => acked(fake).includes(2));

  const reminders = calls.filter((call) => reminder(call.lastText));
  assert.equal(reminders.length, 1);
  assert.match(reminders[0]!.lastText, /"seq":1,"source":"ui"/);
  assert.doesNotMatch(reminders[0]!.lastText, /Private draft|Private request/);
  assert.deepEqual((fake.sent("POST", "/v1/turns/end") as TurnEndRequest[]).map((end) => end.seqs), [[1], [2]]);
  assert.deepEqual(logs.filter((line) => line.startsWith("answer reminder: ")), [
    'answer reminder: {"events":[{"seq":1,"source":"ui"}],"attempted":false,"tool_calls":0,"result":"done"}',
  ]);
});

for (const delivery of ["now", "batch"] as const) {
  test(`an answer route actually delivered as a ${delivery === "now" ? "steer" : "follow-up"} counts in the same turn`, async () => {
    const { fake, start, calls } = await world();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await start(async (call) => {
      if (reminder(call.lastText)) return {};
      await held;
      return { text: "Draft" };
    });
    fake.push(ui(1, "start"));
    try {
      await until(() => calls.length > 0);
      fake.push({ ...ui(2, "another", delivery), answer_via });
      await until(() => fake.polledAfter(2));
    } finally {
      release();
    }
    await until(() => acked(fake).includes(2));
    assert.match(calls.find((call) => reminder(call.lastText))?.lastText ?? "", /"seq":2,"source":"ui"/);
    assert.deepEqual((fake.sent("POST", "/v1/turns/end") as TurnEndRequest[]).map((end) => end.seqs), [[1, 2]]);
  });
}

test("one matching tool attempt suppresses the reminder for the entire turn", async () => {
  const { fake, start, calls } = await world();
  await start((call) => call.lastRole === "toolResult"
    ? { text: "Tried to send." }
    : { calls: [{ tool: "reply", args: { text: "hi" } }] });
  fake.refuseReplies = "Delivery failed";
  fake.push({ ...ui(1, "hello"), answer_via });
  fake.push({ ...ui(2, "another"), answer_via: { tool: "reply_to_agent" } });
  await until(() => acked(fake).includes(2));
  assert.equal(calls.length, 2);
});

for (const tool of ["bash", "job_start"]) {
  test(`a failed ${tool} command with the prefix after a pipe is still a send attempt`, async () => {
    const { fake, start, calls } = await world();
    await start((call) => call.lastRole === "toolResult"
      ? { text: "Sending failed." }
      : { calls: [{ tool, args: {
        command: "printf body | no-such-notifier post",
        ...(tool === "job_start" ? { cwd: "directory-that-does-not-exist" } : {}),
      } }] });
    fake.push({ ...ui(1, "hello"), answer_via: { command: "no-such-notifier post" } });
    await until(() => acked(fake).includes(1));
    assert.equal(calls.length, 2);
  });
}


test("a draft before a tool call does not count when the final assistant message has no text", async () => {
  const { fake, start, calls } = await world();
  await start((call) => call.lastRole === "toolResult"
    ? { thinking: "nothing to add", text: " " }
    : { text: "Working on it", calls: [{ tool: "bash", args: { command: "true" } }] });
  fake.push({ ...ui(1, "hello"), answer_via });
  await until(() => acked(fake).includes(1));
  assert.equal(calls.length, 2);
});

test("text first produced by the fold request does not trigger a reminder", async () => {
  const { fake, start, calls, config } = await world();
  await start((call) => {
    if (call.lastText === foldAskInput()) return { text: "Summary for later" };
    if (call.lastRole === "toolResult") return {};
    return { calls: [{ tool: "read", args: { path: join(config.home, "missing.txt") } }] };
  });
  fake.push({ ...ui(1, "hello"), answer_via });
  await until(() => acked(fake).includes(1));
  assert.deepEqual(calls.slice(2).map((call) => call.lastText), [foldAskInput()]);
});

test("a notice can call the usual tools, and its failure is the turn's failure", async () => {
  const { fake, start, logs } = await world();
  await start((call) => {
    if (reminder(call.lastText)) return { calls: [{ tool: "reply", args: { text: "sent" } }] };
    if (call.lastRole === "toolResult") return { error: "Provider unavailable" };
    return { text: "Draft" };
  });
  fake.push({ ...ui(1, "hello"), answer_via });
  await until(() => acked(fake).includes(1));
  assert.equal(fake.sent("POST", "/v1/agent/reply").length, 1);
  assert.equal((fake.sent("POST", "/v1/turns/end") as TurnEndRequest[])[0]?.result, "failed");
  assert.deepEqual(logs.filter((line) => line.startsWith("answer reminder: ")), [
    'answer reminder: {"events":[{"seq":1,"source":"ui"}],"attempted":true,"tool_calls":1,"result":"failed"}',
  ]);
});
