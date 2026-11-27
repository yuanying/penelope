import assert from "node:assert/strict";
import { test } from "node:test";

import type { DeliveredEvent, TurnLine } from "@penelope/contract";

import { formatEvents } from "../src/turn-input.ts";

const ui: DeliveredEvent = {
  seq: 13,
  source: "ui",
  id: "m-1",
  occurred_at: "2026-11-14T09:01:00Z",
  received_at: "2026-11-14T09:01:00Z",
  summary: "hello",
  delivery: "now",
  inline: true,
  payload: { text: "hello\nthere" },
  appended: { path: "/sources/ui/2026-11-14.jsonl", lines: [1, 1] },
};

const mention: DeliveredEvent = {
  seq: 12,
  source: "slack",
  id: "C0123:1",
  stream: "ops",
  occurred_at: "2026-11-14T09:00:00Z",
  received_at: "2026-11-14T09:00:01Z",
  summary: "#ops: a mention",
  delivery: "now",
  inline: false,
  appended: { path: "/sources/slack/ops/2026-11-14.jsonl", lines: [3, 3] },
};

test("only the heartbeat line includes pending work alongside its summary and source location", () => {
  const pending = { failures: { items: [{ kind: "turn" as const, at: mention.occurred_at, reason: "Model failed" }], omitted: 0 } };
  const appended = { path: "/sources/heartbeat/2026-11-14.jsonl", lines: [1, 1] as [number, number] };
  const [other, heartbeat] = lines(formatEvents([
    { ...mention, pending },
    {
      seq: 14, id: "heartbeat", source: "heartbeat", delivery: "now", inline: false,
      occurred_at: mention.occurred_at, received_at: mention.received_at, summary: "no turn for 60 minutes", appended, pending,
    },
  ]));
  assert.ok(other && !("pending" in other));
  assert.deepEqual(heartbeat, {
    seq: 14, source: "heartbeat", delivery: "now", occurred_at: mention.occurred_at, summary: "no turn for 60 minutes", appended, pending,
  });
});

test("only the heartbeat line carries the event's status snapshot", () => {
  const status = { sleep: { state: "awake" as const }, sleepiness: 85, awake_seconds: 120, context: { tokens: 8_500, context_window: 10_000 } };
  const [other, heartbeat] = lines(formatEvents([
    { ...mention, status },
    { ...mention, seq: 14, id: "heartbeat", source: "heartbeat", status },
  ]));
  assert.ok(other && !("status" in other));
  assert.ok(heartbeat && "status" in heartbeat);
  assert.deepEqual(heartbeat.status, status);
});

function batch(seq: number, stream: string, path: string, line: number): DeliveredEvent {
  return {
    seq,
    source: "slack",
    id: `b-${seq}`,
    stream,
    occurred_at: "2026-11-14T09:00:00Z",
    received_at: "2026-11-14T09:00:00Z",
    summary: `message ${seq}`,
    delivery: "batch",
    inline: false,
    appended: { path, lines: [line, line] },
  };
}

/** The lines inside `<events>`, each read back as JSON. Fails unless the input is that and nothing else. */
function lines(input: string): TurnLine[] {
  const match = /^<events>\n([\s\S]*)\n<\/events>$/.exec(input);
  assert.ok(match, `an <events> block: ${input}`);
  return match[1]!.split("\n").map((line) => JSON.parse(line) as TurnLine);
}

test("a non-inline batch event with an answer route keeps its own seq and route", () => {
  const answer_via = { command: "slackctl post" };
  const [target, rest] = lines(formatEvents([
    { ...mention, delivery: "batch", answer_via },
    batch(14, "ops", mention.appended.path, 4),
  ]));
  assert.deepEqual(target, { seq: 12, source: "slack", stream: "ops", delivery: "batch",
    occurred_at: mention.occurred_at, summary: mention.summary, answer_via, appended: mention.appended });
  assert.deepEqual(rest?.kind === "batch" && rest.seqs, [14]);
});

test("the input is one JSON object a line inside <events>", () => {
  // Guards against: an input she cannot read line by line, such as a text that spans lines unescaped.
  const input = formatEvents([mention, ui]);
  assert.equal(input.split("\n").length, 4, "two events, two lines, and the tags");
  assert.equal(lines(input).length, 2);
});

