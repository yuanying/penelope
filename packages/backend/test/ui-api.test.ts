import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createECDH, createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { SubAgents } from "../src/agents.ts";
import { Assets } from "../src/assets.ts";
import type { AgentSettings } from "../src/avatar.ts";
import { Conversation } from "../src/conversation.ts";
import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { close, type Handler, listenTcp, sendJson } from "../src/http.ts";
import { GitHubLogin, type GitHubSettings } from "../src/login/github.ts";
import { LoginSessions } from "../src/login/sessions.ts";
import { MemoryView } from "../src/memory-view.ts";
import { Memory } from "../src/memory.ts";
import { ModelSettings } from "../src/model-settings.ts";
import { PushSubscriptions } from "../src/push/notifier.ts";
import { Queue } from "../src/queue.ts";
import { ActivityRecord } from "../src/record.ts";
import { cronOf, Schedules } from "../src/schedules.ts";
import { Sources } from "../src/sources.ts";
import { AwakeHours } from "../src/time.ts";
import { uiHandler } from "../src/ui-api.ts";
import { ask, type Ask, FakeClock, multipart, SseReader, tempDir } from "./support.ts";

const OWNER = 4242;

/** A stand-in for GitHub's token exchange and user API. */
async function fakeGitHub(t: { after: (fn: () => Promise<void>) => void }) {
  const state = { userId: OWNER, down: false, challenges: new Map<string, string>(), exchanged: 0 };
  const server = http.createServer((request, response) => {
    if (state.down) {
      response.writeHead(503).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/login/oauth/access_token") {
        state.exchanged += 1;
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const challenge = state.challenges.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const ok = challenge === createHash("sha256").update(verifier).digest("base64url") && form.get("client_secret") === "secret";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(ok ? { access_token: "gho_x" } : { error: "bad_verification_code" }));
        return;
      }
      if (request.url === "/user" && request.headers.authorization === "Bearer gho_x") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: state.userId, login: "someone" }));
        return;
      }
      response.writeHead(401).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => close(server));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    state,
    endpoints: { authorizeUrl: `${base}/login/oauth/authorize`, tokenUrl: `${base}/login/oauth/access_token`, userUrl: `${base}/user` },
  };
}

async function setup(
  t: { after: (fn: () => void | Promise<void>) => void },
  {
    configured = true,
    publicUrl = "http://penelope.example.com",
    agent = { name: "Iris", dir: "/nowhere", icons: {} } as AgentSettings,
    a2a = undefined as Handler | undefined,
    web = undefined as Handler | undefined,
    pushKey = undefined as string | undefined,
    memoryOwner = undefined as { ownerEmail: string; ownerName?: string; fileLimitBytes?: number } | undefined,
  } = {},
) {
  const dir = tempDir(t);
  const clock = new FakeClock("2026-11-14T09:00:00Z");
  const now = clock.now;
  const db = openDatabase(path.join(dir, "backend.sqlite"));
  const sourcesDir = path.join(dir, "sources");
  const queue = new Queue(db, new Sources(sourcesDir, "UTC"), {
    now,
    inline: new Set(["ui", "control"]),
    builtinDelivery: { ui: "now" },
    batch: { quietMs: 300_000, maxMs: 1_800_000 },
    awake: new AwakeHours("00:00-00:00", "UTC"),
    redeliverMs: 300_000,
  });
  const feed = new Feed();
  const assets = new Assets(db, path.join(dir, "assets"), { now });
  const conversation = new Conversation(db, feed, { now, assets });
  const agents = new SubAgents(db, feed, conversation, { now });
  const schedules = new Schedules(db, { now, timeZone: "Asia/Tokyo" });
  const record = new ActivityRecord(db, feed, { now, timeZone: "UTC", nightly: cronOf("0 4 * * *", "UTC") });
  const github = await fakeGitHub(t);
  const sessions = new LoginSessions(db, { now });
  const modelSettings = new ModelSettings(db, now);
  const settings: GitHubSettings | undefined = configured
    ? { clientId: "client", clientSecret: "secret", ownerId: OWNER, callbackUrl: `${publicUrl}/auth/github/callback` }
    : undefined;
  const login = new GitHubLogin({ settings, endpoints: github.endpoints, sessions, now, log: () => {} });
  const subscriptions = new PushSubscriptions(db, { now });
  const memoryDir = path.join(dir, "memory");
  const memory = new Memory(memoryDir, { name: "Backend", email: "backend@example.com" });
  const push = pushKey === undefined ? undefined : { publicKey: pushKey, subscriptions };
  const server = await listenTcp(
    uiHandler({
      queue,
      conversation,
      assets,
      agents,
      schedules,
      record,
      memory,
      memoryView: new MemoryView(memoryDir, db, { now, timeZone: "UTC", backendEmail: "backend@example.com", ...memoryOwner }),
      feed,
      login,
      sessions,
      modelSettings,
      ownerId: settings?.ownerId,
      publicUrl,
      agent: () => agent,
      now,
      ...(a2a ? { a2a } : {}),
      ...(web ? { web } : {}),
      ...(push ? { push } : {}),
    }),
    "127.0.0.1",
    0,
  );
  t.after(async () => {
    await close(server);
    db.close();
  });
  const target = { port: (server.address() as AddressInfo).port };
  const cookieOf = (token: string) => `penelope_session=${token}`;
  /** A session as a finished login leaves it. */
  const signIn = () => cookieOf(sessions.create(OWNER).token);
  const call = (pathname: string, cookie: string | undefined, options: Ask = {}) =>
    ask(target, pathname, { ...options, headers: { ...(cookie ? { cookie } : {}), ...options.headers } });
  return { queue, conversation, assets, agents, schedules, record, feed, sessions, modelSettings, github, target, signIn, call, sourcesDir, clock, subscriptions, memoryDir, memory };
}

it("requires an owner session even on the committed memory image endpoint", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("/api/memory/image?path=avatar%2Fsample.png", undefined)).status, 401);
});

