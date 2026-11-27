import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { HouseAgentStatus, HouseEnterResult, HouseSpeechResult, HouseSyncResult, HouseView } from "@penelope/contract";
import type { SenderCheck } from "@penelope/service-account-auth";

import { parseConfig } from "../src/config.ts";
import { startHouse } from "../src/server.ts";

const awake: HouseAgentStatus = { mood: null, sleepiness: 4, sleep: { state: "awake" } };
const sleeping: HouseAgentStatus = { mood: "quiet", sleepiness: 95, sleep: { state: "falling_asleep", wake_at: "2026-11-27T11:00:00Z" } };
const fixture = {
  name: "Example house",
  listen: { host: "127.0.0.1", port: 0 },
  auth: { gated_assertion: { issuer: "https://gate.example.com", jwks_url: "https://gate.example.com/jwks", public_url: "https://house.example.com" } },
  rooms: [
    { id: "living", name: "居間", description: "A place to talk", capacity: null },
    { id: "bath", name: "風呂", description: "One at a time", capacity: 1 },
  ],
  agents: [
    { id: "ivy", name: "Ivy", service_account: "example/plant" },
    { id: "fern", name: "Fern", service_account: "example/fern" },
    { id: "moss", name: "Moss", service_account: "example/moss" },
  ],
};

const check: SenderCheck = {
  name: "test",
  precedence: 0,
  carries: (headers) => typeof headers["x-test-subject"] === "string",
  async check(headers) {
    return { kind: "subject", subject: `system:serviceaccount:example:${headers["x-test-subject"]}` };
  },
};

