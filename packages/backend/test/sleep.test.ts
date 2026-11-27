import assert from "node:assert/strict";
import { mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { MIGRATIONS, openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { Queue } from "../src/queue.ts";
import { ActivityRecord } from "../src/record.ts";
import { Sleep } from "../src/sleep.ts";
import { Sleepiness } from "../src/sleepiness.ts";
import { Sources } from "../src/sources.ts";
import { FakeClock, tempDir } from "./support.ts";

const minute = 60_000;

function setup(dir: string, clock: FakeClock, log: (line: string) => void = assert.fail) {
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  const timeZone = "Asia/Tokyo";
  const queue = new Queue(db, new Sources(path.join(dir, "sources"), timeZone), {
    now: clock.now, inline: new Set(["control"]), builtinDelivery: {}, timeZone,
    batch: { quietMs: 5 * minute, maxMs: 30 * minute }, redeliverMs: 5 * minute,
  });
  const sleepiness = new Sleepiness(db, clock.now, timeZone);
  const sleep = new Sleep(db, queue, sleepiness, {
    now: clock.now, timeZone, limits: { threshold: 90, defaultMs: 480 * minute, maxMs: 720 * minute },
    notes: () => ({}), log,
  });
  const record = new ActivityRecord(db, new Feed(), { now: clock.now, timeZone, sleepReportTimeoutMs: 60 * minute });
  return { db, queue, sleep, sleepiness, record };
}

test("upgrading starts awake and leaves ordinary queued events intact", (t) => {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-16T09:00:00Z");
  const old = new DatabaseSync(path.join(dir, "backend.sqlite"));
  for (const migration of MIGRATIONS.slice(0, 17)) old.exec(migration);
  old.exec("PRAGMA user_version = 17");
  old.prepare("INSERT INTO sleepiness VALUES (1, ?, NULL, 99, 990, 1000)").run(clock.now());
  const oldQueue = new Queue(old, new Sources(path.join(dir, "sources"), "Asia/Tokyo"), {
    now: clock.now, inline: new Set(["control"]), builtinDelivery: {}, timeZone: "Asia/Tokyo",
    batch: { quietMs: 5 * minute, maxMs: 30 * minute }, redeliverMs: 5 * minute,
  });
  const at = new Date(clock.now()).toISOString();
  oldQueue.accept({ source: "control", id: `nightly@${at}`, occurred_at: at, summary: "old switch", payload: { kind: "nightly" } }, { builtin: true });
  oldQueue.accept({ source: "ui", id: "hello", occurred_at: at, summary: "Hello", payload: null }, { builtin: true });
  old.close();

  const { db, queue, sleep, sleepiness } = setup(dir, clock);
  t.after(() => db.close());
  sleep.start()();
  assert.equal(sleepiness.status().sleep.state, "awake");
  assert.deepEqual(queue.take({ after: 0 }).map(({ id }) => id), ["hello"]);
});

test("startup wakes an overdue persisted sleep exactly once", (t) => {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-16T09:00:00Z");
  const first = setup(dir, clock);
  first.sleep.request(clock.now() + minute);
  const [control] = first.queue.take({ after: 0 });
  first.sleep.completed(control!.seq);
  first.queue.ack([control!.seq]);
  first.db.close();

  clock.advance(10);
  const second = setup(dir, clock);
  second.sleep.start()();
  assert.deepEqual(second.sleepiness.status(), { sleep: { state: "awake" }, sleepiness: 0, awake_seconds: 0 });
  const events = second.queue.take({ after: 0 });
  assert.deepEqual(events.map(({ source }) => source), ["wake"]);
  second.queue.ack(events.map(({ seq }) => seq));
  second.db.close();

  const third = setup(dir, clock);
  t.after(() => third.db.close());
  third.sleep.start()();
  assert.deepEqual(third.queue.take({ after: 0 }), []);
});

test("the first page after wake includes the notice without losing older queued work", (t) => {
  const clock = new FakeClock("2026-11-16T09:00:00Z");
  const { db, queue, sleep } = setup(tempDir(t), clock);
  t.after(() => db.close());
  sleep.request(clock.now() + minute);
  const [control] = queue.take({ after: 0 });
  sleep.completed(control!.seq);
  for (const id of ["one", "two", "three"]) {
    queue.accept({ source: "ui", id, occurred_at: new Date(clock.now()).toISOString(), summary: id, payload: null }, { builtin: true });
  }

  clock.advance(1);
  sleep.tick();
  const first = queue.take({ after: control!.seq, limit: 2 });
  assert.deepEqual(first.map(({ id, source }) => source === "wake" ? source : id), ["one", "wake"]);
  assert.deepEqual(queue.take({ after: first[1]!.seq, limit: 2 }).map(({ id }) => id), ["two", "three"]);
});

test("a failed wake notice write does not keep the agent asleep", (t) => {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-16T09:00:00Z");
  const { db, queue, sleep } = setup(dir, clock, () => {});
  t.after(() => db.close());
  sleep.request(clock.now() + minute);
  const [control] = queue.take({ after: 0 });
  queue.ack([control!.seq]);
  queue.accept({ source: "news", id: "queued", occurred_at: "2026-11-16T09:00:00Z", summary: "News", payload: null });
  const blocked = path.join(dir, "sources", "wake", "2026-11-16.jsonl");
  mkdirSync(blocked, { recursive: true });

  clock.advance(1);
  sleep.tick();
  assert.deepEqual(queue.take({ after: control!.seq }).map(({ source }) => source), ["news"]);
  rmdirSync(blocked);
  sleep.tick();
  assert.deepEqual(queue.take({ after: control!.seq + 1 }).map(({ source }) => source), ["wake"]);
});

test("the safety net uses elapsed awake time after a backend restart without another turn", (t) => {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-16T09:00:00Z");
  setup(dir, clock).db.close();
  clock.advance(22 * 60);

  const { db, queue, sleep, sleepiness } = setup(dir, clock);
  t.after(() => db.close());
  sleep.start()();
  assert.deepEqual(sleepiness.status().sleep, { state: "falling_asleep", wake_at: "2026-11-18T00:00:00.000+09:00" });
  assert.deepEqual(queue.take({ after: 0 }).map(({ source }) => source), ["control"]);
});

test("weekly review counts seven local dates from the last successful review's sleep request", (t) => {
  const clock = new FakeClock("2026-11-17T14:55:00Z"); // Nov 17, 23:55 in Tokyo
  const { db, queue, sleep, record } = setup(tempDir(t), clock);
  t.after(() => db.close());
  sleep.request(clock.now() + 60 * minute);
  const [first] = queue.take({ after: 0 });
  assert.deepEqual(first?.payload, { kind: "nightly", review_date: "2026-11-17" });
  const done = { result: "done" as const };
  clock.advance(10); // The report arrives after local midnight.
  record.nightReported({ seq: first!.seq, stages: {
    reflection: done, verifier: done, curator: { ...done, review: { content: done, structure: done } }, session: done,
  } });
  sleep.completed(first!.seq);

  clock.set("2026-11-23T14:59:00Z"); // Still Nov 23 locally.
  sleep.request(clock.now() + minute);
  const ordinary = queue.take({ after: first!.seq })[0]!;
  assert.deepEqual(ordinary.payload, { kind: "nightly" });
  sleep.completed(ordinary.seq);

  clock.advance(1); // Nov 24 locally, even though less than 7×24 hours have passed.
  sleep.request(clock.now() + minute);
  assert.deepEqual(queue.take({ after: ordinary.seq })[0]?.payload, { kind: "nightly", review_date: "2026-11-24" });
});

test("the next sleep retries a failed weekly review", (t) => {
  const clock = new FakeClock("2026-11-16T09:00:00Z");
  const { db, queue, sleep, record } = setup(tempDir(t), clock);
  t.after(() => db.close());
  sleep.request(clock.now() + minute);
  const [first] = queue.take({ after: 0 });
  const done = { result: "done" as const };
  const failed = { result: "failed" as const };
  record.nightReported({ seq: first!.seq, stages: {
    reflection: done, verifier: done, curator: { ...failed, review: { content: done, structure: failed } }, session: done,
  } });
  queue.ack([first!.seq]);
  clock.advance(2);
  sleep.request(clock.now() + minute);
  assert.deepEqual(queue.take({ after: first!.seq })[0]?.payload, { kind: "nightly", review_date: "2026-11-16" });
});