it("links the activity turn to its committed memory change", async (t) => {
  const { call, signIn, record, memoryDir } = await setup(t);
  mkdirSync(memoryDir);
  writeFileSync(path.join(memoryDir, "guide.md"), "Guide\n");
  const writer = new Memory(memoryDir, { name: "Example", email: "example@example.com" });
  record.turnEnded("main", { turn_id: "turn-1" });
  await writer.commit({ agent: "main", turnId: "turn-1" });
  const cookie = signIn();
  const turn = await call("/api/record/turns/turn-1", cookie);
  const id = turn.json().memory_change.id;
  const detail = await call(`/api/memory/changes/${id}`, cookie);
  assert.deepEqual(detail.json().change.writer, { kind: "daytime", agent: "main", turn_id: "turn-1" });
});

const memoryOwner = { ownerEmail: "owner@example.com" };

describe("saving memory", () => {
  it("requires an owner session to write", async (t) => {
    const { call } = await setup(t, { memoryOwner });
    assert.equal((await call("/api/memory/save", undefined, { json: {} })).status, 401);
  });

  it("commits only the edited path as the owner even with other changes staged", async (t) => {
    const { call, signIn, memoryDir, memory } = await setup(t, { memoryOwner });
    mkdirSync(memoryDir);
    const file = path.join(memoryDir, "[note].md");
    writeFileSync(file, "original\n");
    await memory.commit({ agent: "main", turnId: "turn-1" });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: memoryDir, encoding: "utf8" });
    writeFileSync(path.join(memoryDir, "draft.md"), "unfinished\n");
    git("add", "draft.md");
    const cookie = signIn();
    const { head } = (await call("/api/memory/file?path=%5Bnote%5D.md", cookie)).json();
    const saved = await call("/api/memory/save", cookie, { json: { path: "[note].md", base_head: head, text: "corrected\n" } });
    assert.equal(saved.status, 200);
    const result = saved.json();
    assert.equal(result.kind, "saved");
    assert.equal(result.head, git("rev-parse", "HEAD").trim());
    const change = (await call(`/api/memory/changes/${result.id}`, cookie)).json().change;
    assert.deepEqual(change.paths, ["[note].md"]);
    assert.deepEqual(change.writer, { kind: "owner" });
    assert.equal(git("show", "HEAD:[note].md"), "corrected\n");
    assert.equal(git("diff", "--cached", "--name-only"), "draft.md\n");
    assert.equal(readFileSync(file, "utf8"), "corrected\n");
    assert.equal(statSync(file).mode & 0o777, 0o660);
  });

  it("reports the committed difference when a queued turn removes the path before a restore", async (t) => {
    const { call, signIn, memoryDir, memory } = await setup(t, { memoryOwner });
    mkdirSync(memoryDir);
    const file = path.join(memoryDir, "note.md");
    writeFileSync(file, "original\n");
    await memory.commit({ agent: "main", turnId: "turn-1" });
    const cookie = signIn();
    const { head } = (await call("/api/memory/file?path=note.md", cookie)).json();
    renameSync(file, path.join(memoryDir, "moved.md"));
    const turn = memory.commit({ agent: "main", turnId: "turn-2" });
    const refused = await call("/api/memory/save", cookie, { json: { path: "note.md", base_head: head, text: "previous version\n" } });
    await turn;
    assert.equal(refused.status, 409);
    const result = refused.json();
    assert.equal(result.kind, "head_conflict");
    assert.equal(result.exists, false);
    assert.equal(result.last_change.writer.kind, "daytime");
    assert.deepEqual(result.diff.hunks[0].lines, [{ kind: "removed", old_line: 1, text: "original" }]);
  });

  it("does not overwrite a work-tree draft even when the requested text matches HEAD", async (t) => {
    const { call, signIn, memoryDir, memory } = await setup(t, { memoryOwner });
    mkdirSync(memoryDir);
    const file = path.join(memoryDir, "note.md");
    writeFileSync(file, "original\n");
    await memory.commit({ agent: "main", turnId: "turn-1" });
    const cookie = signIn();
    const { head } = (await call("/api/memory/file?path=note.md", cookie)).json();
    writeFileSync(file, "draft\n");
    const refused = await call("/api/memory/save", cookie, { json: { path: "note.md", base_head: head, text: "original\n" } });
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.json(), { kind: "worktree_conflict", head });
    assert.equal(readFileSync(file, "utf8"), "draft\n");
  });

  it("does not follow a work-tree directory replaced with a symlink", async (t) => {
    const { call, signIn, memoryDir, memory } = await setup(t, { memoryOwner });
    const dir = path.join(memoryDir, "topics");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "note.md"), "original\n");
    await memory.commit({ agent: "main", turnId: "turn-1" });
    const cookie = signIn();
    const { head } = (await call("/api/memory/file?path=topics%2Fnote.md", cookie)).json();
    const outside = tempDir(t);
    const outsideFile = path.join(outside, "note.md");
    writeFileSync(outsideFile, "original\n");
    renameSync(dir, path.join(memoryDir, "moved"));
    symlinkSync(outside, dir);
    const refused = await call("/api/memory/save", cookie, { json: { path: "topics/note.md", base_head: head, text: "corrected\n" } });
    assert.deepEqual(refused.json(), { kind: "worktree_conflict", head });
    assert.equal(readFileSync(outsideFile, "utf8"), "original\n");
  });

  it("refuses an always-read file over the configured UTF-8 byte limit", async (t) => {
    const { call, signIn, memoryDir, memory } = await setup(t, { memoryOwner: { ...memoryOwner, fileLimitBytes: 4 } });
    mkdirSync(memoryDir);
    writeFileSync(path.join(memoryDir, "always.md"), "yes\n");
    await memory.commit({ agent: "main", turnId: "turn-1" });
    const cookie = signIn();
    const { head, edit } = (await call("/api/memory/file?path=always.md", cookie)).json();
    assert.deepEqual(edit, { max_bytes: 4 });
    const refused = await call("/api/memory/save", cookie, { json: { path: "always.md", base_head: head, text: "日本" } });
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.json(), { kind: "prompt_file_limit", max_bytes: 4 });
  });

  it("restores an older body when HEAD advanced only on another path", async (t) => {
    const { call, signIn, memoryDir, memory } = await setup(t, { memoryOwner });
    mkdirSync(memoryDir);
    const file = path.join(memoryDir, "note.md");
    writeFileSync(file, "older\n");
    await memory.commit({ agent: "main", turnId: "turn-1" });
    const cookie = signIn();
    const old = (await call("/api/memory/file?path=note.md", cookie)).json();
    writeFileSync(file, "current\n");
    await memory.commit({ agent: "main", turnId: "turn-2" });
    const { head } = (await call("/api/memory/file?path=note.md", cookie)).json();
    writeFileSync(path.join(memoryDir, "other.md"), "other\n");
    await memory.commit({ agent: "main", turnId: "turn-3" });
    const saved = await call("/api/memory/save", cookie, { json: { path: "note.md", base_head: head, text: old.text } });
    assert.equal(saved.status, 200);
    assert.equal((await call("/api/memory/file?path=note.md", cookie)).json().text, "older\n");
  });

  it("does not add a commit for unchanged text", async (t) => {
    const { call, signIn, memoryDir, memory } = await setup(t, { memoryOwner });
    mkdirSync(memoryDir);
    writeFileSync(path.join(memoryDir, "note.md"), "original\n");
    await memory.commit({ agent: "main", turnId: "turn-1" });
    const cookie = signIn();
    const { head, text } = (await call("/api/memory/file?path=note.md", cookie)).json();
    const saved = await call("/api/memory/save", cookie, { json: { path: "note.md", base_head: head, text } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json(), { kind: "unchanged", head });
    assert.equal((await call("/api/memory", cookie)).json().head, head);
  });

  it("does not create a path absent from the base and HEAD", async (t) => {
    const { call, signIn, memoryDir, memory } = await setup(t, { memoryOwner });
    mkdirSync(memoryDir);
    writeFileSync(path.join(memoryDir, "note.md"), "original\n");
    await memory.commit({ agent: "main", turnId: "turn-1" });
    const cookie = signIn();
    const { head } = (await call("/api/memory/file?path=note.md", cookie)).json();
    const refused = await call("/api/memory/save", cookie, { json: { path: "missing.md", base_head: head, text: "new\n" } });
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.json(), { kind: "file_not_editable" });
  });

  it("disables editing when the deployment has no owner email", async (t) => {
    const { call, signIn } = await setup(t);
    const cookie = signIn();
    assert.equal((await call("/api/memory", cookie)).json().can_edit, false);
    const refused = await call("/api/memory/save", cookie, { json: { path: "note.md", base_head: "0".repeat(40), text: "new\n" } });
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.json(), { kind: "editing_disabled" });
  });
});

