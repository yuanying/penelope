import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { A2APayload } from "@penelope/contract";

import { Inbox, InboxRefusal } from "../src/a2a/inbox.ts";
import { Assets } from "../src/assets.ts";
import { openDatabase } from "../src/db.ts";
import { Queue } from "../src/queue.ts";
import { Sources } from "../src/sources.ts";
import { FakeClock, tempDir, unwritable } from "./support.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function setup(t: { after: (fn: () => void) => void }, limits = { deadlineMs: 24 * HOUR, maxOpenTasks: 3 }) {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-14T10:00:00Z");
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  t.after(() => db.close());
  const sourcesDir = path.join(dir, "sources");
  const queue = new Queue(db, new Sources(sourcesDir, "UTC"), {
    now: clock.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { ui: "now", cron: "now", a2a: "now", self: "now" },
    batch: { quietMs: 5 * MINUTE, maxMs: 30 * MINUTE },
    timeZone: "UTC",
    redeliverMs: 5 * MINUTE,
  });
  const assetsDir = path.join(dir, "assets");
  const assets = new Assets(db, assetsDir, { now: clock.now });
  const inbox = new Inbox(db, queue, { assets, now: clock.now, limits });
  return { sourcesDir, clock, queue, inbox, db, assetsDir };
}

const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
let counter = 0;
const message = (text: string, more: { taskId?: string; contextId?: string } = {}) => ({ text, messageId: `m-${++counter}`, ...more });

function refusal(kind: InboxRefusal["kind"]) {
  return (error: unknown) => error instanceof InboxRefusal && error.kind === kind;
}

