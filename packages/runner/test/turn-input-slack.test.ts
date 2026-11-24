// The seam between the runner's turn input and the Slack plugin's drawing
// (ADR-0029). How a change is drawn is the Slack package's and its tests';
// here only what reaches the turn, from which lines and in which line.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DeliveredEvent, SourcesLine, TurnLine } from "@penelope/contract";
import { drawChanges } from "@penelope/slack";

import { formatEvents, type SlackDrawing } from "../src/turn-input.ts";

const DEV = { id: "C0DEV", name: "dev", type: "channel" };
const OPS = { id: "C0OPS", name: "ops", type: "channel" };
const ALICE = { id: "U0ALICE", name: "alice" };
const BOB = { id: "U0BOB", name: "bob" };

/** 2026-11-16T09:MM:00Z. */
const ts = (minute: number) => `${1794819600 + minute * 60}.000100`;
const iso = (minute: number) => new Date((1794819600 + minute * 60) * 1000).toISOString();

type Said = { seq: number; minute: number; text: string; channel?: typeof DEV; user?: typeof ALICE; thread?: number; delivery?: "now" | "batch" };

function said({ seq, minute, text, channel = DEV, user = ALICE, thread }: Said): SourcesLine {
  return {
    seq,
    received_at: iso(minute),
    occurred_at: iso(minute),
    source: "slack",
    stream: `work.${channel.name}`,
    id: `work/${channel.id}/${ts(minute)}`,
    summary: `work #${channel.name} ${user.name}: ${text}`,
    payload: {
      type: "message",
      workspace: "work",
      channel,
      ts: ts(minute),
      ...(thread === undefined ? {} : { thread_ts: ts(thread) }),
      user,
      own: false,
      mention: false,
      text,
    },
  };
}

/** The event the backend hands over for a line, as an inline source's. */
function delivered(line: SourcesLine, delivery: "now" | "batch", row: number, attachments?: DeliveredEvent["attachments"]): DeliveredEvent {
  return {
    seq: line.seq,
    source: line.source,
    id: line.id,
    ...(line.stream ? { stream: line.stream } : {}),
    occurred_at: line.occurred_at,
    received_at: line.received_at,
    summary: line.summary,
    delivery,
    inline: true,
    payload: line.payload,
    appended: { path: `/sources/${line.source}/${line.stream}/2026-11-16.jsonl`, lines: [row, row] },
    ...(attachments ? { attachments } : {}),
  };
}

