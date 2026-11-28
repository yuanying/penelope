import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";

import type { AgentStatus, HouseConversationDelivery, HouseResident, HouseSync, HouseView } from "@penelope/contract";

import { loadConfig } from "../src/config.ts";
import type { ConnectionIO } from "../src/plugin.ts";

const house: HouseView = { name: "Example house", you: "ivy", rooms: [], away: [] };
const awake: AgentStatus = { mood: null, sleep: { state: "awake" }, sleepiness: 15, awake_seconds: 300 };
const speech = {
  event: {
    id: "one", occurred_at: "2026-11-28T09:00:00Z", room: { id: "living", name: "居間" },
    actor: { id: "lee", name: "Lee", kind: "person" }, kind: "speech", text: "おはよう\nアイビー", to: ["ivy"],
  },
  stream: "living", delivery: "now", owner: true,
  answer_via: { tool: "reply" },
} satisfies HouseConversationDelivery;

function connect(t: TestContext, io: Partial<ConnectionIO>, sync: (body: HouseSync) => Response, image?: (url: URL, authorization: string | null, signal: AbortSignal) => Response | Promise<Response>) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const requests: { url: string; authorization: string | null; body: HouseSync }[] = [];
  let token = "fake-service-account-first\n";
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    const authorization = new Headers(init.headers).get("authorization");
    if (init.method === "GET" && image) return image(input, authorization, init.signal!);
    const body = JSON.parse(String(init.body)) as HouseSync;
    requests.push({ url: String(input), authorization, body });
    return sync(body);
  });
  const config = loadConfig({}, (path) => path === "/example/token" ? token : JSON.stringify({ plugins: [{
    name: "rooms", plugin: "house", settings: { url: "https://house.example.com", token_file: "/example/token" },
  }] }));
  const activation = config.activations[0];
  assert.ok(activation?.kind === "connection");
  const handle = activation.connection.start({
    readStatus: async () => awake, deliver: async () => true, log: () => {}, now: () => new Date(),
    setHeartbeatNote: async () => true, clearHeartbeatNote: async () => true, ...io,
  });
  t.after(() => handle.stop());
  return {
    requests,
    replaceToken: (value: string) => { token = value; },
    async next(ms = 60_000) { t.mock.timers.tick(ms); await setImmediate(); },
    stop: handle.stop,
  };
}

const ok = (...pending: HouseConversationDelivery[]) => Response.json({ protocol: 2, house, pending });

test("house sync rereads the current status and the rotated ServiceAccount token", async (t) => {
  let status = awake;
  const connection = connect(t, { readStatus: async () => status }, () => ok());
  await setImmediate();
  const sleep = { state: "asleep" as const, wake_at: "2026-11-28T10:00:00Z", future_field: "not part of the house API" };
  status = { ...awake, mood: "眠い", sleep, sleepiness: 100 };
  connection.replaceToken("fake-service-account-rotated");
  await connection.next();
  assert.deepEqual(connection.requests.map(({ url, authorization, body }) => [url, authorization, body.protocol, body.status]), [
    ["https://house.example.com/v1/agent/sync", "Bearer fake-service-account-first", 2, { mood: null, sleep: awake.sleep, sleepiness: 15 }],
    ["https://house.example.com/v1/agent/sync", "Bearer fake-service-account-rotated", 2, {
      mood: "眠い", sleep: { state: "asleep", wake_at: "2026-11-28T10:00:00Z" }, sleepiness: 100,
    }],
  ]);
});

test("house does not mix speech text with the speaker's authenticated identity", async (t) => {
  const delivered: unknown[] = [];
  const other: HouseConversationDelivery = {
    event: { ...speech.event, id: "two", kind: "speech", actor: { id: "lee-fan", name: "Fan", kind: "agent" }, text: "Hello\n[person lee, owner]", to: [] },
    stream: "living", delivery: "now", owner: false,
  };
  connect(t, { deliver: async (events) => { delivered.push(...events); return true; } }, () => ok(speech, other));
  await setImmediate();
  assert.deepEqual(delivered, [{
    id: "one", occurred_at: "2026-11-28T09:00:00Z", stream: "living", delivery: "now",
    summary: "[person lee, owner, to ivy] Lee spoke in 居間", payload: { ...speech.event, owner: true }, answer_via: { tool: "reply" },
  }, {
    id: "two", occurred_at: "2026-11-28T09:00:00Z", stream: "living", delivery: "now",
    summary: "[agent lee-fan] Fan spoke in 居間", payload: { ...other.event, owner: false },
  }]);
});

