import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";

import { GatedAssertion, TokenReview, type SenderCheck } from "@penelope/service-account-auth";

import { Senders, whoIs } from "../src/a2a/senders.ts";
import { FakeClock, tempDir } from "./support.ts";

type Seen = { authorization: string | undefined; path: string; body: any };

/** A fake API server: answers each TokenReview with `answer`, and keeps what it was asked. */
async function apiServer(t: { after: (fn: () => void) => void }, answer: (body: any) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const server = http.createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part as Buffer);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    seen.push({ authorization: request.headers.authorization, path: request.url ?? "", body });
    const { status, body: out } = answer(body);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(out));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** What the API server says of a token: authenticated as a ServiceAccount, for the audiences asked. */
function reviewed(subject: string, audiences?: string[]) {
  return (body: any) => ({
    status: 201,
    body: {
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      status: { authenticated: true, user: { username: subject }, audiences: audiences ?? body.spec.audiences ?? [] },
    },
  });
}

const CLAUDE = "system:serviceaccount:agents:claude";
const senders = new Senders(["agents/claude", "natsumi/natsumi"]);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function backendToken(t: { after: (fn: () => void) => void }, value = "backend-sa-token-1"): string {
  const file = path.join(tempDir(t), "token");
  writeFileSync(file, `${value}\n`);
  return file;
}

describe("the allow-list of senders", () => {
  it("names a sender by its ServiceAccount's name, and nobody else", () => {
    // Guards against: a ServiceAccount of the same name in another namespace taken as the sender.
    assert.equal(senders.nameOf(CLAUDE), "claude");
    assert.equal(senders.nameOf("system:serviceaccount:natsumi:natsumi"), "natsumi");
    assert.equal(senders.nameOf("system:serviceaccount:default:claude"), undefined);
    assert.equal(senders.nameOf("claude"), undefined);
  });

  it("refuses an entry that is not <namespace>/<name>, and two senders of one name", () => {
    // Guards against: two senders writing into one place under /sources/a2a/.
    assert.throws(() => new Senders(["claude"]), /namespace/);
    assert.throws(() => new Senders(["a/claude", "b/claude"]), /twice/);
  });
});

describe("the TokenReview check", () => {
  it("lets a ServiceAccount of the allow-list in, asking with the backend's own token and the audiences set", async (t) => {
    // Guards against: the token checked for another audience than the one set, or the backend's token not sent.
    const api = await apiServer(t, reviewed(CLAUDE));
    const check = new TokenReview({ url: api.url, tokenFile: backendToken(t) }, ["https://penelope.example.com"]);
    assert.deepEqual(await whoIs([check], senders, bearer("sender-token")), { kind: "sender", name: "claude" });
    const [request] = api.seen;
    assert.equal(request!.path, "/apis/authentication.k8s.io/v1/tokenreviews");
    assert.equal(request!.authorization, "Bearer backend-sa-token-1");
    assert.equal(request!.body.kind, "TokenReview");
    assert.equal(request!.body.spec.token, "sender-token");
    assert.deepEqual(request!.body.spec.audiences, ["https://penelope.example.com"]);
  });

  it("reads the backend's token again for each review", async (t) => {
    // Guards against: the projected token, which the kubelet rotates, read once at the start and expiring.
    const api = await apiServer(t, reviewed(CLAUDE));
    const file = backendToken(t);
    const check = new TokenReview({ url: api.url, tokenFile: file }, []);
    await whoIs([check], senders, bearer("sender-token"));
    writeFileSync(file, "backend-sa-token-2\n");
    await whoIs([check], senders, bearer("sender-token"));
    assert.deepEqual(api.seen.map((seen) => seen.authorization), ["Bearer backend-sa-token-1", "Bearer backend-sa-token-2"]);
    assert.equal(api.seen[1]!.body.spec.audiences, undefined, "no audiences set: the API server's own");
  });

  it("refuses a token the API server does not authenticate, or authenticates for none of the audiences", async (t) => {
    // Guards against: a forged or expired token, or one made for another service, getting in.
    const unauthenticated = await apiServer(t, () => ({ status: 201, body: { status: { authenticated: false, error: "invalid" } } }));
    const elsewhere = await apiServer(t, reviewed(CLAUDE, ["https://other.example.com"]));
    for (const url of [unauthenticated.url, elsewhere.url]) {
      const check = new TokenReview({ url, tokenFile: backendToken(t) }, ["https://penelope.example.com"]);
      assert.equal((await whoIs([check], senders, bearer("sender-token"))).kind, "refused", url);
    }
  });

  it("refuses a ServiceAccount that is not on the allow-list", async (t) => {
    // Guards against: any ServiceAccount of the cluster being let in.
    const api = await apiServer(t, reviewed("system:serviceaccount:default:stranger"));
    const check = new TokenReview({ url: api.url, tokenFile: backendToken(t) }, []);
    assert.equal((await whoIs([check], senders, bearer("sender-token"))).kind, "refused");
  });

  it("lets nobody in when the API server does not answer", async (t) => {
    // Guards against: a sender let in because the check could not be made (ADR-0010).
    const failing = await apiServer(t, () => ({ status: 500, body: { message: "down" } }));
    for (const url of [failing.url, "http://127.0.0.1:1"]) {
      const check = new TokenReview({ url, tokenFile: backendToken(t) }, []);
      assert.equal((await whoIs([check], senders, bearer("sender-token"))).kind, "unavailable", url);
    }
  });

  it("refuses a call without a bearer token, without asking the API server", async (t) => {
    // Guards against: the API server asked for every stray call.
    const api = await apiServer(t, reviewed(CLAUDE));
    const check = new TokenReview({ url: api.url, tokenFile: backendToken(t) }, []);
    assert.equal((await whoIs([check], senders, {})).kind, "refused");
    assert.equal((await whoIs([check], senders, { authorization: "Basic abc" })).kind, "refused");
    assert.equal(api.seen.length, 0);
  });
});

