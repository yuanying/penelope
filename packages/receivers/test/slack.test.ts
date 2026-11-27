// The Slack plugin as the receivers load it (docs/receivers.md, "Slack のプラグイン"):
// its settings, and the whole of it against a Web API and a Socket Mode
// server on loopback. Every token and value is made up.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, test } from "node:test";

import { WebSocketServer, type WebSocket } from "ws";

import { SettingsError } from "../src/plugin.ts";
import type { ConnectionEvent, PluginEnv } from "../src/plugin.ts";
import { slack, slackPlugin } from "../src/plugins/slack/index.ts";

const FILES: Record<string, string> = {
  "/app": "xapp-1-made-up-app-token\n",
  "/bot": "xoxb-made-up-bot-token\n",
  "/app2": "xapp-1-made-up-other\n",
  "/bot2": "xoxb-made-up-other\n",
  "/empty": "  \n",
};
const env: PluginEnv = {
  readFile: (path) => {
    const text = FILES[path];
    if (text === undefined) throw new Error("ENOENT: no such file");
    return text;
  },
};
const WORK = { name: "work", app_token_file: "/app", bot_token_file: "/bot" };

function refused(settings: Record<string, unknown>): string {
  try {
    slack.create(settings, env);
  } catch (error) {
    assert.ok(error instanceof SettingsError, String(error));
    return error.message;
  }
  assert.fail("the settings were taken");
}

describe("the Slack plugin's settings", () => {
  test("take one or more workspaces with the defaults", () => {
    assert.equal(slack.kind, "connection");
    assert.equal(typeof slack.create({ workspaces: [WORK] }, env).start, "function");
    slack.create(
      {
        workspaces: [WORK, { name: "home", app_token_file: "/app2", bot_token_file: "/bot2", now_channels: ["ops", "C0OPS"] }],
        backfill_hours: 0,
        max_file_bytes: 1024,
        file_types: ["image/png"],
      },
      env,
    );
  });

  test("refuse what they cannot run with, naming the field and never the key", () => {
    assert.equal(refused({}), "workspaces: must be a list of one or more workspaces");
    assert.equal(refused({ workspaces: [] }), "workspaces: must be a list of one or more workspaces");
    assert.equal(refused({ workspaces: [WORK], extra: 1 }), "extra: not a field of this plugin");
    assert.equal(refused({ workspaces: [{ ...WORK, colour: "red" }] }), "workspaces[0].colour: not a field of a workspace");
    assert.match(refused({ workspaces: [{ ...WORK, name: "Work Space" }] }), /^workspaces\[0\]\.name: /);
    assert.equal(refused({ workspaces: [WORK, { ...WORK, app_token_file: "/app2", bot_token_file: "/bot2" }] }), "workspaces[1].name: work is given twice");
    assert.match(refused({ workspaces: [{ ...WORK, app_token_file: "/missing" }] }), /^workspaces\[0\]\.app_token_file: cannot read \/missing/);
    assert.equal(refused({ workspaces: [{ ...WORK, bot_token_file: "/empty" }] }), "workspaces[0].bot_token_file: /empty is empty");
    assert.equal(refused({ workspaces: [{ ...WORK, app_token_file: "/bot" }] }), "workspaces[0].app_token_file: /bot does not hold an app-level token (xapp-)");
    assert.equal(refused({ workspaces: [{ ...WORK, bot_token_file: "/app" }] }), "workspaces[0].bot_token_file: /app does not hold a bot token (xoxb-)");
    assert.equal(refused({ workspaces: [{ ...WORK, now_channels: "ops" }] }), "workspaces[0].now_channels: must be a list of channel names or IDs");
    assert.equal(refused({ workspaces: [WORK], backfill_hours: -1 }), "backfill_hours: must be an integer of 0 or more");
    assert.equal(refused({ workspaces: [WORK], max_file_bytes: 0 }), "max_file_bytes: must be an integer from 1 to 62914560");
    assert.equal(refused({ workspaces: [WORK], file_types: [""] }), "file_types: must be a list of MIME types");
    for (const message of [refused({ workspaces: [{ ...WORK, app_token_file: "/bot" }] })]) assert.doesNotMatch(message, /made-up/);
  });
});

/** Slack's Web API and Socket Mode, on loopback. */
class FakeSlack {
  readonly api: http.Server;
  readonly socket: WebSocketServer;
  readonly calls: { method: string; token: string; form: URLSearchParams }[] = [];
  readonly acks: string[] = [];
  connections: WebSocket[] = [];

