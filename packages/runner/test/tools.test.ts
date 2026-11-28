import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { REPLY_IMAGE_MAX_BYTES } from "@penelope/contract";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { Backend } from "../src/backend.ts";
import { backendTools } from "../src/tools.ts";
import { FakeBackend, TOKEN } from "./fake-backend.ts";

let fake: FakeBackend;
let tools: Map<string, ToolDefinition>;
let home: string;

// Each test has a backend and a home of its own, so that what one sent is not seen by the next.
beforeEach(async () => {
  fake = new FakeBackend();
  home = mkdtempSync(join(tmpdir(), "runner-tools-"));
  const backend = new Backend({ url: await fake.url, token: TOKEN, agent: "main" });
  tools = new Map(backendTools(backend, { home, house: { origin: new URL(await fake.url), token: TOKEN } }).map((tool) => [tool.name, tool]));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  return fake.close();
});

async function call(name: string, params: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name);
  assert.ok(tool, `no tool ${name}`);
  const result = await tool.execute("c-1", params as never, undefined, undefined, {} as never);
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

test("the tools", () => {
  assert.deepEqual([...tools.keys()].sort(), ["mood", "reply", "reply_to_agent", "schedule_add", "schedule_list", "schedule_remove", "self_event", "sleep"]);
  for (const tool of tools.values()) assert.ok(tool.description.length > 0);
});

test("sleep shows the accepted local wake time and duration when it clamps the request", async () => {
  const requested = "2026-11-17T09:00:00Z";
  const accepted = "2026-11-17T06:00:00+09:00";
  fake.sleepResponse = { wake_at: accepted, duration_seconds: 41_400, clamped: true };
  const result = await call("sleep", { wake_at: requested });
  assert.equal(result, `Wake time clamped to ${accepted} (11h 30m from now) by the maximum sleep duration.`);
  assert.deepEqual(fake.sent("POST", "/v1/sleep"), [{ agent: "main", wake_at: requested }]);
});

test("mood saves the main session's sentence through the backend", async () => {
  const mood = "Calm and curious.";
  assert.equal(await call("mood", { mood }), "Mood set.");
  assert.deepEqual(fake.sent("POST", "/v1/mood"), [{ agent: "main", mood }]);
});

test("reply distinguishes addressees who are absent from those who are not awake", async () => {
  fake.houseReplyResult = {
    id: "s-one", destination: { kind: "room", room: { id: "living", name: "居間" } },
    absent_to: ["moss"], not_delivered: [{ id: "fern", name: "Fern", kind: "agent" }],
  };
  const result = await call("reply", { text: "done", expression: "happy", to: ["fern", "moss"] });
  assert.equal(result, "Sent to 居間 (living), id s-one.\nNot in the room: moss\nNot delivered (not awake): Fern (fern)");
  assert.deepEqual(fake.sent("POST", "/v1/agent/reply"), [{ text: "done", expression: "happy", to: ["fern", "moss"] }]);
});

test("reply reports the ignored to value in a direct conversation even when it is not an array", async () => {
  const to = { resident: "fern" };
  fake.houseReplyResult = {
    id: "s-one", destination: { kind: "dm", dm: { agent_id: "ivy", owner_id: "lee" } },
    ignored_to: to, not_delivered: [],
  };
  const result = await call("reply", { text: "done", to });
  assert.equal(result, 'Sent to your owner (lee) in a direct conversation, id s-one.\nIgnored to: {"resident":"fern"}');
  assert.deepEqual(fake.sent("POST", "/v1/agent/reply"), [{ text: "done", to }]);
});

test("reply accepts 20,000 characters but does not send a longer message", async () => {
  const text = "あ".repeat(20_000);
  await assert.rejects(call("reply", { text: text + "い" }), /20000/);
  assert.match(await call("reply", { text }), /^Sent to /);
  assert.deepEqual(fake.sent("POST", "/v1/agent/reply"), [{ text }]);
});

test("reply sends nothing when the text is blank and there are no images", async () => {
  await assert.rejects(call("reply", { text: " \n", images: [] }), /text or an image/);
  assert.deepEqual(fake.sent("POST", "/v1/agent/reply"), []);
});

test("reply does not resend a speech whose confirmation could not be read", async () => {
  fake.houseReplyResult = { id: "s-one" };
  await assert.rejects(call("reply", { text: "done" }), /may already have been recorded/);
  assert.deepEqual(fake.sent("POST", "/v1/agent/reply"), [{ text: "done" }]);
});

test("reply treats a house server error as an unconfirmed delivery", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  await assert.rejects(call("reply", { text: "done" }), /may already have been recorded/);
});

test("reply treats a transport error as an unconfirmed delivery", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("connection closed"); });
  await assert.rejects(call("reply", { text: "done" }), /may already have been recorded/);
});

test("reply accepts a confirmed room delivery with an extra field", async () => {
  fake.houseReplyResult = {
    id: "s-one", destination: { kind: "room", room: { id: "living", name: "居間" } },
    absent_to: [], not_delivered: [], ignored_to: ["fern"],
  };
  assert.equal(await call("reply", { text: "done" }), "Sent to 居間 (living), id s-one.");
});