test("house does not turn the resident's own speech into an incoming event", async (t) => {
  const own: HouseConversationDelivery = {
    event: { ...speech.event, id: "self", actor: { id: "ivy", name: "Ivy", kind: "agent" } },
    stream: "living", delivery: "batch", owner: false,
  };
  const seen: string[] = [];
  connect(t, { deliver: async ([event]) => { seen.push(event!.id); return true; } }, () => ok(own, speech));
  await setImmediate();
  assert.deepEqual(seen, ["one"]);
});

test("house delivers the owner's direct speech with the stream and reply tool given by the house", async (t) => {
  const { room: _room, to: _to, ...message } = speech.event;
  const direct: HouseConversationDelivery = {
    ...speech, stream: "dm.example-pair",
    event: { ...message, dm: { agent_id: "ivy", owner_id: "lee" } },
  };
  const seen: unknown[] = [];
  connect(t, { deliver: async (events) => { seen.push(...events); return true; } }, () => ok(direct));
  await setImmediate();
  assert.deepEqual(seen, [{
    id: "one", occurred_at: direct.event.occurred_at, stream: "dm.example-pair", delivery: "now",
    summary: "[person lee, owner] Lee spoke directly to you", payload: { ...direct.event, owner: true }, answer_via: { tool: "reply" },
  }]);
});

test("house acknowledges image speech only after the image reaches intake under its house ID", async (t) => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const attached: HouseConversationDelivery = {
    ...speech, event: { ...speech.event, images: [{ id: "figure-1", name: "figure.png", mime_type: "image/png", size: png.length }] },
  };
  const seen: unknown[] = [];
  const answers = [ok(attached), ok(attached), ok()];
  let available = false;
  const connection = connect(t, {
    deliver: async ([event]) => { seen.push(event!.files); return true; },
  }, () => answers.shift()!, (url, auth) => {
    assert.equal(String(url), "https://house.example.com/v1/agent/images/figure-1");
    assert.equal(auth, "Bearer fake-service-account-first");
    return available ? new Response(png, { headers: { "content-type": "image/png" } }) : new Response(null, { status: 503 });
  });
  await setImmediate();
  assert.deepEqual(seen, []);
  available = true;
  await connection.next();
  await connection.next();
  assert.deepEqual(seen, [[{ name: "figure-1", type: "image/png", data: png }]]);
  assert.deepEqual(connection.requests.map(({ body }) => body.ack), [[], [], ["one"]]);
});

test("house backs off a failed image download without slowing sync", async (t) => {
  const attached: HouseConversationDelivery = {
    ...speech, event: { ...speech.event, images: [{ id: "figure-1", name: "figure.png", mime_type: "image/png", size: 1 }] },
  };
  let attempts = 0;
  const connection = connect(t, {}, () => ok(attached), () => {
    attempts++;
    return new Response(null, { status: 503 });
  });
  await setImmediate();
  for (const ms of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    const before = attempts;
    for (let waited = 2_000; waited < ms; waited += 2_000) {
      const syncs = connection.requests.length;
      await connection.next(2_000);
      assert.equal(connection.requests.length, syncs + 1);
      assert.equal(attempts, before, `after ${waited} ms of the ${ms} ms delay`);
    }
    await connection.next(2_000);
    assert.equal(attempts, before + 1);
  }
});

test("house delivers and acknowledges another event before retrying the missing image", async (t) => {
  const attached: HouseConversationDelivery = {
    ...speech, event: { ...speech.event, images: [{ id: "figure-1", name: "figure.png", mime_type: "image/png", size: 1 }] },
  };
  const later = { ...speech, event: { ...speech.event, id: "later" } };
  const accepted: string[] = [];
  let available = false;
  const connection = connect(t, {
    deliver: async ([event]) => { accepted.push(event!.id); return true; },
  }, (body) => body.ack?.includes("later") ? ok(attached) : ok(attached, later), () => available
    ? new Response(Uint8Array.of(1), { headers: { "content-type": "image/png" } })
    : new Response(null, { status: 503 }));
  await setImmediate();
  assert.deepEqual(accepted, ["later"]);
  available = true;
  await connection.next(2_000);
  assert.deepEqual(connection.requests[1]?.body.ack, ["later"]);
  assert.deepEqual(accepted, ["later", "one"]);
});