  constructor() {
    this.socket = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.socket.on("connection", (connection) => {
      this.connections.push(connection);
      connection.on("message", (data) => this.acks.push((JSON.parse(data.toString()) as { envelope_id: string }).envelope_id));
      connection.send(JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "A0APP" } }));
    });
    this.api = http.createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on("data", (part: Buffer) => parts.push(part));
      request.on("end", () => {
        const method = (request.url ?? "").replace(/^\/api\//, "");
        const form = new URLSearchParams(Buffer.concat(parts).toString("utf8"));
        this.calls.push({ method, token: (request.headers.authorization ?? "").replace(/^Bearer /, ""), form });
        const json = (value: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (method === "apps.connections.open") return json({ ok: true, url: `ws://127.0.0.1:${(this.socket.address() as AddressInfo).port}/link/?ticket=made-up` });
        if (method === "auth.test") return json({ ok: true, user_id: "U0SELF", bot_id: "B0SELF", team_id: "T0WORK", team: "Work", user: "penelope" });
        if (method === "users.conversations") return json({ ok: true, channels: [{ id: "C0DEV", name: "dev", is_channel: true }], response_metadata: { next_cursor: "" } });
        if (method === "conversations.history") return json({ ok: true, messages: [{ type: "message", user: "U0ALICE", text: "while away", ts: "1794819600.000100" }], has_more: false });
        if (method === "conversations.info") return json({ ok: true, channel: { id: "C0DEV", name: "dev", is_channel: true } });
        if (method === "users.info") return json({ ok: true, user: { id: form.get("user"), name: "alice", profile: { display_name: "Alice" } } });
        json({ ok: false, error: "unknown_method" });
      });
    });
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.api.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => (this.socket.address() ? resolve() : this.socket.once("listening", () => resolve())));
    return `http://127.0.0.1:${(this.api.address() as AddressInfo).port}/api/`;
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.terminate();
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
    this.api.closeAllConnections();
    await new Promise<void>((resolve) => this.api.close(() => resolve()));
  }
}

const until = async (what: string, check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("connects with the app token, fills in with the bot token, and acknowledges each event once the intake took it", async () => {
  const fake = new FakeSlack();
  cleanups.push(() => fake.close());
  const apiUrl = await fake.listen();
  const delivered: ConnectionEvent[][] = [];
  const lines: string[] = [];
  let take = true;
  const handle = slackPlugin({ apiUrl })
    .create({ workspaces: [WORK] }, env)
    .start({
      deliver: async (events) => {
        delivered.push([...events]);
        return take;
      },
      readStatus: async () => undefined,
      setHeartbeatNote: async () => false,
      clearHeartbeatNote: async () => false,
      log: (line) => lines.push(line),
      now: () => new Date("2026-11-16T10:00:00.000Z"),
    });
  cleanups.push(() => handle.stop());

  await until("the fill-in", () => delivered.length === 1);
  assert.deepEqual(
    delivered[0]!.map((event) => event.id),
    ["work/C0DEV/1794819600.000100"],
  );
  const token = (method: string) => fake.calls.find((call) => call.method === method)?.token;
  assert.equal(token("apps.connections.open"), "xapp-1-made-up-app-token");
  assert.equal(token("auth.test"), "xoxb-made-up-bot-token");
  assert.equal(token("conversations.history"), "xoxb-made-up-bot-token");
  assert.equal(fake.calls.find((call) => call.method === "conversations.history")!.form.get("oldest"), String(Date.parse("2026-11-16T09:00:00.000Z") / 1000 - 23 * 3600));

  const send = (id: string, text: string) =>
    fake.connections.at(-1)!.send(
      JSON.stringify({
        envelope_id: id,
        type: "events_api",
        accepts_response_payload: false,
        retry_attempt: 0,
        retry_reason: "",
        payload: {
          team_id: "T0WORK",
          api_app_id: "A0APP",
          type: "event_callback",
          event_id: `Ev${id}`,
          event_time: 1794823200,
          event: { type: "message", channel: "C0DEV", channel_type: "channel", user: "U0ALICE", text, ts: "1794823200.000100" },
        },
      }),
    );
  send("env-1", "live");
  await until("the ack", () => fake.acks.includes("env-1"));
  assert.equal((delivered[1]![0]!.payload as { text: string }).text, "live");

  take = false;
  send("env-2", "not taken");
  await until("the second delivery", () => delivered.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(fake.acks, ["env-1"]);
  assert.ok(lines.some((line) => line === "workspace=work connected"));
  assert.ok(lines.some((line) => /^workspace=work envelope=events_api events=1 dropped=0 taken=false$/.test(line)));
  assert.ok(lines.every((line) => !line.includes("made-up") && !line.includes("live")));
});
