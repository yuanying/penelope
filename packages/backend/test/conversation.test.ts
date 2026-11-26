import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import type { Activity, StreamEvent } from "@penelope/contract";

import { Assets } from "../src/assets.ts";
import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { FakeClock, tempDir } from "./support.ts";

function setup(t: { after: (fn: () => void) => void }) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock("2026-11-14T09:00:00Z");
  const feed = new Feed();
  const seen: StreamEvent[] = [];
  feed.subscribe(undefined, (_id, event) => seen.push(event));
  return { db, clock, feed, seen, conversation: new Conversation(db, feed, { now: clock.now }) };
}

const at = "2026-11-14T09:00:01Z";

// What is kept is read straight from the tables: there is no API to read it
// back yet, and the schema only grows by migrations (docs/backend.md "状態").

describe("the conversation", () => {
  it("keeps a reply and sends it down the stream", (t) => {
    const { conversation, seen } = setup(t);
    const { id } = conversation.reply({ agent: "main", text: "done", expression: "smile", in_reply_to: 3 });
    const entry = { kind: "agent", id, at: "2026-11-14T09:00:00.000Z", text: "done", agent: "main", expression: "smile" };
    assert.deepEqual(seen, [{ event: "reply", data: entry }]);
    assert.deepEqual(conversation.page(), { entries: [entry] });
  });

  it("keeps the owner's messages beside the replies, newest first", (t) => {
    const { conversation, clock } = setup(t);
    conversation.ownerMessage({ id: "m-1", text: "hello" });
    clock.advance(1);
    const { id } = conversation.reply({ agent: "main", text: "hi" });
    assert.deepEqual(conversation.page(), {
      entries: [
        { kind: "agent", id, at: "2026-11-14T09:01:00.000Z", text: "hi", agent: "main" },
        { kind: "owner", id: "m-1", at: "2026-11-14T09:00:00.000Z", text: "hello" },
      ],
    });
  });

  it("keeps the read position when the backend opens the database again", (t) => {
    const file = path.join(tempDir(t), "backend.sqlite");
    const db = openDatabase(file);
    const clock = new FakeClock(at);
    const conversation = new Conversation(db, new Feed(), { now: clock.now });
    const { id } = conversation.reply({ agent: "main", text: "already read" });
    conversation.markRead(id);
    conversation.reply({ agent: "main", text: "still unread" });
    db.close();

    const reopened = openDatabase(file);
    t.after(() => reopened.close());
    assert.equal(new Conversation(reopened, new Feed(), { now: clock.now }).summary(0).unread, 1);
  });

  it("gives each reply its own images on every page, in the order sent", (t) => {
    // Guards against: a reply shown with another reply's images, or with its images out of order.
    const db = openDatabase(":memory:");
    t.after(() => db.close());
    const clock = new FakeClock("2026-11-14T09:00:00Z");
    const assets = new Assets(db, tempDir(t), { now: clock.now });
    const conversation = new Conversation(db, new Feed(), { now: clock.now, assets });
    const png = (n: number) => ({ name: `${n}.png`, mime_type: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]) });
    const first = conversation.reply({ agent: "main", text: "one" }, [png(1), png(2)]);
    conversation.reply({ agent: "main", text: "none" });
    const third = conversation.reply({ agent: "main", text: "three" }, [png(3)]);
    const names = (entries: ReturnType<Conversation["page"]>["entries"]) =>
      entries.map((entry) => [entry.id, entry.kind === "agent" ? entry.images?.map((image) => image.name) : undefined]);
    const top = conversation.page(undefined, 2);
    assert.deepEqual(names(top.entries).map(([, images]) => images), [["3.png"], undefined]);
    assert.equal(top.entries[0]?.id, third.id);
    const rest = conversation.page(top.before, 2);
    assert.deepEqual(names(rest.entries), [[first.id, ["1.png", "2.png"]]]);
    const [image] = top.entries[0]?.kind === "agent" ? (top.entries[0].images ?? []) : [];
    assert.deepEqual(image && { mime_type: image.mime_type, size: image.size }, { mime_type: "image/png", size: 5 });
  });

  it("gives the history in pages, each with the cursor of the next until the last", (t) => {
    const { conversation } = setup(t);
    for (let i = 1; i <= 5; i++) conversation.ownerMessage({ id: `m-${i}`, text: `${i}` });
    const first = conversation.page(undefined, 2);
    assert.deepEqual(first.entries.map((e) => e.id), ["m-5", "m-4"]);
    const second = conversation.page(first.before, 2);
    assert.deepEqual(second.entries.map((e) => e.id), ["m-3", "m-2"]);
    const last = conversation.page(second.before, 2);
    assert.deepEqual(last.entries.map((e) => e.id), ["m-1"]);
    assert.equal("before" in last, false);
  });

  // The UI shows what made her speak (a schedule, a mention) beside a reply.
  // Guards against losing it, and against the event's payload leaking into
  // the history along with it.
  it("names the event a reply answers by its source and summary, in the history and down the stream", (t) => {
    const { conversation, seen, db } = setup(t);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO events (source, id, occurred_at, received_ms, summary, delivery, inline, payload, path, line)
         VALUES ('cron', 'morning@1', '2026-11-14T09:00:00Z', 0, 'every morning at 9:00', 'now', 0, '{"secret":"x"}', 'p', 1)`,
      )
      .run();
    const { id } = conversation.reply({ agent: "main", text: "good morning", in_reply_to: Number(lastInsertRowid) });
    const trigger = { source: "cron", summary: "every morning at 9:00" };
    const [streamed] = seen;
    assert.deepEqual(streamed?.event === "reply" && streamed.data.trigger, trigger);
    const [kept] = conversation.page().entries;
    assert.equal(kept?.id, id);
    assert.deepEqual(kept?.kind === "agent" && kept.trigger, trigger);
  });

  it("gives no trigger to a reply that answers no event it knows", (t) => {
    const { conversation } = setup(t);
    conversation.reply({ agent: "main", text: "on my own" });
    conversation.reply({ agent: "main", text: "to something gone", in_reply_to: 999 });
    for (const entry of conversation.page().entries) assert.equal("trigger" in entry, false);
  });

  it("refuses a cursor it did not give", (t) => {
    const { conversation } = setup(t);
    assert.throws(() => conversation.page("nonsense"), /cursor/);
  });

  it("keeps what the turns did and sends each block down the stream with the agent's state", (t) => {
    const { conversation, seen, db } = setup(t);
    const activities: Activity[] = [
      { kind: "turn_start", at, turn_id: "t-1" },
      { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "ls" } },
      { kind: "turn_end", at, turn_id: "t-1" },
    ];
    conversation.activities("main", activities);
    assert.deepEqual(seen, [
      { event: "state", data: { agent: "main", state: "thinking" } },
      { event: "activity", data: { agent: "main", activity: activities[0] } },
      { event: "activity", data: { agent: "main", activity: activities[1] } },
      { event: "activity", data: { agent: "main", activity: activities[2] } },
      { event: "state", data: { agent: "main", state: "waiting" } },
    ]);
    const kept = db.prepare("SELECT agent, turn_id, kind, body FROM activities ORDER BY row").all() as Array<Record<string, string>>;
    assert.deepEqual(kept.map((row) => [row.agent, row.turn_id, row.kind, JSON.parse(row.body!)]), [
      ["main", "t-1", "turn_start", activities[0]],
      ["main", "t-1", "tool_call", activities[1]],
      ["main", "t-1", "turn_end", activities[2]],
    ]);
  });
});

describe("the feed", () => {
  it("numbers what it sends and sends again what came after the last one a stream saw", () => {
    const feed = new Feed(3);
    for (let i = 1; i <= 4; i++) feed.publish({ event: "state", data: { agent: `a${i}`, state: "waiting" } });
    const seen: Array<[number, string]> = [];
    const stop = feed.subscribe("2", (id, event) => seen.push([id, event.event === "state" ? String(event.data.agent) : ""]));
    feed.publish({ event: "state", data: { agent: "a5", state: "waiting" } });
    stop();
    feed.publish({ event: "state", data: { agent: "a6", state: "waiting" } });
    assert.deepEqual(seen, [
      [3, "a3"],
      [4, "a4"],
      [5, "a5"],
    ]);
  });

  it("sends nothing old to a stream that saw nothing", () => {
    const feed = new Feed();
    feed.publish({ event: "state", data: { agent: "main", state: "waiting" } });
    const seen: number[] = [];
    feed.subscribe(undefined, (id) => seen.push(id));
    assert.deepEqual(seen, []);
  });
});