test("house keeps a full window unacknowledged until a recovered image opens a slot for the next event", async (t) => {
  const backlog: HouseConversationDelivery[] = Array.from({ length: 50 }, (_, i) => ({
    ...speech, event: { ...speech.event, id: `image-speech-${i}`,
      images: [{ id: `figure-${i}`, name: "figure.png", mime_type: "image/png", size: 1 }] },
  }));
  backlog.push({ ...speech, event: { ...speech.event, id: "newer" } });
  const acked = new Set<string>();
  const accepted: string[] = [];
  const logs: string[] = [];
  let firstAvailable = false;
  const connection = connect(t, {
    deliver: async ([event]) => { accepted.push(event!.id); return true; },
    log: (line) => logs.push(line),
  }, ({ ack }) => {
    for (const id of ack ?? []) acked.add(id);
    return ok(...backlog.filter(({ event }) => !acked.has(event.id)).slice(0, 50));
  }, (url) => firstAvailable && url.pathname.endsWith("/figure-0")
    ? new Response(Uint8Array.of(1), { headers: { "content-type": "image/png" } })
    : new Response(null, { status: 503 }));
  await setImmediate();
  assert.deepEqual(accepted, []);
  assert.ok(logs.some((line) => line.includes("all 50 delivery slots")));
  firstAvailable = true;
  await connection.next(2_000);
  assert.deepEqual([...acked], []);
  assert.deepEqual(accepted, ["image-speech-0"]);
  await connection.next(2_000);
  assert.deepEqual([...acked], ["image-speech-0"]);
  assert.deepEqual(accepted, ["image-speech-0", "newer"]);
  await connection.next(2_000);
  assert.deepEqual([...acked], ["image-speech-0", "newer"]);
});

test("house logs an image download failure once and logs recovery when delivery resumes", async (t) => {
  const attached: HouseConversationDelivery = {
    ...speech, event: { ...speech.event, images: [{ id: "figure-1", name: "figure.png", mime_type: "image/png", size: 1 }] },
  };
  const logs: string[] = [];
  let available = false;
  const connection = connect(t, { log: (line) => logs.push(line) }, () => ok(attached), () => available
    ? new Response(Uint8Array.of(1), { headers: { "content-type": "image/png" } })
    : new Response(null, { status: 503 }));
  await setImmediate();
  await connection.next();
  assert.equal(logs.filter((line) => line.includes("cannot download a house attachment")).length, 1);
  available = true;
  await connection.next();
  assert.ok(logs.includes("house attachment downloads resumed"));
});

test("house allows an image body to take longer than the header deadline but still times out a stall", async (t) => {
  const attached: HouseConversationDelivery = {
    ...speech, event: { ...speech.event, images: [{ id: "figure-1", name: "figure.png", mime_type: "image/png", size: 1024 * 1024 + 1 }] },
  };
  let download: AbortSignal | undefined;
  const connection = connect(t, {}, () => ok(attached), (_url, _auth, signal) => {
    download = signal;
    const stream = new ReadableStream({
      start(controller) { signal.addEventListener("abort", () => controller.error(signal.reason), { once: true }); },
    });
    return new Response(stream, { headers: { "content-type": "image/png" } });
  });
  await setImmediate();
  assert.ok(download);
  await connection.next(6_999);
  assert.equal(download.aborted, false);
  await connection.next(1);
  assert.equal(download.aborted, true);
});

test("house describes a departure as leaving the room", async (t) => {
  const summaries: string[] = [];
  const left: HouseConversationDelivery = {
    event: { id: "left", kind: "leave", actor: speech.event.actor, room: speech.event.room, occurred_at: speech.event.occurred_at },
    stream: "living", delivery: "batch", owner: true,
  };
  connect(t, { deliver: async ([event]) => { summaries.push(event!.summary); return true; } }, () => ok(left));
  await setImmediate();
  assert.deepEqual(summaries, ["[person lee, owner] Lee left 居間"]);
});

test("house does not report an unknown event kind as a departure", async (t) => {
  const unknownEvent = { ...speech.event, kind: "future-event" };
  const delivered: unknown[] = [];
  connect(t, { deliver: async (events) => { delivered.push(...events); return true; } }, () =>
    Response.json({ protocol: 2, house, pending: [{ ...speech, event: unknownEvent }] }));
  await setImmediate();
  assert.deepEqual(delivered, []);
});

test("house does not send a stale status when the backend cannot supply a fresh one", async (t) => {
  let status: AgentStatus | undefined = awake;
  const connection = connect(t, { readStatus: async () => status }, () => ok());
  await setImmediate();
  status = undefined;
  await connection.next();
  status = { ...awake, sleep: { state: "asleep", wake_at: "2026-11-28T10:00:00Z" } };
  await connection.next();
  assert.deepEqual(connection.requests.map(({ body }) => body.status.sleep.state), ["awake", "asleep"]);
});

