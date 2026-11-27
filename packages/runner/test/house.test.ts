import assert from "node:assert/strict";
import { test } from "node:test";

import type { HouseResident, HouseView } from "@penelope/contract";

import { runHouse } from "../src/house.ts";

const env = { HOUSE_URL: "https://house.example.com", HOUSE_TOKEN: "fake-house-surrogate" };
const fern: HouseResident = { id: "fern", name: "ファーン", kind: "agent", status: {
  mood: "静かにしたい", sleep: { state: "asleep", wake_at: "2026-11-28T10:00:00Z" },
} };

test("house say sends the verbatim text and explicit recipients with the surrogate", async () => {
  const text = "おはよう\n次の行";
  const result = await runHouse(["say", "living", text, "--to", "fern", "--to", "lee"], env, async (url, init) => {
    assert.equal(String(url), "https://house.example.com/v1/agent/rooms/living/say");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fake-house-surrogate");
    assert.deepEqual(JSON.parse(String(init.body)), { text, to: ["fern", "lee"] });
    return Response.json({ id: "example-speech", not_delivered: [fern] });
  });
  assert.equal(result.code, 0, result.stderr);
});

test("house say names residents who did not receive the speech", async () => {
  const result = await runHouse(["say", "living", "おはよう"], env, async () =>
    Response.json({ id: "example-speech", not_delivered: [fern] }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Not delivered \(not awake\):.*ファーン \(fern\)/);
});

test("house status shows which room people occupy and who is away", async () => {
  const house: HouseView = { name: "Example house", you: "ivy", rooms: [
    { id: "living", name: "居間", description: "話す場所", capacity: null, occupants: [fern] },
  ], away: [{ id: "ivy", name: "アイビー", kind: "agent", status: null }] };
  const result = await runHouse(["status"], env, async () => Response.json(house));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /居間 \(living\).*話す場所[\s\S]*ファーン \(fern\)[\s\S]*Away:[\s\S]*アイビー \(ivy\)/);
});

test("house enter shows the occupants with their visible status", async () => {
  const result = await runHouse(["enter", "living"], env, async () => Response.json({ occupants: [fern] }));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /ファーン \(fern\).*asleep until 2026-11-28T10:00:00Z.*静かにしたい/);
});

test("house enter gives a wake time for a resident who is falling asleep", async () => {
  const result = await runHouse(["enter", "living"], env, async () => Response.json({ occupants: [{
    ...fern, status: { mood: null, sleep: { state: "falling_asleep", wake_at: "2026-11-28T10:00:00Z" } },
  }] }));
  assert.match(result.stdout, /falling asleep, wakes at 2026-11-28T10:00:00Z/);
});

test("house leave succeeds with no response body", async () => {
  const result = await runHouse(["leave"], env, async (url, init) => {
    assert.equal(String(url), "https://house.example.com/v1/agent/room");
    assert.equal(init?.method, "DELETE");
    return new Response(null, { status: 204 });
  });
  assert.equal(result.code, 0, result.stderr);
});

test("house has no command for reading chat history", async () => {
  const result = await runHouse(["history", "living"], env, async () => assert.fail("unexpected request"));
  assert.equal(result.code, 2);
});

test("house explains invalid room IDs, resident IDs and speech before sending a request", async () => {
  for (const [args, reason] of [
    [["enter", "居間"], /room ID.*house status/],
    [["say", "living", "x", "--to", "アイビー"], /resident ID.*house status/],
    [["say", "living", "x".repeat(4_001)], /speech text.*4,000/],
  ] as const) {
    const result = await runHouse(args, env, async () => assert.fail("unexpected request"));
    assert.equal(result.code, 2);
    assert.match(result.stderr, reason);
    assert.equal(result.stderr.trimEnd().split("\n").length, 1);
  }
});

test("house say explains a rejected body without printing the remote error body", async () => {
  const result = await runHouse(["say", "living", "hi", "--to", "nobody"], env, async () => new Response("untrusted response", { status: 400 }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 400:.*speech text.*resident ID/);
  assert.doesNotMatch(result.stderr, /untrusted response/);
});

test("house warns that a failed say may have recorded speech before losing its response", async () => {
  const result = await runHouse(["say", "living", "hi"], env, async () => { throw new TypeError("fetch failed"); });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /speech may already have been recorded/);
});

test("house warns that say may have recorded speech when the success response is incomplete", async () => {
  const result = await runHouse(["say", "living", "hi"], env, async () => Response.json({ not_delivered: [] }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /invalid response.*speech may already have been recorded/);
});

test("house enter explains that the room is full without printing the remote error body", async () => {
  const result = await runHouse(["enter", "living"], env, async () => new Response("untrusted response", { status: 409 }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /room is full/);
  assert.doesNotMatch(result.stderr, /untrusted response/);
});
