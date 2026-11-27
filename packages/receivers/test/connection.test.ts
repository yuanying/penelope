// A plugin that opens a connection of its own (docs/receivers.md, "プラグインの内側の契約"):
// the receivers start it beside the HTTP server, send what it hands over to
// the intake, and stop it when they close.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import type { AgentStatus, Event } from "@penelope/contract";

import type { Config } from "../src/config.ts";
import type { ConnectionIO } from "../src/plugin.ts";
import { startReceivers } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "receivers-connection-"));
const socket = join(dir, "backend.sock");
const received: { type: string; event: Event }[] = [];
let status = 202;
let agentStatus: AgentStatus = { mood: null, sleep: { state: "awake" }, sleepiness: 8, awake_seconds: 120 };
const notes = new Map<string, unknown>();
let intake: http.Server;

before(async () => {
  intake = http.createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", async () => {
      const type = request.headers["content-type"] ?? "";
      const body = Buffer.concat(parts);
      if (request.method === "GET" && request.url === "/v1/status") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(agentStatus));
        return;
      }
      if (request.url?.startsWith("/v1/heartbeat-notes/")) {
        if (request.method === "PUT") notes.set(request.url, JSON.parse(body.toString("utf8")));
        else if (request.method === "DELETE") notes.delete(request.url);
        else return void response.writeHead(405).end();
        response.writeHead(204).end();
        return;
      }
      const event = type.startsWith("multipart/")
        ? (JSON.parse((await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData()).get("event") as string) as Event)
        : (JSON.parse(body.toString("utf8")) as Event);
      received.push({ type, event });
      response.writeHead(status);
      response.end();
    });
  });
  await new Promise<void>((resolve) => intake.listen(socket, resolve));
});

after(async () => {
  await new Promise<void>((resolve) => intake.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  notes.clear();
  received.length = 0;
  status = 202;
});

/** A connection plugin's activation that hands its io out, and says when it was stopped. */
function activation() {
  const state: { io?: ConnectionIO; stopped: boolean } = { stopped: false };
  const config: Config = {
    listen: { host: "127.0.0.1", port: 0 },
    intake: socket,
    intakeTimeoutMs: 1000,
    activations: [
      {
        name: "chat",
        plugin: "slack",
        source: "slack-work",
        kind: "connection",
        connection: {
          start(io) {
            state.io = io;
            return {
              stop: async () => {
                state.stopped = true;
              },
            };
          },
        },
      },
    ],
  };
  return { config, state };
}

const EVENT = { id: "work/C0DEV/1794819600.000100", occurred_at: "2026-11-16T09:00:00.000Z", summary: "a summary", delivery: "now" as const, payload: { text: "hi" } };

test("each event it hands over goes to the intake with the activation's source, its files beside it", async () => {
  const { config, state } = activation();
  const lines: string[] = [];
  const receivers = await startReceivers(config, { log: (line) => lines.push(line) });
  try {
    assert.ok(state.io, "started");
    const taken = await state.io.deliver([
      { ...EVENT, answer_via: { command: "slackctl post" }, files: [{ name: "a.png", type: "image/png", data: new Uint8Array([1, 2, 3]) }] },
      { ...EVENT, id: "work/C0DEV/1794819600.000200", delivery: "batch" },
    ]);
    assert.equal(taken, true);
    assert.deepEqual(
      received.map(({ type, event }) => [type.split(";")[0], event.source, event.id, event.answer_via]),
      [
        ["multipart/form-data", "slack-work", "work/C0DEV/1794819600.000100", { command: "slackctl post" }],
        ["application/json", "slack-work", "work/C0DEV/1794819600.000200", undefined],
      ],
    );
    assert.equal("files" in received[0]!.event, false);
    state.io.log("connected");
    assert.ok(lines.includes("receivers: connection=chat connected"));
  } finally {
    await receivers.close();
  }
  assert.equal(state.stopped, true);
});

test("a connection plugin can read the latest status again after it changes", async (t) => {
  const { config, state } = activation();
  const receivers = await startReceivers(config);
  t.after(() => receivers.close());

  const before: AgentStatus = { mood: null, sleep: { state: "awake" }, sleepiness: 8, awake_seconds: 120 };
  agentStatus = before;
  assert.deepEqual(await state.io!.readStatus(), before);
  const after: AgentStatus = { ...before, mood: "Ready to sleep", sleep: { state: "asleep", wake_at: EVENT.occurred_at } };
  agentStatus = after;
  assert.deepEqual(await state.io!.readStatus(), after);
});

test("a connection plugin sets and clears its note under its configured source", async (t) => {
  const { config, state } = activation();
  const receivers = await startReceivers(config);
  t.after(() => receivers.close());

  assert.equal(await state.io!.setHeartbeatNote({ reports: 2 }), true);
  assert.deepEqual(notes.get("/v1/heartbeat-notes/slack-work"), { reports: 2 });
  assert.equal(await state.io!.clearHeartbeatNote(), true);
  assert.equal(notes.has("/v1/heartbeat-notes/slack-work"), false);
});

test("it is told when the intake did not take one, and the rest are not sent", async () => {
  const { config, state } = activation();
  const lines: string[] = [];
  const receivers = await startReceivers(config, { log: (line) => lines.push(line) });
  try {
    status = 503;
    assert.equal(await state.io!.deliver([EVENT, { ...EVENT, id: "other" }]), false);
    assert.equal(received.length, 1);
    assert.ok(lines.some((line) => line.startsWith("receivers: connection=chat intake did not take slack-work/work/C0DEV/1794819600.000100: answered 503")));
  } finally {
    await receivers.close();
  }
});
