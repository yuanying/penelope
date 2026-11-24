// One Slack workspace of the plugin: Slack's events and fetched messages made
// envelopes (docs/receivers.md, "Slack のプラグイン"), with a fake Web API.
// The events are shaped as in Slack's documents; every value is made up.
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import type { SlackPayload } from "@penelope/slack";

import type { ConnectionEvent } from "../src/plugin.ts";
import { SlackCallError, type SlackApi } from "../src/plugins/slack/api.ts";
import { Workspace } from "../src/plugins/slack/workspace.ts";

/** 2026-11-16T09:00:00Z. */
const TS = "1794819600.000100";
const NOW = new Date("2026-11-16T10:00:00.000Z");

type Raw = Record<string, unknown>;

class FakeApi implements SlackApi {
  users: Record<string, Raw> = {
    U0ALICE: { id: "U0ALICE", name: "alice", profile: { display_name: "Alice A." } },
    U0BOB: { id: "U0BOB", name: "bob", real_name: "Bob B.", profile: { display_name: "" } },
    U0SELF: { id: "U0SELF", name: "penelope", is_bot: true, profile: { display_name: "Penelope" } },
  };
  channels: Record<string, Raw> = {
    C0DEV: { id: "C0DEV", name: "dev", is_channel: true },
    C0OPS: { id: "C0OPS", name: "ops", is_channel: true },
    G0SECRET: { id: "G0SECRET", name: "secret", is_channel: true, is_private: true },
    D0ALICE: { id: "D0ALICE", is_im: true, user: "U0ALICE" },
  };
  member = ["C0DEV", "D0ALICE"];
  history: Record<string, Raw[]> = {};
  threads: Record<string, Raw[]> = {};
  files: Record<string, Uint8Array> = {};
  calls: string[] = [];
  failing = new Set<string>();

  private fail(method: string): void {
    this.calls.push(method);
    if (this.failing.has(method)) throw new SlackCallError(method, "ratelimited");
  }

  async whoAmI() {
    this.fail("auth.test");
    return { userId: "U0SELF", botId: "B0SELF", teamId: "T0WORK" };
  }
  async openConnection(): Promise<string> {
    throw new Error("not in these tests");
  }
  async conversations() {
    this.fail("users.conversations");
    return this.member.map((id) => this.channels[id]!);
  }
  async conversation(id: string) {
    this.fail("conversations.info");
    const found = this.channels[id];
    if (!found) throw new SlackCallError("conversations.info", "channel_not_found");
    return found;
  }
  async messages(channel: string, oldest: string) {
    this.fail(`conversations.history ${channel} ${oldest}`);
    return this.history[channel] ?? [];
  }
  async replies(channel: string, ts: string, oldest: string) {
    this.fail(`conversations.replies ${channel} ${ts} ${oldest}`);
    return this.threads[`${channel}/${ts}`] ?? [];
  }
  async user(id: string) {
    this.fail("users.info");
    const found = this.users[id];
    if (!found) throw new SlackCallError("users.info", "user_not_found");
    return found;
  }
  async download(url: string, maxBytes: number) {
    this.fail(`download ${url}`);
    const data = this.files[url];
    if (!data) throw new SlackCallError("files.download", "http_404");
    return data.length > maxBytes ? undefined : data;
  }
}

let api: FakeApi;
let lines: string[];

function workspace(options: Partial<ConstructorParameters<typeof Workspace>[0]> = {}): Workspace {
  return new Workspace({
    name: "work",
    api,
    nowChannels: ["ops"],
    fileTypes: new Set(["image/png", "application/pdf"]),
    maxFileBytes: 1000,
    backfillSeconds: 3600,
    log: (line) => lines.push(line),
    now: () => NOW,
    ...options,
  });
}

/** An events_api envelope's payload, as Slack sends it. */
function callback(event: Raw, extra: Raw = {}): Raw {
  return {
    token: "made-up-verification-token",
    team_id: "T0WORK",
    api_app_id: "A0APP",
    event,
    type: "event_callback",
    event_id: "Ev0001",
    event_time: 1794819660,
    authorizations: [{ team_id: "T0WORK", user_id: "U0SELF", is_bot: true }],
    ...extra,
  };
}

