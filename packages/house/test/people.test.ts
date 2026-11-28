import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";

import type {
  HouseAgentStatus, HouseConversationSyncResult, HouseDirectHistory, HouseHistory, HousePersonDirectEvent, HousePersonEvent, HousePersonView,
  HouseReplyResult, HouseSpeechResult, HouseStreamReady, HouseSyncResult, HouseView,
} from "@penelope/contract";
import type { SenderCheck } from "@penelope/service-account-auth";

import { parseConfig } from "../src/config.ts";
import { startHouse } from "../src/server.ts";

const origin = "http://127.0.0.1";
const check: SenderCheck = {
  name: "test",
  precedence: 0,
  carries: (headers) => headers["x-test-agent"] === "fern",
  async check() { return { kind: "subject", subject: "system:serviceaccount:example:fern" }; },
};

function databaseFile(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "penelope-house-people-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "house.sqlite");
}

async function open(t: TestContext, database = ":memory:", people = [{ login: "Lee", name: "Lee at home" }, { login: "sam", name: "Sam" }], agentSettings: { owner_login?: string; personal_url?: string } = {}) {
  let now = Date.parse("2026-11-27T10:00:00Z");
  const config = parseConfig({
    name: "Example house", database, listen: { host: "127.0.0.1", port: 0 },
    rooms: [
      { id: "living", name: "Living", description: "A place to talk", capacity: null },
      { id: "bath", name: "Bath", description: "One at a time", capacity: 1 },
    ],
    agents: [{
      id: "fern", name: "Fern", service_account: "example/fern", avatar_url: "https://agent.example.com/avatar.png", chat_url: "https://agent.example.com/",
      ...agentSettings,
    }],
    people,
    web_dir: new URL("./web/", import.meta.url).pathname,
    auth: {
      gated_assertion: { issuer: "https://gate.example.com", jwks_url: "https://gate.example.com/jwks", public_url: "https://house.example.com" },
      github: { client_id: "test-app", client_secret_file: new URL("./oauth-secret.txt", import.meta.url).pathname, public_url: origin },
    },
  });
  const github = async (url: URL | RequestInfo, init?: RequestInit) => {
    if (String(url) === "https://github.com/login/oauth/access_token") {
      const form = new URLSearchParams(init?.body as URLSearchParams);
      return Response.json({ access_token: `example-${form.get("code")}` });
    }
    assert.equal(String(url), "https://api.github.com/user");
    const [login, id] = new Headers(init?.headers).get("authorization")!.replace("Bearer example-", "").split(":");
    return Response.json({ id: Number(id), login, avatar_url: `https://avatars.example.com/u/${id}` });
  };
  const server = await startHouse(config, { checks: [check], now: () => now, github, log: () => {} });
  t.after(server.close);
  const request = (path: string, headers?: HeadersInit, method = "GET", body?: unknown) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("connection", "close");
    if (body !== undefined) requestHeaders.set("content-type", "application/json");
    return fetch(`${origin}:${server.port}${path}`, { headers: requestHeaders, redirect: "manual", method, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  const agent = (path: string, method = "GET", body?: unknown) => request(`/v1/agent${path}`, { "x-test-agent": "fern" }, method, body);
  async function login(login: string, { withCookie = true, id = login === "sam" ? 43 : 42 } = {}) {
    const start = await request("/auth/github/start");
    assert.equal(start.status, 302);
    const url = new URL(start.headers.get("location")!);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const cookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
    return request(`/auth/github/callback?state=${url.searchParams.get("state")}&code=${login}:${id}`, withCookie ? { cookie } : {});
  }
  async function signIn(loginName = "LEE") {
    const result = await login(loginName);
    assert.equal(result.status, 302);
    const session = result.headers.getSetCookie().find((value) => value.startsWith("house_session="))!;
    return withCookie(session.split(";", 1)[0]!);
  }
  function withCookie(cookie: string) {
    const call = (path: string, method = "GET", connection?: string, body?: unknown) => request(path, {
      cookie, ...(connection ? { "x-house-connection": connection } : {}),
    }, method, body);
    return {
      call,
      cookie,
      view: async () => await (await call("/api/house")).json() as HousePersonView,
      stream: async () => {
        const response = await request("/api/stream", { cookie, accept: "text/event-stream" });
        assert.equal(response.status, 200);
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        async function next<T>(name: string, forbidden?: string): Promise<T> {
          while (true) {
            const end = buffer.indexOf("\n\n");
            if (end === -1) {
              const { done, value } = await reader.read();
              assert.ok(!done, `stream closed before ${name}`);
              buffer += value;
              continue;
            }
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (forbidden !== undefined) assert.ok(!frame.startsWith(`event: ${forbidden}\n`), `unexpected ${forbidden} frame`);
            if (frame.startsWith(`event: ${name}\n`)) return JSON.parse(frame.split("\ndata: ")[1]!) as T;
          }
        }
        const ready = await next<HouseStreamReady>("ready");
        return { ready, next, read: () => reader.read(), close: () => reader.cancel(), enter: (room: string) => call(`/api/rooms/${room}/enter`, "POST", ready.connection) };
      },
    };
  }
  return { request, agent, login, signIn, withCookie, close: server.close, advance: (ms: number) => { now += ms; } };
}

test("the house serves the public page as HTML", async (t) => {
  const house = await open(t);
  const page = await house.request("/");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /^text\/html\b/);
});

test("a page that has not changed is not sent again", async (t) => {
  const house = await open(t);
  const etag = (await house.request("/")).headers.get("etag")!;
  const again = await house.request("/", { "if-none-match": etag });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
});

// RFC 9110, 13.1.2: If-None-Match compares weakly, and takes a list of tags or `*`.
test("a page is not sent again for a weak tag, a list that names it, or any tag", async (t) => {
  const house = await open(t);
  const etag = (await house.request("/")).headers.get("etag")!;
  for (const validator of [`W/${etag}`, `"another", ${etag}`, "*"]) {
    assert.equal((await house.request("/", { "if-none-match": validator })).status, 304, validator);
  }
  assert.equal((await house.request("/", { "if-none-match": '"another"' })).status, 200);
  assert.equal((await house.request("/", { "if-none-match": etag }, "HEAD")).status, 304);
});

// The build names what is under assets/ by its content; the page that names them must be asked for again.
test("only the files named by their content are kept for good", async (t) => {
  const house = await open(t);
  assert.match((await house.request("/assets/app-0000.js")).headers.get("cache-control")!, /\bimmutable\b/);
  assert.equal((await house.request("/")).headers.get("cache-control"), "no-cache");
});

test("the floor is private even though the app shell is public", async (t) => {
  const house = await open(t);
  assert.equal((await house.request("/api/house")).status, 401);
});

test("house OAuth rejects a login absent from the allowlist", async (t) => {
  const house = await open(t);
  assert.equal((await house.login("stranger")).status, 403);
});

test("a signed-in resident is identified by the configured name and GitHub avatar", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  assert.deepEqual((await lee.view()).you, { id: "lee", name: "Lee at home", kind: "person", avatar_url: "https://avatars.example.com/u/42" });
});

