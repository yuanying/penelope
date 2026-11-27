import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHash, generateKeyPairSync, hkdfSync, verify } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";
import { it, type TestContext } from "node:test";

import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { AppTokens } from "../src/login/app-tokens.ts";
import { ApnsChannel, ApnsClient, type ApnsRequest, type ApnsResponse } from "../src/push/apns.ts";
import { ApnsRegistrations } from "../src/push/apns-registrations.ts";
import { noticeChannel, Notifier } from "../src/push/notifier.ts";

function setup(t: TestContext, answer: (request: ApnsRequest) => Promise<ApnsResponse> = async () => ({ status: 200 })) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let time = 0;
  const owner = 42;
  const now = () => time;
  const phones = new AppTokens(db, { now });
  const registrations = new ApnsRegistrations(db, { now, ownerId: owner });
  const feed = new Feed();
  const sent: ApnsRequest[] = [];
  const logs: string[] = [];
  const channel = new ApnsChannel("https://penelope.example.com", async (request) => {
    sent.push(request);
    return answer(request);
  });
  const notifier = new Notifier({ feed, channels: [noticeChannel("apns", registrations, channel)], agentName: "Iris", log: (line) => logs.push(line) });
  t.after(notifier.start());
  const register = (token: string) => {
    const verifier = "a".repeat(43);
    const code = phones.issueCode(owner, createHash("sha256").update(verifier).digest("base64url"))!;
    const credential = phones.exchange({ code, code_verifier: verifier, device_name: "Test phone" }, owner)!;
    const id = phones.authenticate(credential.token, owner)!;
    const key = createECDH("prime256v1");
    const registration = { token, publicKey: key.generateKeys(), environment: "sandbox" as const };
    registrations.save(id, registration);
    return { id, key, registration, expiresAt: Date.parse(credential.expires_at) };
  };
  const reply = (text: string) => feed.publish({ event: "reply", data: { id: "r1", kind: "agent", text, expression: "happy", at: "2026-11-26T00:00:00Z", agent: "main" } });
  return { phones, owner, register, registrations, sent, logs, reply, settled: () => notifier.settled(), moveTo: (ms: number) => { time = ms; } };
}

it("delivers an APNs reply preview only the enrolled iPhone can open", async (t) => {
  const env = setup(t);
  const token = "ab".repeat(32);
  const { key } = env.register(token);
  env.reply("秘密の返事");
  await env.settled();
  const [request] = env.sent;
  assert.ok(request);
  assert.equal(request.environment, "sandbox");
  assert.equal(request.token, token);
  assert.ok(!request.body.includes("秘密の返事"));
  assert.ok(!request.body.includes("penelope.example.com"));
  const { aps, messageId, e } = JSON.parse(request.body);
  assert.equal(messageId, "r1");
  assert.equal(e.v, 1);
  assert.equal(aps["mutable-content"], 1);
  assert.deepEqual(aps.alert, { title: "Iris", body: "返事があります" });
  // CryptoKit's open procedure from natsumi ADR 0029: X9.63 salt, then nonce ‖ ciphertext ‖ tag.
  const epk = Buffer.from(e.epk, "base64");
  const secret = hkdfSync("sha256", key.computeSecret(epk), Buffer.concat([epk, key.getPublicKey()]), "natsumi-push-v1", 32);
  const ct = Buffer.from(e.ct, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(secret), Buffer.from(e.nonce, "base64"));
  decipher.setAAD(Buffer.from(messageId));
  decipher.setAuthTag(ct.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(ct.subarray(0, -16)), decipher.final()]).toString()), {
    text: "秘密の返事", expression: "happy", url: "https://penelope.example.com",
  });
});

it("does not send to iPhones whose app tokens were revoked or expired", async (t) => {
  const env = setup(t);
  const revoked = env.register("aa".repeat(32));
  const expired = env.register("bb".repeat(32));
  env.phones.revoke(revoked.id, env.owner);
  env.moveTo(expired.expiresAt - 1);
  env.register("cc".repeat(32));
  env.moveTo(expired.expiresAt);
  env.reply("返事");
  await env.settled();
  assert.deepEqual(env.sent.map((request) => request.token), ["cc".repeat(32)]);
});

it("stops sending to registrations APNs says are gone, without logging the reply or token", async (t) => {
  const gone = "aa".repeat(32);
  const bad = "bb".repeat(32);
  const busy = "cc".repeat(32);
  const env = setup(t, async ({ token }) => token === gone ? { status: 410 } : token === bad ? { status: 400, reason: "BadDeviceToken" } : { status: 503, reason: busy });
  for (const token of [gone, bad, busy]) env.register(token);
  env.reply("private reply");
  await env.settled();
  env.sent.length = 0;
  env.reply("next reply");
  await env.settled();
  assert.deepEqual(env.sent.map((request) => request.token), [busy]);
  for (const token of [gone, bad, busy, "private reply"]) assert.ok(!env.logs.join("\n").includes(token));
});

it("keeps a renewed registration when an earlier send reports it gone", async (t) => {
  const token = "ab".repeat(32);
  let refuse!: (answer: ApnsResponse) => void;
  const pending = new Promise<ApnsResponse>((resolve) => { refuse = resolve; });
  const env = setup(t, () => pending);
  const phone = env.register(token);
  env.reply("first reply");
  env.registrations.save(phone.id, phone.registration);
  refuse({ status: 410 });
  await env.settled();
  env.reply("second reply");
  await env.settled();
  assert.equal(env.sent.length, 2);
});

it("fits a reply whose JSON escaping would overflow the APNs alert", async () => {
  const publicKey = createECDH("prime256v1").generateKeys();
  const text = "\u0001".repeat(200);
  // A long deployment URL adds to the exact length after sealing and base64 encoding.
  let body = "";
  const channel = new ApnsChannel(`https://penelope.example.com/${"x".repeat(2000)}`, async (request) => {
    body = request.body;
    return { status: 200 };
  });
  await channel.deliver({ id: 1, token: "ab".repeat(32), environment: "sandbox", publicKey }, { id: "r1", agent: "Iris", text });
  assert.ok(Buffer.byteLength(body) > 0 && Buffer.byteLength(body) <= 4096);
});

it("authenticates an APNs alert to the selected HTTP/2 endpoint with ES256", { timeout: 3000 }, async (t) => {
  let request: IncomingHttpHeaders | undefined;
  const server = createServer();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new ApnsClient({ key: privateKey, keyId: "KEYEXAMPLE", teamId: "TEAMEXAMPL" }, () => 123_000, {
    sandbox: "http://127.0.0.1:0",
    production: url,
  });
  t.after(() => {
    client.close();
    server.close();
  });
  server.on("stream", (stream, headers) => {
    request = headers;
    stream.resume();
    stream.respond({ ":status": 400 });
    stream.end(JSON.stringify({ reason: "BadDeviceToken" }));
  });
  const token = "ab".repeat(32);
  assert.deepEqual(await client.send({ environment: "production", token, body: "{}" }), { status: 400, reason: "BadDeviceToken" });
  assert.equal(request?.[":method"], "POST");
  assert.equal(request?.[":path"], `/3/device/${token}`);
  assert.equal(request?.["apns-topic"], "io.github.yuanying.penelope.phone");
  assert.equal(request?.["apns-push-type"], "alert");
  const jwt = /^bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(String(request?.authorization));
  assert.ok(jwt);
  const [, header, claims, signature] = jwt as RegExpExecArray & [string, string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "ES256", kid: "KEYEXAMPLE" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), { iss: "TEAMEXAMPL", iat: 123 });
  assert.ok(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
});