const said = (text: string, extra: Raw = {}): Raw => ({ type: "message", channel: "C0DEV", channel_type: "channel", user: "U0ALICE", text, ts: TS, event_ts: TS, ...extra });

async function eventsOf(ws: Workspace, payload: Raw): Promise<{ events: ConnectionEvent[]; dropped: number }> {
  await ws.identify();
  return ws.fromCallback(payload);
}

beforeEach(() => {
  api = new FakeApi();
  lines = [];
});

describe("a message", () => {
  test("is one event, named by the workspace, the channel and its ts", async () => {
    const { events, dropped } = await eventsOf(workspace(), callback(said("hi <@U0BOB>, see <#C0OPS>")));
    assert.equal(dropped, 0);
    assert.deepEqual(events, [
      {
        id: `work/C0DEV/${TS}`,
        occurred_at: "2026-11-16T09:00:00.000Z",
        summary: "work #dev Alice A.: hi @Bob B., see #ops",
        stream: "work.dev",
        delivery: "batch",
        payload: {
          type: "message",
          workspace: "work",
          channel: { id: "C0DEV", name: "dev", type: "channel" },
          ts: TS,
          user: { id: "U0ALICE", name: "Alice A." },
          own: false,
          mention: false,
          text: "hi <@U0BOB>, see <#C0OPS>",
          names: { U0BOB: "Bob B.", C0OPS: "ops" },
        } satisfies SlackPayload,
      },
    ]);
  });

  test("that mentions the bot is now, and so is a DM, but never the agent's own", async () => {
    const ws = workspace();
    const mention = await eventsOf(ws, callback(said("<@U0SELF> help")));
    assert.deepEqual([mention.events[0]!.delivery, mention.events[0]!.answer_via], ["now", { command: "slackctl post" }]);
    assert.equal((mention.events[0]!.payload as { mention: boolean }).mention, true);

    const dm = await eventsOf(ws, callback(said("psst", { channel: "D0ALICE", channel_type: "im" })));
    assert.deepEqual([dm.events[0]!.delivery, dm.events[0]!.answer_via], ["now", { command: "slackctl post" }]);
    assert.equal(dm.events[0]!.stream, "work.dm.alice");
    assert.deepEqual((dm.events[0]!.payload as { channel: unknown }).channel, { id: "D0ALICE", name: "Alice A.", type: "im" });
    assert.equal(dm.events[0]!.summary, "work DM with Alice A. Alice A.: psst");

    const own = await eventsOf(ws, callback(said("on it", { channel: "D0ALICE", channel_type: "im", user: "U0SELF", bot_id: "B0SELF" })));
    assert.deepEqual([own.events[0]!.delivery, own.events[0]!.answer_via], ["batch", undefined]);
    assert.equal((own.events[0]!.payload as { own: boolean }).own, true);
  });

  test("in a channel of now_channels is now", async () => {
    const { events } = await eventsOf(workspace(), callback(said("disk full", { channel: "C0OPS" })));
    assert.deepEqual([events[0]!.delivery, events[0]!.answer_via], ["now", { command: "slackctl post" }]);
  });

  test("in a thread carries its parent's ts, and a private channel is a group", async () => {
    const { events } = await eventsOf(workspace(), callback(said("yes", { channel: "G0SECRET", channel_type: "group", ts: "1794819700.000200", thread_ts: TS })));
    const payload = events[0]!.payload as { thread_ts?: string; channel: { type: string } };
    assert.equal(payload.thread_ts, TS);
    assert.equal(payload.channel.type, "group");
    assert.equal(events[0]!.stream, "work.secret");
    assert.equal(events[0]!.id, "work/G0SECRET/1794819700.000200");
  });

  test("a parent never carries thread_ts of its own", async () => {
    const { events } = await eventsOf(workspace(), callback(said("parent", { thread_ts: TS })));
    assert.equal("thread_ts" in (events[0]!.payload as object), false);
  });

  test("from another bot names the bot", async () => {
    const { events } = await eventsOf(workspace(), callback(said("build passed", { user: undefined, subtype: "bot_message", bot_id: "B0CI", username: "ci" })));
    assert.deepEqual((events[0]!.payload as { user: unknown }).user, { name: "ci", bot: true });
    assert.equal((events[0]!.payload as { subtype?: string }).subtype, "bot_message");
  });

  test("whose author cannot be looked up keeps the ID as the name, and the log says why", async () => {
    const { events } = await eventsOf(workspace(), callback(said("who am I", { user: "U0GONE" })));
    assert.deepEqual((events[0]!.payload as { user: unknown }).user, { id: "U0GONE", name: "U0GONE" });
    assert.ok(lines.some((line) => line.includes("users.info") && line.includes("user_not_found")));
    assert.ok(lines.every((line) => !line.includes("who am I")));
  });

  test("joins, topics and other subtypes are dropped, and so are events it does not read", async () => {
    const ws = workspace();
    assert.deepEqual(await eventsOf(ws, callback(said("joined", { subtype: "channel_join" }))), { events: [], dropped: 1 });
    assert.deepEqual(await eventsOf(ws, callback({ type: "team_join", user: { id: "U0NEW" } })), { events: [], dropped: 1 });
  });

  test("from a workspace that is not this one is dropped", async () => {
    assert.deepEqual(await eventsOf(workspace(), callback(said("hi"), { team_id: "T0OTHER" })), { events: [], dropped: 1 });
  });
});