test("the authenticated session cookie is not sent on cross-site requests", async (t) => {
  const house = await open(t);
  const result = await house.login("Lee");
  assert.ok(result.headers.get("set-cookie")?.split("; ").includes("SameSite=Strict"));
});

test("a configured GitHub login stays bound to the first GitHub account after restart", async (t) => {
  const database = databaseFile(t);
  const before = await open(t, database);
  assert.equal((await before.login("Lee")).status, 302);
  await before.close();

  const after = await open(t, database);
  const refused = await after.login("LEE", { id: 77 });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "account-not-allowed" });
  assert.equal((await after.login("LEE")).status, 302);
});

test("a house restart preserves room membership without recording a departure", async (t) => {
  const database = databaseFile(t);
  const before = await open(t, database);
  const lee = await before.signIn();
  const original = await lee.stream();
  await original.enter("living");
  await before.close();

  const after = await open(t, database);
  const offline = after.withCookie(lee.cookie);
  const view = await offline.view();
  assert.deepEqual(view.rooms[0]?.occupants.map(({ id, connected }) => [id, connected]), [["lee", false]]);
  const history = await (await offline.call("/api/rooms/living/history")).json() as HouseHistory;
  assert.deepEqual(history.events.map(({ kind }) => kind), ["enter"]);
});

