import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import type { Activity, StreamEvent } from "@penelope/contract";

import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { Queue } from "../src/queue.ts";
import { ActivityRecord } from "../src/record.ts";
import { cronOf } from "../src/schedules.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours } from "../src/time.ts";
import { FakeClock, tempDir } from "./support.ts";

/** The record begins at 09:00 on the 14th; the nights are at 04:00 UTC. */
function setup(t: { after: (fn: () => void) => void }, nightly = "0 4 * * *") {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-14T09:00:00Z");
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  t.after(() => db.close());
  const queue = new Queue(db, new Sources(path.join(dir, "sources"), "UTC"), {
    now: clock.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: {},
    batch: { quietMs: 300_000, maxMs: 1_800_000 },
    awake: new AwakeHours("00:00-00:00", "UTC"),
    redeliverMs: 300_000,
  });
  const feed = new Feed();
  const streamed: StreamEvent[] = [];
  feed.subscribe(undefined, (_id, event) => streamed.push(event));
  const conversation = new Conversation(db, feed, { now: clock.now });
  const record = new ActivityRecord(db, feed, { now: clock.now, timeZone: "UTC", nightly: cronOf(nightly, "UTC"), owner: 1, log: () => {} });
  const event = (source: string, id: string, summary: string) =>
    queue.accept({ source, id, occurred_at: new Date(clock.now()).toISOString(), summary, payload: { text: summary } }, { builtin: true }).seq;
  /** A turn from start to end, its blocks kept as the sandbox's API keeps them. */
  const turn = (agent: string, turnId: string, start: string, end: string, middle: Activity[] = []) => {
    const blocks: Activity[] = [{ kind: "turn_start", at: start, turn_id: turnId }, ...middle, { kind: "turn_end", at: end, turn_id: turnId }];
    conversation.activities(agent, blocks);
    record.activities(agent, blocks);
  };
  const night = (due: string) =>
    queue.accept({ source: "control", id: `nightly@${due}`, occurred_at: due, summary: "the nightly switch", payload: { kind: "nightly" } }, { builtin: true }).seq;
  return { db, clock, queue, conversation, record, streamed, event, turn, night };
}

const done = { result: "done" as const };