describe("files on a message", () => {
  const file = (id: string, name: string, mimetype: string, size: number): Raw => ({ id, name, mimetype, size, url_private_download: `https://files.example.com/${id}/${name}` });

  test("of the types and size set are fetched and sent beside it; the rest are only noted", async () => {
    api.files["https://files.example.com/F0PDF/report.pdf"] = new Uint8Array(Buffer.from("%PDF-1.7"));
    const { events } = await eventsOf(
      workspace(),
      callback(
        said("files", {
          subtype: "file_share",
          files: [file("F0PDF", "report.pdf", "application/pdf", 8), file("F0BIG", "big.png", "image/png", 5000), file("F0MOV", "clip.mov", "video/quicktime", 10)],
        }),
      ),
    );
    const [event] = events;
    assert.deepEqual(
      (event!.payload as { files: unknown }).files,
      [
        { id: "F0PDF", name: "report.pdf", mimetype: "application/pdf", size: 8, attached: true },
        { id: "F0BIG", name: "big.png", mimetype: "image/png", size: 5000, attached: false },
        { id: "F0MOV", name: "clip.mov", mimetype: "video/quicktime", size: 10, attached: false },
      ],
    );
    assert.deepEqual(event!.files, [{ name: "report.pdf", type: "application/pdf", data: new Uint8Array(Buffer.from("%PDF-1.7")) }]);
    assert.deepEqual(
      api.calls.filter((call) => call.startsWith("download")),
      ["download https://files.example.com/F0PDF/report.pdf"],
    );
  });

  test("that cannot be fetched are only noted, and the log says why", async () => {
    const { events } = await eventsOf(workspace(), callback(said("files", { files: [file("F0GONE", "gone.png", "image/png", 10)] })));
    assert.equal(((events[0]!.payload as { files: { attached: boolean }[] }).files[0]!).attached, false);
    assert.equal(events[0]!.files, undefined);
    assert.ok(lines.some((line) => line.includes("files.download") && line.includes("http_404")));
  });

  test("that turn out larger than they said are only noted", async () => {
    api.files["https://files.example.com/F0LIE/small.png"] = new Uint8Array(2000);
    const { events } = await eventsOf(workspace(), callback(said("files", { files: [file("F0LIE", "small.png", "image/png", 10)] })));
    assert.equal(((events[0]!.payload as { files: { attached: boolean }[] }).files[0]!).attached, false);
  });
});