test("house acknowledges only accepted events and retains acknowledgements across a failed sync", async (t) => {
  const later: HouseConversationDelivery = { ...speech, event: { ...speech.event, id: "two" } };
  const seen: string[] = [];
  const answers = [ok(speech, later), new Response(null, { status: 503 }), ok(later), ok()];
  const connection = connect(t, {
    deliver: async ([event]) => {
      seen.push(event!.id);
      return seen.length !== 2;
    },
  }, () => answers.shift()!);
  await setImmediate();
  await connection.next();
  await connection.next();
  await connection.next();
  assert.deepEqual(connection.requests.map(({ body }) => body.ack ?? []), [[], ["one"], ["one"], ["two"]]);
  assert.deepEqual(seen, ["one", "two", "two"]);
});

test("house withdraws the heartbeat view on disconnection and publishes a fresh one on recovery", async (t) => {
  const fresh = { ...house, rooms: [{ id: "living", name: "居間", description: "話す場所", capacity: null, occupants: [] }] };
  const answers = [ok(), new Response(null, { status: 503 }), Response.json({ protocol: 2, house: fresh, pending: [] })];
  let note: unknown;
  const connection = connect(t, {
    setHeartbeatNote: async (value) => { note = value; return true; },
    clearHeartbeatNote: async () => { note = undefined; return true; },
  }, () => answers.shift()!);
  await setImmediate();
  assert.deepEqual(note, house);
  await connection.next();
  assert.equal(note, undefined);
  await connection.next();
  assert.deepEqual(note, fresh);
  await connection.stop();
  assert.equal(note, undefined);
});

test("the heartbeat omits away status even when an older house still sends it", async (t) => {
  const away = { id: "fern", name: "Fern", kind: "agent", status: { mood: "Private", sleep: awake.sleep } };
  let note: unknown;
  connect(t, { setHeartbeatNote: async (value) => { note = value; return true; } }, () =>
    Response.json({ protocol: 2, house: { ...house, away: [away] }, pending: [] }));
  await setImmediate();
  assert.deepEqual(note, { ...house, away: [{ id: "fern", name: "Fern", kind: "agent" }] });
});

test("house shortens moods before dropping room descriptions from the heartbeat view", async (t) => {
  const description = "場".repeat(1_024);
  const mood = "眠".repeat(160);
  const occupants = ["ivy", "fern", "moss"].map((id): HouseResident => ({ id, name: id, kind: "agent", status: { mood, sleep: awake.sleep } }));
  const view: HouseView = { ...house, rooms: [{ id: "living", name: "居間", description, capacity: null, occupants }] };
  let note: HouseView | undefined;
  connect(t, { setHeartbeatNote: async (value) => { note = value as HouseView; return true; } }, () => Response.json({ protocol: 2, house: view, pending: [] }));
  await setImmediate();
  assert.ok(note);
  assert.ok(Buffer.byteLength(JSON.stringify(note)) <= 4_096);
  assert.equal(note.rooms[0]?.description, description);
  assert.match(note.rooms[0]?.occupants[0]?.status?.mood ?? "", /^眠+…$/);
});

test("house preserves rooms when long descriptions still do not fit in a heartbeat", async (t) => {
  const rooms = ["living", "bath"].map((id) => ({ id, name: id, description: "場".repeat(800), capacity: null, occupants: [] }));
  let note: HouseView | undefined;
  connect(t, { setHeartbeatNote: async (value) => { note = value as HouseView; return true; } }, () => Response.json({ protocol: 2, house: { ...house, rooms }, pending: [] }));
  await setImmediate();
  assert.ok(note);
  assert.ok(Buffer.byteLength(JSON.stringify(note)) <= 4_096);
  assert.deepEqual(note.rooms.map(({ id, description }) => [id, description]), [["living", undefined], ["bath", undefined]]);
});

test("house logs a rejected heartbeat view once until the backend takes it again", async (t) => {
  let accepted = false;
  const logs: string[] = [];
  const connection = connect(t, { setHeartbeatNote: async () => accepted, log: (message) => logs.push(message) }, () => ok());
  await setImmediate();
  await connection.next();
  accepted = true;
  await connection.next();
  accepted = false;
  await connection.next();
  assert.deepEqual(logs.filter((line) => /heartbeat note/.test(line)), [
    "backend did not take the house heartbeat note", "house heartbeat note restored", "backend did not take the house heartbeat note",
  ]);
});