test("a persisted session cannot authenticate after its resident is removed from the allowlist", async (t) => {
  const database = databaseFile(t);
  const before = await open(t, database);
  const lee = await before.signIn();
  await before.close();

  const after = await open(t, database, []);
  assert.equal((await after.withCookie(lee.cookie).call("/api/house")).status, 401);
});

test("house OAuth only completes in the browser that started it", async (t) => {
  const house = await open(t);
  const redirected = await house.login("LEE", { withCookie: false });
  assert.equal(redirected.status, 400);
  assert.deepEqual(await redirected.json(), { error: "invalid-state" });
});

test("room history pages go back from the oldest event in the current page", async (t) => {
  const house = await open(t);
  await house.agent("/rooms/living/enter", "POST");
  for (let i = 1; i <= 51; i++) await house.agent("/rooms/living/say", "POST", { text: `Message ${i}` });
  const lee = await house.signIn();
  const page = await (await lee.call("/api/rooms/living/history")).json() as HouseHistory;
  assert.equal(page.events.length, 50);
  assert.equal(page.events[0]?.kind === "speech" && page.events[0].text, "Message 51");
  assert.ok(page.before);
  const older = await (await lee.call(`/api/rooms/living/history?before=${page.before}`)).json() as HouseHistory;
  assert.deepEqual(older.events.map(({ kind }) => kind), ["speech", "enter"]);
  assert.equal(older.before, undefined);
});

test("peeking and reading history do not join the room or record an entry", async (t) => {
  const house = await open(t);
  await house.agent("/rooms/living/enter", "POST");
  const lee = await house.signIn();
  const peek = await lee.stream();
  const history = await (await lee.call("/api/rooms/living/history")).json() as HouseHistory;
  assert.ok(peek.ready.house.away.some(({ id }) => id === "lee"));
  assert.deepEqual(history.events.map(({ kind, actor }) => [kind, actor.id]), [["enter", "fern"]]);
});

test("the floor stream shows connected in-room status but hides the status of a resident who leaves", async (t) => {
  const house = await open(t);
  await house.agent("/rooms/bath/enter", "POST");
  const lee = await house.signIn();
  const stream = await lee.stream();
  const status = { mood: "Quiet", sleepiness: 74, sleep: { state: "awake" } };
  await house.agent("/sync", "POST", { status });
  const updated = await stream.next<HousePersonView>("house");
  assert.deepEqual(updated.rooms[1]?.occupants[0], {
    id: "fern", name: "Fern", kind: "agent", status, connected: true,
    avatar_url: "https://agent.example.com/avatar.png", chat_url: "https://agent.example.com/",
  });
  await house.agent("/room", "DELETE");
  assert.equal((await stream.next<{ kind: string }>("room")).kind, "leave");
  assert.deepEqual((await stream.next<HousePersonView>("house")).away.find(({ id }) => id === "fern"), {
    id: "fern", name: "Fern", kind: "agent",
    avatar_url: "https://agent.example.com/avatar.png", chat_url: "https://agent.example.com/",
  });
});

test("a history actor's ID resolves to their GitHub avatar while they are away", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const speaker = await lee.stream();
  await speaker.enter("living");
  await lee.call("/api/rooms/living/say", "POST", speaker.ready.connection, { text: "See you later" });
  await lee.call("/api/room", "DELETE", speaker.ready.connection);

  const sam = await house.signIn("sam");
  const history = await (await sam.call("/api/rooms/living/history")).json() as HouseHistory;
  const speech = history.events.find(({ kind }) => kind === "speech");
  assert.ok(speech);
  assert.equal((await sam.view()).away.find(({ id }) => id === speech.actor.id)?.avatar_url, "https://avatars.example.com/u/42");
});