const modelChoice = { model: "example/org/chat", thinking: "low" } as const;

it("keeps the owner's selection of a model the runner offers, including a slash in the model ID", async (t) => {
  const { call, signIn, modelSettings } = await setup(t);
  const cookie = signIn();
  modelSettings.report({ models: [{ provider: "example", id: "org/chat", name: "Chat", context_window: 32000, thinking_levels: ["off", "low"] }], default: null });
  assert.equal((await call("/api/settings", cookie, { method: "PUT", json: modelChoice })).status, 200);
  assert.deepEqual((await call("/api/settings", cookie)).json().selection, modelChoice);
});

it("refuses a model that the runner has not offered", async (t) => {
  const { call, signIn } = await setup(t);
  assert.equal((await call("/api/settings", signIn(), { method: "PUT", json: modelChoice })).status, 400);
});

it("refuses a thinking level that the selected model does not support", async (t) => {
  const { call, signIn, modelSettings } = await setup(t);
  modelSettings.report({ models: [{ provider: "example", id: "org/chat", name: "Chat", context_window: 32000, thinking_levels: ["off"] }], default: null });
  assert.equal((await call("/api/settings", signIn(), { method: "PUT", json: modelChoice })).status, 400);
});

it("does not accept model settings from a bearer token without the owner's session", async (t) => {
  const { call } = await setup(t);
  assert.equal((await call("/api/settings", undefined, { method: "PUT", json: modelChoice, headers: { authorization: "Bearer example" } })).status, 401);
});

/** A Set-Cookie line as its value and its attributes, in whatever order they came. */
function parseCookie(line: string | undefined): { name: string; value: string; attributes: Map<string, string> } {
  assert.ok(line, "a Set-Cookie line");
  const [pair, ...rest] = line.split(";").map((part) => part.trim());
  const [name, value] = pair!.split("=") as [string, string];
  const attributes = new Map(
    rest.map((part) => {
      const [key, ...v] = part.split("=");
      return [key!.toLowerCase(), v.join("=")] as [string, string];
    }),
  );
  return { name, value, attributes };
}

/** Follows a login through GitHub as a browser would, and answers the callback's response. */
async function logIn(env: Awaited<ReturnType<typeof setup>>, { tamperState = false } = {}) {
  const start = await env.call("/auth/github/start", undefined);
  assert.equal(start.status, 302);
  const authorize = new URL(String(start.headers.location));
  const code = `code-${Math.random()}`;
  env.github.state.challenges.set(code, authorize.searchParams.get("code_challenge") ?? "");
  const state = tamperState ? "forged" : authorize.searchParams.get("state");
  return env.call(`/auth/github/callback?code=${code}&state=${state}`, undefined);
}