/** gated's signing key and its JWKS, served; and assertions signed with it. */
async function gated(t: { after: (fn: () => void) => void }) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let fetches = 0;
  const server = http.createServer((_request, response) => {
    fetches += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    jwksUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__gated/jwks.json`,
    fetches: () => fetches,
    sign: (claims: Record<string, unknown>, header: Record<string, unknown> = {}, key: KeyObject = privateKey) => {
      const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const signed = `${part({ alg: "EdDSA", typ: "gated-assertion+jwt", kid: "k1", ...header })}.${part(claims)}`;
      return `${signed}.${sign(null, Buffer.from(signed), key).toString("base64url")}`;
    },
  };
}

const ISSUER = "https://auth.example.com";

describe("the gated assertion check", () => {
  const clock = new FakeClock("2026-11-14T09:00:00Z");
  const claims = (more: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    aud: "penelope.example.com",
    sub: CLAUDE,
    iat: clock.ms / 1000,
    exp: clock.ms / 1000 + 60,
    ...more,
  });

  it("lets in a ServiceAccount of the allow-list that gated asserts for this host", async (t) => {
    // Guards against: the senders that call through gated, whose token gated takes off, not getting in.
    const keys = await gated(t);
    const check = new GatedAssertion({ issuer: ISSUER, jwksUrl: keys.jwksUrl, audience: "penelope.example.com", now: clock.now });
    assert.deepEqual(await whoIs([check], senders, { "gated-assertion": keys.sign(claims()) }), { kind: "sender", name: "claude" });
  });

  it("refuses an assertion of another issuer or host, expired, of another key, or not signed by gated", async (t) => {
    // Guards against: an assertion for another host replayed here, a stale one, or a forged one getting in.
    const keys = await gated(t);
    const check = new GatedAssertion({ issuer: ISSUER, jwksUrl: keys.jwksUrl, audience: "penelope.example.com", now: clock.now });
    const forger = generateKeyPairSync("ed25519").privateKey;
    const bad = {
      issuer: keys.sign(claims({ iss: "https://evil.example.com" })),
      host: keys.sign(claims({ aud: "other.example.com" })),
      expired: keys.sign(claims({ exp: clock.ms / 1000 - 120 })),
      key: keys.sign(claims(), { kid: "k2" }),
      forged: keys.sign(claims(), {}, forger),
      algorithm: keys.sign(claims(), { alg: "none" }),
      stranger: keys.sign(claims({ sub: "system:serviceaccount:default:stranger" })),
      garbage: "not.an.assertion",
    };
    for (const [why, assertion] of Object.entries(bad)) {
      assert.equal((await whoIs([check], senders, { "gated-assertion": assertion })).kind, "refused", why);
    }
  });

  it("refuses a call without an assertion", async (t) => {
    // Guards against: a call that did not come through gated being let in by this check.
    const keys = await gated(t);
    const check = new GatedAssertion({ issuer: ISSUER, jwksUrl: keys.jwksUrl, audience: "penelope.example.com", now: clock.now });
    assert.equal((await whoIs([check], senders, bearer("sender-token"))).kind, "refused");
  });

  it("refuses everything while gated's keys cannot be fetched", async (t) => {
    // Guards against: a sender let in because the check could not be made (ADR-0010).
    const keys = await gated(t);
    const check = new GatedAssertion({ issuer: ISSUER, jwksUrl: "http://127.0.0.1:1/jwks.json", audience: "penelope.example.com", now: clock.now });
    assert.notEqual((await whoIs([check], senders, { "gated-assertion": keys.sign(claims()) })).kind, "sender");
  });

  it("keeps gated's keys for a while instead of fetching them for every call", async (t) => {
    // Guards against: every call waiting on gated's key endpoint.
    const keys = await gated(t);
    const check = new GatedAssertion({ issuer: ISSUER, jwksUrl: keys.jwksUrl, audience: "penelope.example.com", now: clock.now });
    for (let i = 0; i < 3; i++) await whoIs([check], senders, { "gated-assertion": keys.sign(claims()) });
    assert.equal(keys.fetches(), 1);
  });
});

describe("two checks at once", () => {
  it("decides a call by the check whose header it carries: the assertion first, then the bearer token", async (t) => {
    // Guards against: a call through gated, which also carries a token of another audience, decided by that token;
    // or a direct call refused while both checks are on during a move from one to the other.
    const keys = await gated(t);
    const api = await apiServer(t, reviewed("system:serviceaccount:natsumi:natsumi"));
    const clock = new FakeClock("2026-11-14T09:00:00Z");
    const checks: SenderCheck[] = [
      new TokenReview({ url: api.url, tokenFile: backendToken(t) }, []),
      new GatedAssertion({ issuer: ISSUER, jwksUrl: keys.jwksUrl, audience: "penelope.example.com", now: clock.now }),
    ];
    const assertion = keys.sign({ iss: ISSUER, aud: "penelope.example.com", sub: CLAUDE, iat: clock.ms / 1000, exp: clock.ms / 1000 + 60 });
    assert.deepEqual(await whoIs(checks, senders, { "gated-assertion": assertion, ...bearer("x") }), { kind: "sender", name: "claude" });
    assert.equal(api.seen.length, 0, "the token was not reviewed");
    assert.deepEqual(await whoIs(checks, senders, bearer("x")), { kind: "sender", name: "natsumi" });
    assert.equal((await whoIs(checks, senders, {})).kind, "refused");
  });
});
