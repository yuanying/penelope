// The Signal plugin (docs/receivers.md, "Signal のプラグイン"): its settings,
// the events it makes of what signal-cli receives, and the whole of it against
// a made-up signal-cli on a Unix socket. Every number is made up.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { SettingsError, type ConnectionEvent } from "../src/plugin.ts";
import { eventOf, fold, signal, signalPlugin, type Audience } from "../src/plugins/signal.ts";

const OWNER = "+15550000001";
const AGENT = "+15550000002";
const STRANGER = "+15550000003";
const GROUP = "Z3JvdXAtb25lLWlkLW1hZGUtdXA=";
const env = { readFile: () => "" };
const SETTINGS = { socket: "/run/signal/cli.sock", account: AGENT, senders: [OWNER] };

function refused(settings: Record<string, unknown>): string {
  try {
    signal.create(settings, env);
  } catch (error) {
    assert.ok(error instanceof SettingsError, String(error));
    return error.message;
  }
  assert.fail("the settings were taken");
}

describe("the Signal plugin's settings", () => {
  test("take a socket, the account and the senders", () => {
    assert.equal(signal.kind, "connection");
    signal.create(
      { ...SETTINGS, senders: [OWNER, "0b0e5b1c-1111-4222-8333-444455556666"], groups: { family: GROUP }, names: ["いおり"], send_socket: "/run/signal-send/send.sock", max_file_bytes: 1024, rpc_timeout_seconds: 5 },
      env,
    );
  });

  test("refuse what they cannot run with, naming the field", () => {
    assert.equal(refused({ ...SETTINGS, extra: 1 }), "extra: not a field of this plugin");
    assert.equal(refused({ ...SETTINGS, socket: "cli.sock" }), "socket: must be the absolute path of a Unix socket");
    assert.equal(refused({ ...SETTINGS, account: "0901234567" }), "account: must be a phone number in E.164 (+81…)");
    assert.equal(refused({ ...SETTINGS, senders: [] }), "senders: must be a list of one or more phone numbers or UUIDs");
    assert.equal(refused({ ...SETTINGS, senders: [OWNER, "alice"] }), "senders[1]: must be a phone number in E.164 or a UUID");
    assert.equal(refused({ ...SETTINGS, max_file_bytes: 0 }), "max_file_bytes: must be an integer from 1 to 62914560");
    assert.equal(refused({ ...SETTINGS, groups: [GROUP] }), "groups: must map a name to a group ID");
    assert.equal(refused({ ...SETTINGS, groups: { Family: GROUP } }), "groups.Family: the name must be 1-32 of a-z, 0-9 and -, not starting with -");
    assert.equal(refused({ ...SETTINGS, groups: { family: "not an id!" } }), "groups.family: must be a group ID as signal-cli's listGroups gives it (base64)");
    assert.equal(refused({ ...SETTINGS, groups: { family: GROUP, again: GROUP } }), "groups.again: the same group ID is named twice");
    assert.equal(refused({ ...SETTINGS, names: ["い"] }), "names[0]: must be a name of 2 characters or more");
    assert.equal(refused({ ...SETTINGS, typing_seconds: -1 }), "typing_seconds: must be a number from 0 to 3600");
  });
});

const message = (dataMessage: Record<string, unknown>, from = OWNER) => ({ sourceNumber: from, sourceUuid: null, sourceName: "Owner", timestamp: 1794819600000, dataMessage: { timestamp: 1794819600000, ...dataMessage } });
const allowed: Audience = { account: AGENT, senders: new Set([OWNER]), groups: new Map([[GROUP, "family"]]), names: [fold("イオリ")] };
const inGroup = (dataMessage: Record<string, unknown>, from = STRANGER) => message({ groupInfo: { groupId: GROUP, groupName: "Family", type: "DELIVER" }, ...dataMessage }, from);