describe("the login", () => {
  it("sends the browser to GitHub with a state and a PKCE challenge", async (t) => {
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    assert.equal(start.status, 302);
    const location = new URL(String(start.headers.location));
    assert.equal(`${location.origin}${location.pathname}`, env.github.endpoints.authorizeUrl);
    assert.equal(location.searchParams.get("client_id"), "client");
    assert.equal(location.searchParams.get("redirect_uri"), "http://penelope.example.com/auth/github/callback");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    // An S256 challenge is the 43 base64url characters of a SHA-256 (RFC 7636).
    assert.match(location.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.ok((location.searchParams.get("state") ?? "").length > 0);
  });

  it("lets the owner in with a session cookie and goes back to the top", async (t) => {
    const env = await setup(t);
    const callback = await logIn(env);
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.location, "/");
    const [cookie] = callback.headers["set-cookie"] ?? [];
    // The cookie of docs/backend.md: one, HttpOnly, SameSite=Strict, for the whole site, for 30 days.
    const { name, value, attributes } = parseCookie(cookie);
    assert.equal(name, "penelope_session");
    assert.ok(value.length > 0);
    assert.equal(attributes.get("path"), "/");
    assert.ok(attributes.has("httponly"));
    assert.equal(attributes.get("samesite")?.toLowerCase(), "strict");
    assert.equal(attributes.get("max-age"), String(30 * 24 * 60 * 60));
    assert.ok(!attributes.has("secure"), "not Secure over http");
    const session = `${name}=${value}`;
    assert.equal((await env.call("/api/history", session)).status, 200);
  });

  it("marks the cookie Secure when the backend is served over https", async (t) => {
    const env = await setup(t, { publicUrl: "https://penelope.example.com" });
    const [cookie] = (await logIn(env)).headers["set-cookie"] ?? [];
    assert.ok(parseCookie(cookie).attributes.has("secure"));
  });

  it("does not let in a GitHub account that is not the owner's", async (t) => {
    const env = await setup(t);
    env.github.state.userId = 7;
    const callback = await logIn(env);
    assert.equal(callback.status, 403);
    assert.equal(callback.json().error, "account-not-allowed");
    assert.equal(callback.headers["set-cookie"], undefined);
  });

  it("refuses a callback whose state it did not give, without asking GitHub", async (t) => {
    const env = await setup(t);
    const callback = await logIn(env, { tamperState: true });
    assert.equal(callback.status, 400);
    assert.equal(callback.json().error, "invalid-state");
    assert.equal(env.github.state.exchanged, 0);
  });

  it("takes each state once", async (t) => {
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    const authorize = new URL(String(start.headers.location));
    env.github.state.challenges.set("c", authorize.searchParams.get("code_challenge") ?? "");
    const url = `/auth/github/callback?code=c&state=${authorize.searchParams.get("state")}`;
    assert.equal((await env.call(url, undefined)).status, 302);
    assert.equal((await env.call(url, undefined)).status, 400);
  });

  it("refuses a login that took longer than its 10 minutes", async (t) => {
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    const authorize = new URL(String(start.headers.location));
    env.github.state.challenges.set("c", authorize.searchParams.get("code_challenge") ?? "");
    env.clock.advance(10);
    const callback = await env.call(`/auth/github/callback?code=c&state=${authorize.searchParams.get("state")}`, undefined);
    assert.equal(callback.status, 400);
    assert.equal(callback.json().error, "login-expired");
  });

  it("answers 403 when the owner declined at GitHub", async (t) => {
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    const state = new URL(String(start.headers.location)).searchParams.get("state");
    const callback = await env.call(`/auth/github/callback?error=access_denied&state=${state}`, undefined);
    assert.equal(callback.status, 403);
    assert.equal(callback.json().error, "github-denied");
  });

  it("answers 502 when GitHub does not take the code", async (t) => {
    // Guards against: a login that goes on, or is taken as GitHub being down, when the exchange is refused.
    const env = await setup(t);
    const start = await env.call("/auth/github/start", undefined);
    const state = new URL(String(start.headers.location)).searchParams.get("state");
    // GitHub never gave this code: its exchange is refused.
    const callback = await env.call(`/auth/github/callback?code=unknown&state=${state}`, undefined);
    assert.equal(callback.status, 502);
    assert.equal(callback.json().error, "github-exchange-failed");
    assert.equal(callback.headers["set-cookie"], undefined);
  });

  it("answers 429 while too many logins are under way, until they expire", async (t) => {
    // Guards against: logins started without end filling the backend's memory (docs/backend.md: they live 10 minutes).
    const env = await setup(t);
    let refused: Awaited<ReturnType<typeof env.call>> | undefined;
    for (let i = 0; i < 1000 && !refused; i++) {
      const start = await env.call("/auth/github/start", undefined);
      if (start.status !== 302) refused = start;
    }
    assert.ok(refused, "some number of logins under way is too many");
    assert.equal(refused.status, 429);
    assert.equal(refused.json().error, "too-many-logins");
    env.clock.advance(10);
    assert.equal((await env.call("/auth/github/start", undefined)).status, 302, "the expired ones make room");
  });

  it("answers 502 when GitHub cannot be reached", async (t) => {
    const env = await setup(t);
    env.github.state.down = true;
    const callback = await logIn(env);
    assert.equal(callback.status, 502);
    assert.equal(callback.json().error, "github-unavailable");
  });

  it("lets no one in when it is not configured", async (t) => {
    const env = await setup(t, { configured: false });
    const start = await env.call("/auth/github/start", undefined);
    assert.equal(start.status, 503);
    assert.equal(start.json().error, "login-not-configured");
    const forged = env.sessions.create(OWNER).token;
    assert.equal((await env.call("/api/history", `penelope_session=${forged}`)).status, 401);
  });

  it("logs out: the cookie is cleared and the session no longer works", async (t) => {
    const env = await setup(t);
    const session = env.signIn();
    const out = await env.call("/auth/logout", session, { method: "POST" });
    assert.equal(out.status, 204);
    const cleared = parseCookie(out.headers["set-cookie"]?.[0]);
    assert.equal(cleared.name, "penelope_session");
    assert.equal(cleared.value, "");
    assert.equal(cleared.attributes.get("max-age"), "0");
    assert.equal((await env.call("/api/history", session)).status, 401);
  });
});

