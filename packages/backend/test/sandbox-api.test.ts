import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";

import { REPLY_IMAGE_MAX_BYTES, REPLY_IMAGES_MAX, type StreamEvent } from "@penelope/contract";

import { Inbox } from "../src/a2a/inbox.ts";
import { SubAgents } from "../src/agents.ts";
import { Assets } from "../src/assets.ts";
import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { ModelSettings } from "../src/model-settings.ts";
import { Feed } from "../src/feed.ts";
import { close, listenTcp } from "../src/http.ts";
import { MemoryView } from "../src/memory-view.ts";
import { Memory } from "../src/memory.ts";
import { Queue } from "../src/queue.ts";
import { ActivityRecord } from "../src/record.ts";
import { sandboxHandler } from "../src/sandbox-api.ts";
import { cronOf, Schedules } from "../src/schedules.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours } from "../src/time.ts";
import { ask, type Ask, FakeClock, tempDir } from "./support.ts";

const TOKEN = "the-real-token";

async function setup(
  t: { after: (fn: () => void | Promise<void>) => void },
  token: string | undefined = TOKEN,
  options: { inline?: string[]; delivery?: Record<string, "now" | "batch"> } = {},
) {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-14T09:00:00Z");
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  const queue = new Queue(db, new Sources(path.join(dir, "sources"), "UTC"), {
    now: Date.now,
    inline: new Set(options.inline ?? ["ui", "control"]),
    builtinDelivery: { self: "now", ...options.delivery },
    batch: { quietMs: 300_000, maxMs: 1_800_000 },
    awake: new AwakeHours("00:00-00:00", "UTC"),
    redeliverMs: 300_000,
  });
  const feed = new Feed();
  const streamed: StreamEvent[] = [];
  feed.subscribe(undefined, (_id, event) => streamed.push(event));
  const assetsDir = path.join(dir, "assets");
  const assets = new Assets(db, assetsDir, { now: clock.now });
  const conversation = new Conversation(db, feed, { now: clock.now, assets });
  const agents = new SubAgents(db, feed, conversation, { now: clock.now });
  const memoryDir = path.join(dir, "memory");
  mkdirSync(memoryDir);
  const memory = new Memory(memoryDir, { name: "penelope-backend", email: "backend@penelope.invalid" });
  const memoryView = new MemoryView(memoryDir, db, { now: clock.now, timeZone: "UTC" });
  const schedules = new Schedules(db, { now: Date.now, timeZone: "UTC" });
  const inbox = new Inbox(db, queue, { assets, now: Date.now, limits: { deadlineMs: 86_400_000, maxOpenTasks: 3 } });
  const record = new ActivityRecord(db, feed, { now: clock.now, timeZone: "UTC", nightly: cronOf("0 4 * * *", "UTC") });
  const modelSettings = new ModelSettings(db, clock.now);
  const logs: string[] = [];
  const server = await listenTcp(
    sandboxHandler({ token, queue, conversation, agents, schedules, memory, memoryView, inbox, record, modelSettings, now: Date.now, log: (line) => logs.push(line) }),
    "127.0.0.1", 0,
  );
  const { port } = server.address() as AddressInfo;
  t.after(async () => {
    await close(server);
    db.close();
  });
  const call = (pathname: string, options: Ask = {}) =>
    ask({ port }, pathname, { ...options, headers: { connection: "close", authorization: `Bearer ${TOKEN}`, ...options.headers } });
  return { queue, conversation, agents, record, streamed, memoryDir, memoryView, sourcesDir: path.join(dir, "sources"), call, logs, inbox, db, feed, clock, assets, assetsDir, modelSettings };
}

/** The first bytes of each kind of image a reply may carry, followed by `padding` zero bytes. */
const image = {
  png: (padding = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(padding)]),
  jpeg: () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
  gif: () => Buffer.from("GIF89a-gif"),
  webp: () => Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]),
};
const upload = (name: string, bytes: Buffer) => ({ name, data: bytes.toString("base64") });

const self = (id: string) => ({ agent: "main", id, summary: `note ${id}`, payload: { id } });