test("reply without a configured house fails without sending to the backend", async () => {
  const backend = new Backend({ url: await fake.url, token: TOKEN, agent: "main" });
  tools = new Map(backendTools(backend, { home }).map((tool) => [tool.name, tool]));
  await assert.rejects(call("reply", { text: "done" }), /house is not configured/);
  assert.deepEqual(fake.order(), []);
});

test("reply sends images in order even when given no text", async () => {
  mkdirSync(join(home, "out"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 2]);
  writeFileSync(join(home, "out", "cat.png"), png);
  writeFileSync(join(home, "dog.jpg"), jpeg);
  assert.match(await call("reply", { images: ["out/cat.png", join(home, "dog.jpg")] }), /r-1/);
  assert.deepEqual(fake.sent("POST", "/v1/agent/reply"), [
    {
      text: "",
      images: [
        { name: "cat.png", data: png.toString("base64") },
        { name: "dog.jpg", data: jpeg.toString("base64") },
      ],
    },
  ]);
});

test("reply sends nothing when an image cannot be read, and says which", async () => {
  // Guards against: a reply that reaches the owner without an image she meant to show.
  writeFileSync(join(home, "ok.png"), "x");
  mkdirSync(join(home, "folder"));
  await assert.rejects(call("reply", { text: "見て", images: ["ok.png", "missing.png"] }), /missing\.png/);
  await assert.rejects(call("reply", { text: "見て", images: ["folder"] }), /folder/);
  await assert.rejects(call("reply", { text: "見て", images: ["1", "2", "3", "4", "5"] }), /at most 4/);
  assert.deepEqual(fake.sent("POST", "/v1/agent/reply"), []);
});

test("reply sends nothing for an image over the size limit, and does not read it", async () => {
  // Guards against: a file of any size read into memory and sent through the Sentinel.
  writeFileSync(join(home, "huge.png"), "");
  truncateSync(join(home, "huge.png"), REPLY_IMAGE_MAX_BYTES + 1);
  await assert.rejects(call("reply", { text: "見て", images: ["huge.png"] }), /huge\.png/);
  assert.deepEqual(fake.sent("POST", "/v1/agent/reply"), []);
});

test("reply gives the house's refusal of an image as its error", async () => {
  fake.refuseReplies = "not sent: image 1 (notes.png) is not a PNG, JPEG, GIF or WebP image";
  writeFileSync(join(home, "notes.png"), "just text");
  await assert.rejects(call("reply", { text: "見て", images: ["notes.png"] }), /notes\.png\) is not a PNG/);
});

test("reply_to_agent answers in the task of the a2a event it names", async () => {
  // Guards against: her answer to another agent not reaching the backend's reply path, or a refusal taken as sent.
  assert.match(await call("reply_to_agent", { in_reply_to: 7, state: "input-required", text: "Which one?" }), /input-required/);
  assert.match(await call("reply_to_agent", { in_reply_to: 7, state: "completed" }), /completed/);
  assert.deepEqual(fake.sent("POST", "/v1/a2a/replies"), [
    { agent: "main", in_reply_to: 7, state: "input-required", text: "Which one?" },
    { agent: "main", in_reply_to: 7, state: "completed" },
  ]);
  await assert.rejects(call("reply_to_agent", { in_reply_to: 404, state: "completed" }), /404/);
});

test("reply_to_agent uploads the bytes of a sandbox image as the completed answer", async () => {
  const image = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  writeFileSync(join(home, "diagram.gif"), image);
  assert.match(await call("reply_to_agent", { in_reply_to: 7, state: "completed", images: ["diagram.gif"] }), /completed/);
  assert.deepEqual(fake.sent("POST", "/v1/a2a/replies"), [{
    agent: "main", in_reply_to: 7, state: "completed", images: [{ name: "diagram.gif", data: image.toString("base64") }],
  }]);
});

test("schedules are added, listed and removed", async () => {
  const added = JSON.parse(await call("schedule_add", { reason: "look at CI", at: "2026-11-15T09:00:00Z" }));
  assert.deepEqual(added, { id: "s-1", agent: "main", reason: "look at CI", at: "2026-11-15T09:00:00Z" });
  assert.deepEqual(JSON.parse(await call("schedule_list", {})), [added]);
  await call("schedule_remove", { id: "s-1" });
  assert.deepEqual(JSON.parse(await call("schedule_list", {})), []);
});

test("a schedule takes a cron expression or a time, not both", async () => {
  await assert.rejects(call("schedule_add", { reason: "x" }), /cron or at/);
  await assert.rejects(call("schedule_add", { reason: "x", cron: "0 9 * * *", at: "2026-11-15T09:00:00Z" }), /cron or at/);
});

test("self_event sends the event to herself", async () => {
  await call("self_event", { id: "e-1", summary: "the build is done", payload: { ok: true } });
  await call("self_event", { id: "e-2", summary: "no payload" });
  assert.deepEqual(fake.sent("POST", "/v1/self-events"), [
    { agent: "main", id: "e-1", summary: "the build is done", payload: { ok: true } },
    { agent: "main", id: "e-2", summary: "no payload", payload: null },
  ]);
});

test("a failure of the backend is the tool's error", async () => {
  await assert.rejects(call("schedule_remove", { id: "missing" }), /404/);
});
