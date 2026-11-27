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
  tools = new Map(backendTools(backend, { home }).map((tool) => [tool.name, tool]));
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

test("reply sends the text, the expression and the event it answers", async () => {
  assert.match(await call("reply", { text: "done", expression: "smile", in_reply_to: 13 }), /r-1/);
  assert.deepEqual(fake.sent("POST", "/v1/replies"), [{ agent: "main", text: "done", expression: "smile", in_reply_to: 13 }]);
});

test("reply sends the images it is given, read from their files, in their order", async () => {
  // Guards against: an image she names not reaching the backend, or reaching it as another file's bytes.
  mkdirSync(join(home, "out"));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 2]);
  writeFileSync(join(home, "out", "cat.png"), png);
  writeFileSync(join(home, "dog.jpg"), jpeg);
  assert.match(await call("reply", { text: "描いたよ", images: ["out/cat.png", join(home, "dog.jpg")] }), /r-1/);
  assert.deepEqual(fake.sent("POST", "/v1/replies"), [
    {
      agent: "main",
      text: "描いたよ",
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
  assert.deepEqual(fake.sent("POST", "/v1/replies"), []);
});

test("reply sends nothing for an image over the size limit, and does not read it", async () => {
  // Guards against: a file of any size read into memory and sent through the Sentinel.
  writeFileSync(join(home, "huge.png"), "");
  truncateSync(join(home, "huge.png"), REPLY_IMAGE_MAX_BYTES + 1);
  await assert.rejects(call("reply", { text: "見て", images: ["huge.png"] }), /huge\.png/);
  assert.deepEqual(fake.sent("POST", "/v1/replies"), []);
});

test("reply gives the backend's refusal of an image as its error", async () => {
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