describe("the activity record", () => {
  describe("turns", () => {
    it("lists a failed turn with its reason and the source and summary of the events it was given", (t) => {
      const { record, event, turn, clock } = setup(t);
      const seq = event("ui", "m-1", "check the cluster");
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:48.000Z", [
        { kind: "tool_call", at: "2026-11-14T10:00:10.000Z", turn_id: "t-1", call_id: "c-1", name: "bash", arguments: {} },
      ]);
      clock.set("2026-11-14T10:00:49Z");
      record.turnEnded("main", { turn_id: "t-1", result: "failed", reason: "the model's request failed\nwith more", seqs: [seq] });
      const [row] = record.day({ day: "2026-11-14" }).rows;
      assert.deepEqual(row, {
        kind: "turn",
        id: "t-1",
        at: "2026-11-14T10:00:00.000Z",
        agent: "main",
        started_at: "2026-11-14T10:00:00.000Z",
        ended_at: "2026-11-14T10:00:48.000Z",
        seconds: 48,
        result: "failed",
        reason: "the model's request failed",
        triggers: [{ seq, source: "ui", summary: "check the cluster" }],
        trigger_count: 1,
        tools: 1,
        replies: 0,
        failed_at: "2026-11-14T10:00:49.000Z",
      });
    });

    it("names at most the first twenty events of a turn, and counts them all", (t) => {
      const { record, event, turn } = setup(t);
      const seqs = Array.from({ length: 25 }, (_, n) => event("slack", `s-${n}`, `said ${n}`));
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z");
      record.turnEnded("main", { turn_id: "t-1", result: "done", seqs });
      const row = record.turn("t-1").turn;
      assert.equal(row.triggers.length, 20);
      assert.equal(row.trigger_count, 25);
    });

    it("says a turn an older runner ended is unknown, and one with no end yet is running", (t) => {
      const { record, turn, conversation } = setup(t);
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z");
      record.turnEnded("main", { turn_id: "t-1" });
      const start: Activity[] = [{ kind: "turn_start", at: "2026-11-14T11:00:00.000Z", turn_id: "t-2" }];
      conversation.activities("main", start);
      record.activities("main", start);
      assert.deepEqual(
        record.day({ day: "2026-11-14" }).rows.map((row) => row.kind === "turn" && [row.id, row.result]),
        [["t-2", "running"], ["t-1", "unknown"]],
      );
    });

    it("takes a turn that never ended as stopped once the same agent starts another", (t) => {
      // Guards against: a turn cut by the Pod going down shown as running for ever.
      const { record } = setup(t);
      record.activities("main", [{ kind: "turn_start", at: "2026-11-14T10:00:00.000Z", turn_id: "t-1" }]);
      record.activities("helper", [{ kind: "turn_start", at: "2026-11-14T10:30:00.000Z", turn_id: "s-1" }]);
      record.activities("main", [{ kind: "turn_start", at: "2026-11-14T11:00:00.000Z", turn_id: "t-2" }]);
      assert.equal(record.turn("t-1").turn.result, "stopped");
      assert.equal(record.turn("s-1").turn.result, "running", "another agent's turn is its own");
    });

    it("gives a turn's flow with only the size of each tool's result, and the result itself on its own", (t) => {
      const { record, turn } = setup(t);
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:05.000Z", [
        { kind: "tool_call", at: "2026-11-14T10:00:01.000Z", turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "ls" } },
        { kind: "tool_result", at: "2026-11-14T10:00:02.000Z", turn_id: "t-1", call_id: "c-1", is_error: false, output: "a\nb\né" },
      ]);
      const { flow, expired } = record.turn("t-1");
      assert.equal(expired, false);
      assert.deepEqual(flow[1], { kind: "tool_result", at: "2026-11-14T10:00:02.000Z", turn_id: "t-1", call_id: "c-1", is_error: false, lines: 3, bytes: 6 });
      assert.equal(record.result("t-1", "c-1"), "a\nb\né");
    });

    it("gives the replies a turn sent, each with a cursor of the history whose page starts with it", (t) => {
      const { record, conversation, turn } = setup(t);
      conversation.reply({ agent: "main", text: "earlier" });
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:05.000Z");
      const { id } = conversation.reply({ agent: "main", text: "done", turn_id: "t-1" });
      conversation.reply({ agent: "main", text: "later" });
      const [reply] = record.turn("t-1").replies;
      assert.equal(reply!.id, id);
      assert.equal(conversation.page(reply!.history_before).entries[0]!.id, id);
      assert.equal(record.turn("t-1").turn.replies, 1);
    });

    it("ties a reply that names no turn to the main agent's turn under way", (t) => {
      const { record } = setup(t);
      record.activities("main", [{ kind: "turn_start", at: "2026-11-14T10:00:00.000Z", turn_id: "t-1" }]);
      assert.equal(record.replyTurn(undefined), "t-1");
      record.activities("main", [{ kind: "turn_end", at: "2026-11-14T10:00:05.000Z", turn_id: "t-1" }]);
      assert.equal(record.replyTurn(undefined), undefined);
    });
  });

  describe("nights", () => {
    it("shows a verifier failure even when the night continued, and links the verifier's turn", (t) => {
      const { record, turn, night, clock } = setup(t);
      clock.set("2026-11-15T04:00:00Z");
      const seq = night("2026-11-15T04:00:00.000Z");
      turn("main", "r-1", "2026-11-15T04:00:01.000Z", "2026-11-15T04:01:00.000Z");
      record.turnEnded("main", { turn_id: "r-1", ...done, night: { seq, stage: "reflection" } });
      turn("main", "v-1", "2026-11-15T04:01:01.000Z", "2026-11-15T04:02:00.000Z");
      const verifier = { result: "failed", reason: "context overflow" } as const;
      record.turnEnded("main", { turn_id: "v-1", ...verifier, night: { seq, stage: "verifier" } });
      clock.set("2026-11-15T04:02:10Z");
      record.nightReported({ seq, stages: { reflection: done, verifier, curator: done, session: done } });

      const { rows, failures, turns } = record.day({ day: "2026-11-15" });
      assert.deepEqual(rows.map((row) => row.kind), ["night"], "the turns of its steps are under the night");
      assert.deepEqual([turns, failures], [0, 1]);
      const shown = rows[0]!;
      assert.equal(shown.kind === "night" && shown.result, "failed");
      assert.equal(shown.at, "2026-11-15T04:00:01.000Z");
      const detail = record.night(shown.id);
      assert.equal(detail.night.scheduled_at, "2026-11-15T04:00:00.000Z");
      assert.deepEqual([detail.turns.reflection?.id, detail.turns.verifier?.id], ["r-1", "v-1"]);
    });

    it("keeps each weekly review's own memory change and links only its reported turn", (t) => {
      const { record } = setup(t);
      const end = (turn_id: string, added: number) => {
        const ended = { turn_id, ...done, night: { seq: 7, stage: "curator" as const } };
        record.turnEnded("main", ended);
        record.nightMemoryChanged(ended, { files: 1, added, removed: 0 });
      };
      end("content", 4);
      end("structure", 2);
      end("other-attempt", 10);
      record.nightReported({ seq: 7, stages: {
        reflection: done, verifier: done, session: done,
        curator: { ...done, turn_id: "structure", review: {
          content: { ...done, turn_id: "content" },
          structure: { ...done, turn_id: "structure" },
        } },
      } });
      const [row] = record.day({ day: "2026-11-14" }).rows;
      assert.ok(row?.kind === "night");
      assert.deepEqual(row.stages.curator.review, {
        content: { ...done, turn_id: "content", memory_change: { files: 1, added: 4, removed: 0 } },
        structure: { ...done, turn_id: "structure", memory_change: { files: 1, added: 2, removed: 0 } },
      });
      const { turns } = record.night(row.id);
      assert.deepEqual([turns.content?.id, turns.structure?.id], ["content", "structure"]);
    });

    it("shows memory warnings without counting them as unseen failures", (t) => {
      const { record, clock } = setup(t);
      clock.set("2026-11-14T10:00:00Z");
      const verifier = { ...done, dropped_records: 2 };
      const curator = { ...done, always_read_over_target: { total_bytes: 9, target_bytes: 5 } };
      record.nightReported({ seq: 7, stages: { reflection: done, verifier, curator, session: done } });
      const { rows: [row], failures } = record.day({ day: "2026-11-14" });
      assert.ok(row?.kind === "night");
      assert.deepEqual([row.stages.verifier, row.stages.curator, row.result], [verifier, curator, "done"]);
      assert.deepEqual([failures, record.unseen()], [0, 0]);
    });

    it("keeps a night's steps when the same night is reported again without them", (t) => {
      const { record, night, clock } = setup(t);
      clock.set("2026-11-15T04:00:00Z");
      const seq = night("2026-11-15T04:00:00.000Z");
      record.nightReported({ seq, stages: { reflection: done, verifier: done, curator: done, session: done } });
      record.nightReported({ seq });
      const rows = record.day({ day: "2026-11-15" }).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.kind === "night" && rows[0]!.result, "done");
    });

    it("shows an older runner's switch as a night whose first three steps are unknown", (t) => {
      const { record } = setup(t);
      record.nightReported({});
      const [row] = record.day({ day: "2026-11-14" }).rows;
      assert.deepEqual(row?.kind === "night" && [row.result, row.stages], ["unknown", { reflection: { result: "unknown" }, verifier: { result: "unknown" }, curator: { result: "unknown" }, session: { result: "done" } }]);
    });
  });

  describe("missed nights", () => {
    it("shows a night due while the backend was down, a minute after it was due", (t) => {
      const { record, clock } = setup(t);
      clock.set("2026-11-15T04:00:30Z");
      assert.deepEqual(record.day({ day: "2026-11-15" }).rows, []);
      clock.set("2026-11-15T04:01:00Z");
      assert.deepEqual(record.day({ day: "2026-11-15" }).rows, [
        { kind: "missed_night", id: "missed@2026-11-15T04:00:00.000Z", at: "2026-11-15T04:00:00.000Z", scheduled_at: "2026-11-15T04:00:00.000Z", failed_at: "2026-11-15T04:01:00.000Z" },
      ]);
    });

    it("shows a night whose event was queued as missed only when no report came before the next night", (t) => {
      const { record, clock, night } = setup(t);
      clock.set("2026-11-15T04:00:00Z");
      night("2026-11-15T04:00:00.000Z");
      clock.set("2026-11-16T03:59:59Z");
      assert.deepEqual(record.day({ day: "2026-11-15" }).rows, []);
      clock.set("2026-11-16T04:00:00Z");
      assert.deepEqual(record.day({ day: "2026-11-15" }).rows.map((row) => row.kind), ["missed_night"]);
    });

    it("takes an older runner's report as the night it came after", (t) => {
      const { record, clock, night } = setup(t);
      clock.set("2026-11-15T04:00:00Z");
      night("2026-11-15T04:00:00.000Z");
      clock.set("2026-11-15T04:05:00Z");
      record.nightReported({});
      clock.set("2026-11-16T05:00:00Z");
      assert.deepEqual(record.day({ day: "2026-11-15" }).rows.map((row) => row.kind), ["night"]);
    });

    it("does not show the nights before the record began", (t) => {
      const { record, clock } = setup(t);
      clock.set("2026-11-14T12:00:00Z");
      assert.deepEqual(record.day({ day: "2026-11-14" }).rows, [], "the 04:00 of the 14th came before the record");
    });
  });

  describe("background jobs", () => {
    const job = (end: string, extra: object = {}) => ({
      job: "0000abcd",
      command: "make test",
      cwd: "/home/agent",
      end,
      started_at: "2026-11-14T10:00:00.000Z",
      ended_at: "2026-11-14T10:03:12.000Z",
      seconds: 192,
      output: "/home/agent/jobs/0000abcd/output.log",
      output_bytes: 10,
      tail: "",
      tail_truncated: false,
      ...extra,
    });

    it("takes a job that exited with a code other than 0, ran out of time or was signalled as failed, and not one she stopped", (t) => {
      const { record } = setup(t);
      record.jobEnded("j-exit", job("exited", { exit_code: 2 }));
      record.jobEnded("j-ok", job("exited", { exit_code: 0 }));
      record.jobEnded("j-time", job("timed-out", { signal: "SIGTERM" }));
      record.jobEnded("j-signal", job("signaled", { signal: "SIGKILL" }));
      record.jobEnded("j-stop", job("stopped", { signal: "SIGTERM" }));
      record.jobEnded("j-cut", job("interrupted"));
      const failed = record.day({ day: "2026-11-14", failed: true }).rows.map((row) => row.id).sort();
      assert.deepEqual(failed, ["j-exit", "j-signal", "j-time"]);
    });

    it("leaves out a job's end that is not of the shape of one", (t) => {
      const { record } = setup(t);
      record.jobEnded("j-1", { command: "make" });
      assert.deepEqual(record.day({ day: "2026-11-14" }).rows, []);
    });
  });

  describe("the list", () => {
    it("gives the closed sub-agents with their turns, and a page of a sub-agent's turns", (t) => {
      const { db, record, turn } = setup(t);
      db.prepare("INSERT INTO sub_agents (agent, purpose, closed, started_at, updated_at) VALUES ('helper', 'read the logs', 1, '2026-11-14T09:30:00.000Z', '2026-11-14T12:00:00.000Z')").run();
      for (let n = 0; n < 21; n++) turn("helper", `s-${n}`, `2026-11-14T10:${String(n).padStart(2, "0")}:00.000Z`, `2026-11-14T10:${String(n).padStart(2, "0")}:30.000Z`);
      const rows = record.day({ day: "2026-11-14", kind: "sub_agent" }).rows;
      assert.deepEqual(rows, [
        { kind: "sub_agent", id: "helper", at: "2026-11-14T12:00:00.000Z", agent: "helper", purpose: "read the logs", started_at: "2026-11-14T09:30:00.000Z", closed_at: "2026-11-14T12:00:00.000Z", turns: 21, failed_turns: 0 },
      ]);
      const first = record.subAgent("helper");
      assert.equal(first.turns.length, 20);
      assert.equal(first.turns[0]!.id, "s-20");
      assert.deepEqual(record.subAgent("helper", first.before).turns.map((row) => row.id), ["s-0"]);
    });

    it("narrows to one agent's rows: the main agent's are its turns, nights and jobs", (t) => {
      const { record, turn } = setup(t);
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z");
      turn("helper", "s-1", "2026-11-14T10:10:00.000Z", "2026-11-14T10:10:01.000Z");
      record.nightReported({});
      assert.deepEqual(record.day({ day: "2026-11-14", agent: "helper" }).rows.map((row) => row.id), ["s-1"]);
      assert.deepEqual(record.day({ day: "2026-11-14", agent: "main" }).rows.map((row) => row.kind).sort(), ["night", "turn"]);
    });

    it("counts the whole day's turns and failures however it is narrowed", (t) => {
      const { record, turn } = setup(t);
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z");
      record.turnEnded("main", { turn_id: "t-1", result: "failed" });
      turn("main", "t-2", "2026-11-14T11:00:00.000Z", "2026-11-14T11:00:01.000Z");
      const page = record.day({ day: "2026-11-14", failed: true });
      assert.deepEqual([page.rows.length, page.turns, page.failures], [1, 2, 1]);
    });

    it("points to the next older day that has rows, past the days that have none", (t) => {
      const { record, turn, clock } = setup(t);
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z");
      clock.set("2026-11-17T09:00:00Z");
      // The nights of the 15th to the 17th were missed; a narrowing to turns passes over them.
      turn("main", "t-2", "2026-11-17T08:00:00.000Z", "2026-11-17T08:00:01.000Z");
      const today = record.day({ kind: "turn" });
      assert.deepEqual([today.day, today.before], ["2026-11-17", "2026-11-14"]);
      assert.equal(record.day({ day: "2026-11-14" }).before, undefined);
    });

    it("cuts the days in the time zone asked for", (t) => {
      const { record, turn } = setup(t);
      turn("main", "t-1", "2026-11-14T15:30:00.000Z", "2026-11-14T15:30:01.000Z");
      assert.deepEqual(record.day({ day: "2026-11-15", timeZone: "Asia/Tokyo" }).rows.map((row) => row.id), ["t-1"]);
      assert.deepEqual(record.day({ day: "2026-11-14", timeZone: "Asia/Tokyo" }).rows, []);
    });
  });

  describe("the unseen failures", () => {
    it("counts the failures after the owner last opened the record, missed nights too, and none once she opens it", (t) => {
      const { record, turn, clock } = setup(t);
      clock.set("2026-11-14T10:00:02Z");
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z");
      record.turnEnded("main", { turn_id: "t-1", result: "failed" });
      clock.set("2026-11-15T05:00:00Z");
      assert.equal(record.unseen(), 2, "the failed turn and the missed night of the 15th");
      assert.equal(record.day({ day: "2026-11-15" }).failures, 0, "a missed night is not a failure of its day");
      assert.deepEqual(record.seen(), { unseen: 2, previous_seen_at: "2026-11-14T09:00:00.000Z" }, "the first time, when the record began");
      assert.equal(record.unseen(), 0);
      clock.set("2026-11-15T06:00:00Z");
      assert.deepEqual(record.seen(), { unseen: 0, previous_seen_at: "2026-11-15T05:00:00.000Z" });
    });

    it("does not count a turn she stopped", (t) => {
      const { record, turn } = setup(t);
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z");
      record.turnEnded("main", { turn_id: "t-1", result: "stopped" });
      assert.equal(record.unseen(), 0);
    });

    it("sends the new number down the stream when a failure comes", (t) => {
      const { record, turn, streamed, clock } = setup(t);
      clock.set("2026-11-14T10:00:02Z");
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:01.000Z");
      record.turnEnded("main", { turn_id: "t-1", result: "failed" });
      assert.deepEqual(streamed.filter((event) => event.event === "record"), [{ event: "record", data: { unseen: 1 } }]);
    });
  });

  describe("with time", () => {
    it("removes a turn's flow after 30 days and keeps its summary, which says the flow is gone", async (t) => {
      const { record, turn, clock } = setup(t);
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:05.000Z", [{ kind: "thinking", at: "2026-11-14T10:00:01.000Z", turn_id: "t-1", text: "hm" }]);
      clock.set("2026-12-14T10:00:06Z");
      await record.prune();
      const { flow, expired, turn: summary } = record.turn("t-1");
      assert.deepEqual([flow, expired, summary.id], [[], true, "t-1"]);
    });

    it("removes the summaries after a year", async (t) => {
      const { record, turn, clock } = setup(t);
      turn("main", "t-1", "2026-11-14T10:00:00.000Z", "2026-11-14T10:00:05.000Z");
      clock.set("2027-11-15T10:00:00Z");
      await record.prune();
      assert.throws(() => record.turn("t-1"), /no such turn/);
    });
  });
});