describe("the events it makes", () => {
  test("a message from an allowed sender comes now, its text inline", () => {
    const made = eventOf(message({ message: "hello\nthere", quote: { id: 1794819500000, text: "earlier" } }), allowed)!;
    assert.deepEqual(made.event, {
      id: `${OWNER}/1794819600000`,
      occurred_at: "2026-11-16T09:00:00.000Z",
      stream: "dm.15550000001",
      delivery: "now",
      summary: "Signal Owner: hello there",
      payload: { type: "message", from: { number: OWNER, name: "Owner" }, timestamp: 1794819600000, text: "hello\nthere", quote: { timestamp: 1794819500000, text: "earlier" } },
    });
    assert.deepEqual(made.attachments, []);
  });

  test("files are listed, to be fetched", () => {
    const made = eventOf(message({ attachments: [{ id: "a1.png", contentType: "image/png", filename: "photo.png", size: 3 }] }), allowed)!;
    assert.equal(made.event.summary, "Signal Owner: (1 file)");
    assert.deepEqual(made.event.payload.files, [{ name: "photo.png", mimetype: "image/png", size: 3, attached: false }]);
    assert.deepEqual(made.attachments, [{ id: "a1.png", name: "photo.png", type: "image/png", size: 3 }]);
  });

  test("a reaction is batched", () => {
    const made = eventOf(message({ reaction: { emoji: "👍", targetSentTimestamp: 1794819500000, isRemove: false } }), allowed)!;
    assert.equal(made.event.delivery, "batch");
    assert.equal(made.event.summary, "Signal Owner reacted 👍");
    assert.deepEqual(made.event.payload.reaction, { emoji: "👍", target_timestamp: 1794819500000, removed: false });
  });

  test("anyone's message in an allowed group comes batched, in the group's stream", () => {
    const made = eventOf(inGroup({ message: "dinner at 7?" }), allowed)!;
    assert.equal(made.groupId, GROUP);
    assert.deepEqual(made.event, {
      id: `group.family/${STRANGER}/1794819600000`,
      occurred_at: "2026-11-16T09:00:00.000Z",
      stream: "group.family",
      delivery: "batch",
      summary: "Signal family Owner: dinner at 7?",
      payload: { type: "message", from: { number: STRANGER, name: "Owner" }, group: { name: "family", title: "Family" }, timestamp: 1794819600000, text: "dinner at 7?" },
    });
    assert.equal(eventOf(inGroup({ reaction: { emoji: "👍", targetSentTimestamp: 1, isRemove: false } }), allowed)!.event.stream, "group.family");
  });

  test("what is for the agent in a group comes now: a mention, a quote of hers, her name, or what follows her post", () => {
    const mention = eventOf(inGroup({ message: "\uFFFC can you? \uFFFC", mentions: [{ number: AGENT, start: 0, length: 1 }, { number: OWNER, name: "Masa", start: 11, length: 1 }] }), allowed)!;
    assert.equal(mention.event.delivery, "now");
    assert.equal(mention.event.payload.text, "@you can you? @Masa");
    assert.equal(mention.event.payload.mentions_me, true);
    const quote = eventOf(inGroup({ message: "yes", quote: { id: 5, authorNumber: AGENT, text: "shall I?" } }), allowed)!;
    assert.equal(quote.event.delivery, "now");
    assert.deepEqual(quote.event.payload.quote, { timestamp: 5, text: "shall I?", author: AGENT, mine: true });
    assert.equal(eventOf(inGroup({ message: "ask いおり" }), allowed)!.event.delivery, "now");
    assert.equal(eventOf(inGroup({ message: "hi" }), { ...allowed, followsOwn: (id, at) => id === GROUP && at === 1794819600000 })!.event.delivery, "now");
  });

  test("other groups, strangers, receipts and empty messages are dropped", () => {
    assert.equal(eventOf(message({ message: "hi", groupInfo: { groupId: "g" } }), allowed), undefined);
    assert.equal(eventOf(message({ message: "hi", groupInfo: { groupId: "b3RoZXI=" } }), allowed), undefined);
    assert.equal(eventOf(message({ message: "hi" }, STRANGER), allowed), undefined);
    assert.equal(eventOf({ sourceNumber: OWNER, receiptMessage: { isRead: true } }, allowed), undefined);
    assert.equal(eventOf(message({}), allowed), undefined);
  });
});

