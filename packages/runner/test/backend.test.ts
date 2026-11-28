import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { DeliveredEvent } from "@penelope/contract";

import { Backend, BackendError } from "../src/backend.ts";
import { FakeBackend, TOKEN } from "./fake-backend.ts";

let fake: FakeBackend;
let backend: Backend;

// Each test has a backend of its own, so that what one sent is not seen by the next.
beforeEach(async () => {
  fake = new FakeBackend();
  backend = new Backend({ url: await fake.url, token: TOKEN, agent: "main" });
});
afterEach(() => fake.close());

const event: DeliveredEvent = {
  seq: 1,
  source: "ui",
  id: "m-1",
  occurred_at: "2026-11-14T09:00:00Z",
  received_at: "2026-11-14T09:00:00Z",
  summary: "hi",
  delivery: "now",
  inline: true,
  payload: { text: "hi" },
  appended: { path: "/sources/ui/2026-11-14.jsonl", lines: [1, 1] },
};

test("poll names the agent, the cursor and the wait", async () => {
  fake.push(event);
  assert.deepEqual(await backend.poll(0, 1), [event]);
  const request = fake.received.at(-1)!;
  assert.deepEqual(request.query, { agent: "main", after: "0", wait: "1" });
  assert.equal(request.authorization, `Bearer ${TOKEN}`);
});

test("every body names the agent", async () => {
  await backend.ack([1]);
  await backend.activity([{ kind: "turn_start", at: "t", turn_id: "x" }]);
  await backend.turnEnd({ turn_id: "x" });
  await backend.selfEvent({ id: "e-1", summary: "s", payload: { a: 1 } });
  await backend.rotated({ seq: 7 });
  assert.deepEqual(fake.sent("POST", "/v1/events/ack"), [{ agent: "main", seqs: [1] }]);
  assert.deepEqual(fake.sent("POST", "/v1/activity"), [
    { agent: "main", activities: [{ kind: "turn_start", at: "t", turn_id: "x" }] },
  ]);
  assert.deepEqual(fake.sent("POST", "/v1/turns/end"), [{ agent: "main", turn_id: "x" }]);
  assert.deepEqual(fake.sent("POST", "/v1/self-events"), [{ agent: "main", id: "e-1", summary: "s", payload: { a: 1 } }]);
  assert.deepEqual(fake.sent("POST", "/v1/sessions/rotated"), [{ agent: "main", seq: 7 }]);
});

test("schedules are made, listed and deleted", async () => {
  const made = await backend.createSchedule({ reason: "check CI", cron: "0 9 * * *" });
  assert.deepEqual(made, { id: "s-1", agent: "main", reason: "check CI", cron: "0 9 * * *" });
  assert.deepEqual(await backend.listSchedules(), [made]);
  assert.equal(fake.received.at(-1)!.query.agent, "main");
  await backend.deleteSchedule("s-1");
  assert.deepEqual(await backend.listSchedules(), []);
});

test("a failure carries the status and the backend's error", async () => {
  await assert.rejects(backend.deleteSchedule("missing"), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.status, 404);
    assert.match(error.message, /no such schedule/);
    return true;
  });
  const wrong = new Backend({ url: await fake.url, token: "surrogate", agent: "main" });
  await assert.rejects(wrong.ack([1]), (error: unknown) => error instanceof BackendError && error.status === 401);
});
