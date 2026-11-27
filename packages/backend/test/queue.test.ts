import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import type { Event } from "@penelope/contract";

import { openDatabase } from "../src/db.ts";
import { Queue } from "../src/queue.ts";
import { Sources } from "../src/sources.ts";
import { FakeClock, tempDir, unwritable } from "./support.ts";

const MINUTE = 60_000;

function setup(t: { after: (fn: () => void) => void }, start = "2026-11-14T10:00:00Z", timeZone = "UTC") {
  const dir = tempDir(t);
  const clock = new FakeClock(start);
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  t.after(() => db.close());
  const sourcesDir = path.join(dir, "sources");
  const queue = new Queue(db, new Sources(sourcesDir, timeZone), {
    now: clock.now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { ui: "now", cron: "now", a2a: "now", self: "now" },
    batch: { quietMs: 5 * MINUTE, maxMs: 30 * MINUTE },
    timeZone: timeZone,
    redeliverMs: 5 * MINUTE,
  });
  return { dir, sourcesDir, clock, queue };
}

let counter = 0;
function event(overrides: Partial<Event> = {}): Event {
  counter += 1;
  return {
    source: "slack",
    id: `e-${counter}`,
    occurred_at: "2026-11-14T09:59:00Z",
    summary: `event ${counter}`,
    payload: { n: counter },
    ...overrides,
  };
}

const seqs = (events: Array<{ seq: number }>) => events.map((e) => e.seq);

