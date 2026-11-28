import assert from "node:assert/strict";
import { test } from "node:test";

import type { HouseResident, HouseView } from "@penelope/contract";

import { runHouse } from "../src/house.ts";

const env = { HOUSE_URL: "https://house.example.com", HOUSE_TOKEN: "fake-house-surrogate" };
const fern: HouseResident = { id: "fern", name: "ファーン", kind: "agent", status: {
  mood: "静かにしたい", sleep: { state: "asleep", wake_at: "2026-11-28T10:00:00Z" },
} };

test("house status shows which room people occupy and who is away", async () => {
  const house: HouseView = { name: "Example house", you: "ivy", rooms: [
    { id: "living", name: "居間", description: "話す場所", capacity: null, occupants: [fern] },
  ], away: [{ id: "ivy", name: "アイビー", kind: "agent" }] };
  const result = await runHouse(["status"], env, async () => Response.json(house));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /居間 \(living\).*話す場所[\s\S]*ファーン \(fern\)[\s\S]*Away:\n  アイビー \(ivy\)\n$/);
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

test("house explains invalid room IDs before sending a request", async () => {
  const result = await runHouse(["enter", "居間"], env, async () => assert.fail("unexpected request"));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /room ID.*house status/);
});

test("house has no command for reading chat history", async () => {
  const result = await runHouse(["history", "living"], env, async () => assert.fail("unexpected request"));
  assert.equal(result.code, 2);
});

test("house enter explains that the room is full without printing the remote error body", async () => {
  const result = await runHouse(["enter", "living"], env, async () => new Response("untrusted response", { status: 409 }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /room is full/);
  assert.doesNotMatch(result.stderr, /untrusted response/);
});