describe("the A2A inbox", () => {
  describe("a new request", () => {
    it("opens a working task and becomes an a2a event of the sender's stream in /sources", (t) => {
      // Guards against: a request she never hears of, or one she cannot tell the sender or the task of.
      const { inbox, queue, sourcesDir } = setup(t);
      const task = inbox.receive("claude", message("Look at the alerts.\nThe ones since noon."));
      assert.equal(task.state, "working");
      assert.equal(task.sender, "claude");

      const [event] = queue.take({ after: 0 });
      assert.ok(event);
      assert.equal(event.source, "a2a");
      assert.equal(event.stream, "claude");
      assert.equal(event.delivery, "now");
      assert.equal(event.summary, "Look at the alerts.");
      assert.deepEqual(event.answer_via, { tool: "reply_to_agent" });
      const [line] = lines(path.join(sourcesDir, "a2a", "claude", "2026-11-14.jsonl"));
      assert.equal(line.seq, event.seq);
      assert.deepEqual(line.payload, {
        kind: "request",
        task_id: task.taskId,
        context_id: task.contextId,
        message_id: task.messages[0]!.messageId,
        text: "Look at the alerts.\nThe ones since noon.",
      } satisfies A2APayload);
    });

    it("keeps nothing of the task when its event cannot be written to /sources", (t) => {
      // Guards against: a task the sender sees as taken while she never hears of it (ADR-0013: not written, not taken).
      const { inbox, sourcesDir } = setup(t);
      inbox.receive("claude", message("first"));
      const restore = unwritable(path.join(sourcesDir, "a2a", "claude", "2026-11-14.jsonl"));
      assert.throws(() => inbox.receive("claude", message("second")));
      restore();
      assert.equal(inbox.openCount("claude"), 1);
    });

    it("rejects a request past the sender's open tasks, without telling her", (t) => {
      // Guards against: one sender filling her queue with requests she has not answered.
      const { inbox, queue } = setup(t, { deadlineMs: 24 * HOUR, maxOpenTasks: 2 });
      inbox.receive("claude", message("one"));
      inbox.receive("claude", message("two"));
      const third = inbox.receive("claude", message("three"));
      assert.equal(third.state, "rejected");
      assert.ok(third.reason);
      assert.equal(queue.take({ after: 0 }).length, 2);
      // Another sender has its own.
      assert.equal(inbox.receive("natsumi", message("one")).state, "working");
      // GetTask still finds the rejected one.
      assert.equal(inbox.task("claude", third.taskId)?.state, "rejected");
    });

    it("refuses an empty text, one over 1 MiB, and a context it never gave the sender", (t) => {
      // Guards against: an empty event, a huge one, or a sender joining another's conversation.
      const { inbox } = setup(t);
      assert.throws(() => inbox.receive("claude", message("  ")), refusal("empty"));
      assert.throws(() => inbox.receive("claude", message("x".repeat(1024 * 1024 + 1))), refusal("too-large"));
      const theirs = inbox.receive("natsumi", message("hello"));
      assert.throws(() => inbox.receive("claude", message("me too", { contextId: theirs.contextId })), refusal("unknown-context"));
    });

    it("opens a new task in a context it gave the sender before", (t) => {
      // Guards against: a follow-up of an earlier conversation refused, or put into a new one.
      const { inbox } = setup(t);
      const first = inbox.receive("claude", message("hello"));
      const next = inbox.receive("claude", message("and then", { contextId: first.contextId }));
      assert.notEqual(next.taskId, first.taskId);
      assert.equal(next.contextId, first.contextId);
    });
  });

  describe("her reply", () => {
    it("closes the task of the event she answers, with her text as its answer", (t) => {
      // Guards against: her answer not reaching the sender's task.
      const { inbox, queue } = setup(t);
      const task = inbox.receive("claude", message("hello"));
      const [event] = queue.take({ after: 0 });
      assert.deepEqual(inbox.reply({ in_reply_to: event!.seq, state: "completed", text: "Done." }), { task_id: task.taskId, state: "completed" });
      const done = inbox.task("claude", task.taskId)!;
      assert.equal(done.state, "completed");
      assert.deepEqual(
        done.messages.map((m) => [m.role, m.text]),
        [
          ["sender", "hello"],
          ["agent", "Done."],
        ],
      );
    });

    it("does not complete the task if the asset directory cannot be written", (t) => {
      const { inbox, queue, assetsDir } = setup(t);
      const task = inbox.receive("claude", message("show me"));
      const [event] = queue.take({ after: 0 });
      writeFileSync(assetsDir, "not a directory");
      assert.throws(() => inbox.reply({ in_reply_to: event!.seq, state: "completed" }, [
        { name: "diagram.gif", mime_type: "image/gif", data: Buffer.from("GIF89a") },
      ]), /images could not be kept/);
      assert.equal(inbox.task("claude", task.taskId)?.state, "working");
    });

    it("discards the new copies if recording the completed task fails", (t) => {
      const { inbox, queue, db, assetsDir } = setup(t);
      const task = inbox.receive("claude", message("show me"));
      const [event] = queue.take({ after: 0 });
      db.exec(`CREATE TRIGGER refuse_completion BEFORE UPDATE OF state ON a2a_tasks
        WHEN NEW.state = 'completed' BEGIN SELECT RAISE(ABORT, 'cannot record completion'); END`);
      assert.throws(() => inbox.reply({ in_reply_to: event!.seq, state: "completed" }, [
        { name: "diagram.gif", mime_type: "image/gif", data: Buffer.from("GIF89a") },
      ]), /cannot record completion/);
      assert.equal(inbox.task("claude", task.taskId)?.state, "working");
      assert.deepEqual(readdirSync(assetsDir), []);
    });

    it("may close without words, but cannot ask without them", (t) => {
      // Guards against: a question with nothing in it left for the sender.
      const { inbox, queue } = setup(t);
      inbox.receive("claude", message("one"));
      inbox.receive("claude", message("two"));
      const [first, second] = queue.take({ after: 0 });
      assert.throws(() => inbox.reply({ in_reply_to: first!.seq, state: "input-required" }), refusal("needs-text"));
      assert.equal(inbox.reply({ in_reply_to: second!.seq, state: "completed" }).state, "completed");
    });

    it("asks the sender, takes its answer into the same task as another event, and closes it then", (t) => {
      // Guards against: the sender's answer lost, put into a new task, or not reaching her.
      const { inbox, queue, clock } = setup(t);
      const task = inbox.receive("claude", message("Restart it?"));
      const [request] = queue.take({ after: 0 });
      inbox.reply({ in_reply_to: request!.seq, state: "input-required", text: "Which one?" });
      assert.equal(inbox.task("claude", task.taskId)!.state, "input-required");

      clock.advance(10);
      const answered = inbox.receive("claude", message("The backend.", { taskId: task.taskId }));
      assert.equal(answered.state, "working");
      const [answer] = queue.take({ after: request!.seq });
      assert.ok(answer);
      assert.equal(answer.stream, "claude");
      assert.deepEqual(answer.answer_via, { tool: "reply_to_agent" });
      // Her reply can name either event of the task.
      assert.equal(inbox.reply({ in_reply_to: answer.seq, state: "completed", text: "Restarted." }).task_id, task.taskId);
      assert.deepEqual(
        inbox.task("claude", task.taskId)!.messages.map((m) => m.text),
        ["Restart it?", "Which one?", "The backend.", "Restarted."],
      );
    });

    it("refuses a reply to an event that is not an A2A request, and to a closed task", (t) => {
      // Guards against: a reply that goes nowhere taken as sent, or a closed task opened again.
      const { inbox, queue } = setup(t);
      queue.accept({ source: "ui", id: "u-1", occurred_at: "2026-11-14T10:00:00Z", summary: "hi", payload: { text: "hi" } }, { builtin: true });
      inbox.receive("claude", message("hello"));
      const [owner, request] = queue.take({ after: 0 });
      assert.throws(() => inbox.reply({ in_reply_to: owner!.seq, state: "completed" }), refusal("no-such-event"));
      assert.throws(() => inbox.reply({ in_reply_to: 9999, state: "completed" }), refusal("no-such-event"));
      inbox.reply({ in_reply_to: request!.seq, state: "completed" });
      assert.throws(() => inbox.reply({ in_reply_to: request!.seq, state: "completed", text: "again" }), refusal("closed"));
    });
  });

  describe("the sender's messages into a task", () => {
    it("refuses more while the task is working, and any into a closed task or another sender's", (t) => {
      // Guards against: a sender piling messages into a task she has not asked about, or reading another's.
      const { inbox, queue } = setup(t);
      const task = inbox.receive("claude", message("hello"));
      assert.throws(() => inbox.receive("claude", message("more", { taskId: task.taskId })), refusal("not-waiting"));
      assert.throws(() => inbox.receive("natsumi", message("mine?", { taskId: task.taskId })), refusal("not-found"));
      assert.equal(inbox.task("natsumi", task.taskId), undefined);
      inbox.reply({ in_reply_to: queue.take({ after: 0 })[0]!.seq, state: "completed" });
      assert.throws(() => inbox.receive("claude", message("more", { taskId: task.taskId })), refusal("closed"));
    });
  });

  describe("the deadline", () => {
    it("fails an open task the sender has not written to within the deadline, and frees its place", (t) => {
      // Guards against: a task left open for ever, holding the sender's place, or her reply taken after it failed.
      const { inbox, queue, clock } = setup(t, { deadlineMs: 24 * HOUR, maxOpenTasks: 1 });
      const task = inbox.receive("claude", message("hello"));
      const [event] = queue.take({ after: 0 });
      inbox.reply({ in_reply_to: event!.seq, state: "input-required", text: "Which?" });
      clock.advance(24 * 60 - 1);
      assert.equal(inbox.task("claude", task.taskId)!.state, "input-required", "still open a minute before");
      clock.advance(1);
      const failed = inbox.task("claude", task.taskId)!;
      assert.equal(failed.state, "failed");
      assert.ok(failed.reason);
      assert.throws(() => inbox.reply({ in_reply_to: event!.seq, state: "completed" }), refusal("closed"));
      assert.equal(inbox.receive("claude", message("again")).state, "working");
    });

    it("counts from the sender's last message", (t) => {
      // Guards against: a task failed while the sender has just answered her question.
      const { inbox, queue, clock } = setup(t);
      const task = inbox.receive("claude", message("hello"));
      inbox.reply({ in_reply_to: queue.take({ after: 0 })[0]!.seq, state: "input-required", text: "Which?" });
      clock.advance(23 * 60);
      inbox.receive("claude", message("That one.", { taskId: task.taskId }));
      clock.advance(2 * 60);
      assert.equal(inbox.task("claude", task.taskId)!.state, "working");
    });
  });
});
