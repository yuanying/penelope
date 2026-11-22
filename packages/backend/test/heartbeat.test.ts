import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { Activity } from "@penelope/contract";

import { Inbox } from "../src/a2a/inbox.ts";
import { Assets } from "../src/assets.ts";
import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { Heartbeat } from "../src/heartbeat.ts";
import { Queue } from "../src/queue.ts";
import { ActivityRecord } from "../src/record.ts";
import { cronOf } from "../src/schedules.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours, iso } from "../src/time.ts";
import { FakeClock, tempDir } from "./support.ts";

const QUIET_MINUTES = 60;

function setup(
  t: { after: (fn: () => void) => void },
  { start = "2026-11-16T09:00:00Z", awake = "07:00-23:00", quietMs = QUIET_MINUTES * 60_000 } = {},
) {
  const dir = tempDir(t);
  const clock = new FakeClock(start);
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  t.after(() => db.close());
  const awakeHours = new AwakeHours(awake, "UTC");
  const queue = new Queue(db, new Sources(path.join(dir, "sources"), "UTC"), {
    now: clock.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { ui: "now", cron: "now", a2a: "now", self: "now" },
    batch: { quietMs: 5 * 60_000, maxMs: 30 * 60_000 },
    awake: awakeHours,
    redeliverMs: 5 * 60_000,
  });
  const feed = new Feed();
  const conversation = new Conversation(db, feed, { now: clock.now });
  const record = new ActivityRecord(db, feed, { now: clock.now, timeZone: "UTC", nightly: cronOf("0 0 * * *", "UTC") });
  const inbox = new Inbox(db, queue, {
    assets: new Assets(db, path.join(dir, "assets"), { now: clock.now }),
    now: clock.now,
    limits: { maxOpenTasks: 3, deadlineMs: 120 * 60_000 },
  });
  const heartbeat = new Heartbeat(queue, conversation, { now: clock.now, quietMs, awake: awakeHours, log: () => {}, inbox, record });
  let turns = 0;
  /** The runner's blocks of one turn: its start, or its end. */
  const turn = (kind: "turn_start" | "turn_end") => {
    if (kind === "turn_start") turns++;
    const activity: Activity = { kind, at: iso(clock.ms), turn_id: `turn-${turns}` };
    conversation.activities("main", [activity]);
  };
  /** Takes what is due and acks it, as the runner does at a turn's end. */
  const takeAll = () => {
    const events = queue.take({ after: 0 });
    queue.ack(events.map((event) => event.seq));
    return events;
  };
  return { clock, queue, conversation, heartbeat, inbox, record, turn, takeAll };
}