async function open(t: TestContext, options: { database?: string; now?: () => number } = {}) {
  const config = parseConfig({ ...fixture, database: options.database ?? ":memory:" });
  const server = await startHouse(config, { checks: [check], now: options.now });
  t.after(server.close);
  const request = (agent: string, path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${server.port}/v1/agent${path}`, {
    method,
    headers: { "x-test-subject": agent, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async <T>(response: Promise<Response>): Promise<T> => {
    const answer = await response;
    assert.equal(answer.status, 200);
    return await answer.json() as T;
  };
  return {
    close: server.close,
    request,
    view: (agent: string) => json<HouseView>(request(agent, "/house")),
    enter: (agent: string, room = "living") => json<HouseEnterResult>(request(agent, `/rooms/${room}/enter`, "POST")),
    say: (agent: string, text: string, to?: string[]) => json<HouseSpeechResult>(request(agent, "/rooms/living/say", "POST", { text, to })),
    sync: (agent: string, status = awake, ack?: string[]) => json<HouseSyncResult>(request(agent, "/sync", "POST", { status, ack })),
  };
}

test("a move to a full room leaves the resident in the old room", async (t) => {
  const house = await open(t);
  await house.enter("fern", "bath");
  await house.enter("plant");

  assert.equal((await house.request("plant", "/rooms/bath/enter", "POST")).status, 409);
  assert.deepEqual((await house.view("plant")).rooms.map((room) => room.occupants.map(({ id }) => id)), [["ivy"], ["fern"]]);
});

test("entering returns only occupants and does not deliver earlier speech", async (t) => {
  const house = await open(t);
  await house.enter("plant");
  await house.say("plant", "Before Fern arrived");

  assert.deepEqual(await house.enter("fern"), { occupants: [
    { id: "ivy", name: "Ivy", kind: "agent", status: null },
    { id: "fern", name: "Fern", kind: "agent", status: null },
  ] });
  assert.deepEqual((await house.sync("fern")).pending, []);
});

test("enter and leave notify the other occupants without notifying an away resident", async (t) => {
  const house = await open(t);
  await house.enter("plant");
  await house.enter("fern");
  assert.equal((await house.request("fern", "/room", "DELETE")).status, 204);

  assert.deepEqual((await house.sync("plant")).pending.map(({ event, delivery }) => [event.kind, event.actor.id, delivery]), [
    ["enter", "fern", "now"], ["leave", "fern", "batch"],
  ]);
  assert.deepEqual((await house.sync("moss")).pending, []);
});

test("speech reaches every eligible listener but only explicit addressees get a reply hint", async (t) => {
  const house = await open(t, { now: () => Date.parse("2026-11-27T10:00:00Z") });
  await house.enter("fern");
  await house.enter("moss");
  await house.enter("plant");
  const { id } = await house.say("plant", "@Moss is in the room", ["fern"]);

  const addressed = (await house.sync("fern")).pending.find(({ event }) => event.id === id);
  assert.deepEqual(addressed, {
    event: { kind: "speech", id, actor: { id: "ivy", name: "Ivy", kind: "agent" }, room: { id: "living", name: "居間" }, occurred_at: "2026-11-27T10:00:00.000Z", text: "@Moss is in the room", to: ["fern"] },
    delivery: "now", answer_via: { command: "house say" },
  });
  const other = (await house.sync("moss")).pending.find(({ event }) => event.id === id);
  assert.equal(other?.delivery, "now");
  assert.equal(other?.answer_via, undefined);
});

test("a resident gets their own speech in batch without a reply hint", async (t) => {
  const house = await open(t);
  await house.enter("plant");
  await house.say("plant", "My words", ["ivy"]);

  const [own] = (await house.sync("plant")).pending;
  assert.equal(own?.event.kind, "speech");
  assert.equal(own?.delivery, "batch");
  assert.equal(own?.answer_via, undefined);
});

test("sleep drops speech permanently but preserves room entry notifications", async (t) => {
  const house = await open(t);
  await house.enter("plant");
  await house.enter("fern");
  await house.sync("fern", sleeping);
  await house.enter("moss");

  const result = await house.say("plant", "While Fern is asleep");
  assert.deepEqual(result.not_delivered, [{ id: "fern", name: "Fern", kind: "agent" }]);
  assert.deepEqual((await house.sync("fern")).pending.map(({ event }) => [event.kind, event.actor.id]), [["enter", "moss"]]);
});

test("the room view hides sleepiness and stops showing a disconnected resident's status", async (t) => {
  let now = Date.parse("2026-11-27T10:00:00Z");
  const house = await open(t, { now: () => now });
  await house.enter("fern");
  await house.sync("fern", sleeping);
  assert.deepEqual((await house.view("plant")).rooms[0]?.occupants[0]?.status, { mood: "quiet", sleep: sleeping.sleep });

  now += 16_000;
  assert.deepEqual((await house.view("plant")).rooms[0]?.occupants, [{ id: "fern", name: "Fern", kind: "agent", status: null }]);
});

test("unacked delivery survives restart with the same id and only the recipient's ack clears it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "penelope-house-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, "house.sqlite");
  const before = await open(t, { database });
  await before.enter("plant");
  await before.enter("fern");
  await before.say("plant", "Keep this until Fern accepts it");
  const [delivery] = (await before.sync("fern")).pending;
  assert.ok(delivery && delivery.event.kind === "speech");
  await before.close();

  const after = await open(t, { database });
  await after.sync("moss", awake, [delivery.event.id]);
  assert.deepEqual((await after.sync("fern")).pending, [delivery]);
  assert.deepEqual((await after.sync("fern", awake, [delivery.event.id])).pending, []);
});

test("pending deliveries expire even though an agent remains in the room", async (t) => {
  let now = Date.parse("2026-11-27T10:00:00Z");
  const house = await open(t, { now: () => now });
  await house.enter("plant");
  await house.enter("fern");
  await house.say("plant", "Old speech");
  now += 24 * 60 * 60 * 1000;

  assert.deepEqual((await house.sync("fern")).pending, []);
  assert.equal((await house.view("fern")).rooms[0]?.occupants.some(({ id }) => id === "fern"), true);
});

test("an unlisted ServiceAccount cannot enter or publish status", async (t) => {
  const house = await open(t);
  assert.equal((await house.request("guest", "/rooms/living/enter", "POST")).status, 401);
  assert.equal((await house.request("guest", "/sync", "POST", { status: awake })).status, 401);
});

test("speech cannot name a different actor in the request", async (t) => {
  const house = await open(t);
  await house.enter("plant");
  assert.equal((await house.request("plant", "/rooms/living/say", "POST", { text: "Spoof", actor: "fern" })).status, 400);
  assert.deepEqual((await house.sync("plant")).pending, []);
});

test("a room identifier must fit the intake stream format", () => {
  assert.throws(() => parseConfig({ ...fixture, rooms: [{ ...fixture.rooms[0], id: "../living" }] }), /rooms\[0\]\.id/);
});

test("a nonempty resident list cannot start without authentication settings", () => {
  assert.throws(() => parseConfig({ ...fixture, auth: {} }), /auth/);
});