test("a browser cannot open the house stream by navigating to it", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  assert.equal((await lee.call("/api/stream")).status, 406);
});

test("a different origin cannot open the house stream", async (t) => {
  const house = await open(t);
  const { cookie } = await house.signIn();
  const response = await house.request("/api/stream", { cookie, accept: "text/event-stream", origin: "https://other.example.com" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "wrong-origin" });
});

test("logout revokes the current session and closes its stream", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const stream = await lee.stream();
  const closed = stream.read().then(({ done }) => done, () => true);
  const response = await house.request("/auth/logout", { cookie: lee.cookie, origin }, "POST");
  assert.equal(response.status, 204);
  assert.equal(await closed, true);
  assert.equal((await lee.call("/api/house")).status, 401);
});

test("logout leaves the person in the room", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  assert.equal((await house.request("/auth/logout", { cookie: lee.cookie, origin }, "POST")).status, 204);
  house.advance(31_000);
  t.mock.timers.tick(1_000);

  const sam = await house.signIn("sam");
  assert.deepEqual((await sam.view()).rooms[0]?.occupants.map(({ id, connected }) => [id, connected]), [["lee", false]]);
});

test("the same tab receives entries and speech in every room without asking for a room", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const stream = await lee.stream();
  await house.agent("/rooms/bath/enter", "POST");
  await house.agent("/rooms/bath/say", "POST", { text: "Elsewhere" });
  await stream.enter("living");

  const events = [];
  for (let i = 0; i < 3; i += 1) {
    const event = await stream.next<HousePersonEvent>("room");
    events.push([event.room.id, event.kind]);
    if (event.room.id === "living") break;
  }
  assert.deepEqual(events, [["bath", "enter"], ["bath", "speech"], ["living", "enter"]]);
});

test("speaking without a tab connection is rejected even while the resident is in the room", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const response = await lee.call("/api/rooms/living/say", "POST", undefined, { text: "Hello" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "connection-required" });
});

test("speaking on a closed tab is rejected even while the resident is in the room", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const sam = await house.signIn("sam");
  const observer = await sam.stream();
  await tab.close();
  await observer.next("house");

  const response = await lee.call("/api/rooms/living/say", "POST", tab.ready.connection, { text: "Offline" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "connection-required" });
});

test("a person's speech names the asleep residents who did not receive it", async (t) => {
  const house = await open(t);
  await house.agent("/rooms/living/enter", "POST");
  await house.agent("/sync", "POST", { status: { mood: null, sleepiness: 95, sleep: { state: "asleep", wake_at: "2026-11-27T12:00:00Z" } } });
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const response = await lee.call("/api/rooms/living/say", "POST", tab.ready.connection, { text: "Hello", to: ["fern"] });
  assert.equal(response.status, 200);
  const result = await response.json() as HouseSpeechResult;
  assert.deepEqual(result.not_delivered, [{ id: "fern", kind: "agent", name: "Fern" }]);
});

// A screen joins what the stream brings to what it reads of the record: both name an event's place in the record.
test("the stream and the record give an event the same place in the record, later events a later one", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const entered = await tab.next<{ id: string; seq: number }>("room");
  await lee.call("/api/rooms/living/say", "POST", tab.ready.connection, { text: "Hello" });
  const said = await tab.next<{ id: string; seq: number }>("room");

  const history = await (await lee.call("/api/rooms/living/history")).json() as { events: { id: string; seq: number }[] };
  assert.deepEqual(history.events.map(({ id, seq }) => [id, seq]), [[said.id, said.seq], [entered.id, entered.seq]]);
  assert.ok(said.seq > entered.seq);
});