/** A /sources with these lines written as the backend writes them, one file a stream and day. */
async function sources(lines: SourcesLine[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sources-"));
  const files = new Map<string, string[]>();
  for (const line of lines) {
    const dir = join(root, line.source, line.stream!);
    const file = join(dir, `${line.received_at.slice(0, 10)}.jsonl`);
    await mkdir(dir, { recursive: true });
    files.set(file, [...(files.get(file) ?? []), JSON.stringify(line)]);
  }
  for (const [file, rows] of files) await writeFile(file, `${rows.join("\n")}\n`);
  return root;
}

function drawing(sourcesDir: string, more: Partial<SlackDrawing> = {}): SlackDrawing & { logs: string[] } {
  const logs: string[] = [];
  return { sources: new Set(["slack"]), sourcesDir, maxChars: 6000, timeZone: "UTC", log: (line) => logs.push(line), logs, ...more };
}

function lines(input: string): (TurnLine & Record<string, unknown>)[] {
  const match = /^<events>\n([\s\S]*)\n<\/events>$/.exec(input);
  assert.ok(match, `an <events> block: ${input}`);
  return match[1]!.split("\n").map((line) => JSON.parse(line) as TurnLine & Record<string, unknown>);
}

test("batched Slack events of a stream are one line that carries what changed, drawn", async () => {
  // Guards against: Slack's batched changes left as one JSON line each, or the batch line losing where they were appended.
  const earlier = said({ seq: 1, minute: 0, text: "Shall we release?" });
  const reply = said({ seq: 2, minute: 5, text: "After lunch.", user: BOB, thread: 0 });
  const other = said({ seq: 3, minute: 6, text: "lunch?", user: BOB });
  const root = await sources([earlier, reply, other]);

  const [line, ...rest] = lines(formatEvents([delivered(reply, "batch", 2), delivered(other, "batch", 3)], drawing(root)));
  assert.equal(rest.length, 0);
  assert.equal(line!.kind, "batch");
  assert.deepEqual([line!.source, line!.stream, line!.count, line!.seqs], ["slack", "work.dev", 2, [2, 3]]);
  assert.equal(line!.summary, `${reply.summary}\n${other.summary}`);
  assert.deepEqual(line!.appended, [{ path: "/sources/slack/work.dev/2026-11-16.jsonl", lines: [2, 3] }]);
  // The parent of the reply is read from /sources, drawn short beside it.
  assert.equal(line!.text, drawChanges([reply, other], [earlier, reply, other], { timeZone: "UTC" }).text);
  assert.match(line!.text as string, /\(earlier\): "Shall we release\?"/);
});

test("a now Slack event is a line of its own, drawn with a few of the messages before it", async () => {
  // Guards against: a mention that comes without what led up to it, or the seq to answer to lost.
  const before = [1, 2, 3, 4].map((n) => said({ seq: n, minute: n, text: `message ${n}` }));
  const mention = said({ seq: 5, minute: 5, text: "<@U0SELF> can you look?" });
  const root = await sources([...before, mention]);
  const attachments = [{ path: "/sources/slack/files/5-a.png", mime_type: "image/png", size: 10 }];

  const [line] = lines(formatEvents([delivered(mention, "now", 5, attachments)], drawing(root)));
  assert.equal(line!.kind, undefined);
  assert.deepEqual([line!.seq, line!.delivery, line!.summary], [5, "now", mention.summary]);
  assert.equal(line!.appended, undefined);
  assert.deepEqual(line!.attachments, attachments);
  const text = line!.text as string;
  assert.ok(!text.includes("message 1"), "only a few messages before it");
  for (const n of [2, 3, 4]) assert.match(text, new RegExp(`\\(earlier\\): "message ${n}"`));
  assert.match(text, /alice \[[0-9.]+\]: @U0SELF can you look\?/);
});

test("a now event with the batched ones before it: each where it belongs", async () => {
  // Guards against: the batch that comes with a mention merged into the mention's line, or the order of the lines changed.
  const flow = said({ seq: 1, minute: 0, text: "the deploy failed" });
  const mention = said({ seq: 2, minute: 1, text: "<@U0SELF> help" });
  const root = await sources([flow, mention]);
  const out = lines(formatEvents([delivered(flow, "batch", 1), delivered(mention, "now", 2)], drawing(root)));
  assert.deepEqual(
    out.map((line) => [line.kind ?? "event", line.seq ?? line.seqs]),
    [
      ["event", 2],
      ["batch", [1]],
    ],
  );
  assert.match(out[1]!.text as string, /the deploy failed/);
});

test("over the limit, the oldest changes are left out with how to read them, and stay in the line", async () => {
  // Guards against: an input that grows with Slack without end, or changes left out with no word of them.
  const busy = Array.from({ length: 40 }, (_, n) => said({ seq: n + 1, minute: n, text: `busy message number ${n + 1} ${"x".repeat(40)}` }));
  const quiet = said({ seq: 41, minute: 41, text: "a quiet one", channel: OPS });
  const root = await sources([...busy, quiet]);
  const events = [...busy.map((line, n) => delivered(line, "batch", n + 1)), delivered(quiet, "batch", 1)];

  const out = lines(formatEvents(events, drawing(root, { maxChars: 1200 })));
  const total = out.reduce((sum, line) => sum + (line.text as string).length, 0);
  assert.ok(total <= 1200, `at most the limit: ${total}`);
  const [dev, ops] = out;
  assert.equal(dev!.count, 40, "every change is still counted");
  assert.deepEqual(dev!.seqs, busy.map((line) => line.seq));
  assert.match(dev!.text as string, /earlier changes left out; slackctl history work\.dev/);
  assert.match(dev!.text as string, /busy message number 40/, "the newest are kept");
  assert.match(ops!.text as string, /a quiet one/, "a quiet stream is drawn whole");
});

test("a payload the drawing does not know is an inline line as before, and the reason is logged", async () => {
  // Guards against: an event dropped because it cannot be drawn (ADR-0029 Decision 6).
  const odd: SourcesLine = { ...said({ seq: 1, minute: 0, text: "x" }), payload: { type: "something_new", text: "new kind" } };
  const root = await sources([odd]);
  const slack = drawing(root);
  const [line] = lines(formatEvents([delivered(odd, "batch", 1)], slack));
  assert.equal(line!.kind, undefined);
  assert.equal(line!.text, "new kind");
  assert.ok(slack.logs.some((log) => log.includes("1")), slack.logs.join("\n"));
});

test("when /sources cannot be read, the events are inline lines as before, and the reason is logged", async () => {
  // Guards against: a drawing made without the lines it needs, passed off as the whole picture.
  const message = said({ seq: 1, minute: 0, text: "hello" });
  const slack = drawing(join(tmpdir(), "no-such-sources"));
  const [line] = lines(formatEvents([delivered(message, "now", 1)], slack));
  assert.equal(line!.kind, undefined);
  assert.equal(line!.text, "hello", "the payload's text, as any inline event");
  assert.equal(slack.logs.length, 1);
  assert.ok(!slack.logs[0]!.includes("hello"), "the log carries no text of Slack");
});

test("a source not drawn with Slack's drawing, and a Slack event that is not inline, come as before", async () => {
  // Guards against: the drawing reaching other sources, or the runner reading a payload the backend did not hand over.
  const message = said({ seq: 1, minute: 0, text: "hello" });
  const root = await sources([message]);
  const other = { ...delivered(message, "now", 1), source: "elsewhere" };
  const [line] = lines(formatEvents([other], drawing(root)));
  assert.equal(line!.text, "hello", "the payload's text, as any inline event");

  const { payload: _, ...rest } = delivered(message, "batch", 1);
  const notInline: DeliveredEvent = { ...rest, inline: false };
  const [batch] = lines(formatEvents([notInline], drawing(root)));
  assert.equal(batch!.kind, "batch");
  assert.equal(batch!.text, undefined);
});

test("a drawing that fails leaves the events as they would come without it", async () => {
  // Guards against: a turn lost to the drawing (ADR-0029 Decision 6).
  const message = said({ seq: 1, minute: 0, text: "hello" });
  const root = await sources([message]);
  const slack = drawing(root, { timeZone: "Not/A_Zone" });
  const answer_via = { command: "slackctl post" };
  const [one, batch] = lines(formatEvents([
    { ...delivered(message, "batch", 1), answer_via },
    delivered({ ...message, seq: 2 }, "batch", 2),
  ], slack));
  assert.equal(one!.text, "hello");
  assert.ok(one && one.kind === undefined);
  assert.deepEqual(one.answer_via, answer_via);
  assert.equal(batch!.kind, "batch");
  assert.equal(batch!.text, undefined);
  assert.deepEqual(batch!.seqs, [2]);
  assert.equal(slack.logs.length, 1);
});