describe("the queue", () => {
  describe("taking events in", () => {
    it("gives each event the next seq and the time it came", (t) => {
      const { queue, clock } = setup(t);
      assert.deepEqual(queue.accept(event({ delivery: "now" })), { seq: 1, duplicate: false });
      clock.advance(1);
      assert.deepEqual(queue.accept(event({ delivery: "now" })), { seq: 2, duplicate: false });
      const taken = queue.take({ after: 0 });
      assert.deepEqual(
        taken.map((e) => e.received_at),
        ["2026-11-14T10:00:00.000Z", "2026-11-14T10:01:00.000Z"],
      );
    });

    it("drops an event whose source and id it has already taken, and writes nothing for it", (t) => {
      const { queue, sourcesDir } = setup(t);
      const first = event({ delivery: "now" });
      assert.deepEqual(queue.accept(first), { seq: 1, duplicate: false });
      assert.deepEqual(queue.accept({ ...first, summary: "again" }), { seq: 1, duplicate: true });
      const lines = readFileSync(path.join(sourcesDir, "slack/2026-11-14.jsonl"), "utf8").trimEnd().split("\n");
      assert.equal(lines.length, 1);
      assert.equal(queue.take({ after: 0 }).length, 1);
    });

    it("takes the same id from another source as another event", (t) => {
      const { queue } = setup(t);
      queue.accept(event({ id: "x" }));
      assert.deepEqual(queue.accept(event({ id: "x", source: "github" })), { seq: 2, duplicate: false });
    });

    it("appends the event to /sources and hands over where it went", (t) => {
      const { queue, sourcesDir } = setup(t);
      queue.accept(event({ delivery: "now", stream: "ops" }));
      const [taken] = queue.take({ after: 0 });
      assert.deepEqual(taken?.appended, { path: path.join(sourcesDir, "slack/ops/2026-11-14.jsonl"), lines: [1, 1] });
      const written = JSON.parse(readFileSync(taken!.appended.path, "utf8"));
      assert.equal(written.seq, 1);
      assert.equal(written.received_at, "2026-11-14T10:00:00.000Z");
    });

    it("does not take an event it cannot write to /sources", (t) => {
      const { queue, sourcesDir } = setup(t);
      queue.accept(event({ delivery: "now" }));
      const restore = unwritable(path.join(sourcesDir, "slack/2026-11-14.jsonl"));
      const lost = event({ delivery: "now" });
      assert.throws(() => queue.accept(lost));
      restore();
      // Nothing of it was kept: the same id is taken as new once /sources can be written.
      assert.deepEqual(queue.accept(lost), { seq: 2, duplicate: false });
      assert.deepEqual(seqs(queue.take({ after: 0 })), [1, 2]);
    });

    it("keeps the attachments and names them in the line and in what it hands over", (t) => {
      const { queue, sourcesDir } = setup(t);
      queue.accept(event({ source: "ui", payload: { text: "look" } }), {
        builtin: true,
        attachments: [{ name: "a.png", type: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }],
      });
      const [taken] = queue.take({ after: 0 });
      const where = path.join(sourcesDir, "ui/files/1-a.png");
      assert.deepEqual(taken?.attachments, [{ path: where, mime_type: "image/png", size: 8 }]);
      // The line keeps only the paths.
      assert.deepEqual(JSON.parse(readFileSync(taken!.appended.path, "utf8")).attachments, [where]);
    });
  });

  describe("handing events over", () => {
    it("hands over the next morning in Tokyo without changing the recorded event time", (t) => {
      const { queue } = setup(t, "2026-11-18T23:01:00Z", "Asia/Tokyo");
      const occurred_at = "2026-11-18T23:00:00.123Z";
      queue.accept(event({ source: "heartbeat", occurred_at }), { builtin: true });

      const [taken] = queue.take({ after: 0 });
      assert.equal(taken?.occurred_at, "2026-11-19T08:00:00.123+09:00");
      assert.equal(JSON.parse(readFileSync(taken!.appended.path, "utf8")).occurred_at, occurred_at);
    });

    it("uses the offset at each occurrence when daylight saving time ends", (t) => {
      const { queue } = setup(t, "2026-11-01T07:00:00Z", "America/New_York");
      queue.accept(event({ delivery: "now", occurred_at: "2026-11-01T07:30:00+02:00" }));
      queue.accept(event({ delivery: "now", occurred_at: "2026-11-01T06:30:00Z" }));

      assert.deepEqual(queue.take({ after: 0 }).map((event) => event.occurred_at), [
        "2026-11-01T01:30:00-04:00",
        "2026-11-01T01:30:00-05:00",
      ]);
    });

    it("hands a now event over at once, in seq order", (t) => {
      const { queue } = setup(t);
      queue.accept(event({ delivery: "now" }));
      queue.accept(event({ delivery: "now" }));
      assert.deepEqual(seqs(queue.take({ after: 0 })), [1, 2]);
    });

    it("does not hand an event over again before its ack is overdue", (t) => {
      const { queue, clock } = setup(t);
      queue.accept(event({ delivery: "now" }));
      assert.deepEqual(seqs(queue.take({ after: 0 })), [1]);
      assert.deepEqual(seqs(queue.take({ after: 1 })), []);
      clock.advance(4);
      assert.deepEqual(seqs(queue.take({ after: 1 })), []);
    });

    it("hands an event over again when no ack came in time, whatever after says", (t) => {
      const { queue, clock } = setup(t);
      queue.accept(event({ delivery: "now" }));
      queue.take({ after: 0 });
      clock.advance(5);
      assert.deepEqual(seqs(queue.take({ after: 1 })), [1]);
    });

    it("hands an event over again at once to a runner that asks from before it", (t) => {
      const { queue } = setup(t);
      queue.accept(event({ delivery: "now" }));
      queue.take({ after: 0 });
      // The runner restarted and asks from the beginning.
      assert.deepEqual(seqs(queue.take({ after: 0 })), [1]);
    });

    it("never hands an acked event over again", (t) => {
      const { queue, clock } = setup(t);
      queue.accept(event({ delivery: "now" }));
      queue.take({ after: 0 });
      queue.ack([1, 99]);
      clock.advance(10);
      assert.deepEqual(seqs(queue.take({ after: 0 })), []);
    });

    it("hands over no more than the limit at once", (t) => {
      const { queue } = setup(t);
      for (let i = 0; i < 3; i++) queue.accept(event({ delivery: "now" }));
      assert.deepEqual(seqs(queue.take({ after: 0, limit: 2 })), [1, 2]);
      assert.deepEqual(seqs(queue.take({ after: 2, limit: 2 })), [3]);
    });

    it("hands over an inline source's payload and only the summary and place of any other", (t) => {
      const { queue } = setup(t);
      queue.accept(event({ source: "ui", payload: { text: "hello" } }), { builtin: true });
      queue.accept(event({ delivery: "now", stream: "ops" }));
      const [ui, slack] = queue.take({ after: 0 });
      assert.equal(ui?.inline, true);
      assert.deepEqual(ui?.inline && ui.payload, { text: "hello" });
      assert.equal(slack?.inline, false);
      assert.equal("payload" in slack!, false);
      assert.equal(slack?.stream, "ops");
      assert.equal(slack?.delivery, "now");
    });

    it("leaves the stream and the attachments out when there are none", (t) => {
      const { queue } = setup(t);
      queue.accept(event({ delivery: "now" }));
      const [taken] = queue.take({ after: 0 });
      assert.equal("stream" in taken!, false);
      assert.equal("attachments" in taken!, false);
    });
  });

  describe("delivery", () => {
    it("is batch for a receivers' event that does not say", (t) => {
      const { queue } = setup(t);
      queue.accept(event());
      assert.deepEqual(queue.take({ after: 0 }), []);
    });

    it("is the backend's setting for its own sources", (t) => {
      const { queue } = setup(t);
      queue.accept(event({ source: "self" }), { builtin: true });
      assert.equal(queue.take({ after: 0 })[0]?.delivery, "now");
    });

    it("is what the source said, for the backend's sources too", (t) => {
      const { queue } = setup(t);
      queue.accept(event({ source: "cron", delivery: "batch" }), { builtin: true });
      assert.deepEqual(queue.take({ after: 0 }), []);
    });

    it("is always now for a control event", (t) => {
      const { queue } = setup(t);
      queue.accept(event({ source: "control", delivery: "batch", payload: { kind: "nightly" } }), { builtin: true });
      assert.equal(queue.take({ after: 0 })[0]?.delivery, "now");
    });
  });

  describe("a batch", () => {
    it("is held while events keep coming and handed over N minutes after the last", (t) => {
      const { queue, clock } = setup(t);
      queue.accept(event());
      clock.advance(3);
      queue.accept(event());
      clock.advance(4); // 7 minutes after the first, 4 after the last
      assert.deepEqual(queue.take({ after: 0 }), []);
      clock.advance(1);
      assert.deepEqual(seqs(queue.take({ after: 0 })), [1, 2]);
    });

    it("is handed over M minutes after its first event even while events keep coming", (t) => {
      const { queue, clock } = setup(t);
      for (let minute = 0; minute < 30; minute += 4) {
        queue.accept(event());
        clock.advance(4);
      }
      // 32 minutes after the first; the last came 4 minutes ago.
      assert.equal(queue.take({ after: 0 }).length, 8);
    });

    it("spans sources and streams", (t) => {
      const { queue, clock } = setup(t);
      queue.accept(event({ source: "slack", stream: "ops" }));
      queue.accept(event({ source: "github" }));
      clock.advance(5);
      assert.deepEqual(seqs(queue.take({ after: 0 })), [1, 2]);
    });

    it("goes with a now event, in seq order, when one comes while it is held", (t) => {
      const { queue } = setup(t);
      queue.accept(event({ source: "slack", stream: "ops" }));
      queue.accept(event({ source: "github" }));
      queue.accept(event({ source: "slack", stream: "ops", delivery: "now" }));
      assert.deepEqual(seqs(queue.take({ after: 0 })), [1, 2, 3]);
    });

    it("that starts after a now event was handed over waits again", (t) => {
      const { queue, clock } = setup(t);
      queue.accept(event({ delivery: "now" }));
      assert.deepEqual(seqs(queue.take({ after: 0 })), [1]);
      queue.ack([1]);
      queue.accept(event());
      assert.deepEqual(queue.take({ after: 1 }), []);
      clock.advance(5);
      assert.deepEqual(seqs(queue.take({ after: 1 })), [2]);
    });

    it("is not sent along when a now event is only handed over again", (t) => {
      const { queue, clock } = setup(t);
      queue.accept(event({ delivery: "now" }));
      queue.take({ after: 0 });
      queue.accept(event());
      // The runner restarted: the now event comes again, the batch keeps waiting.
      assert.deepEqual(seqs(queue.take({ after: 0 })), [1]);
      queue.ack([1]);
      clock.advance(5);
      assert.deepEqual(seqs(queue.take({ after: 1 })), [2]);
    });

    it("starts again with the next event after one was handed over", (t) => {
      const { queue, clock } = setup(t);
      queue.accept(event());
      clock.advance(5);
      queue.take({ after: 0 });
      queue.ack([1]);
      queue.accept(event());
      clock.advance(1);
      assert.deepEqual(queue.take({ after: 1 }), []);
      clock.advance(4);
      assert.deepEqual(seqs(queue.take({ after: 1 })), [2]);
    });
  });

  describe("telling when to look again", () => {
    it("knows when a held batch is due", (t) => {
      const { queue, clock } = setup(t);
      assert.equal(queue.nextWakeAt(), undefined);
      queue.accept(event());
      assert.equal(queue.nextWakeAt(), clock.ms + 5 * MINUTE);
    });

    it("knows when an ack becomes overdue", (t) => {
      const { queue, clock } = setup(t);
      queue.accept(event({ delivery: "now" }));
      queue.take({ after: 0 });
      assert.equal(queue.nextWakeAt(), clock.ms + 5 * MINUTE);
      queue.ack([1]);
      assert.equal(queue.nextWakeAt(), undefined);
    });

    it("tells its listeners when an event comes in", (t) => {
      const { queue } = setup(t);
      let told = 0;
      const stop = queue.onChange(() => (told += 1));
      queue.accept(event());
      queue.accept(event({ id: "same" }));
      queue.accept(event({ id: "same" }));
      stop();
      queue.accept(event());
      assert.equal(told, 2);
    });
  });
});