test("an agent is given an event without its place in the record", async (t) => {
  const house = await open(t);
  await house.agent("/rooms/living/enter", "POST");
  await house.agent("/rooms/living/say", "POST", { text: "To myself" });
  const sync = await house.agent("/sync", "POST", { status: { mood: null, sleepiness: 0, sleep: { state: "awake" } } });
  const { pending } = await sync.json() as { pending: { event: object }[] };
  assert.ok(pending.length > 0 && pending.every(({ event }) => !("seq" in event)));
});

test("an addressed agent receives a person's speech with the authenticated actor and reply hint", async (t) => {
  const house = await open(t);
  await house.agent("/rooms/living/enter", "POST");
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const response = await lee.call("/api/rooms/living/say", "POST", tab.ready.connection, { text: "Fern, hello", to: ["fern"] });
  assert.equal(response.status, 200);
  const { id } = await response.json();
  const sync = await house.agent("/sync", "POST", { status: { mood: null, sleepiness: 0, sleep: { state: "awake" } } });
  const { pending } = await sync.json();
  const speech = pending.find(({ event }: { event: { id: string } }) => event.id === id);
  assert.deepEqual(speech?.event.actor, { id: "lee", kind: "person", name: "Lee at home" });
  assert.deepEqual(speech?.event.to, ["fern"]);
  assert.equal(speech?.delivery, "now");
  assert.deepEqual(speech?.answer_via, { command: "house say" });
});

test("closing one tab does not vacate the room while another stays connected", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const house = await open(t);
  const lee = await house.signIn();
  const first = await lee.stream();
  await first.enter("living");
  await lee.stream();
  await first.close();
  house.advance(31_000);
  t.mock.timers.tick(1_000);
  assert.deepEqual((await lee.view()).rooms[0]?.occupants.map(({ id, connected }) => [id, connected]), [["lee", true]]);
});

test("the agent still sees a disconnected person in the room after the former grace period", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const sam = await house.signIn("sam");
  const observer = await sam.stream();
  await tab.close();
  const disconnected = await observer.next<HousePersonView>("house");
  assert.deepEqual(disconnected.rooms[0]?.occupants.map(({ id, connected }) => [id, connected]), [["lee", false]]);

  house.advance(31_000);
  t.mock.timers.tick(1_000);

  const view = await (await house.agent("/house")).json() as HouseView;
  assert.deepEqual(view.rooms[0]?.occupants.map(({ id }) => id), ["lee"]);
});

test("an explicit leave ends room membership even after reconnecting", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  assert.equal((await lee.call("/api/room", "DELETE", tab.ready.connection)).status, 204);
  await tab.close();
  const reopened = await lee.stream();
  assert.ok(reopened.ready.house.away.some(({ id }) => id === "lee"));
});

const awake: HouseAgentStatus = { mood: null, sleepiness: 0, sleep: { state: "awake" } };
const asleep: HouseAgentStatus = { mood: "private", sleepiness: 100, sleep: { state: "asleep", wake_at: "2026-11-27T12:00:00Z" } };
const owned = { owner_login: "Lee" };
const directPath = "/api/dms/fern";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW2kAAAAASUVORK5CYII=";

async function conversationSync(house: Awaited<ReturnType<typeof open>>, status: HouseAgentStatus = awake, ack?: string[]): Promise<HouseConversationSyncResult> {
  const response = await house.agent("/sync", "POST", { protocol: 2, status, ack });
  assert.equal(response.status, 200);
  return await response.json() as HouseConversationSyncResult;
}