describe("an edit, a deletion and a reaction", () => {
  test("an edit is an event named by Slack's event_id, with the text now", async () => {
    const { events } = await eventsOf(
      workspace(),
      callback({
        type: "message",
        subtype: "message_changed",
        channel: "C0DEV",
        channel_type: "channel",
        hidden: true,
        ts: "1794819700.000300",
        message: { type: "message", user: "U0ALICE", text: "the plan", ts: TS, edited: { user: "U0ALICE", ts: "1794819700.000000" } },
        previous_message: { type: "message", user: "U0ALICE", text: "teh plan", ts: TS },
      }),
    );
    assert.deepEqual(events, [
      {
        id: "work/Ev0001",
        occurred_at: "2026-11-16T09:01:00.000Z",
        summary: "work #dev Alice A. edited: the plan",
        stream: "work.dev",
        delivery: "batch",
        payload: {
          type: "message_changed",
          workspace: "work",
          channel: { id: "C0DEV", name: "dev", type: "channel" },
          ts: TS,
          user: { id: "U0ALICE", name: "Alice A." },
          own: false,
          text: "the plan",
        } satisfies SlackPayload,
      },
    ]);
  });

  test("a change that leaves the text and files as they were (an unfurl, a reply count) is dropped", async () => {
    const same = { type: "message", user: "U0ALICE", text: "see https://example.com", ts: TS };
    const result = await eventsOf(
      workspace(),
      callback({ type: "message", subtype: "message_changed", channel: "C0DEV", channel_type: "channel", message: { ...same, attachments: [{ title: "Example" }] }, previous_message: same }),
    );
    assert.deepEqual(result, { events: [], dropped: 1 });
  });

  test("a deletion names the message it took away", async () => {
    const { events } = await eventsOf(
      workspace(),
      callback({ type: "message", subtype: "message_deleted", channel: "C0DEV", channel_type: "channel", hidden: true, deleted_ts: TS, previous_message: { type: "message", user: "U0ALICE", text: "x", ts: TS, thread_ts: "1794819000.000100" } }),
    );
    assert.equal(events[0]!.summary, "work #dev: a message was deleted");
    assert.deepEqual(events[0]!.payload, { type: "message_deleted", workspace: "work", channel: { id: "C0DEV", name: "dev", type: "channel" }, ts: TS, thread_ts: "1794819000.000100" });
  });

  test("a reaction put on or taken off a message is an event; one on anything else is dropped", async () => {
    const ws = workspace();
    const added = await eventsOf(ws, callback({ type: "reaction_added", user: "U0BOB", reaction: "+1", item_user: "U0ALICE", item: { type: "message", channel: "C0DEV", ts: TS }, event_ts: "1794819700.000400" }));
    assert.equal(added.events[0]!.summary, "work #dev Bob B. reacted :+1:");
    assert.equal(added.events[0]!.delivery, "batch");
    assert.deepEqual(added.events[0]!.payload, {
      type: "reaction_added",
      workspace: "work",
      channel: { id: "C0DEV", name: "dev", type: "channel" },
      ts: TS,
      user: { id: "U0BOB", name: "Bob B." },
      own: false,
      reaction: "+1",
    });
    const removed = await eventsOf(ws, callback({ type: "reaction_removed", user: "U0BOB", reaction: "+1", item: { type: "message", channel: "C0DEV", ts: TS } }, { event_id: "Ev0002" }));
    assert.equal(removed.events[0]!.summary, "work #dev Bob B. took off :+1:");
    assert.equal(removed.events[0]!.id, "work/Ev0002");
    assert.deepEqual(await eventsOf(ws, callback({ type: "reaction_added", user: "U0BOB", reaction: "+1", item: { type: "file", file: "F0A" } })), { events: [], dropped: 1 });
  });
});