describe("the sandbox's API", () => {
  describe("authentication", () => {
    it("refuses a request without the real token", async (t) => {
      const { call } = await setup(t);
      for (const authorization of ["", "Bearer surrogate", `Basic ${TOKEN}`, `Bearer ${TOKEN}x`]) {
        const answer = await call("/v1/events?agent=main&wait=0", { headers: { authorization } });
        assert.equal(answer.status, 401, authorization);
        assert.equal(typeof answer.json().error, "string");
      }
    });

    it("refuses everyone when no token is set", async (t) => {
      const { call } = await setup(t, "");
      assert.equal((await call("/v1/events?agent=main&wait=0")).status, 401);
    });
  });

  it("reads the saved model without changing the catalog, default or selection", async (t) => {
    const { call, clock, modelSettings } = await setup(t);
    const selection = { model: "test/chosen", thinking: "low" };
    const report = await call("/v1/model-settings", { method: "PUT", json: {
      agent: "main",
      models: [{ provider: "test", id: "chosen", name: "Chosen", context_window: 1024, thinking_levels: ["low", "high"] }],
      default: { ...selection, thinking: "high" },
    } });
    assert.equal(report.status, 200);
    modelSettings.save(selection);
    clock.advance(1);
    const before = modelSettings.read();
    const answer = await call("/v1/model-settings?agent=main");
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json(), { selection });
    assert.deepEqual(modelSettings.read(), before);
    clock.advance(1);
    assert.deepEqual(modelSettings.read(), { models: [], default: null, selection: before.selection });
  });

  describe("taking events", () => {
    it("hands over what is due, inline ones with their payload", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/self-events", { json: self("s-1") })).status, 202);
      const answer = await call("/v1/events?agent=main&wait=0");
      assert.equal(answer.status, 200);
      const { events } = answer.json();
      assert.equal(events.length, 1);
      assert.equal(events[0].source, "self");
      assert.equal(events[0].summary, "note s-1");
      assert.equal(events[0].delivery, "now");
      assert.equal(events[0].inline, false);
      assert.deepEqual(events[0].appended.lines, [1, 1]);
    });

    it("answers an empty list when nothing came within the wait", async (t) => {
      const { call } = await setup(t);
      const started = Date.now();
      const answer = await call("/v1/events?agent=main&after=0&wait=1");
      assert.deepEqual(answer.json(), { events: [] });
      assert.ok(Date.now() - started >= 900);
    });

    it("answers as soon as an event comes in during the wait", async (t) => {
      const { call, queue } = await setup(t);
      const started = Date.now();
      const polled = call("/v1/events?agent=main&wait=30");
      setTimeout(() => {
        queue.accept(
          { source: "ui", id: "m-1", occurred_at: new Date().toISOString(), summary: "hi", payload: { text: "hi" } },
          { builtin: true },
        );
      }, 200);
      const { events } = (await polled).json();
      assert.equal(events[0].inline, true);
      assert.deepEqual(events[0].payload, { text: "hi" });
      assert.ok(Date.now() - started < 5000);
    });

    it("does not hand an acked event over again", async (t) => {
      const { call } = await setup(t);
      await call("/v1/self-events", { json: self("s-1") });
      const [first] = (await call("/v1/events?agent=main&wait=0")).json().events;
      const ack = await call("/v1/events/ack", { json: { agent: "main", seqs: [first.seq] } });
      assert.equal(ack.status, 204);
      assert.deepEqual((await call("/v1/events?agent=main&after=0&wait=0")).json(), { events: [] });
    });

    it("refuses a poll without the agent or with a bad after or wait", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/events?wait=0")).status, 400);
      assert.equal((await call("/v1/events?agent=main&after=x&wait=0")).status, 400);
      assert.equal((await call("/v1/events?agent=main&wait=-1")).status, 400);
    });

    it("refuses a poll from an agent other than main, for now", async (t) => {
      const { call } = await setup(t);
      const answer = await call("/v1/events?agent=child&wait=0");
      assert.equal(answer.status, 400);
      assert.equal(typeof answer.json().error, "string");
    });

    it("refuses an ack whose seqs are not integers", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/events/ack", { json: { agent: "main", seqs: ["1"] } })).status, 400);
      assert.equal((await call("/v1/events/ack", { json: { seqs: [1] } })).status, 400);
    });
  });

  describe("events to herself", () => {
    it("are queued once per id", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/self-events", { json: self("s-1") })).status, 202);
      assert.equal((await call("/v1/self-events", { json: self("s-1") })).status, 202);
      assert.equal((await call("/v1/events?agent=main&wait=0")).json().events.length, 1);
    });

    it("are refused without an id", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/self-events", { json: { agent: "main", summary: "x", payload: 1 } })).status, 400);
    });
  });

  describe("the ends of her background jobs", () => {
    const ended = (id: string, agent = "main") => ({
      agent,
      id,
      summary: `[exit 0] make test`,
      payload: { job: id, command: "make test", end: "exited", exit_code: 0, tail: "ok\n" },
    });

    it("are queued as `job` events with no stream, once per id", async (t) => {
      // Guards against: the end of a job going in as a `self` event, which would make it share the inline setting of
      // the sub-agents' notices (ADR-0030).
      const { call, sourcesDir } = await setup(t, TOKEN, { inline: ["ui", "job", "control"], delivery: { job: "now" } });
      assert.equal((await call("/v1/job-events", { json: ended("j-1") })).status, 202);
      assert.equal((await call("/v1/job-events", { json: ended("j-1") })).status, 202);
      const { events } = (await call("/v1/events?agent=main&wait=0")).json();
      assert.equal(events.length, 1);
      assert.equal(events[0].source, "job");
      assert.equal(events[0].stream, undefined);
      assert.equal(events[0].id, "j-1");
      assert.equal(events[0].delivery, "now");
      assert.equal(events[0].inline, true);
      assert.deepEqual(events[0].payload, ended("j-1").payload);
      const [file] = readdirSync(path.join(sourcesDir, "job"));
      assert.match(file!, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
      const [line] = readFileSync(path.join(sourcesDir, "job", file!), "utf8")
        .trim()
        .split("\n")
        .map((text) => JSON.parse(text));
      assert.equal(line.source, "job");
      assert.equal(line.id, "j-1");
    });

    it("are refused from a sub-agent, which has no jobs", async (t) => {
      const { call } = await setup(t);
      const answer = await call("/v1/job-events", { json: ended("j-1", "child") });
      assert.equal(answer.status, 400);
      assert.equal((await call("/v1/events?agent=main&wait=0")).json().events.length, 0);
    });

    it("are refused without an id, a summary or a payload", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/job-events", { json: { agent: "main", summary: "x", payload: 1 } })).status, 400);
      assert.equal((await call("/v1/job-events", { json: { agent: "main", id: "j-1", payload: 1 } })).status, 400);
      assert.equal((await call("/v1/job-events", { json: { agent: "main", id: "j-1", summary: "x" } })).status, 400);
    });
  });

  describe("replies", () => {
    it("are kept in the history and sent down the stream", async (t) => {
      const { call, conversation, streamed } = await setup(t);
      const answer = await call("/v1/replies", { json: { agent: "main", text: "done", in_reply_to: 3 } });
      assert.equal(answer.status, 201);
      const { id } = answer.json();
      assert.equal(conversation.page().entries[0]?.id, id);
      assert.equal(streamed[0]?.event, "reply");
    });

    it("are tied to the turn the runner names", async (t) => {
      const { call, conversation } = await setup(t);
      await call("/v1/replies", { json: { agent: "main", text: "done", turn_id: "t-1" } });
      const [entry] = conversation.page().entries;
      assert.equal(entry?.kind === "agent" && entry.turn_id, "t-1");
    });

    it("are refused without text", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/replies", { json: { agent: "main" } })).status, 400);
      assert.equal((await call("/v1/replies", { json: { agent: "main", text: "x", in_reply_to: "3" } })).status, 400);
    });
  });

  describe("replies with images", () => {
    it("keep a copy of each image, tied to the reply, in the history and down the stream", async (t) => {
      // Guards against: an image the owner is not shown, shown in another order, or read from the sandbox's file later.
      const { call, conversation, streamed, assets } = await setup(t);
      const sent = [image.png(100), image.jpeg(), image.gif(), image.webp()];
      const answer = await call("/v1/replies", {
        json: { agent: "main", text: "描いたよ", images: sent.map((bytes, i) => upload(`draw-${i}.img`, bytes)) },
      });
      assert.equal(answer.status, 201, answer.text);
      const { id } = answer.json();
      const [entry] = conversation.page().entries;
      assert.equal(entry?.id, id);
      assert.equal(entry?.kind, "agent");
      const images = entry?.kind === "agent" ? (entry.images ?? []) : [];
      assert.deepEqual(
        images.map(({ mime_type, size, name }) => ({ mime_type, size, name })),
        [
          { mime_type: "image/png", size: sent[0]!.length, name: "draw-0.img" },
          { mime_type: "image/jpeg", size: sent[1]!.length, name: "draw-1.img" },
          { mime_type: "image/gif", size: sent[2]!.length, name: "draw-2.img" },
          { mime_type: "image/webp", size: sent[3]!.length, name: "draw-3.img" },
        ],
      );
      assert.equal(new Set(images.map((kept) => kept.id)).size, 4, "each copy has an id of its own");
      images.forEach((kept, i) => {
        const found = assets.get(kept.id);
        assert.ok(found, kept.id);
        assert.equal(found.mime_type, kept.mime_type);
        assert.deepEqual(readFileSync(found.file), sent[i]);
      });
      const reply = streamed.find((event) => event.event === "reply");
      assert.deepEqual(reply?.event === "reply" ? reply.data.images : undefined, images);
    });

    it("leave out the images of a reply that has none", async (t) => {
      const { call, conversation, streamed } = await setup(t);
      assert.equal((await call("/v1/replies", { json: { agent: "main", text: "x", images: [] } })).status, 201);
      const [entry] = conversation.page().entries;
      assert.ok(entry && !("images" in entry));
      assert.ok(streamed[0]?.event === "reply" && !("images" in streamed[0].data));
    });

    it("take four images of the largest size in one reply", async (t) => {
      // Guards against: a body limit that refuses what the limits of the images allow.
      const { call, conversation } = await setup(t);
      const largest = image.png(REPLY_IMAGE_MAX_BYTES - 8);
      const images = Array.from({ length: REPLY_IMAGES_MAX }, (_, i) => upload(`big-${i}.png`, largest));
      const answer = await call("/v1/replies", { json: { agent: "main", text: "大きいよ", images } });
      assert.equal(answer.status, 201, answer.text.slice(0, 200));
      const [entry] = conversation.page().entries;
      assert.equal(entry?.kind === "agent" ? entry.images?.length : 0, REPLY_IMAGES_MAX);
    });

    for (const [why, images, said] of [
      ["an image that is not PNG, JPEG, GIF or WebP", [upload("ok.png", image.png()), upload("notes.txt", Buffer.from("just text"))], /notes\.txt/],
      ["an image with no bytes", [upload("empty.png", Buffer.alloc(0))], /empty\.png/],
      ["an image over the size limit", [upload("huge.png", image.png(REPLY_IMAGE_MAX_BYTES - 7))], /huge\.png/],
      ["more images than the limit", Array.from({ length: REPLY_IMAGES_MAX + 1 }, (_, i) => upload(`${i}.png`, image.png())), /at most 4/],
      ["data that is not base64", [{ name: "x.png", data: "not base64!" }], /x\.png/],
      ["an image without a name", [{ data: image.png().toString("base64") }], /name/],
      ["images that are not a list", "x.png", /images/],
    ] as const) {
      it(`are refused whole, text and all, for ${why}`, async (t) => {
        // Guards against: a reply that reaches the owner with an image missing, or a copy kept of what was refused.
        const { call, conversation, streamed, assetsDir } = await setup(t);
        const answer = await call("/v1/replies", { json: { agent: "main", text: "見て", images } });
        assert.equal(answer.status, 400);
        assert.match(answer.json().error, said);
        assert.deepEqual(conversation.page().entries, []);
        assert.deepEqual(streamed, []);
        assert.deepEqual(existsSync(assetsDir) ? readdirSync(assetsDir) : [], []);
      });
    }

    it("are refused whole with 500 when the copies cannot be written", async (t) => {
      // Guards against: a reply that reaches the owner without the images it said it had.
      const { call, conversation, streamed, assetsDir } = await setup(t);
      writeFileSync(assetsDir, "not a directory");
      const answer = await call("/v1/replies", { json: { agent: "main", text: "見て", images: [upload("a.png", image.png())] } });
      assert.equal(answer.status, 500);
      assert.match(answer.json().error, /images/);
      assert.deepEqual(conversation.page().entries, []);
      assert.deepEqual(streamed, []);
    });
  });

  describe("activity", () => {
    const at = "2026-11-14T09:00:00Z";
    it("is sent down the stream", async (t) => {
      const { call, streamed } = await setup(t);
      const activities = [
        { kind: "turn_start", at, turn_id: "t-1" },
        { kind: "thinking", at, turn_id: "t-1", text: "hm" },
        { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", name: "bash", arguments: { command: "ls" } },
        { kind: "tool_result", at, turn_id: "t-1", call_id: "c-1", is_error: false, output: "a\n" },
        { kind: "message", at, turn_id: "t-1", text: "done" },
        { kind: "turn_end", at, turn_id: "t-1" },
      ];
      const answer = await call("/v1/activity", { json: { agent: "main", activities } });
      assert.equal(answer.status, 204);
      assert.deepEqual(
        streamed.filter((e) => e.event === "activity").map((e) => e.event === "activity" && e.data.activity),
        activities,
      );
    });

    it("is refused when a block is not one of the kinds", async (t) => {
      const { call } = await setup(t);
      for (const activity of [
        { kind: "token", at, turn_id: "t-1", text: "a" },
        { kind: "thinking", at, turn_id: "t-1" },
        { kind: "tool_call", at, turn_id: "t-1", call_id: "c-1", arguments: {} },
        { kind: "tool_result", at, turn_id: "t-1", call_id: "c-1", is_error: "no", output: "" },
        { kind: "turn_start", at: "now", turn_id: "t-1" },
        { kind: "turn_start", at },
      ]) {
        const answer = await call("/v1/activity", { json: { agent: "main", activities: [activity] } });
        assert.equal(answer.status, 400, JSON.stringify(activity));
      }
    });

    it("keeps none of a request with one block of the wrong shape", async (t) => {
      // Guards against: part of a refused request in the record and the stream (docs/sandbox-api.md).
      const { call, streamed } = await setup(t);
      const activities = [
        { kind: "turn_start", at, turn_id: "t-1" },
        { kind: "thinking", at, turn_id: "t-1" },
      ];
      assert.equal((await call("/v1/activity", { json: { agent: "main", activities } })).status, 400);
      assert.deepEqual(streamed, []);
    });
  });

  describe("memory reference repairs", () => {
    it("commits exactly the repaired files separately from the curator's move", async (t) => {
      const { call, memoryDir } = await setup(t);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: memoryDir, encoding: "utf8" });
      writeFileSync(path.join(memoryDir, "new.md"), "the moved topic");
      writeFileSync(path.join(memoryDir, "a[1].md"), "[topic](old.md)");
      assert.equal((await call("/v1/turns/end", { json: { agent: "main", turn_id: "curator", night: { seq: 7, stage: "curator" } } })).status, 204);
      writeFileSync(path.join(memoryDir, "a[1].md"), "[topic](new.md)");
      writeFileSync(path.join(memoryDir, "a1.md"), "unrelated change");
      const repair = { paths: ["a[1].md"], moves: [{ from: "old.md", to: "new.md" }] };
      assert.equal((await call("/v1/memory/repairs", { json: { agent: "main", ...repair } })).status, 204);
      assert.equal(git("show", "HEAD^:a[1].md"), "[topic](old.md)");
      assert.equal(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"), "a[1].md\n");
      assert.match(git("log", "-1", "--format=%B"), /Runner.*reference.*\n[\s\S]*old\.md.*→.*new\.md/i);
    });

    it("does not accept an unscoped repair commit", async (t) => {
      const { call, memoryDir } = await setup(t);
      writeFileSync(path.join(memoryDir, "always.md"), "unrelated change");
      for (const paths of [[], ["../always.md"], [".git/config"]]) {
        assert.equal((await call("/v1/memory/repairs", { json: { agent: "main", paths, moves: [{ from: "old.md", to: "new.md" }] } })).status, 400);
      }
      assert.ok(!existsSync(path.join(memoryDir, ".git")));
    });
  });

  describe("the end of a turn", () => {
    it("commits /memory", async (t) => {
      const { call, memoryDir } = await setup(t);
      writeFileSync(path.join(memoryDir, "always.md"), "# always\n");
      const answer = await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-9" } });
      assert.equal(answer.status, 204);
      const log = execFileSync("git", ["-c", `safe.directory=${memoryDir}`, "log", "--format=%s"], { cwd: memoryDir, encoding: "utf8" });
      assert.equal(log, "Turn t-9\n");
    });

    it("answers 500 when the commit fails, and commits what is left at the next end", async (t) => {
      // Guards against: a turn's end taken as committed when /memory was not (docs/backend.md).
      const { call, memoryDir } = await setup(t);
      writeFileSync(path.join(memoryDir, "always.md"), "# always\n");
      writeFileSync(path.join(memoryDir, ".git"), "not a repository\n");
      assert.equal((await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-1" } })).status, 500);
      rmSync(path.join(memoryDir, ".git"));
      assert.equal((await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-2" } })).status, 204);
      const files = execFileSync("git", ["-c", `safe.directory=${memoryDir}`, "ls-files"], { cwd: memoryDir, encoding: "utf8" });
      assert.equal(files, "always.md\n");
    });

    it("logs the reason and affected count, not the paths from a Git commit error", async (t) => {
      const { call, memoryDir, logs } = await setup(t);
      execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: memoryDir });
      writeFileSync(path.join(memoryDir, "private-note.md"), "private text");
      writeFileSync(path.join(memoryDir, ".git", "index.lock"), "");
      const answer = await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-lock" } });

      assert.deepEqual(logs, ["memory: a turn could not be committed: git add: index.lock (affected=1)"]);
      assert.deepEqual(answer.json(), { error: "/memory could not be committed" });
    });

    it("distinguishes unreadable worktree files from an existing index lock", { skip: process.geteuid?.() === 0 }, async (t) => {
      const { call, memoryDir, logs } = await setup(t);
      writeFileSync(path.join(memoryDir, "unreadable.md"), "private text", { mode: 0o000 });
      await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-denied" } });

      assert.deepEqual(logs, ["memory: a turn could not be committed: git add: permission denied (affected=1)"]);
    });

    it("sets the agent waiting", async (t) => {
      const { call, streamed } = await setup(t);
      await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-9" } });
      assert.deepEqual(streamed, [{ event: "state", data: { agent: "main", state: "waiting" } }]);
    });

    it("keeps how the turn went and what it was given for the record", async (t) => {
      const { call, record } = await setup(t);
      const answer = await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-9", result: "failed", reason: "the model's request failed", seqs: [] } });
      assert.equal(answer.status, 204);
      const { turn } = record.turn("t-9");
      assert.deepEqual([turn.result, turn.reason], ["failed", "the model's request failed"]);
    });

    it("is refused with a result, seqs or a night not of their shape", async (t) => {
      const { call } = await setup(t);
      for (const extra of [{ result: "crashed" }, { seqs: ["1"] }, { night: { seq: 1, stage: "dream" } }, { reason: 3 }]) {
        assert.equal((await call("/v1/turns/end", { json: { agent: "main", turn_id: "t-9", ...extra } })).status, 400, JSON.stringify(extra));
      }
    });
  });

  describe("schedules", () => {
    it("are made, listed and deleted", async (t) => {
      const { call } = await setup(t);
      const made = await call("/v1/schedules", { json: { agent: "main", reason: "every morning", cron: "0 9 * * *" } });
      assert.equal(made.status, 201);
      const schedule = made.json();
      assert.deepEqual(schedule, { id: schedule.id, agent: "main", reason: "every morning", cron: "0 9 * * *" });
      assert.deepEqual((await call("/v1/schedules?agent=main")).json(), { schedules: [schedule] });
      assert.equal((await call(`/v1/schedules/${schedule.id}?agent=main`, { method: "DELETE" })).status, 204);
      assert.equal((await call(`/v1/schedules/${schedule.id}?agent=main`, { method: "DELETE" })).status, 404);
      assert.deepEqual((await call("/v1/schedules?agent=main")).json(), { schedules: [] });
    });

    it("are refused with both a cron expression and a time, or neither, or a bad one", async (t) => {
      const { call } = await setup(t);
      const at = "2026-11-15T09:00:00Z";
      for (const body of [
        { agent: "main", reason: "x", cron: "0 9 * * *", at },
        { agent: "main", reason: "x" },
        { agent: "main", reason: "x", cron: "nonsense" },
        { agent: "main", reason: "x", at: "tomorrow" },
        { agent: "main", cron: "0 9 * * *" },
      ]) {
        assert.equal((await call("/v1/schedules", { json: body })).status, 400, JSON.stringify(body));
      }
    });
  });

  describe("the switch of the session", () => {
    it("is noted", async (t) => {
      const { call } = await setup(t);
      assert.equal((await call("/v1/sessions/rotated", { json: { agent: "main" } })).status, 204);
    });

    it("keeps the steps of the night for the record", async (t) => {
      const { call, record, clock } = await setup(t);
      const stages = { reflection: { result: "done" }, verifier: { result: "failed", reason: "no context left" }, curator: { result: "done" }, session: { result: "done" } };
      assert.equal((await call("/v1/sessions/rotated", { json: { agent: "main", seq: 7, stages } })).status, 204);
      const [night] = record.day({ day: new Date(clock.now()).toISOString().slice(0, 10), kind: "night" }).rows;
      assert.deepEqual(night?.kind === "night" && [night.result, night.stages], ["failed", stages]);
    });

    it("keeps the latest read snapshot when an older night or a legacy report arrives later", async (t) => {
      const { call, memoryDir, memoryView } = await setup(t);
      writeFileSync(path.join(memoryDir, "guide.md"), "A sample guide\n");
      assert.equal((await call("/v1/turns/end", { json: { agent: "main", turn_id: "day" } })).status, 204);
      const done = { result: "done" };
      const stages = { reflection: done, verifier: done, curator: done, session: done };
      const day = "2026-11-14";
      const body = { agent: "main", stages };
      for (const json of [
        { ...body, seq: 8, memory_reads: { day, files: [{ path: "guide.md", dates: [day, day, "2026-10-01"] }] } },
        { ...body, seq: 7, memory_reads: { day, files: [] } },
        { agent: "main", seq: 8 },
      ]) assert.equal((await call("/v1/sessions/rotated", { json })).status, 204);
      assert.deepEqual((await memoryView.overview()).files[0]?.reads, { count_30_days: 2, last_day: day });
    });

    it("accepts optional memory warnings and weekly review reports without keeping extra fields", async (t) => {
      const { call, record } = await setup(t);
      const done = { result: "done" };
      const over = { total_bytes: 9, target_bytes: 5 };
      const content = { ...done, turn_id: "content" };
      const structure = { ...done, turn_id: "structure" };
      const stages = {
        reflection: done, verifier: { ...done, dropped_records: 2 }, session: done,
        curator: { ...done, always_read_over_target: { ...over, path: "example.md" }, review: {
          content: { ...content, text: "not part of the summary" }, structure,
        } },
      };
      assert.equal((await call("/v1/sessions/rotated", { json: { agent: "main", seq: 7, stages } })).status, 204);
      const [row] = record.day({ day: "2026-11-14" }).rows;
      assert.ok(row?.kind === "night");
      assert.deepEqual(row.stages, { ...stages, curator: { ...done, always_read_over_target: over, review: { content, structure } } });
    });

    it("reports the committed memory changes separately from each night's stage result", async (t) => {
      const { call, record, memoryDir } = await setup(t);
      const done = { result: "done" };
      const failed = { result: "failed" };
      // Reflection made no edits, but the verifier finished the handoff even though its turn failed.
      writeFileSync(path.join(memoryDir, "notes\tfor tomorrow.md"), "old\nkeep\n");
      await call("/v1/turns/end", { json: { agent: "main", turn_id: "day" } });
      const end = async (stage: string, outcome: { result: string }) => {
        assert.equal((await call("/v1/turns/end", { json: { agent: "main", turn_id: stage, ...outcome, night: { seq: 7, stage } } })).status, 204);
        return { ...outcome, turn_id: stage };
      };
      const reflection = await end("reflection", done);
      writeFileSync(path.join(memoryDir, "handoff.md"), "read this\n");
      const verifier = await end("verifier", failed);
      writeFileSync(path.join(memoryDir, "notes\tfor tomorrow.md"), "keep\nnew\nnewer\n");
      const curator = await end("curator", done);
      assert.equal((await call("/v1/sessions/rotated", { json: { agent: "main", seq: 7, stages: { reflection, verifier, curator, session: done } } })).status, 204);

      const [night] = record.day({ day: "2026-11-14", kind: "night" }).rows;
      assert.ok(night?.kind === "night");
      assert.deepEqual(night.stages, {
        reflection: { ...done, memory_change: { files: 0, added: 0, removed: 0, handoff_changed: false } },
        verifier: { ...failed, memory_change: { files: 1, added: 1, removed: 0 } },
        curator: { ...done, memory_change: { files: 1, added: 2, removed: 1 } },
        session: done,
      });
    });

    it("does not borrow the memory changes of a prior attempt when a stage did not reach a turn", async (t) => {
      const { call, record, memoryDir } = await setup(t);
      writeFileSync(path.join(memoryDir, "handoff.md"), "read this\n");
      const done = { result: "done" };
      const failed = { result: "failed" };
      await call("/v1/turns/end", { json: { agent: "main", turn_id: "first", ...done, night: { seq: 7, stage: "reflection" } } });
      const rotate = (reflection: { result: string; turn_id?: string }) =>
        call("/v1/sessions/rotated", { json: { agent: "main", seq: 7, stages: { reflection, verifier: done, curator: done, session: failed } } });
      assert.equal((await rotate({ ...done, turn_id: "first" })).status, 204);
      const [first] = record.day({ day: "2026-11-14", kind: "night" }).rows;
      assert.ok(first?.kind === "night");
      assert.deepEqual(first.stages.reflection.memory_change, { files: 1, added: 1, removed: 0, handoff_changed: true });

      assert.equal((await rotate(failed)).status, 204);
      assert.deepEqual(record.night(first.id).night.stages.reflection, failed);
    });

    it("is refused with steps not of their shape, or with no seq of their night", async (t) => {
      const { call } = await setup(t);
      const ok = { result: "done" };
      for (const body of [
        { seq: 7, stages: { reflection: ok, verifier: { result: "maybe" }, curator: ok, session: ok } },
        { seq: 7, stages: { reflection: { ...ok, turn_id: "" }, verifier: ok, curator: ok, session: ok } },
        { seq: 7, stages: { reflection: ok, verifier: { ...ok, dropped_records: -1 }, curator: ok, session: ok } },
        { seq: 7, stages: { reflection: ok, curator: { ...ok, always_read_over_target: { total_bytes: 5, target_bytes: 5 } }, session: ok } },
        { seq: 7, stages: { reflection: ok, curator: { ...ok, review: { content: ok } }, session: ok } },
        { seq: 7, stages: { reflection: ok, curator: ok } },
        { stages: { reflection: ok, curator: ok, session: ok } },
        { seq: "7" },
      ]) {
        assert.equal((await call("/v1/sessions/rotated", { json: { agent: "main", ...body } })).status, 400, JSON.stringify(body));
      }
    });
  });

  describe("sub-agents", () => {
    const at = "2026-11-14T09:00:00Z";
    const started = { agent: "review-pr-22", purpose: "review PR 22", closed: false };
    const block = (agent: string, kind: string, extra: Record<string, unknown> = {}) => ({
      agent,
      activities: [{ kind, at, turn_id: "t-1", ...extra }],
    });

    it("are kept as the runner says, sent down the stream, and listed until closed", async (t) => {
      const { call, agents, streamed } = await setup(t);
      assert.equal((await call("/v1/agents", { json: started })).status, 204);
      const t0 = "2026-11-14T09:00:00.000Z";
      assert.deepEqual(agents.list(), [{ agent: "review-pr-22", purpose: "review PR 22", state: "waiting", started_at: t0, state_since: t0 }]);
      assert.deepEqual(streamed, [{ event: "agent", data: started }]);

      assert.equal((await call("/v1/agents", { json: { ...started, closed: true } })).status, 204);
      assert.deepEqual(agents.list(), []);
      assert.deepEqual(streamed.at(-1), { event: "agent", data: { ...started, closed: true } });
    });

    it("are kept with the last status the runner sent, across a restart of the backend", async (t) => {
      const { call, db, feed, conversation, clock } = await setup(t);
      await call("/v1/agents", { json: started });
      clock.advance(5);
      await call("/v1/agents", { json: { ...started, purpose: "review PR 22 again" } });
      await call("/v1/agents", { json: { agent: "dig-logs", purpose: "dig the logs", closed: false } });
      await call("/v1/agents", { json: { agent: "dig-logs", purpose: "dig the logs", closed: true } });
      const again = new SubAgents(db, feed, new Conversation(db, feed, { now: clock.now }), { now: clock.now });
      const t0 = "2026-11-14T09:00:00.000Z";
      assert.deepEqual(again.list(), [
        { agent: "review-pr-22", purpose: "review PR 22 again", state: "waiting", started_at: t0, state_since: t0 },
      ]);
      assert.equal(conversation.stateOf("review-pr-22").state, "waiting");
    });

    it("are refused as main, under a name of another shape, or without a purpose or closed", async (t) => {
      const { call, agents, streamed } = await setup(t);
      for (const body of [
        { ...started, agent: "main" },
        { ...started, agent: "Review" },
        { ...started, agent: "-a" },
        { ...started, agent: "a/b" },
        { ...started, agent: "a".repeat(64) },
        { purpose: "x", closed: false },
        { agent: "a", closed: false },
        { agent: "a", purpose: 1, closed: false },
        { agent: "a", purpose: "x" },
        { agent: "a", purpose: "x", closed: "no" },
      ]) {
        const answer = await call("/v1/agents", { json: body });
        assert.equal(answer.status, 400, JSON.stringify(body));
        assert.equal(typeof answer.json().error, "string");
      }
      assert.deepEqual(agents.list(), []);
      assert.deepEqual(streamed, []);
      assert.equal((await call("/v1/agents")).status, 405);
    });

    it("cannot reply, answer an A2A task or touch the schedules", async (t) => {
      // Guards against: a sub-agent's words reaching the owner or another agent (ADR-0022).
      const { call, conversation } = await setup(t);
      const agent = "review-pr-22";
      for (const [pathname, options] of [
        ["/v1/replies", { json: { agent, text: "done" } }],
        ["/v1/a2a/replies", { json: { agent, in_reply_to: 1, state: "completed" } }],
        ["/v1/schedules", { json: { agent, reason: "x", cron: "0 9 * * *" } }],
        [`/v1/schedules?agent=${agent}`, {}],
        [`/v1/schedules/s-1?agent=${agent}`, { method: "DELETE" }],
        ["/v1/schedules/s-1", { method: "DELETE" }],
      ] as const) {
        const answer = await call(pathname, options);
        assert.equal(answer.status, 400, pathname);
        assert.equal(typeof answer.json().error, "string");
      }
      assert.deepEqual(conversation.page().entries, []);
    });

    it("tell the main agent they stopped by events to herself, under their own stream", async (t) => {
      const { call, sourcesDir } = await setup(t);
      const payload = { reason: "stopped", purpose: "review PR 22", text: "Two comments.\nFirst, ..." };
      const notice = { agent: "review-pr-22", id: "review-pr-22/1", summary: "Two comments.", payload };
      assert.equal((await call("/v1/self-events", { json: notice })).status, 202);
      assert.equal((await call("/v1/self-events", { json: notice })).status, 202);
      const { events } = (await call("/v1/events?agent=main&wait=0")).json();
      assert.equal(events.length, 1);
      assert.equal(events[0].source, "self");
      assert.equal(events[0].stream, "review-pr-22");
      assert.equal(path.dirname(events[0].appended.path), path.join(sourcesDir, "self", "review-pr-22"));
      const line = JSON.parse(readFileSync(events[0].appended.path, "utf8"));
      assert.equal(line.stream, "review-pr-22");
      assert.deepEqual(line.payload, payload);
    });

    it("leave the main agent's events to herself without a stream", async (t) => {
      const { call, sourcesDir } = await setup(t);
      await call("/v1/self-events", { json: self("s-1") });
      const [event] = (await call("/v1/events?agent=main&wait=0")).json().events;
      assert.equal(event.stream, undefined);
      assert.equal(path.dirname(event.appended.path), path.join(sourcesDir, "self"));
    });

    it("cannot put an event to herself under a name of another shape", async (t) => {
      const { call } = await setup(t);
      for (const agent of ["Review", "../x", "a.b", ""]) {
        const answer = await call("/v1/self-events", { json: { ...self("s-1"), agent } });
        assert.equal(answer.status, 400, agent);
      }
      assert.deepEqual((await call("/v1/events?agent=main&wait=0")).json(), { events: [] });
    });

    it("send their activity down the stream and are thinking until their turn ends", async (t) => {
      const { call, agents, streamed } = await setup(t);
      await call("/v1/agents", { json: started });
      const startedAt = "2026-11-14T09:01:00Z";
      const turn = (kind: string, when: string, extra = {}) => ({
        agent: "review-pr-22",
        activities: [{ kind, at: when, turn_id: "t-1", ...extra }],
      });
      assert.equal((await call("/v1/activity", { json: turn("turn_start", startedAt) })).status, 204);
      assert.deepEqual(agents.list()[0]?.state, "thinking");
      assert.equal(agents.list()[0]?.state_since, startedAt);
      assert.equal(agents.list()[0]?.started_at, "2026-11-14T09:00:00.000Z");
      await call("/v1/activity", { json: turn("message", "2026-11-14T09:02:00Z", { text: "so" }) });
      assert.equal(agents.list()[0]?.state_since, startedAt, "a block of the same turn does not move it");
      assert.deepEqual(streamed.slice(1, 3), [
        { event: "state", data: { agent: "review-pr-22", state: "thinking" } },
        { event: "activity", data: { agent: "review-pr-22", activity: { kind: "turn_start", at: startedAt, turn_id: "t-1" } } },
      ]);
      await call("/v1/activity", { json: turn("turn_end", "2026-11-14T09:03:00Z") });
      assert.deepEqual(agents.list()[0]?.state, "waiting");
      assert.equal(agents.list()[0]?.state_since, "2026-11-14T09:03:00Z");
      assert.deepEqual(streamed.at(-1), { event: "state", data: { agent: "review-pr-22", state: "waiting" } });
    });

    it("are waiting at the end of their turn and have /memory committed under their name", async (t) => {
      const { call, agents, memoryDir, streamed } = await setup(t);
      await call("/v1/agents", { json: started });
      await call("/v1/activity", { json: block("review-pr-22", "turn_start") });
      writeFileSync(path.join(memoryDir, "notes.md"), "# notes\n");
      // The runner sends the turn_end block before the end of the turn.
      await call("/v1/activity", { json: block("review-pr-22", "turn_end") });
      assert.equal((await call("/v1/turns/end", { json: { agent: "review-pr-22", turn_id: "t-1" } })).status, 204);
      assert.equal(agents.list()[0]?.state, "waiting");
      assert.deepEqual(streamed.at(-1), { event: "state", data: { agent: "review-pr-22", state: "waiting" } });
      const log = execFileSync("git", ["-c", `safe.directory=${memoryDir}`, "log", "--format=%s%n%b"], { cwd: memoryDir, encoding: "utf8" });
      assert.equal(log.trim(), "Turn t-1\nAgent: review-pr-22");
    });

    it("keep their state and since when across a restart of the backend", async (t) => {
      // Guards against: a sub-agent shown as waiting since the restart when it has waited since yesterday.
      const { call, db, feed, clock } = await setup(t);
      await call("/v1/agents", { json: started });
      await call("/v1/activity", { json: block("review-pr-22", "turn_start") });
      await call("/v1/activity", { json: { agent: "review-pr-22", activities: [{ kind: "turn_end", at: "2026-11-14T09:01:00Z", turn_id: "t-1" }] } });
      clock.advance(24 * 60);
      const agents = new SubAgents(db, feed, new Conversation(db, feed, { now: clock.now }), { now: clock.now });
      assert.deepEqual(agents.list()[0], {
        agent: "review-pr-22",
        purpose: "review PR 22",
        state: "waiting",
        started_at: "2026-11-14T09:00:00.000Z",
        state_since: "2026-11-14T09:01:00Z",
      });
    });

    it("are listed by their last turn_start or turn_end, whatever else came", async (t) => {
      const { call, agents, conversation, streamed } = await setup(t);
      await call("/v1/agents", { json: started });
      conversation.activities("review-pr-22", [{ kind: "thinking", at, turn_id: "t-1", text: "hm" }]);
      assert.equal(agents.list()[0]?.state, "waiting");
      assert.equal(streamed.at(-1)?.event, "activity", "no state for a block other than a turn's start or end");
      conversation.activities("review-pr-22", [{ kind: "turn_start", at, turn_id: "t-2" }]);
      await call("/v1/turns/end", { json: { agent: "review-pr-22", turn_id: "t-2" } });
      assert.deepEqual(streamed.at(-1), { event: "state", data: { agent: "review-pr-22", state: "waiting" } });
      assert.equal(agents.list()[0]?.state, "thinking", "the end of a turn alone is not in the record");
    });

    it("are not listed when only their activity came, and are listed with their state once the runner names them", async (t) => {
      const { call, agents, streamed } = await setup(t);
      assert.equal((await call("/v1/activity", { json: block("dig-logs", "turn_start") })).status, 204);
      assert.equal(streamed.at(-1)?.event, "activity");
      assert.deepEqual(agents.list(), []);
      await call("/v1/agents", { json: { agent: "dig-logs", purpose: "dig the logs", closed: false } });
      assert.deepEqual(agents.list().map((agent) => agent.state), ["thinking"]);
    });

    it("cannot send activity or end a turn under a name of another shape", async (t) => {
      const { call, streamed } = await setup(t);
      assert.equal((await call("/v1/activity", { json: block("Dig", "turn_start") })).status, 400);
      assert.equal((await call("/v1/turns/end", { json: { agent: "a b", turn_id: "t-1" } })).status, 400);
      assert.deepEqual(streamed, []);
    });
  });

  it("answers 413 to a body over the 16 MiB of the spec, and keeps none of it", async (t) => {
    // Guards against: a sandbox that can make the backend read and keep a body of any size.
    const { call, streamed } = await setup(t);
    const answer = await call("/v1/activity", { json: { agent: "main", activities: [], padding: "x".repeat(16 * 1024 * 1024) } });
    assert.equal(answer.status, 413);
    assert.deepEqual(streamed, []);
  });

  it("answers 413 to a reply over the 64 MiB of the spec, and keeps none of it", async (t) => {
    // Guards against: a reply's images making the backend read and keep a body of any size.
    const { call, conversation } = await setup(t);
    const answer = await call("/v1/replies", { json: { agent: "main", text: "x".repeat(64 * 1024 * 1024) } });
    assert.equal(answer.status, 413);
    assert.deepEqual(conversation.page().entries, []);
  });

  it("answers 404 to a path it does not have", async (t) => {
    const { call } = await setup(t);
    assert.equal((await call("/v1/nothing")).status, 404);
    assert.equal((await call("/v1/replies")).status, 405);
  });

  describe("A2A replies", () => {
    it("answers in the task of the a2a event it names, and says what became of the task", async (t) => {
      // Guards against: her answer to another agent not reaching its task.
      const { call, inbox, queue } = await setup(t);
      const task = inbox.receive("claude", { text: "Restart it?", messageId: "m-1" });
      const [event] = queue.take({ after: 0 });
      const asked = await call("/v1/a2a/replies", { method: "POST", json: { agent: "main", in_reply_to: event!.seq, state: "input-required", text: "Which one?" } });
      assert.equal(asked.status, 200);
      assert.deepEqual(asked.json(), { task_id: task.taskId, state: "input-required" });
      assert.equal(inbox.task("claude", task.taskId)!.messages.at(-1)!.text, "Which one?");
    });

    it("does not complete a Task if a reply contains an invalid image", async (t) => {
      const { call, inbox, queue } = await setup(t);
      const task = inbox.receive("claude", { text: "Show me", messageId: "m-1" });
      const [event] = queue.take({ after: 0 });
      const answer = await call("/v1/a2a/replies", { method: "POST", json: {
        agent: "main", in_reply_to: event!.seq, state: "completed", text: "Here it is.",
        images: [{ name: "not-an-image.gif", data: "bm90IGFuIGltYWdl" }],
      } });
      assert.equal(answer.status, 400);
      const unchanged = inbox.task("claude", task.taskId)!;
      assert.equal(unchanged.state, "working");
      assert.deepEqual(unchanged.messages.map((m) => m.text), ["Show me"]);
    });

    it("refuses a reply to an event that is no A2A task's, to a closed task, and a question without text", async (t) => {
      // Guards against: a reply that goes nowhere taken as sent, so that she believes the agent has it.
      const { call, inbox, queue } = await setup(t);
      inbox.receive("claude", { text: "hello", messageId: "m-1" });
      const [event] = queue.take({ after: 0 });
      const reply = (body: Record<string, unknown>) => call("/v1/a2a/replies", { method: "POST", json: { agent: "main", ...body } });
      assert.equal((await reply({ in_reply_to: 9999, state: "completed" })).status, 404);
      assert.equal((await reply({ in_reply_to: event!.seq, state: "input-required" })).status, 400);
      assert.equal((await reply({ in_reply_to: event!.seq, state: "failed" })).status, 400);
      assert.equal((await reply({ state: "completed" })).status, 400);
      assert.equal((await reply({ in_reply_to: event!.seq, state: "completed" })).status, 200);
      const again = await reply({ in_reply_to: event!.seq, state: "completed", text: "more" });
      assert.equal(again.status, 409);
      assert.match(again.json().error, /completed/);
    });
  });
});