test("an inline event carries its text, not where it was appended", () => {
  // Guards against: the owner's message reduced to a summary, or the wrong seq to answer to.
  assert.deepEqual(lines(formatEvents([ui])), [
    { seq: 13, source: "ui", delivery: "now", occurred_at: "2026-11-14T09:01:00Z", summary: "hello", text: "hello\nthere" },
  ]);
});

test("an inline event's attachments come with their type and size", () => {
  // Guards against: attachments she cannot find or cannot tell an image from.
  const attachments = [
    { path: "/sources/ui/files/13-a.png", mime_type: "image/png", size: 10 },
    { path: "/sources/ui/files/13-b.pdf", mime_type: "application/pdf", size: 20 },
  ];
  const [line] = lines(formatEvents([{ ...ui, attachments }]));
  assert.deepEqual(line!.kind === undefined && line!.attachments, attachments);
});

test("an inline payload without text is given as JSON", () => {
  // Guards against: an inline payload of another shape dropped.
  const [line] = lines(formatEvents([{ ...ui, payload: { kind: "x", n: 1 } }]));
  assert.equal(line!.kind === undefined && line!.text, '{"kind":"x","n":1}');
});

test("an event that is not inline carries its summary and where it was appended", () => {
  // Guards against: the content of a source pushed into the turn (ADR-0013), or a place she cannot open.
  assert.deepEqual(lines(formatEvents([mention])), [
    {
      seq: 12,
      source: "slack",
      stream: "ops",
      delivery: "now",
      occurred_at: "2026-11-14T09:00:00Z",
      summary: "#ops: a mention",
      appended: { path: "/sources/slack/ops/2026-11-14.jsonl", lines: [3, 3] },
    },
  ]);
});

test("batched events are one line per source and stream, with their seqs, summaries and places", () => {
  // Guards against: a batch spread over one line per event, a seq left out, or ranges that do not match the file.
  const ops = "/sources/slack/ops/2026-11-14.jsonl";
  const dev = "/sources/slack/dev/2026-11-14.jsonl";
  const input = formatEvents([batch(20, "ops", ops, 4), batch(21, "dev", dev, 1), batch(22, "ops", ops, 5), batch(23, "ops", ops, 7)]);
  assert.deepEqual(lines(input), [
    {
      kind: "batch",
      source: "slack",
      stream: "ops",
      count: 3,
      seqs: [20, 22, 23],
      summary: "message 20\nmessage 22\nmessage 23",
      appended: [
        { path: ops, lines: [4, 5] },
        { path: ops, lines: [7, 7] },
      ],
    },
    { kind: "batch", source: "slack", stream: "dev", count: 1, seqs: [21], summary: "message 21", appended: [{ path: dev, lines: [1, 1] }] },
  ]);
});

test("a batch that spans two files names each", () => {
  // Guards against: the lines of the next day's file read as the first day's.
  const today = "/sources/slack/ops/2026-11-14.jsonl";
  const tomorrow = "/sources/slack/ops/2026-11-15.jsonl";
  const [line] = lines(formatEvents([batch(30, "ops", today, 9), batch(31, "ops", tomorrow, 1)]));
  assert.deepEqual(line!.kind === "batch" && line!.appended, [
    { path: today, lines: [9, 9] },
    { path: tomorrow, lines: [1, 1] },
  ]);
});

test("the events of one turn are in seq order, the batches last", () => {
  // Guards against: the order of the backend lost, which `in_reply_to` and the reading of /sources rely on.
  const ops = "/sources/slack/ops/2026-11-14.jsonl";
  const order = lines(formatEvents([batch(11, "ops", ops, 1), ui, mention])).map((line) => (line.kind === "batch" ? "batch" : line.seq));
  assert.deepEqual(order, [12, 13, "batch"]);
});

test("an event without a stream has no stream", () => {
  // Guards against: an empty or made-up stream pointing at a directory that is not there.
  const { stream: _, ...alert } = { ...mention, source: "alertmanager" };
  const [line] = lines(formatEvents([alert]));
  assert.equal(line!.source, "alertmanager");
  assert.ok(!("stream" in line!));
});