describe("the fill-in after a (re)connection", () => {
  const oldest = String(NOW.getTime() / 1000 - 3600);

  test("fetches the recent messages and threads of every conversation the bot is in, as the live ones are made", async () => {
    api.history.C0DEV = [
      { type: "message", user: "U0ALICE", text: "parent", ts: TS, reply_count: 1, latest_reply: "1794819700.000200", reactions: [{ name: "eyes", users: ["U0BOB"], count: 1 }] },
      { type: "message", subtype: "channel_join", user: "U0BOB", text: "joined", ts: "1794819650.000100" },
    ];
    api.threads[`C0DEV/${TS}`] = [
      { type: "message", user: "U0ALICE", text: "parent", ts: TS, thread_ts: TS },
      { type: "message", user: "U0BOB", text: "<@U0SELF> reply", ts: "1794819700.000200", thread_ts: TS },
    ];
    api.history.D0ALICE = [{ type: "message", user: "U0ALICE", text: "psst", ts: "1794819800.000100" }];
    const delivered: ConnectionEvent[][] = [];
    const ws = workspace();
    await ws.identify();
    const result = await ws.backfill(async (events) => {
      delivered.push([...events]);
      return true;
    });
    assert.deepEqual(result, { conversations: 2, events: 3, failed: 0, stopped: false });
    assert.deepEqual(
      delivered.map((batch) => batch.map((event) => [event.id, event.delivery, (event.payload as { fetched?: true }).fetched])),
      [
        [
          [`work/C0DEV/${TS}`, "batch", true],
          ["work/C0DEV/1794819700.000200", "now", true],
        ],
        [["work/D0ALICE/1794819800.000100", "now", true]],
      ],
    );
    assert.deepEqual(delivered.flat().map((event) => event.answer_via), [undefined, { command: "slackctl post" }, { command: "slackctl post" }]);
    assert.deepEqual((delivered[0]![0]!.payload as { reactions: unknown }).reactions, [{ name: "eyes", users: [{ id: "U0BOB", name: "Bob B." }], count: 1 }]);
    assert.ok(api.calls.includes(`conversations.history C0DEV ${oldest}`));
    assert.ok(api.calls.includes(`conversations.replies C0DEV ${TS} ${oldest}`));
  });

  test("skips the threads with no reply in the time it reads", async () => {
    api.history.C0DEV = [{ type: "message", user: "U0ALICE", text: "old thread", ts: TS, reply_count: 3, latest_reply: "1794810000.000100" }];
    const ws = workspace();
    await ws.identify();
    await ws.backfill(async () => true);
    assert.equal(api.calls.filter((call) => call.startsWith("conversations.replies")).length, 0);
  });

  test("stops at the first conversation the intake does not take", async () => {
    api.history.C0DEV = [{ type: "message", user: "U0ALICE", text: "one", ts: TS }];
    api.history.D0ALICE = [{ type: "message", user: "U0ALICE", text: "two", ts: TS }];
    const ws = workspace();
    await ws.identify();
    const result = await ws.backfill(async () => false);
    assert.deepEqual(result, { conversations: 1, events: 0, failed: 0, stopped: true });
    assert.equal(api.calls.filter((call) => call.startsWith("conversations.history")).length, 1);
  });

  test("goes on past a conversation Slack refuses, and counts it", async () => {
    api.history.D0ALICE = [{ type: "message", user: "U0ALICE", text: "two", ts: TS }];
    api.failing.add(`conversations.history C0DEV ${oldest}`);
    const ws = workspace();
    await ws.identify();
    const result = await ws.backfill(async () => true);
    assert.deepEqual(result, { conversations: 1, events: 1, failed: 1, stopped: false });
    assert.ok(lines.some((line) => line.includes("conversations.history") && line.includes("ratelimited")));
  });

  test("is not run when backfill_hours is 0", async () => {
    const ws = workspace({ backfillSeconds: 0 });
    await ws.identify();
    assert.deepEqual(await ws.backfill(async () => true), { conversations: 0, events: 0, failed: 0, stopped: false });
    assert.equal(api.calls.includes("users.conversations"), false);
  });
});