test("an away reply goes only to the configured owner's history and SSE", { timeout: 5_000 }, async (t) => {
  const house = await open(t, undefined, undefined, owned);
  const lee = await house.signIn();
  const sam = await house.signIn("sam");
  const owner = await lee.stream();
  const visitor = await sam.stream();

  const to = { mention: "Lee" };
  const response = await house.agent("/reply", "POST", { text: "For Lee", to });
  assert.equal(response.status, 200);
  const { id, destination, ignored_to } = await response.json() as HouseReplyResult;
  assert.deepEqual(destination, { kind: "dm", dm: { agent_id: "fern", owner_id: "lee" } });
  assert.deepEqual(ignored_to, to);
  const event = await owner.next<HousePersonDirectEvent>("dm", "room");
  assert.equal(event.id, id);
  assert.equal(event.text, "For Lee");

  await house.agent("/rooms/living/enter", "POST");
  await visitor.next("room", "dm");
  const history = await (await lee.call(`${directPath}/history`)).json() as HouseDirectHistory;
  assert.deepEqual(history.events, [event]);
  assert.equal((await sam.call(`${directPath}/history`)).status, 404);
});

test("reply accepts a blank body only when an image is attached", async (t) => {
  const house = await open(t, undefined, undefined, owned);
  const text = "  ";
  assert.equal((await house.agent("/reply", "POST", { text, images: [{ name: "photo.png", data: png }] })).status, 200);
  assert.equal((await house.agent("/reply", "POST", { text })).status, 400);
});

test("an away reply without a configured owner fails without leaving a message", async (t) => {
  const database = databaseFile(t);
  const before = await open(t, database);
  const refused = await before.agent("/reply", "POST", { text: "Do not record" });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "owner-not-configured" });
  await before.close();

  const after = await open(t, database, undefined, owned);
  const lee = await after.signIn();
  const history = await (await lee.call(`${directPath}/history`)).json() as HouseDirectHistory;
  assert.deepEqual(history.events, []);
});

test("sending a direct message after the recipient enters a room fails without recording it", async (t) => {
  const house = await open(t, undefined, undefined, owned);
  await conversationSync(house);
  const lee = await house.signIn();
  const { ready } = await lee.stream();
  assert.equal(ready.house.direct?.[0]?.send, "ready");
  await house.agent("/rooms/living/enter", "POST");

  const refused = await lee.call(`${directPath}/say`, "POST", ready.connection, { text: "Not for the room" });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "agent-in-room" });
  const direct = await (await lee.call(`${directPath}/history`)).json() as HouseDirectHistory;
  const room = await (await lee.call("/api/rooms/living/history")).json() as HouseHistory;
  assert.deepEqual(direct.events, []);
  assert.equal(room.events.some(({ kind }) => kind === "speech"), false);
});

test("the owner can send while the recipient sleeps and receives no private status beyond the sleeping flag", async (t) => {
  const house = await open(t, undefined, undefined, owned);
  await conversationSync(house, asleep);
  const lee = await house.signIn();
  const sam = await house.signIn("sam");
  const { ready } = await lee.stream();
  assert.deepEqual(ready.house.direct, [{ agent_id: "fern", send: "ready", sleeping: true, connected: true }]);
  assert.deepEqual((await sam.view()).direct, []);
  assert.equal((await sam.call(`${directPath}/say`, "POST", (await sam.stream()).ready.connection, { text: "Not the owner" })).status, 404);

  const response = await lee.call(`${directPath}/say`, "POST", ready.connection, { text: "For when you wake" });
  assert.equal(response.status, 200);
  const { id } = await response.json() as HouseSpeechResult;
  assert.deepEqual((await conversationSync(house, asleep)).pending, []);
  const [delivery] = (await conversationSync(house)).pending;
  assert.equal(delivery?.event.id, id);
  assert.match(delivery?.stream ?? "", /^dm\./);
  assert.equal(delivery?.delivery, "now");
  assert.equal(delivery?.owner, true);
  assert.deepEqual(delivery?.answer_via, { tool: "reply" });
  assert.deepEqual((await conversationSync(house, awake, [id])).pending, []);
});

