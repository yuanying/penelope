import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { HouseHistory, HousePersonView, HouseSpeechResult, HouseStreamReady } from "@penelope/contract";
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

async function open(t: TestContext, database = ":memory:", people = [{ login: "Lee", name: "Lee at home" }, { login: "sam", name: "Sam" }]) {
  let now = Date.parse("2026-11-27T10:00:00Z");
  const config = parseConfig({
    name: "Example house", database, listen: { host: "127.0.0.1", port: 0 },
    rooms: [
      { id: "living", name: "Living", description: "A place to talk", capacity: null },
      { id: "bath", name: "Bath", description: "One at a time", capacity: 1 },
    ],
    agents: [{ id: "fern", name: "Fern", service_account: "example/fern", avatar_url: "https://agent.example.com/avatar.png", chat_url: "https://agent.example.com/" }],
    people,
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
      stream: async (peek?: string) => {
        const response = await request(`/api/stream${peek ? `?peek=${peek}` : ""}`, { cookie, accept: "text/event-stream" });
        assert.equal(response.status, 200);
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        async function next<T>(name: string): Promise<T> {
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

test("the same cookie can reconnect to the room after a house restart", async (t) => {
  const database = databaseFile(t);
  const before = await open(t, database);
  const lee = await before.signIn();
  const original = await lee.stream();
  await original.enter("living");
  await before.close();

  const after = await open(t, database);
  const returned = await after.withCookie(lee.cookie).stream();
  assert.deepEqual(returned.ready.house.rooms[0]?.occupants.map(({ id }) => id), ["lee"]);
  const history = await (await after.withCookie(lee.cookie).call("/api/rooms/living/history")).json() as HouseHistory;
  assert.deepEqual(history.events.map(({ kind }) => kind), ["enter", "leave", "enter"]);
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
  const peek = await lee.stream("living");
  const history = await (await lee.call("/api/rooms/living/history")).json() as HouseHistory;
  assert.ok(peek.ready.house.away.some(({ id }) => id === "lee"));
  assert.deepEqual(history.events.map(({ kind, actor }) => [kind, actor.id]), [["enter", "fern"]]);
});

test("the floor stream shows connected in-room status but hides the status of a resident who leaves", async (t) => {
  const house = await open(t);
  await house.agent("/rooms/bath/enter", "POST");
  const lee = await house.signIn();
  const stream = await lee.stream("bath");
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

test("live room events include the person's room and the tab's peek room", async (t) => {
  const house = await open(t);
  await house.agent("/rooms/bath/enter", "POST");
  const lee = await house.signIn();
  const stream = await lee.stream("bath");
  await stream.enter("living");
  await stream.next("room");
  await house.agent("/rooms/bath/say", "POST", { text: "Peek" });
  assert.equal((await stream.next<{ text: string }>("room")).text, "Peek");
  await lee.call("/api/rooms/living/say", "POST", stream.ready.connection, { text: "Home" });
  assert.equal((await stream.next<{ text: string }>("room")).text, "Home");
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

test("speaking on a closed tab is rejected during the grace period", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const sam = await house.signIn("sam");
  const observer = await sam.stream("living");
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

test("reconnecting during grace does not record a departure or a new entry", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const sam = await house.signIn("sam");
  const observer = await sam.stream("living");
  await tab.close();
  const grace = await observer.next<HousePersonView>("house");
  assert.deepEqual(grace.rooms[0]?.occupants.map(({ id, connected }) => [id, connected]), [["lee", false]]);

  house.advance(29_000);
  t.mock.timers.tick(1_000);
  await lee.stream();
  house.advance(31_000);
  t.mock.timers.tick(1_000);
  const history = await (await lee.call("/api/rooms/living/history")).json() as HouseHistory;
  assert.deepEqual(history.events.map(({ kind }) => kind), ["enter"]);
});

test("reconnecting after grace returns the resident to their previous room", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  const sam = await house.signIn("sam");
  const observer = await sam.stream("living");
  await tab.close();
  await observer.next("house");

  house.advance(31_000);
  t.mock.timers.tick(1_000);
  assert.equal((await observer.next<{ kind: string }>("room")).kind, "leave");
  const returned = await lee.stream();
  assert.deepEqual(returned.ready.house.rooms[0]?.occupants.map(({ id }) => id), ["lee"]);
});

test("a full previous room prevents auto-return", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const house = await open(t);
  const lee = await house.signIn();
  const sam = await house.signIn("sam");
  const observer = await sam.stream("bath");
  const tab = await lee.stream();
  await tab.enter("bath");
  await observer.next("room");
  await observer.next("house");
  await tab.close();
  await observer.next("house");
  house.advance(31_000);
  t.mock.timers.tick(1_000);
  assert.equal((await observer.next<{ kind: string }>("room")).kind, "leave");
  await observer.enter("bath");
  const blocked = await lee.stream();
  assert.equal(blocked.ready.return_failed, "bath");
  assert.ok(blocked.ready.house.away.some(({ id }) => id === "lee"));
});

test("an explicit leave clears the room to return to on reconnect", async (t) => {
  const house = await open(t);
  const lee = await house.signIn();
  const tab = await lee.stream();
  await tab.enter("living");
  assert.equal((await lee.call("/api/room", "DELETE", tab.ready.connection)).status, 204);
  await tab.close();
  const reopened = await lee.stream();
  assert.ok(reopened.ready.house.away.some(({ id }) => id === "lee"));
  assert.equal(reopened.ready.return_failed, undefined);
});
