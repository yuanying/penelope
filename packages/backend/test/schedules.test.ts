import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { openDatabase } from "../src/db.ts";
import { Queue } from "../src/queue.ts";
import { Scheduler, ScheduleError, Schedules } from "../src/schedules.ts";
import { Sources } from "../src/sources.ts";
import { FakeClock, tempDir, unwritable } from "./support.ts";

function setup(t: { after: (fn: () => void) => void }, start = "2026-11-14T08:30:00Z") {
  const dir = tempDir(t);
  const clock = new FakeClock(start);
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  t.after(() => db.close());
  const sourcesDir = path.join(dir, "sources");
  const queue = new Queue(db, new Sources(sourcesDir, "UTC"), {
    now: clock.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { cron: "now" },
    batch: { quietMs: 300_000, maxMs: 1_800_000 },
    timeZone: "UTC",
    redeliverMs: 300_000,
  });
  const schedules = new Schedules(db, { now: clock.now, timeZone: "UTC" });
  const scheduler = new Scheduler(schedules, queue, { now: clock.now, log: () => {} });
  return { clock, queue, schedules, scheduler, sourcesDir };
}

describe("schedules", () => {
  it("are made from a cron expression and listed by agent", (t) => {
    const { schedules } = setup(t);
    const made = schedules.create({ agent: "main", reason: "every morning", cron: "0 9 * * *" });
    assert.ok(made.id.length > 0);
    assert.deepEqual(made, { id: made.id, agent: "main", reason: "every morning", cron: "0 9 * * *" });
    assert.deepEqual(schedules.list("main"), [made]);
    assert.deepEqual(schedules.list("child"), []);
  });

  it("are made for one time", (t) => {
    const { schedules } = setup(t);
    const made = schedules.create({ agent: "main", reason: "once", at: "2026-11-15T09:00:00Z" });
    assert.deepEqual(made, { id: made.id, agent: "main", reason: "once", at: "2026-11-15T09:00:00Z" });
  });

  it("are refused with a cron expression that is not five fields", (t) => {
    const { schedules } = setup(t);
    assert.throws(() => schedules.create({ agent: "main", reason: "x", cron: "0 0 9 * * *" }), ScheduleError);
    assert.throws(() => schedules.create({ agent: "main", reason: "x", cron: "every day" }), ScheduleError);
  });

  it("are refused with a time that is not RFC 3339", (t) => {
    const { schedules } = setup(t);
    assert.throws(() => schedules.create({ agent: "main", reason: "x", at: "tomorrow" }), ScheduleError);
  });

  it("are deleted by id", (t) => {
    const { schedules } = setup(t);
    const made = schedules.create({ agent: "main", reason: "x", cron: "0 9 * * *" });
    assert.equal(schedules.remove(made.id), true);
    assert.equal(schedules.remove(made.id), false);
    assert.deepEqual(schedules.list("main"), []);
  });
});

describe("the scheduler", () => {
  it("queues a cron event when a schedule comes due, and keeps it for the next time", (t) => {
    const { clock, queue, schedules, scheduler } = setup(t);
    const made = schedules.create({ agent: "main", reason: "look at the CI", cron: "0 9 * * *" });
    scheduler.tick();
    assert.deepEqual(queue.take({ after: 0 }), []);
    clock.set("2026-11-14T09:00:00Z");
    scheduler.tick();
    const [fired] = queue.take({ after: 0 });
    assert.equal(fired?.source, "cron");
    assert.equal(fired?.summary, "look at the CI");
    assert.equal(Date.parse(fired!.occurred_at), clock.ms);
    assert.equal(fired?.delivery, "now");
    assert.equal(fired?.inline, false);
    assert.deepEqual(schedules.list("main"), [made]);
    queue.ack([fired!.seq]);
    // The next day's run, not this one again.
    scheduler.tick();
    assert.equal(queue.take({ after: 1 }).length, 0);
    clock.set("2026-11-15T09:00:00Z");
    scheduler.tick();
    const next = queue.take({ after: 1 }).filter((e) => e.source === "cron");
    assert.deepEqual(next.map((e) => Date.parse(e.occurred_at)), [clock.ms]);
  });

  it("writes the schedule's id and reason as the payload", (t) => {
    const { clock, schedules, scheduler, queue } = setup(t);
    const made = schedules.create({ agent: "main", reason: "once", at: "2026-11-14T08:45:00Z" });
    clock.set("2026-11-14T08:45:00Z");
    scheduler.tick();
    const [fired] = queue.take({ after: 0 });
    const line = JSON.parse(readFileSync(fired!.appended.path, "utf8"));
    assert.deepEqual(line.payload, { schedule_id: made.id, reason: "once" });
  });

  it("deletes a one-time schedule once it is queued", (t) => {
    const { clock, schedules, scheduler } = setup(t);
    schedules.create({ agent: "main", reason: "once", at: "2026-11-14T08:45:00Z" });
    clock.set("2026-11-14T08:46:00Z");
    scheduler.tick();
    assert.deepEqual(schedules.list("main"), []);
  });

  it("queues a schedule missed while the backend was down once, not once per run missed", (t) => {
    const { clock, schedules, scheduler, queue } = setup(t);
    schedules.create({ agent: "main", reason: "hourly", cron: "0 * * * *" });
    clock.set("2026-11-14T12:30:00Z");
    scheduler.tick();
    assert.equal(queue.take({ after: 0 }).length, 1);
    scheduler.tick();
    assert.equal(queue.take({ after: 1 }).length, 0);
  });

  it("keeps a schedule due when its event could not be queued", (t) => {
    const { clock, schedules, scheduler, queue, sourcesDir } = setup(t);
    schedules.create({ agent: "main", reason: "a", cron: "0 9 * * *" });
    schedules.create({ agent: "main", reason: "b", at: "2026-11-14T08:31:00Z" });
    clock.set("2026-11-14T08:31:00Z");
    scheduler.tick(); // b, writing the day's file of cron
    queue.ack(queue.take({ after: 0 }).map((e) => e.seq));
    const restore = unwritable(path.join(sourcesDir, "cron/2026-11-14.jsonl"));
    clock.set("2026-11-14T09:00:00Z");
    scheduler.tick();
    restore();
    scheduler.tick();
    assert.deepEqual(queue.take({ after: 1 }).map((e) => e.summary), ["a"]);
  });

});