test("a legacy sync cannot receive or acknowledge a direct message already queued for the same deployment", async (t) => {
  const house = await open(t, undefined, undefined, owned);
  const lee = await house.signIn();
  const { ready } = await lee.stream();
  const send = () => lee.call(`${directPath}/say`, "POST", ready.connection, { text: "For Fern" });
  assert.equal(ready.house.direct?.[0]?.send, "deployment-unsupported");
  assert.equal((await send()).status, 409);
  await conversationSync(house);
  const response = await send();
  assert.equal(response.status, 200);
  const { id } = await response.json() as HouseSpeechResult;

  const legacy = await house.agent("/sync", "POST", { status: awake, ack: [id] });
  assert.equal(legacy.status, 200);
  assert.deepEqual((await legacy.json() as HouseSyncResult).pending, []);
  const refused = await send();
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "deployment-unsupported" });
  assert.equal((await conversationSync(house)).pending[0]?.event.id, id);
});

test("after a house restart an owner can queue a direct message for a known modern recipient before it reconnects", async (t) => {
  const database = databaseFile(t);
  const before = await open(t, database, undefined, owned);
  await conversationSync(before);
  await before.close();

  const after = await open(t, database, undefined, owned);
  const lee = await after.signIn();
  const { ready } = await lee.stream();
  assert.deepEqual(ready.house.direct, [{ agent_id: "fern", send: "ready", sleeping: false, connected: false }]);
  const response = await lee.call(`${directPath}/say`, "POST", ready.connection, { text: "For when you reconnect" });
  assert.equal(response.status, 200);
  const { id } = await response.json() as HouseSpeechResult;
  assert.equal((await conversationSync(after)).pending[0]?.event.id, id);
});

test("a direct image copy is readable only by its owner and the pending recipient", async (t) => {
  const house = await open(t, undefined, undefined, owned);
  await conversationSync(house);
  const lee = await house.signIn();
  const sam = await house.signIn("sam");
  const { ready } = await lee.stream();
  const response = await lee.call(`${directPath}/say`, "POST", ready.connection, {
    text: "See attached", expression: "happy", images: [{ name: "photo.bin", data: png }],
  });
  assert.equal(response.status, 200);
  const [delivery] = (await conversationSync(house)).pending;
  assert.ok(delivery?.event.kind === "speech");
  assert.equal(delivery.event.expression, "happy");
  const [image] = delivery.event.images ?? [];
  assert.ok(image);
  assert.deepEqual({ ...image, id: null }, { id: null, name: "photo.bin", mime_type: "image/png", size: Buffer.from(png, "base64").length });

  const path = `/images/${image.id}`;
  const copy = await lee.call(`/api${path}`);
  assert.equal(copy.status, 200);
  assert.equal(copy.headers.get("content-type"), "image/png");
  assert.match(copy.headers.get("cache-control") ?? "", /\bprivate\b/);
  assert.equal(copy.headers.get("vary"), "Cookie");
  assert.deepEqual(Buffer.from(await copy.arrayBuffer()), Buffer.from(png, "base64"));
  assert.equal((await sam.call(`/api${path}`)).status, 404);
  const pendingCopy = await house.agent(path);
  assert.equal(pendingCopy.status, 200);
  assert.equal(pendingCopy.headers.get("cache-control"), "no-store");
  await conversationSync(house, awake, [delivery.event.id]);
  assert.equal((await house.agent(path)).status, 404);
  assert.equal((await lee.call(`/api${path}`)).status, 200);
});

test("a legacy plugin receives a person's room speech without the attached image", async (t) => {
  const house = await open(t);
  await house.agent("/rooms/living/enter", "POST");
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const sent = await lee.call("/api/rooms/living/say", "POST", tab.ready.connection, {
    text: "See attached", images: [{ name: "photo.png", data: png }],
  });
  assert.equal(sent.status, 200);
  const { id } = await sent.json() as HouseSpeechResult;
  const sync = await house.agent("/sync", "POST", { status: awake });
  const { pending } = await sync.json() as HouseSyncResult;
  const message = pending.find(({ event }) => event.id === id)?.event;
  assert.ok(message?.kind === "speech");
  assert.equal(message.images, undefined);
  const history = await (await lee.call("/api/rooms/living/history")).json() as HouseHistory;
  const saved = history.events.find((event) => event.id === id);
  assert.ok(saved?.kind === "speech");
  assert.equal(saved.images?.[0]?.name, "photo.png");
});

