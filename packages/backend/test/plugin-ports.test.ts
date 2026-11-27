import assert from "node:assert/strict";
import path from "node:path";
import { test, type TestContext } from "node:test";

import type { PollResponse } from "@penelope/contract";

import { startBackend } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { ask, FakeClock, tempDir } from "./support.ts";

const headers = { authorization: "Bearer test-token" };

async function start(t: TestContext) {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-28T09:00:00Z");
  const config = loadConfig({
    PENELOPE_DATABASE: path.join(dir, "backend.sqlite"),
    PENELOPE_SOURCES_DIR: path.join(dir, "sources"),
    PENELOPE_MEMORY_DIR: path.join(dir, "memory"),
    PENELOPE_INTAKE_SOCKET: path.join(dir, "intake.sock"),
    PENELOPE_SANDBOX_SOCKET: path.join(dir, "sandbox.sock"),
    PENELOPE_LISTEN: "127.0.0.1:0",
    PENELOPE_SANDBOX_TOKEN_FILE: path.join(dir, "sandbox-token"),
    TZ: "UTC",
  }, () => "test-token");
  const backend = await startBackend(config, { now: clock.now, log: () => {} });
  t.after(() => backend.close());
  return { clock, intake: { socketPath: config.intakeSocket }, sandbox: { socketPath: config.sandboxSocket } };
}

test("the intake returns a fresh copy of the main agent's status without a token", async (t) => {
  const { clock, intake, sandbox } = await start(t);
  const initial = await ask(intake, "/v1/status");
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.json(), { mood: null, sleep: { state: "awake" }, sleepiness: 0, awake_seconds: 0 });

  clock.advance(6 * 60);
  assert.equal((await ask(sandbox, "/v1/mood", { headers, json: { agent: "main", mood: "Calm" } })).status, 204);
  const wake_at = "2026-11-28T16:00:00Z";
  assert.equal((await ask(sandbox, "/v1/sleep", { headers, json: { agent: "main", wake_at } })).status, 200);
  assert.deepEqual((await ask(intake, "/v1/status")).json(), {
    mood: "Calm", sleep: { state: "falling_asleep", wake_at: "2026-11-28T16:00:00.000+00:00" }, sleepiness: 25, awake_seconds: 21_600,
  });
});

test("the wake event carries a deposited note but not one withdrawn at the intake", async (t) => {
  const { clock, intake, sandbox } = await start(t);
  assert.equal((await ask(sandbox, "/v1/sleep", { headers, json: { agent: "main", wake_at: "2026-11-28T09:00:05Z" } })).status, 200);
  assert.equal((await ask(intake, "/v1/heartbeat-notes/room-view", { method: "PUT", json: { visitors: ["Lee"] } })).status, 204);
  assert.equal((await ask(intake, "/v1/heartbeat-notes/builds", { method: "PUT", json: ["passing"] })).status, 204);
  assert.equal((await ask(intake, "/v1/heartbeat-notes/builds", { method: "DELETE" })).status, 204);

  clock.set("2026-11-28T09:00:05Z");
  const { events }: PollResponse = (await ask(sandbox, "/v1/events?agent=main", { headers })).json();
  assert.deepEqual(events.find((event) => event.source === "wake")?.plugin_notes, { "room-view": { visitors: ["Lee"] } });
});

test("the intake counts UTF-8 bytes against the note limit", async (t) => {
  const { intake } = await start(t);
  const pathname = "/v1/heartbeat-notes/room-view";
  assert.equal((await ask(intake, pathname, { method: "PUT", json: "界".repeat(1364) + "ab" })).status, 204);
  assert.equal((await ask(intake, pathname, { method: "PUT", json: "界".repeat(1365) })).status, 413);
});