describe("the heartbeat", () => {
  it("is queued once the awake hours have gone the set minutes since the last turn ended", (t) => {
    const { clock, queue, heartbeat, turn } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES - 1);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }), []);

    clock.advance(1);
    heartbeat.tick();
    const [event, ...more] = queue.take({ after: 0 });
    assert.deepEqual(more, []);
    assert.equal(event?.source, "heartbeat");
    assert.equal(event?.delivery, "now");
    assert.equal(event?.id, "heartbeat@2026-11-16T10:00:00.000Z");
    assert.equal(Date.parse(event!.occurred_at), clock.ms);
    assert.equal(event?.summary, "no turn for 60 minutes");
    assert.equal(event?.inline, false);
    assert.ok(event && !("pending" in event));
  });

  it("writes since when it counted and how long it waited as the payload", (t) => {
    const { clock, heartbeat, turn, queue } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES);
    heartbeat.tick();
    const { appended } = queue.take({ after: 0 })[0]!;
    // The payload is not handed over (heartbeat is not inline); it is in /sources.
    const line = JSON.parse(readFileSync(appended.path, "utf8").split("\n")[appended.lines[0] - 1]!);
    assert.deepEqual(line.payload, { since: "2026-11-16T09:00:00.000Z", quiet_minutes: QUIET_MINUTES });
  });

  it("includes only unexpired open A2A tasks and points to the sender's latest event", (t) => {
    const { clock, heartbeat, inbox, takeAll } = setup(t);
    inbox.receive("old", { messageId: "expired", text: "Expired request" });
    takeAll();
    clock.advance(60);
    const working = inbox.receive("helper", { messageId: "request", text: "Original request" });
    const waiting = inbox.receive("helper", { messageId: "waiting", text: "Waiting request" });
    const closed = inbox.receive("helper", { messageId: "closed", text: "Finished request" });
    const [request, question, finished] = takeAll();
    inbox.reply({ in_reply_to: request!.seq, state: "input-required", text: "Which one?" });
    inbox.reply({ in_reply_to: question!.seq, state: "input-required", text: "When?" });
    inbox.reply({ in_reply_to: finished!.seq, state: "completed" });
    clock.advance(1);
    const answerAt = iso(clock.ms);
    inbox.receive("helper", { taskId: working.taskId, messageId: "answer", text: "x".repeat(201) + "\nDo not include this body" });
    const [answer] = takeAll();
    clock.advance(59);
    heartbeat.tick();
    const [event] = takeAll();
    assert.deepEqual(event?.pending?.a2a_tasks, {
      items: [
        { sender: "helper", state: "input-required", task_id: waiting.taskId, since: question!.received_at, seq: question!.seq, summary: "Waiting request" },
        { sender: "helper", state: "working", task_id: working.taskId, since: answerAt, seq: answer!.seq, summary: "x".repeat(199) + "…" },
      ],
      omitted: 0,
    });
  });

  it("counts the open tasks that do not fit in the heartbeat", (t) => {
    const { clock, heartbeat, inbox, takeAll } = setup(t);
    for (let i = 0; i < 7; i++) inbox.receive(`helper-${i}`, { messageId: "request", text: `Request ${i}` });
    const tasks = takeAll();
    clock.advance(60);
    heartbeat.tick();
    const [event] = takeAll();
    assert.deepEqual(event?.pending?.a2a_tasks?.items.map(({ seq }) => seq), tasks.slice(0, 5).map(({ seq }) => seq));
    assert.equal(event?.pending?.a2a_tasks?.omitted, 2);
  });

  it("only includes failures recorded after the previous heartbeat was queued", (t) => {
    const { clock, heartbeat, record, takeAll } = setup(t);
    clock.advance(60);
    record.turnEnded("main", { turn_id: "already-known", result: "failed", reason: "Previous failure" });
    heartbeat.tick();
    // The report comes while the heartbeat is still queued, not yet delivered or acked.
    clock.advance(1);
    const at = iso(clock.ms);
    record.turnEnded("main", { turn_id: "new-failure", result: "failed", reason: "Model failed\nDetails" });
    takeAll();
    clock.advance(59);
    heartbeat.tick();
    const [event] = takeAll();
    assert.deepEqual(event?.pending?.failures, { items: [{ kind: "turn", at, reason: "Model failed" }], omitted: 0 });
  });

  it("bounds the first heartbeat's failure lookup to one quiet interval", (t) => {
    const { clock, heartbeat, record, takeAll } = setup(t);
    clock.advance(1);
    record.turnEnded("main", { turn_id: "older", result: "failed" });
    clock.advance(60);
    const at = iso(clock.ms);
    record.turnEnded("main", { turn_id: "recent", result: "failed" });
    heartbeat.tick();
    assert.deepEqual(takeAll()[0]?.pending?.failures, { items: [{ kind: "turn", at }], omitted: 0 });
  });

  it("uses activity-record failures without including interrupted work or nightly results", (t) => {
    const { clock, heartbeat, record, takeAll } = setup(t);
    clock.advance(59);
    const at = iso(clock.ms);
    record.turnEnded("main", { turn_id: "stopped", result: "stopped" });
    record.turnEnded("main", { turn_id: "night", result: "failed", night: { seq: 123, stage: "reflection" } });
    const job = { command: "example command", started_at: at, ended_at: at, seconds: 0 };
    record.jobEnded("interrupted", { ...job, end: "interrupted" });
    record.jobEnded("failed", { ...job, end: "exited", exit_code: 2 });
    clock.advance(1);
    heartbeat.tick();
    const [event] = takeAll();
    assert.deepEqual(event?.pending?.failures, { items: [{ kind: "job", at, command: "example command", exit_code: 2 }], omitted: 0 });
  });

  it("shares the five newest failure slots between turns and jobs", (t) => {
    const { clock, heartbeat, record, takeAll } = setup(t);
    const times: string[] = [];
    for (let i = 0; i < 8; i++) {
      clock.advance(8);
      const at = iso(clock.ms);
      times.unshift(at);
      if (i % 2 === 0) record.turnEnded("main", { turn_id: `failed-${i}`, result: "failed" });
      else record.jobEnded(`failed-${i}`, { command: "example", started_at: at, ended_at: at, seconds: 0, end: "timed-out" });
    }
    heartbeat.tick();
    const failures = takeAll()[0]?.pending?.failures;
    assert.deepEqual(failures?.items.map(({ at }) => at), times.slice(0, 5));
    assert.equal(failures?.omitted, 3);
  });

  it("still delivers the other pending work when one lookup fails", (t) => {
    const { clock, heartbeat, inbox, record, takeAll } = setup(t);
    t.mock.method(record, "heartbeatFailures", () => {
      throw new Error("cannot read failures");
    });
    inbox.receive("helper", { messageId: "request", text: "Open request" });
    takeAll();
    clock.advance(60);
    heartbeat.tick();
    const [event] = takeAll();
    assert.deepEqual(Object.keys(event?.pending ?? {}), ["a2a_tasks"]);
  });

  it("says its seconds when they are not whole minutes (the tests'), and ticks every second for them", (t) => {
    // Guards against: a heartbeat of the tests' seconds named as 0 minutes, or left for the 15 s tick.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { clock, queue, heartbeat, turn } = setup(t, { quietMs: 5_000 });
    turn("turn_start");
    turn("turn_end");
    const stop = heartbeat.start();
    t.after(stop);
    clock.ms += 5_000;
    t.mock.timers.tick(1_000);
    const { summary, appended } = queue.take({ after: 0 })[0]!;
    assert.equal(summary, "no turn for 5 seconds");
    const line = JSON.parse(readFileSync(appended.path, "utf8").split("\n")[appended.lines[0] - 1]!);
    assert.deepEqual(line.payload, { since: "2026-11-16T09:00:00.000Z", quiet_minutes: 5 / 60 });
  });

  it("is not queued while a turn runs", (t) => {
    const { clock, queue, heartbeat, turn } = setup(t);
    turn("turn_start");
    clock.advance(QUIET_MINUTES * 3);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }), []);
  });

  it("is queued once, and counts again from the end of the turn it made", (t) => {
    const { clock, heartbeat, turn, takeAll } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES);
    heartbeat.tick();
    clock.advance(1);
    heartbeat.tick();
    // The runner has not taken it yet: still one.
    assert.equal(takeAll().length, 1);

    turn("turn_start");
    clock.advance(1);
    turn("turn_end");
    clock.advance(QUIET_MINUTES - 1);
    heartbeat.tick();
    assert.deepEqual(takeAll(), []);
    clock.advance(1);
    heartbeat.tick();
    assert.deepEqual(takeAll().map((event) => event.source), ["heartbeat"]);
  });

  it("is not queued while an event waits to be handed over or acked", (t) => {
    // Guards against: a heartbeat beside the owner's message about to start a turn, or during the nightly switch,
    // whose control event is acked only once the new session has started.
    const { clock, queue, heartbeat, turn } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES);
    queue.accept({ source: "control", id: "nightly@x", occurred_at: iso(clock.ms), summary: "the nightly switch", payload: { kind: "nightly" } }, { builtin: true });
    heartbeat.tick();
    const handed = queue.take({ after: 0 });
    assert.deepEqual(handed.map((event) => event.source), ["control"]);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: handed[0]!.seq }), []);

    queue.ack([handed[0]!.seq]);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: handed[0]!.seq }).map((event) => event.source), ["heartbeat"]);
  });

  it("takes the held batch with it", (t) => {
    const { clock, queue, heartbeat, turn } = setup(t);
    turn("turn_start");
    turn("turn_end");
    clock.advance(QUIET_MINUTES - 2);
    queue.accept({ source: "slack", id: "1", occurred_at: iso(clock.ms), summary: "a message", payload: {} });
    clock.advance(2);
    heartbeat.tick();
    assert.deepEqual(
      queue.take({ after: 0 }).map((event) => [event.source, event.delivery]),
      [
        ["slack", "batch"],
        ["heartbeat", "now"],
      ],
    );
  });

  it("is not queued outside the awake hours, and is when they start", (t) => {
    const { clock, queue, heartbeat, turn } = setup(t, { start: "2026-11-16T22:30:00Z" });
    turn("turn_start");
    turn("turn_end");
    clock.set("2026-11-16T23:30:00Z");
    heartbeat.tick();
    clock.set("2026-11-17T06:59:00Z");
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }), []);
    clock.set("2026-11-17T07:00:00Z");
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }).map((event) => event.id), ["heartbeat@2026-11-17T07:00:00.000Z"]);
  });

  it("counts from when the backend started when there has been no turn", (t) => {
    const { clock, queue, heartbeat } = setup(t);
    clock.advance(QUIET_MINUTES - 1);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }), []);
    clock.advance(1);
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }).map((event) => event.source), ["heartbeat"]);
  });

  it("is left for the next tick when it cannot be queued", (t) => {
    const { clock, queue, heartbeat } = setup(t);
    clock.advance(QUIET_MINUTES);
    const accept = queue.accept.bind(queue);
    let refuse = true;
    queue.accept = (...args) => {
      if (refuse) throw new Error("/sources is not writable");
      return accept(...args);
    };
    heartbeat.tick();
    refuse = false;
    heartbeat.tick();
    assert.deepEqual(queue.take({ after: 0 }).map((event) => event.source), ["heartbeat"]);
  });
});