describe("the UI's API", () => {
  it("answers 401 to a request without a session", async (t) => {
    const env = await setup(t);
    for (const [pathname, options] of [
      ["/api/history", {}],
      ["/api/stream", {}],
      ["/api/messages", { json: { text: "hi" } }],
      ["/api/agents", {}],
      ["/api/schedules", {}],
      ["/api/schedules/s-1", { method: "DELETE" }],
      ["/api/record", {}],
      ["/api/record/seen", { method: "POST" }],
    ] as const) {
      const answer = await env.call(pathname, undefined, options);
      assert.equal(answer.status, 401, pathname);
      assert.equal(typeof answer.json().error, "string");
    }
    assert.equal((await env.call("/api/history", "penelope_session=not-a-token")).status, 401);
  });

  describe("a message", () => {
    it("becomes an inline ui event and a line of the history", async (t) => {
      const env = await setup(t);
      const answer = await env.call("/api/messages", env.signIn(), { json: { text: "hello\nmore" } });
      assert.equal(answer.status, 202);
      const { id } = answer.json();
      const [event] = env.queue.take({ after: 0 });
      assert.equal(event?.source, "ui");
      assert.equal(event?.id, id);
      assert.equal(event?.summary, "hello");
      assert.equal(event?.delivery, "now");
      assert.deepEqual(event?.inline && event.payload, { text: "hello\nmore" });
      assert.deepEqual(event?.answer_via, { tool: "reply" });
      assert.deepEqual(env.conversation.page().entries.map((e) => [e.kind, e.id, e.text]), [["owner", id, "hello\nmore"]]);
    });

    it("carries files sent with it as multipart", async (t) => {
      const env = await setup(t);
      const { body, contentType } = await multipart([
        ["text", "see this"],
        ["file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" }), "shot.png"],
      ]);
      const answer = await env.call("/api/messages", env.signIn(), { body, headers: { "content-type": contentType } });
      assert.equal(answer.status, 202);
      const [event] = env.queue.take({ after: 0 });
      assert.deepEqual(event?.attachments, [{ path: path.join(env.sourcesDir, "ui/files/1-shot.png"), mime_type: "image/png", size: 8 }]);
    });

    it("keeps a copy of each image sent with it, and the names of the other files, in its line of the history", async (t) => {
      // Guards against: the owner's own images gone from the conversation once the page is read again (ADR-0034).
      const env = await setup(t);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      const { body, contentType } = await multipart([
        ["text", "見て"],
        ["file", new Blob([png], { type: "image/png" }), "shot.png"],
        ["file", new Blob(["notes"], { type: "text/plain" }), "notes.txt"],
      ]);
      const cookie = env.signIn();
      const answer = await env.call("/api/messages", cookie, { body, headers: { "content-type": contentType } });
      assert.equal(answer.status, 202);
      const sent = answer.json();
      const [entry] = (await env.call("/api/history", cookie)).json().entries;
      assert.deepEqual(entry, { kind: "owner", id: sent.id, at: entry.at, text: "見て", images: sent.images, files: sent.files });
      assert.deepEqual({ ...entry.images[0], id: "" }, { id: "", mime_type: "image/png", size: png.length, name: "shot.png" });
      assert.deepEqual(entry.files, [{ name: "notes.txt", size: 5 }]);
      assert.deepEqual((await env.call(`/api/assets/${entry.images[0].id}`, cookie)).body, Buffer.from(png));
    });

    it("is not sent when its images cannot be kept", async (t) => {
      // Guards against: a message the agent got while the history lost its images.
      const env = await setup(t);
      writeFileSync(env.assets.dir, "not a directory");
      const { body, contentType } = await multipart([["file", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]), "shot.png"]]);
      const answer = await env.call("/api/messages", env.signIn(), { body, headers: { "content-type": contentType } });
      assert.equal(answer.status, 500);
      assert.deepEqual(env.queue.take({ after: 0 }), []);
      assert.deepEqual(env.conversation.page().entries, []);
    });

    it("is summed up by its first line, cut at 200 characters", async (t) => {
      // Guards against: a long message making a summary that is not one line (docs/ui-api.md).
      const env = await setup(t);
      const cookie = env.signIn();
      await env.call("/api/messages", cookie, { json: { text: `${"a".repeat(300)}\nsecond` } });
      const [event] = env.queue.take({ after: 0 });
      assert.ok(event!.summary.startsWith("a".repeat(200)));
      assert.ok(!event!.summary.includes("a".repeat(201)));
      assert.ok(!event!.summary.includes("second"));
    });

    it("of files alone is summed up by how many there are", async (t) => {
      const env = await setup(t);
      const { body, contentType } = await multipart([
        ["file", new Blob(["a"]), "a.txt"],
        ["file", new Blob(["b"]), "b.txt"],
      ]);
      assert.equal((await env.call("/api/messages", env.signIn(), { body, headers: { "content-type": contentType } })).status, 202);
      const [event] = env.queue.take({ after: 0 });
      assert.match(event!.summary, /\b2\b/);
    });

    it("is refused with no text and no files", async (t) => {
      const env = await setup(t);
      assert.equal((await env.call("/api/messages", env.signIn(), { json: { text: "" } })).status, 400);
      assert.equal((await env.call("/api/messages", env.signIn(), { json: {} })).status, 400);
    });
  });

  describe("the history", () => {
    it("comes newest first, a page at a time", async (t) => {
      const env = await setup(t);
      for (let i = 1; i <= 60; i++) env.conversation.ownerMessage({ id: `m-${i}`, text: `${i}` });
      const cookie = env.signIn();
      const first = (await env.call("/api/history", cookie)).json();
      assert.equal(first.entries.length, 50);
      assert.equal(first.entries[0].id, "m-60");
      const second = (await env.call(`/api/history?before=${encodeURIComponent(first.before)}`, cookie)).json();
      assert.deepEqual(second.entries.map((e: { id: string }) => e.id).slice(0, 2), ["m-10", "m-9"]);
      assert.equal(second.before, undefined);
    });

    it("refuses a cursor it did not give", async (t) => {
      const env = await setup(t);
      assert.equal((await env.call("/api/history?before=x", env.signIn())).status, 400);
    });

    it("lists the images of a reply, whose bytes are read by their id", async (t) => {
      // Guards against: the owner not seeing an image of a reply, or seeing other bytes than were sent.
      const env = await setup(t);
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
      env.conversation.reply({ agent: "main", text: "描いたよ" }, [{ name: "cat.png", mime_type: "image/png", data: bytes }]);
      const cookie = env.signIn();
      const [entry] = (await env.call("/api/history", cookie)).json().entries;
      assert.equal(entry.images.length, 1);
      const [image] = entry.images;
      assert.deepEqual({ ...image, id: "" }, { id: "", mime_type: "image/png", size: bytes.length, name: "cat.png" });

      const answer = await env.call(`/api/assets/${image.id}`, cookie);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers["content-type"], "image/png");
      assert.equal(answer.headers["content-length"], String(bytes.length));
      assert.equal(answer.headers["x-content-type-options"], "nosniff");
      // The same id is always the same bytes: the browser keeps what it read.
      assert.match(answer.headers["cache-control"] ?? "", /private/);
      assert.match(answer.headers["cache-control"] ?? "", /immutable/);
      assert.deepEqual(answer.body, Buffer.from(bytes));
    });

    it("gives an image only to the owner's session, and not one it does not have", async (t) => {
      // Guards against: the images of the conversation read by anyone who has the link.
      const env = await setup(t);
      env.conversation.reply({ agent: "main", text: "x" }, [{ name: "a.png", mime_type: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }]);
      const cookie = env.signIn();
      const [entry] = (await env.call("/api/history", cookie)).json().entries;
      const id = entry.images[0].id;
      assert.equal((await env.call(`/api/assets/${id}`, undefined)).status, 401);
      assert.equal((await env.call("/api/assets/no-such-image", cookie)).status, 404);
      assert.equal((await env.call(`/api/assets/${id}/more`, cookie)).status, 404);
      assert.equal((await env.call(`/api/assets/${id}`, cookie, { method: "POST", body: "" })).status, 405);
    });
  });

  describe("the stream", () => {
    it("sends replies, activity and state as server-sent events", async (t) => {
      const env = await setup(t);
      const reader = new SseReader();
      t.after(() => reader.close());
      await reader.open(env.target, "/api/stream", { cookie: env.signIn() });
      assert.equal(reader.status, 200);
      env.conversation.reply({ agent: "main", text: "done" });
      env.conversation.turnEnded("main");
      await reader.waitFor(2);
      assert.deepEqual(reader.events.map((e) => [e.id, e.event]), [["1", "reply"], ["2", "state"]]);
      assert.equal(reader.events[0]?.data.text, "done");
    });

    it("sends again what came after the Last-Event-ID", async (t) => {
      const env = await setup(t);
      env.conversation.turnEnded("main");
      env.conversation.turnEnded("main");
      const reader = new SseReader();
      t.after(() => reader.close());
      await reader.open(env.target, "/api/stream", { cookie: env.signIn(), "last-event-id": "1" });
      await reader.waitFor(1);
      assert.deepEqual(reader.events.map((e) => e.id), ["2"]);
    });
  });

  // The login screen and the home screen's icon show who she is before
  // anyone signs in, and the name comes from the settings (ADR-0001).
  describe("the agent", () => {
    it("is named from the settings, without a session", async (t) => {
      const env = await setup(t, { agent: { name: "Iris", dir: "/nowhere", icons: {} } });
      const answer = await env.call("/api/agent", undefined);
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json(), { name: "Iris" });
      assert.equal((await env.call("/api/agent/icons/neutral", undefined)).status, 404);
    });

    // The avatar changes its face with the expression of her replies (ADR-0016).
    it("serves each face of the avatar the settings chose, without a session", async (t) => {
      const dir = tempDir(t);
      const faces = { neutral: Buffer.from("RIFF-neutral"), happy: Buffer.from("RIFF-happy") };
      for (const [name, body] of Object.entries(faces)) writeFileSync(path.join(dir, `${name}.webp`), body);
      const env = await setup(t, { agent: { name: "Iris", dir, icons: { neutral: "neutral.webp", happy: "happy.webp" } } });
      const agent = (await env.call("/api/agent", undefined)).json();
      assert.deepEqual(Object.keys(agent.icons).sort(), ["happy", "neutral"]);
      const happy = await env.call(agent.icons.happy, undefined);
      assert.equal(happy.status, 200);
      assert.equal(happy.headers["content-type"], "image/webp");
      assert.equal(happy.text, "RIFF-happy");
      assert.equal((await env.call("/api/agent/icons/angry", undefined)).status, 404);
    });

    // Slack takes the face as an icon_url, and an image's URL there ends in
    // its extension (docs/ui-api.md, "エージェント").
    it("gives each face's way with the extension of its image, and still serves it without one", async (t) => {
      const dir = tempDir(t);
      writeFileSync(path.join(dir, "happy.PNG"), "PNG-happy");
      writeFileSync(path.join(dir, "odd.name.webp"), "RIFF-odd");
      const env = await setup(t, { agent: { name: "Iris", dir, icons: { happy: "happy.PNG", "odd.name": "odd.name.webp" } } });
      const agent = (await env.call("/api/agent", undefined)).json();
      assert.deepEqual(agent.icons, { happy: "/api/agent/icons/happy.png", "odd.name": "/api/agent/icons/odd.name.webp" });
      for (const way of ["/api/agent/icons/happy.png", "/api/agent/icons/happy"]) {
        const answer = await env.call(way, undefined);
        assert.equal(answer.status, 200, way);
        assert.equal(answer.headers["content-type"], "image/png");
        assert.equal(answer.text, "PNG-happy");
      }
      assert.equal((await env.call("/api/agent/icons/odd.name.webp", undefined)).text, "RIFF-odd");
      assert.equal((await env.call("/api/agent/icons/odd.name", undefined)).text, "RIFF-odd");
      assert.equal((await env.call("/api/agent/icons/happy.webp", undefined)).status, 404);
    });

    // Slack may not take a WebP as an icon, so a face's PNG has a way of its
    // own, while the Web UI keeps the WebP (docs/ui-api.md, "エージェント").
    it("serves the PNG of a face beside its image, at the way ending in .png", async (t) => {
      const dir = tempDir(t);
      writeFileSync(path.join(dir, "happy.webp"), "RIFF-happy");
      writeFileSync(path.join(dir, "happy.png"), "PNG-happy");
      writeFileSync(path.join(dir, "neutral.webp"), "RIFF-neutral");
      const env = await setup(t, {
        agent: { name: "Iris", dir, icons: { happy: "happy.webp", neutral: "neutral.webp" }, pngIcons: { happy: "happy.png" } },
      });
      const agent = (await env.call("/api/agent", undefined)).json();
      assert.deepEqual(agent.icons, { happy: "/api/agent/icons/happy.webp", neutral: "/api/agent/icons/neutral.webp" });
      assert.deepEqual(agent.png_icons, { happy: "/api/agent/icons/happy.png" });
      const png = await env.call(agent.png_icons.happy, undefined);
      assert.equal(png.status, 200);
      assert.equal(png.headers["content-type"], "image/png");
      assert.equal(png.text, "PNG-happy");
      for (const way of ["/api/agent/icons/happy.webp", "/api/agent/icons/happy"]) {
        const answer = await env.call(way, undefined);
        assert.equal(answer.headers["content-type"], "image/webp", way);
        assert.equal(answer.text, "RIFF-happy", way);
      }
      assert.equal((await env.call("/api/agent/icons/neutral.png", undefined)).status, 404);
    });

    it("gives nothing else away without a session", async (t) => {
      const env = await setup(t);
      assert.equal((await env.call("/api/agent/other", undefined)).status, 401);
      assert.equal((await env.call("/api/agent/icons/../../history", undefined)).status, 401);
    });
  });

  describe("the sub-agents", () => {
    it("are listed while they are not closed, with their purpose and state", async (t) => {
      const env = await setup(t);
      const at = "2026-11-14T09:00:00Z";
      assert.deepEqual((await env.call("/api/agents", env.signIn())).json(), { agents: [] });
      env.agents.record({ agent: "review-pr-22", purpose: "review PR 22", closed: false });
      env.clock.advance(1);
      env.agents.record({ agent: "dig-logs", purpose: "dig the logs", closed: false });
      env.agents.record({ agent: "old-one", purpose: "done long ago", closed: false });
      env.agents.record({ agent: "old-one", purpose: "done long ago", closed: true });
      env.clock.advance(1);
      env.conversation.activities("dig-logs", [{ kind: "turn_start", at, turn_id: "t-1" }]);
      env.conversation.activities("main", [{ kind: "turn_start", at, turn_id: "t-2" }]);
      const answer = await env.call("/api/agents", env.signIn());
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json(), {
        agents: [
          {
            agent: "review-pr-22",
            purpose: "review PR 22",
            state: "waiting",
            started_at: "2026-11-14T09:00:00.000Z",
            state_since: "2026-11-14T09:00:00.000Z",
          },
          {
            agent: "dig-logs",
            purpose: "dig the logs",
            state: "thinking",
            started_at: "2026-11-14T09:01:00.000Z",
            state_since: at,
          },
        ],
      });
    });
  });

  // The same schedules as her schedule_list and schedule_remove (docs/sandbox-api.md), with when each comes due next.
  describe("the schedules", () => {
    it("are listed as she lists them, with when each comes due next", async (t) => {
      const env = await setup(t);
      assert.deepEqual((await env.call("/api/schedules", env.signIn())).json(), { schedules: [] });
      // 09:00 in UTC is 18:00 in Tokyo, the backend's time zone here.
      const morning = env.schedules.create({ agent: "main", reason: "every morning", cron: "0 9 * * *" });
      env.clock.advance(1);
      const once = env.schedules.create({ agent: "main", reason: "look at the PR", at: "2026-11-20T01:30:00Z" });
      const answer = await env.call("/api/schedules", env.signIn());
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json(), {
        schedules: [
          { id: morning.id, reason: "every morning", cron: "0 9 * * *", next_at: "2026-11-15T00:00:00.000Z" },
          { id: once.id, reason: "look at the PR", at: "2026-11-20T01:30:00Z", next_at: "2026-11-20T01:30:00.000Z" },
        ],
      });
    });

    it("are removed by their id, as she removes them, and she is not told", async (t) => {
      const env = await setup(t);
      const kept = env.schedules.create({ agent: "main", reason: "every morning", cron: "0 9 * * *" });
      const gone = env.schedules.create({ agent: "main", reason: "every night", cron: "0 22 * * *" });
      const removed = await env.call(`/api/schedules/${encodeURIComponent(gone.id)}`, env.signIn(), { method: "DELETE" });
      assert.equal(removed.status, 204);
      assert.deepEqual(env.schedules.list("main"), [kept], "what her schedule_list sees");
      assert.deepEqual(env.queue.take({ after: 0 }), [], "no event of it");
      assert.deepEqual((await env.call("/api/schedules", env.signIn())).json().schedules.map((s: { id: string }) => s.id), [kept.id]);
      const again = await env.call(`/api/schedules/${encodeURIComponent(gone.id)}`, env.signIn(), { method: "DELETE" });
      assert.equal(again.status, 404);
      assert.equal(typeof again.json().error, "string");
    });

    it("cannot be added from the UI", async (t) => {
      const env = await setup(t);
      const answer = await env.call("/api/schedules", env.signIn(), { json: { reason: "x", cron: "0 9 * * *" } });
      assert.equal(answer.status, 404);
      assert.deepEqual(env.schedules.list("main"), []);
    });
  });

  // What the record holds is record.test.ts's; here, that the UI reaches it (docs/ui-api.md "活動の記録").
  describe("the activity record", () => {
    it("gives a day of it, narrowed as asked", async (t) => {
      const env = await setup(t);
      env.record.activities("main", [{ kind: "turn_start", at: "2026-11-14T01:00:00.000Z", turn_id: "t-1" }]);
      const answer = await env.call("/api/record?day=2026-11-14&tz=Asia%2FTokyo&kind=turn&failed=0", env.signIn());
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json().rows.map((row: { id: string }) => row.id), ["t-1"]);
    });

    it("refuses a day, a time zone or a kind it does not know", async (t) => {
      const env = await setup(t);
      for (const query of ["day=yesterday", "tz=Mars%2FOlympus", "kind=turns", "failed=yes"]) {
        assert.equal((await env.call(`/api/record?${query}`, env.signIn())).status, 400, query);
      }
    });

    it("answers 404 for a turn, a night or a sub-agent it does not have", async (t) => {
      const env = await setup(t);
      for (const pathname of ["/api/record/turns/t-0", "/api/record/turns/t-0/results/c-0", "/api/record/nights/1", "/api/record/sub-agents/helper"]) {
        assert.equal((await env.call(pathname, env.signIn())).status, 404, pathname);
      }
    });

    it("keeps when the owner opened it, which leaves no failure unseen", async (t) => {
      const env = await setup(t);
      env.clock.advance(1);
      env.record.activities("main", [{ kind: "turn_start", at: "2026-11-14T01:00:00.000Z", turn_id: "t-1" }]);
      env.record.turnEnded("main", { turn_id: "t-1", result: "failed" });
      assert.deepEqual((await env.call("/api/record/unseen", env.signIn())).json(), { unseen: 1 });
      assert.equal((await env.call("/api/record/seen", env.signIn(), { method: "POST" })).json().unseen, 1);
      assert.deepEqual((await env.call("/api/record/unseen", env.signIn())).json(), { unseen: 0 });
    });
  });

  it("answers the health check without a session", async (t) => {
    const env = await setup(t);
    assert.equal((await env.call("/healthz", undefined)).status, 200);
  });

  // What is not under /api/ is the Web UI's (web.test.ts); an API path it does not have is 404, not a page.
  it("answers 404 to an API path it does not have", async (t) => {
    const env = await setup(t);
    assert.equal((await env.call("/api/nothing", env.signIn())).status, 404);
  });

  describe("the A2A way in", () => {
    const web: Handler = async (_request, response) => sendJson(response, 200, { page: true });

    it("is handed the A2A paths, including root discovery, without a login", async (t) => {
      // Guards against: the senders' calls going to the Web UI, or asked for the owner's cookie.
      const a2a: Handler = async (request, response) => sendJson(response, 200, { a2a: request.url });
      const { call } = await setup(t, { a2a, web });
      for (const pathname of ["/a2a", "/a2a/", "/a2a/unknown", "/.well-known/agent-card.json"]) {
        const answer = await call(pathname, undefined);
        assert.deepEqual(answer.json(), { a2a: pathname });
      }
      for (const pathname of ["/", "/a2another", "/.well-known/other.json"]) {
        assert.deepEqual((await call(pathname, undefined)).json(), { page: true });
      }
    });

    it("is not found while it is closed, rather than the Web UI's page", async (t) => {
      // Guards against: a sender reading the page as an Agent Card, or taking a closed way in for an open one.
      const { call } = await setup(t, { web });
      const answer = await call("/.well-known/agent-card.json", undefined);
      assert.equal(answer.status, 404);
      assert.equal(typeof answer.json().error, "string");
    });
  });

  describe("the subscriptions to notices", () => {
    const KEY = "BPublicKeyOfTheDeployment";
    const keys = () => {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") };
    };
    const subscribe = (env: Awaited<ReturnType<typeof setup>>, cookie: string | undefined, body: unknown) =>
      env.call("/api/push/subscriptions", cookie, { method: "POST", json: body });

    it("tells the UI the VAPID public key, or that there is no Web Push", async (t) => {
      const on = await setup(t, { pushKey: KEY });
      assert.deepEqual((await on.call("/api/push", on.signIn())).json(), { web_push: { public_key: KEY } });
      const off = await setup(t);
      const answer = await off.call("/api/push", off.signIn());
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.json(), {});
    });

    it("registers and removes a browser's subscription for the owner's session only", async (t) => {
      const env = await setup(t, { pushKey: KEY });
      const subscription = { kind: "web-push", endpoint: "https://push.example.com/send/1", keys: keys() };
      assert.equal((await subscribe(env, undefined, subscription)).status, 401);
      assert.equal(env.subscriptions.all().length, 0);

      const cookie = env.signIn();
      assert.equal((await subscribe(env, cookie, subscription)).status, 204);
      // The same browser again replaces what it had.
      assert.equal((await subscribe(env, cookie, { ...subscription, keys: keys() })).status, 204);
      assert.equal((await subscribe(env, cookie, { ...subscription, endpoint: "https://push.example.com/send/2" })).status, 204);
      assert.deepEqual(
        env.subscriptions.all().map((s) => s.endpoint),
        ["https://push.example.com/send/1", "https://push.example.com/send/2"],
      );

      const remove = (who: string | undefined) =>
        env.call("/api/push/subscriptions/delete", who, { method: "POST", json: { endpoint: "https://push.example.com/send/1" } });
      assert.equal((await remove(undefined)).status, 401);
      assert.equal((await remove(cookie)).status, 204);
      // Removing what is not there is the same answer.
      assert.equal((await remove(cookie)).status, 204);
      assert.deepEqual(
        env.subscriptions.all().map((s) => s.endpoint),
        ["https://push.example.com/send/2"],
      );
    });

    it("refuses a subscription it could not send to", async (t) => {
      const env = await setup(t, { pushKey: KEY });
      const cookie = env.signIn();
      for (const body of [
        { kind: "web-push", endpoint: "http://push.example.com/send/1", keys: keys() },
        { kind: "web-push", endpoint: "https://push.example.com/send/1", keys: { p256dh: "AAAA", auth: "AAAA" } },
        { kind: "apns", endpoint: "https://push.example.com/send/1", keys: keys() },
        "not an object",
      ]) {
        const answer = await subscribe(env, cookie, body);
        assert.equal(answer.status, 400, JSON.stringify(body));
        assert.equal(typeof answer.json().error, "string");
      }
      assert.equal((await env.call("/api/push/subscriptions/delete", cookie, { method: "POST", json: { endpoint: 1 } })).status, 400);
      assert.equal(env.subscriptions.all().length, 0);
    });

    it("takes no subscription when there is no Web Push", async (t) => {
      const env = await setup(t);
      const answer = await subscribe(env, env.signIn(), { kind: "web-push", endpoint: "https://push.example.com/send/1", keys: keys() });
      assert.equal(answer.status, 503);
      assert.equal(answer.json().error, "web-push-not-configured");
    });
  });
});
