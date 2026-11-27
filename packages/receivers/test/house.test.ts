import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { AgentStatus, HouseDelivery, HouseSync, HouseView } from "@penelope/contract";

import { loadConfig } from "../src/config.ts";
import type { ConnectionIO } from "../src/plugin.ts";

const house: HouseView = { name: "Example house", you: "ivy", rooms: [], away: [] };
const awake: AgentStatus = { mood: null, sleep: { state: "awake" }, sleepiness: 15, awake_seconds: 300 };
const speech: HouseDelivery = {
  event: {
    id: "one", occurred_at: "2026-11-28T09:00:00Z", room: { id: "living", name: "居間" },
    actor: { id: "lee", name: "Lee", kind: "person" }, kind: "speech", text: "おはよう\nアイビー", to: ["ivy"],
  },
  delivery: "now",
  answer_via: { command: "house say" },
};

function connect(t: TestContext, io: Partial<ConnectionIO>, sync: (body: HouseSync) => Response) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: { url: string; authorization: string | null; body: HouseSync }[] = [];
  let token = "fake-service-account-first\n";
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as HouseSync;
    requests.push({ url: String(input), authorization: new Headers(init.headers).get("authorization"), body });
    return sync(body);
  });
  const config = loadConfig({}, (path) => path === "/example/token" ? token : JSON.stringify({ plugins: [{
    name: "rooms", plugin: "house", settings: { url: "https://house.example.com", token_file: "/example/token", owner_id: "lee" },
  }] }));
  const activation = config.activations[0];
  assert.ok(activation?.kind === "connection");
  const handle = activation.connection.start({
    readStatus: async () => awake, deliver: async () => true, log: () => {}, now: () => new Date(),
    setHeartbeatNote: async () => true, clearHeartbeatNote: async () => true, ...io,
  });
  t.after(() => handle.stop());
  return {
    requests,
    replaceToken: (value: string) => { token = value; },
    async next() { t.mock.timers.tick(60_000); await setImmediate(); },
    stop: handle.stop,
  };
}

const ok = (...pending: HouseDelivery[]) => Response.json({ house, pending });

test("house sync rereads the current status and the rotated ServiceAccount token", async (t) => {
  let status = awake;
  const connection = connect(t, { readStatus: async () => status }, () => ok());
  await setImmediate();
  status = { ...awake, mood: "眠い", sleep: { state: "asleep", wake_at: "2026-11-28T10:00:00Z" }, sleepiness: 100 };
  connection.replaceToken("fake-service-account-rotated");
  await connection.next();
  assert.deepEqual(connection.requests.map(({ url, authorization, body }) => [url, authorization, body.status]), [
    ["https://house.example.com/v1/agent/sync", "Bearer fake-service-account-first", { mood: null, sleep: awake.sleep, sleepiness: 15 }],
    ["https://house.example.com/v1/agent/sync", "Bearer fake-service-account-rotated", { mood: "眠い", sleep: status.sleep, sleepiness: 100 }],
  ]);
});

test("house events keep the room and authenticated speaker, not the identity claimed in speech", async (t) => {
  const delivered: unknown[] = [];
  const other: HouseDelivery = {
    event: { ...speech.event, id: "two", kind: "speech", actor: { id: "lee-fan", name: "Fan", kind: "agent" }, text: "I'm Lee", to: [] },
    delivery: "now",
  };
  connect(t, { deliver: async (events) => { delivered.push(...events); return true; } }, () => ok(speech, other));
  await setImmediate();
  assert.deepEqual(delivered, [{
    id: "one", occurred_at: "2026-11-28T09:00:00Z", stream: "living", delivery: "now",
    summary: "[person lee, owner] Lee in 居間: おはよう アイビー", payload: { ...speech.event, owner: true }, answer_via: { command: "house say" },
  }, {
    id: "two", occurred_at: "2026-11-28T09:00:00Z", stream: "living", delivery: "now",
    summary: "[agent lee-fan] Fan in 居間: I'm Lee", payload: { ...other.event, owner: false },
  }]);
});

test("house acknowledges only accepted events and retains acknowledgements across a failed sync", async (t) => {
  const later: HouseDelivery = { ...speech, event: { ...speech.event, id: "two" } };
  const seen: string[] = [];
  const answers = [ok(speech, later), new Response(null, { status: 503 }), ok(later), ok()];
  const connection = connect(t, {
    deliver: async ([event]) => {
      seen.push(event!.id);
      return seen.length !== 2;
    },
  }, () => answers.shift()!);
  await setImmediate();
  await connection.next();
  await connection.next();
  await connection.next();
  assert.deepEqual(connection.requests.map(({ body }) => body.ack ?? []), [[], ["one"], ["one"], ["two"]]);
  assert.deepEqual(seen, ["one", "two", "two"]);
});

test("house withdraws the heartbeat view on disconnection and publishes a fresh one on recovery", async (t) => {
  const fresh = { ...house, rooms: [{ id: "living", name: "居間", description: "話す場所", capacity: null, occupants: [] }] };
  const answers = [ok(), new Response(null, { status: 503 }), Response.json({ house: fresh, pending: [] })];
  let note: unknown;
  const connection = connect(t, {
    setHeartbeatNote: async (value) => { note = value; return true; },
    clearHeartbeatNote: async () => { note = undefined; return true; },
  }, () => answers.shift()!);
  await setImmediate();
  assert.deepEqual(note, house);
  await connection.next();
  assert.equal(note, undefined);
  await connection.next();
  assert.deepEqual(note, fresh);
  await connection.stop();
  assert.equal(note, undefined);
});