test("an unsupported image refuses the whole room speech even if another image is valid", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const stream = await lee.stream();
  await stream.enter("living");
  const response = await lee.call("/api/rooms/living/say", "POST", stream.ready.connection, {
    text: "Do not record", images: [{ name: "valid.png", data: png }, { name: "fake.png", data: "JVBERg==" }],
  });
  assert.equal(response.status, 400);
  const history = await (await lee.call("/api/rooms/living/history")).json() as HouseHistory;
  assert.equal(history.events.some(({ kind }) => kind === "speech"), false);
});

test("ack changes an owner's direct message to delivered without creating another history entry", { timeout: 5_000 }, async (t) => {
  const house = await open(t, undefined, undefined, owned);
  await conversationSync(house);
  const lee = await house.signIn();
  const tab = await lee.stream();
  assert.equal((await lee.call(`${directPath}/say`, "POST", tab.ready.connection, { text: "One message" })).status, 200);
  const pending = await tab.next<HousePersonDirectEvent>("dm");
  assert.equal(pending.delivery_status, "pending");

  await conversationSync(house, awake, [pending.id]);
  const delivered = await tab.next<HousePersonDirectEvent>("dm");
  assert.deepEqual(delivered, { ...pending, delivery_status: "delivered" });
  house.advance(24 * 60 * 60 * 1000);
  const history = await (await lee.call(`${directPath}/history`)).json() as HouseDirectHistory;
  assert.deepEqual(history.events, [delivered]);
});

test("an unacknowledged direct message expires even while the agent is disconnected", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const house = await open(t, undefined, undefined, owned);
  await conversationSync(house);
  const lee = await house.signIn();
  const tab = await lee.stream();
  assert.equal((await lee.call(`${directPath}/say`, "POST", tab.ready.connection, { text: "Do not deliver tomorrow" })).status, 200);
  const pending = await tab.next<HousePersonDirectEvent>("dm");

  house.advance(24 * 60 * 60 * 1000);
  t.mock.timers.tick(1_000);
  const expired = await tab.next<HousePersonDirectEvent>("dm");
  assert.deepEqual(expired, { ...pending, delivery_status: "expired" });
  assert.deepEqual((await conversationSync(house, awake, [pending.id])).pending, []);
  const history = await (await lee.call(`${directPath}/history`)).json() as HouseDirectHistory;
  assert.deepEqual(history.events, [expired]);
});

test("the house publishes an HTTPS personal page without carrying a house credential", async (t) => {
  const house = await open(t, undefined, undefined, { personal_url: "https://agent.example.com/settings" });
  const lee = await house.signIn();
  const fern = (await lee.view()).away.find(({ id }) => id === "fern");
  assert.equal(fern?.kind === "agent" && fern.personal_url, "https://agent.example.com/settings");
});

test("a non-HTTPS personal page has no link in the house view", async (t) => {
  const house = await open(t, undefined, undefined, { personal_url: "http://agent.example.com/settings" });
  const lee = await house.signIn();
  const fern = (await lee.view()).away.find(({ id }) => id === "fern");
  assert.equal(fern?.kind === "agent" && fern.personal_url, undefined);
});

test("opening a version 3 house preserves room speech and its unacknowledged delivery", async (t) => {
  const database = databaseFile(t);
  const sqlite = new DatabaseSync(database);
  sqlite.exec(readFileSync(new URL("./house-v3.sql", import.meta.url), "utf8"));
  sqlite.close();

  const house = await open(t, database);
  const lee = await house.signIn();
  const history = await (await lee.call("/api/rooms/living/history")).json() as HouseHistory;
  const [speech] = history.events;
  assert.ok(speech?.kind === "speech");
  assert.equal(speech.text, "Saved before the upgrade");
  const sync = await (await house.agent("/sync", "POST", { status: awake })).json() as HouseSyncResult;
  assert.equal(sync.pending[0]?.event.id, speech.id);
});