/** signal-cli's JSON-RPC on a Unix socket, one line a message. */
class FakeSignalCli {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly server: net.Server;
  clients: net.Socket[] = [];
  sendResult: unknown = { timestamp: 1794819700000, results: [{ type: "SUCCESS" }] };

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.server = net.createServer((client) => {
      this.clients.push(client);
      let buffer = "";
      client.on("error", () => {});
      client.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, end)) as { id: number; method: string; params: Record<string, unknown> };
          buffer = buffer.slice(end + 1);
          this.calls.push({ method: request.method, params: request.params });
          const result = request.method === "getAttachment" ? { data: Buffer.from([1, 2, 3]).toString("base64") } : request.method === "send" ? this.sendResult : {};
          client.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
    });
  }

  listen = () => new Promise<void>((resolve) => this.server.listen(this.path, resolve));
  push(envelope: unknown, account: string | undefined = AGENT) {
    for (const client of this.clients) client.write(`${JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope, account } })}\n`);
  }
  close = () => new Promise<void>((resolve) => {
    for (const client of this.clients) client.destroy();
    this.clients = [];
    this.server.close(() => resolve());
  });
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "in time");
};

function post(path: string, form: FormData) {
  return new Promise<{ status: number; body: Record<string, unknown> }>(async (resolve, reject) => {
    const request = new Request("http://signal/v1/send", { method: "POST", body: form });
    const body = Buffer.from(await request.arrayBuffer());
    const req = http.request({ socketPath: path, path: "/v1/send", method: "POST", headers: { "content-type": request.headers.get("content-type")!, "content-length": body.length } }, (response) => {
      const parts: Buffer[] = [];
      response.on("data", (part: Buffer) => parts.push(part));
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the Signal plugin against signal-cli", () => {
  const dir = mkdtempSync(join(tmpdir(), "receivers-signal-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("hands messages over, fetches files, sends a read receipt, answers through the send socket and connects again", async () => {
    const cli = new FakeSignalCli(join(dir, "cli.sock"));
    await cli.listen();
    const delivered: ConnectionEvent[] = [];
    const lines: string[] = [];
    let take = false;
    const sendSocket = join(dir, "send.sock");
    const connection = signalPlugin({ backoffMs: () => 10 }).create({ ...SETTINGS, groups: { family: GROUP }, socket: cli.path, send_socket: sendSocket }, env);
    const handle = connection.start({
      deliver: async (events) => {
        if (!take) {
          take = true; // the first try is not taken, the next is
          return false;
        }
        delivered.push(...events);
        return true;
      },
      log: (line) => lines.push(line),
      now: () => new Date(),
    });
    try {
      await until(() => cli.clients.length === 1 && lines.includes("connected"));
      // Guards against: an allowed sender's message to another number of a multi-account daemon taken as ours.
      cli.push(message({ message: "not ours", attachments: [{ id: "x.png", contentType: "image/png", filename: "x.png", size: 3 }] }), "+819000000009");
      cli.push(message({ message: "hi" }, STRANGER));
      cli.push(message({ message: "look", attachments: [{ id: "a1.png", contentType: "image/png", filename: "photo.png", size: 3 }] }));
      await until(() => delivered.length === 1 && cli.calls.some((call) => call.method === "sendReceipt"));
      const [event] = delivered;
      assert.equal(event!.id, `${OWNER}/1794819600000`);
      assert.deepEqual(event!.files, [{ name: "photo.png", type: "image/png", data: Buffer.from([1, 2, 3]) }]);
      assert.equal((event!.payload as { files: { attached: boolean }[] }).files[0]!.attached, true);
      assert.deepEqual(
        cli.calls.map((call) => call.method),
        ["getAttachment", "sendTyping", "sendReceipt"],
      );
      assert.deepEqual(cli.calls[1]!.params, { account: AGENT, recipient: [OWNER] });
      assert.deepEqual(cli.calls[2]!.params, { account: AGENT, recipient: OWNER, targetTimestamp: [1794819600000], type: "read" });
      assert.ok(lines.includes("envelope events=0 dropped=1"));
      assert.ok(lines.includes("envelope events=0 dropped=1 (another account)"));

      // Guards against: a body cut off midway rejecting the handler and taking the process down.
      await new Promise<void>((resolve) => {
        const cut = http.request({ socketPath: sendSocket, path: "/v1/send", method: "POST", headers: { "content-type": "text/plain", "content-length": 1000 } });
        cut.on("error", () => resolve());
        cut.write("x".repeat(10));
        setTimeout(() => (cut.destroy(), resolve()), 50);
      });
      await until(() => lines.some((line) => line.startsWith("send aborted")));

      const form = new FormData();
      form.set("text", "here it is\n");
      form.append("file", new Blob([new Uint8Array([4, 5])], { type: "image/png" }), "drawn;1.png");
      const sent = await post(sendSocket, form);
      assert.deepEqual(sent, { status: 200, body: { timestamp: 1794819700000 } });
      assert.deepEqual(cli.calls.at(-1), {
        method: "send",
        params: { account: AGENT, recipient: [OWNER], message: "here it is", attachments: ["data:image/png;filename=drawn%3B1.png;base64,BAU="] },
      });
      // curl sends a WebP as octet-stream; a file with no type or an unknown extension stays octet-stream.
      const typed = new FormData();
      typed.append("file", new Blob([new Uint8Array([4])], { type: "application/octet-stream" }), "moving.WEBP");
      typed.append("file", new Blob([new Uint8Array([4])]), "clip.mp4");
      typed.append("file", new Blob([new Uint8Array([4])]), "notes.bin");
      assert.equal((await post(sendSocket, typed)).status, 200);
      assert.deepEqual(cli.calls.at(-1)!.params.attachments, [
        "data:image/webp;filename=moving.WEBP;base64,BA==",
        "data:video/mp4;filename=clip.mp4;base64,BA==",
        "data:application/octet-stream;filename=notes.bin;base64,BA==",
      ]);
      // signal-cli URL-decodes the name: a % or a + must come through as itself. A type's parameters are dropped.
      const named = new FormData();
      named.append("file", new Blob([new Uint8Array([4])], { type: "application/pdf" }), "100%.pdf");
      named.append("file", new Blob([new Uint8Array([4])], { type: "image/png; x=1" }), "a+b.png");
      assert.equal((await post(sendSocket, named)).status, 200);
      assert.deepEqual(cli.calls.at(-1)!.params.attachments, ["data:application/pdf;filename=100%25.pdf;base64,BA==", "data:image/png;filename=a%2Bb.png;base64,BA=="]);
      assert.deepEqual(
        (cli.calls.at(-1)!.params.attachments as string[]).map((uri) => decodeURIComponent(/filename=([^;]*)/.exec(uri)![1]!)),
        ["100%.pdf", "a+b.png"],
      );

      const stranger = new FormData();
      stranger.set("text", "hi");
      stranger.set("to", STRANGER);
      assert.equal((await post(sendSocket, stranger)).status, 403);
      assert.equal((await post(sendSocket, new FormData())).status, 400);

      // To a group, as a quoted reply: her post goes into the group's stream, and what follows it comes now.
      const toGroup = new FormData();
      toGroup.set("text", "7 is fine");
      toGroup.set("group", "family");
      toGroup.set("quote_timestamp", "1794819600000");
      toGroup.set("quote_author", STRANGER);
      assert.deepEqual(await post(sendSocket, toGroup), { status: 200, body: { timestamp: 1794819700000 } });
      assert.deepEqual(cli.calls.at(-1), {
        method: "send",
        params: { account: AGENT, groupId: GROUP, message: "7 is fine", quoteTimestamp: 1794819600000, quoteAuthor: STRANGER },
      });
      await until(() => delivered.length === 2);
      assert.equal(delivered[1]!.id, `group.family/${AGENT}/1794819700000`);
      assert.equal(delivered[1]!.delivery, "batch");
      assert.deepEqual(delivered[1]!.payload, { type: "message", from: { number: AGENT }, group: { name: "family" }, own: true, timestamp: 1794819700000, text: "7 is fine" });
      cli.push({ ...inGroup({ message: "great" }), timestamp: 1794819800000, dataMessage: { ...inGroup({}).dataMessage, message: "great", timestamp: 1794819800000 } });
      await until(() => delivered.length === 3);
      assert.equal(delivered[2]!.delivery, "now");
      const both = new FormData();
      both.set("text", "hi");
      both.set("group", "family");
      both.set("to", OWNER);
      assert.equal((await post(sendSocket, both)).status, 400);
      const otherGroup = new FormData();
      otherGroup.set("text", "hi");
      otherGroup.set("group", "work");
      assert.equal((await post(sendSocket, otherGroup)).status, 403);
      cli.sendResult = { timestamp: 1794819900000, results: [{ type: "UNREGISTERED_FAILURE" }, { type: "SUCCESS" }] };
      assert.equal((await post(sendSocket, toGroup)).status, 200, "a group's send fails only when no member took it");

      cli.sendResult = { timestamp: 1, results: [{ type: "UNREGISTERED_FAILURE" }] };
      const refusedForm = new FormData();
      refusedForm.set("text", "hi");
      assert.deepEqual(await post(sendSocket, refusedForm), { status: 502, body: { error: "Signal did not take it (UNREGISTERED_FAILURE)" } });

      // signal-cli goes away and comes back.
      await cli.close();
      await until(() => lines.some((line) => line.startsWith("connecting again")));
      assert.equal((await post(sendSocket, refusedForm)).status, 503);
      await cli.listen();
      await until(() => cli.clients.length === 1 && lines.filter((line) => line === "connected").length === 2);
    } finally {
      await handle.stop();
      await cli.close();
    }
  });

  test("shows typing in a group while a message for the agent is worked on, and stops it after typing_seconds", async () => {
    const cli = new FakeSignalCli(join(dir, "typing.sock"));
    await cli.listen();
    const lines: string[] = [];
    const connection = signalPlugin({ backoffMs: () => 10 }).create({ ...SETTINGS, groups: { family: GROUP }, names: ["iori"], socket: cli.path, typing_seconds: 0.05 }, env);
    const handle = connection.start({ deliver: async () => true, log: (line) => lines.push(line), now: () => new Date() });
    try {
      await until(() => cli.clients.length === 1 && lines.includes("connected"));
      cli.push(inGroup({ message: "chatting" }));
      await until(() => cli.calls.some((call) => call.method === "sendReceipt"));
      assert.ok(!cli.calls.some((call) => call.method === "sendTyping"), "a batched message shows no typing");
      // Her name comes now, but only a mention or a quote of hers shows typing in a group.
      cli.push(inGroup({ message: "Iori said so" }));
      await until(() => cli.calls.filter((call) => call.method === "sendReceipt").length === 2);
      assert.ok(!cli.calls.some((call) => call.method === "sendTyping"), "a name alone shows no typing");
      cli.push(inGroup({ message: "\uFFFC?", mentions: [{ number: AGENT, start: 0, length: 1 }] }));
      await until(() => cli.calls.some((call) => call.method === "sendTyping" && call.params.stop === true));
      assert.deepEqual(
        cli.calls.filter((call) => call.method === "sendTyping").map((call) => call.params),
        [{ account: AGENT, groupId: [GROUP] }, { account: AGENT, groupId: [GROUP], stop: true }],
      );
    } finally {
      await handle.stop();
      await cli.close();
    }
  });

  test("a direct message sent ends the typing, also to a sender written as a UUID", async () => {
    const cli = new FakeSignalCli(join(dir, "typing-dm.sock"));
    await cli.listen();
    const lines: string[] = [];
    const sendSocket = join(dir, "typing-send.sock");
    const OWNER_UUID = "0b0e5b1c-1111-4222-8333-444455556666";
    const connection = signalPlugin({ backoffMs: () => 10 }).create({ ...SETTINGS, senders: [OWNER_UUID], socket: cli.path, send_socket: sendSocket, typing_seconds: 0.2 }, env);
    const handle = connection.start({ deliver: async () => true, log: (line) => lines.push(line), now: () => new Date() });
    try {
      await until(() => lines.includes("connected"));
      cli.push({ ...message({ message: "hi" }), sourceUuid: OWNER_UUID });
      await until(() => cli.calls.some((call) => call.method === "sendTyping"));
      assert.deepEqual(cli.calls.find((call) => call.method === "sendTyping")!.params, { account: AGENT, recipient: [OWNER_UUID] });
      const form = new FormData();
      form.set("text", "here");
      assert.equal((await post(sendSocket, form)).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 400)); // past typing_seconds
      // Guards against: typing started under the number and the send's `to` (the UUID) not finding it, so it ran to the limit.
      assert.deepEqual(
        cli.calls.filter((call) => call.method === "sendTyping").map((call) => call.params),
        [{ account: AGENT, recipient: [OWNER_UUID] }],
      );
    } finally {
      await handle.stop();
      await cli.close();
    }
  });
});


describe("the Signal plugin while the intake refuses or it stops", () => {
  const dir = mkdtempSync(join(tmpdir(), "receivers-signal-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("stop() wakes every wait in progress: a redelivery's and a reconnection's", async () => {
    const cli = new FakeSignalCli(join(dir, "wake.sock"));
    await cli.listen();
    const lines: string[] = [];
    const connection = signalPlugin({ backoffMs: () => 60_000 }).create({ ...SETTINGS, socket: cli.path }, env);
    const handle = connection.start({ deliver: async () => false, log: (line) => lines.push(line), now: () => new Date() });
    await until(() => lines.includes("connected"));
    cli.push(message({ message: "hi" }));
    await new Promise((resolve) => setTimeout(resolve, 50)); // refused once, waiting to try again
    await cli.close();
    await until(() => lines.some((line) => line.startsWith("connecting again")));
    const started = Date.now();
    await handle.stop();
    // Guards against: one slot for the wake, the second wait overwriting the first so stop() waits it out.
    assert.ok(Date.now() - started < 5_000, `stop() took ${Date.now() - started} ms`);
    assert.ok(lines.includes("envelope events=1 dropped=0 taken=false (stopping)"));
  });

  test("a message that comes while it stops is still handed over once", async () => {
    const cli = new FakeSignalCli(join(dir, "stopping.sock"));
    await cli.listen();
    const lines: string[] = [];
    const delivered: ConnectionEvent[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const connection = signalPlugin({ backoffMs: () => 10 }).create({ ...SETTINGS, socket: cli.path }, env);
    const handle = connection.start({
      deliver: async (events) => {
        await held;
        delivered.push(...events);
        return true;
      },
      log: (line) => lines.push(line),
      now: () => new Date(),
    });
    try {
      await until(() => lines.includes("connected"));
      cli.push(message({ message: "first" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stopping = handle.stop();
      cli.push({ ...message({ message: "second" }), dataMessage: { timestamp: 1794819600001, message: "second" } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await stopping;
      // Guards against: a receive dropped without a word because stop() had begun.
      assert.deepEqual(delivered.map((event) => (event.payload as { text: string }).text), ["first", "second"]);
    } finally {
      await cli.close();
    }
  });

  test("her post to a group the intake refuses is handed over again, not sent again, and answered 200", async () => {
    const cli = new FakeSignalCli(join(dir, "own.sock"));
    await cli.listen();
    const lines: string[] = [];
    const delivered: ConnectionEvent[] = [];
    let refusals = 2;
    const sendSocket = join(dir, "own-send.sock");
    const connection = signalPlugin({ backoffMs: () => 5 }).create({ ...SETTINGS, groups: { family: GROUP }, socket: cli.path, send_socket: sendSocket }, env);
    const handle = connection.start({
      deliver: async (events) => {
        if (refusals-- > 0) return false; // a backend restarting
        delivered.push(...events);
        return true;
      },
      log: (line) => lines.push(line),
      now: () => new Date(),
    });
    try {
      await until(() => lines.includes("connected"));
      const form = new FormData();
      form.set("text", "7 is fine");
      form.set("group", "family");
      assert.equal((await post(sendSocket, form)).status, 200);
      // Guards against: her post, which Signal never gives back, lost for good after one refusal.
      await until(() => delivered.length === 1);
      assert.equal(delivered[0]!.id, `group.family/${AGENT}/1794819700000`);
      assert.equal(cli.calls.filter((call) => call.method === "send").length, 1);
    } finally {
      await handle.stop();
      await cli.close();
    }
  });

  test("an event the intake keeps refusing is dropped after 30 minutes, without a receipt", async () => {
    const cli = new FakeSignalCli(join(dir, "refused.sock"));
    await cli.listen();
    const lines: string[] = [];
    let clock = 0;
    const connection = signalPlugin({ backoffMs: () => 1 }).create({ ...SETTINGS, socket: cli.path }, env);
    const handle = connection.start({
      deliver: async () => false,
      log: (line) => lines.push(line),
      now: () => new Date((clock += 10 * 60 * 1000)), // ten minutes a look
    });
    try {
      await until(() => lines.includes("connected"));
      cli.push(message({ message: "hi" }));
      await until(() => lines.some((line) => line.startsWith("envelope events=1 dropped=1 taken=false (refused for 30 minutes")));
      assert.ok(!cli.calls.some((call) => call.method === "sendReceipt"));
    } finally {
      await handle.stop();
      await cli.close();
    }
  });
});
