import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, generateKeyPairSync, hkdfSync, verify } from "node:crypto";
import { describe, it } from "node:test";

import type { Notice } from "@penelope/contract";

import { openDatabase } from "../src/db.ts";
import { Feed } from "../src/feed.ts";
import { NOTICE_TEXT_LENGTH, noticeChannel, Notifier, noticeOf, PushSubscriptions } from "../src/push/notifier.ts";
import { encryptWebPush, vapidAuthorization, vapidKeyOf, WebPushChannel, type WebPushRequest, webPushSubscriptionOf } from "../src/push/web-push.ts";
import { FakeClock } from "./support.ts";

const b64 = (text: string) => Buffer.from(text, "base64url");

/** The browser's side of RFC 8291, written apart from the backend's, as a push service's client would. */
function decrypt(body: Buffer, browser: { privateKey: Buffer; auth: Buffer }): Buffer {
  const salt = body.subarray(0, 16);
  const keyLength = body[20]!;
  const serverKey = body.subarray(21, 21 + keyLength);
  const record = body.subarray(21 + keyLength);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(browser.privateKey);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(serverKey), browser.auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(padded.at(-1), 2, "the last record ends with the delimiter 0x02");
  return padded.subarray(0, -1);
}

function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { privateKey: ecdh.getPrivateKey(), p256dh: ecdh.getPublicKey(), auth: Buffer.alloc(16, 7) };
}

const subscriptionJson = (endpoint: string, keys: { p256dh: Buffer; auth: Buffer }) => ({
  kind: "web-push",
  endpoint,
  keys: { p256dh: keys.p256dh.toString("base64url"), auth: keys.auth.toString("base64url") },
});

const vapidPem = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("Web Push", () => {
  // RFC 8291, Appendix A.
  it("encrypts the RFC's example with its keys and salt byte for byte", () => {
    const body = encryptWebPush({
      p256dh: b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      auth: b64("BTBZMqHH6r4Tts7J_aSIgg"),
      plaintext: Buffer.from("When I grow up, I want to be a watermelon"),
      serverPrivateKey: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
    });
    assert.equal(
      body.toString("base64url"),
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("encrypts each push with a fresh key pair and salt, opened by the browser's key", () => {
    const browser = browserKeys();
    const plaintext = Buffer.from(JSON.stringify({ text: "返事" }));
    const first = encryptWebPush({ p256dh: browser.p256dh, auth: browser.auth, plaintext });
    const second = encryptWebPush({ p256dh: browser.p256dh, auth: browser.auth, plaintext });
    assert.notDeepEqual(first.subarray(0, 86), second.subarray(0, 86));
    assert.equal(first.readUInt32BE(16), 4096);
    assert.deepEqual(decrypt(first, browser), plaintext);
    assert.deepEqual(decrypt(second, browser), plaintext);
  });

  it("names the backend to the push service with an ES256 token for its origin and the public key", () => {
    const vapid = vapidKeyOf(vapidPem());
    const now = Date.parse("2026-11-16T00:00:00Z");
    const header = vapidAuthorization({ vapid, endpoint: "https://push.example.com/send/abc?x=1", subject: "https://penelope.example.com", now });
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    assert.ok(match, header);
    const [, head, claims, signature, key] = match;
    assert.equal(key, vapid.publicKey);
    assert.deepEqual(JSON.parse(b64(head!).toString()), { typ: "JWT", alg: "ES256" });
    const body = JSON.parse(b64(claims!).toString());
    assert.equal(body.aud, "https://push.example.com");
    assert.equal(body.sub, "https://penelope.example.com");
    // At most 24 hours ahead (RFC 8292, section 2).
    assert.ok(body.exp > now / 1000 && body.exp <= now / 1000 + 24 * 3600);
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(key!).subarray(1, 33).toString("base64url"), y: b64(key!).subarray(33).toString("base64url") }, format: "jwk" });
    assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, b64(signature!)));
  });

  it("takes only a P-256 private key for VAPID", () => {
    const vapid = vapidKeyOf(vapidPem());
    // Uncompressed P-256: 65 bytes, starting with 4.
    assert.equal(b64(vapid.publicKey).length, 65);
    assert.equal(b64(vapid.publicKey)[0], 4);
    assert.throws(() => vapidKeyOf("not a key"));
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    assert.throws(() => vapidKeyOf(rsa));
    const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    assert.throws(() => vapidKeyOf(p384));
  });

  it("takes a subscription only with an https endpoint and the browser's keys", () => {
    const keys = browserKeys();
    const good = subscriptionJson("https://push.example.com/send/abc", keys);
    assert.deepEqual(webPushSubscriptionOf(good), { endpoint: good.endpoint, p256dh: keys.p256dh, auth: keys.auth });
    assert.equal(webPushSubscriptionOf({ ...good, endpoint: "http://push.example.com/send/abc" }), undefined);
    assert.equal(webPushSubscriptionOf({ ...good, endpoint: "not a url" }), undefined);
    assert.equal(webPushSubscriptionOf({ ...good, endpoint: `https://push.example.com/${"a".repeat(2048)}` }), undefined);
    assert.equal(webPushSubscriptionOf({ ...good, kind: "apns" }), undefined);
    assert.equal(webPushSubscriptionOf({ ...good, keys: { ...good.keys, auth: "AAAA" } }), undefined);
    assert.equal(webPushSubscriptionOf({ ...good, keys: { ...good.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } }), undefined, "not a point of the curve");
    assert.equal(webPushSubscriptionOf({ endpoint: good.endpoint }), undefined);
    assert.equal(webPushSubscriptionOf(null), undefined);
  });
});

describe("the notice of a reply", () => {
  it("carries the agent's name, the reply's id, its face and its head", () => {
    const notice = noticeOf({ kind: "agent", id: "r1", at: "2026-11-16T00:00:00Z", text: "終わりました", agent: "main", expression: "happy" }, "Iris");
    assert.deepEqual(notice, { id: "r1", agent: "Iris", text: "終わりました", expression: "happy" } satisfies Notice);
  });

  it("says how many images the reply has, and carries none of them", () => {
    // Guards against: a notice that does not say the reply has images, or that grows with their bytes (ADR-0032).
    const images = [1, 2].map((n) => ({ id: `a${n}`, mime_type: "image/png", size: 100, name: `${n}.png` }));
    const notice = noticeOf({ kind: "agent", id: "r1", at: "2026-11-16T00:00:00Z", text: "描いたよ", agent: "main", images }, "Iris");
    assert.deepEqual(notice, { id: "r1", agent: "Iris", text: "描いたよ", images: 2 } satisfies Notice);
    const none = noticeOf({ kind: "agent", id: "r2", at: "2026-11-16T00:00:00Z", text: "x", agent: "main", images: [] }, "Iris");
    assert.equal("images" in none, false);
  });

  it("cuts a long reply short, without breaking a character", () => {
    const text = "😀".repeat(NOTICE_TEXT_LENGTH + 10);
    const notice = noticeOf({ kind: "agent", id: "r1", at: "2026-11-16T00:00:00Z", text, agent: "main" }, "Iris");
    assert.equal(notice.text, `${"😀".repeat(NOTICE_TEXT_LENGTH)}…`);
  });
});

async function setup(t: { after: (fn: () => void) => void }, answer: (request: WebPushRequest) => Promise<number> = async () => 201) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const clock = new FakeClock("2026-11-16T09:00:00Z");
  const feed = new Feed();
  const subscriptions = new PushSubscriptions(db, { now: clock.now });
  const sent: WebPushRequest[] = [];
  const logs: string[] = [];
  const vapid = vapidKeyOf(vapidPem());
  const notifier = new Notifier({
    feed,
    agentName: "Iris",
    channels: [noticeChannel("web-push", subscriptions, new WebPushChannel({
        vapid,
        subject: "https://penelope.example.com",
        now: clock.now,
        send: async (request) => {
          sent.push(request);
          return answer(request);
        },
    }))],
    log: (line) => logs.push(line),
  });
  const stop = notifier.start();
  t.after(stop);
  const reply = (text: string, id = "r1") => feed.publish({ event: "reply", data: { kind: "agent", id, at: "2026-11-16T09:00:00Z", text, agent: "main" } });
  return { db, feed, subscriptions, notifier, sent, logs, reply, vapid };
}

describe("the subscriptions", () => {
  it("keeps one per endpoint, the newest keys winning, and drops one by its endpoint", (t) => {
    const db = openDatabase(":memory:");
    t.after(() => db.close());
    const subscriptions = new PushSubscriptions(db, { now: () => 0 });
    const first = browserKeys();
    const second = browserKeys();
    subscriptions.save({ kind: "web-push", endpoint: "https://push.example.com/a", p256dh: first.p256dh, auth: first.auth });
    subscriptions.save({ kind: "web-push", endpoint: "https://push.example.com/b", p256dh: first.p256dh, auth: first.auth });
    subscriptions.save({ kind: "web-push", endpoint: "https://push.example.com/a", p256dh: second.p256dh, auth: second.auth });
    const all = subscriptions.all();
    assert.deepEqual(
      all.map((s) => [s.endpoint, s.p256dh]),
      [
        ["https://push.example.com/a", second.p256dh],
        ["https://push.example.com/b", first.p256dh],
      ],
    );
    assert.equal(subscriptions.remove("https://push.example.com/a"), true);
    assert.equal(subscriptions.remove("https://push.example.com/a"), false);
    assert.deepEqual(
      subscriptions.all().map((s) => s.endpoint),
      ["https://push.example.com/b"],
    );
  });
});

describe("the notifier", () => {
  it("sends every reply to every subscription, encrypted to each browser", async (t) => {
    const env = await setup(t);
    const phone = browserKeys();
    const pc = browserKeys();
    env.subscriptions.save({ kind: "web-push", endpoint: "https://push.example.com/phone", ...phone });
    env.subscriptions.save({ kind: "web-push", endpoint: "https://push.example.net/pc", ...pc });
    env.reply("終わりました");
    await env.notifier.settled();
    assert.deepEqual(
      env.sent.map((request) => request.endpoint),
      ["https://push.example.com/phone", "https://push.example.net/pc"],
    );
    const [toPhone, toPc] = env.sent;
    assert.deepEqual(JSON.parse(decrypt(toPhone!.body, phone).toString()), { id: "r1", agent: "Iris", text: "終わりました" });
    assert.deepEqual(JSON.parse(decrypt(toPc!.body, pc).toString()), { id: "r1", agent: "Iris", text: "終わりました" });
    assert.equal(toPhone!.headers["content-encoding"], "aes128gcm");
    assert.ok(Number(toPhone!.headers.ttl) > 0);
    assert.match(toPhone!.headers.authorization!, /^vapid t=.+, k=/);
    // Each push service is named its own origin.
    const audience = (request: WebPushRequest) => JSON.parse(b64(/t=[^.]+\.([^.]+)\./.exec(request.headers.authorization!)![1]!).toString()).aud;
    assert.equal(audience(toPhone!), "https://push.example.com");
    assert.equal(audience(toPc!), "https://push.example.net");
  });

  it("sends nothing for what is not a reply", async (t) => {
    const env = await setup(t);
    env.subscriptions.save({ kind: "web-push", endpoint: "https://push.example.com/phone", ...browserKeys() });
    env.feed.publish({ event: "state", data: { agent: "main", state: "thinking" } });
    env.feed.publish({ event: "activity", data: { agent: "main", activity: { kind: "turn_start", at: "2026-11-16T09:00:00Z", turn_id: "t1" } } as never });
    await env.notifier.settled();
    assert.deepEqual(env.sent, []);
  });

  it("drops a subscription the push service says is gone, and keeps one that failed otherwise", async (t) => {
    const answers: Record<string, number> = {
      "https://push.example.com/gone": 410,
      "https://push.example.com/unknown": 404,
      "https://push.example.com/busy": 503,
      "https://push.example.com/ok": 201,
    };
    const env = await setup(t, async (request) => answers[request.endpoint]!);
    for (const endpoint of Object.keys(answers)) env.subscriptions.save({ kind: "web-push", endpoint, ...browserKeys() });
    env.reply("秘密の返事");
    await env.notifier.settled();
    assert.deepEqual(
      env.subscriptions.all().map((s) => s.endpoint),
      ["https://push.example.com/busy", "https://push.example.com/ok"],
    );
    // Sent once: the busy one is not tried again.
    env.reply("次の返事", "r2");
    await env.notifier.settled();
    assert.equal(env.sent.filter((request) => request.endpoint.endsWith("/busy")).length, 2);
    // The log names subscriptions and statuses, never the text or an endpoint.
    assert.ok(env.logs.some((line) => line.includes("410")));
    assert.ok(env.logs.some((line) => line.includes("503")));
    for (const line of env.logs) {
      assert.ok(!line.includes("秘密"), line);
      assert.ok(!line.includes("push.example.com"), line);
    }
  });

  it("does not let a push that cannot be sent touch the reply", async (t) => {
    const env = await setup(t, async () => {
      throw new Error("no route to https://push.example.com");
    });
    env.subscriptions.save({ kind: "web-push", endpoint: "https://push.example.com/phone", ...browserKeys() });
    assert.doesNotThrow(() => env.reply("返事"));
    await env.notifier.settled();
    assert.equal(env.subscriptions.all().length, 1);
    assert.equal(env.logs.length, 1);
    assert.ok(!env.logs[0]!.includes("push.example.com"), env.logs[0]);
  });

  it("fits a long reply in one record", async (t) => {
    const env = await setup(t);
    const keys = browserKeys();
    env.subscriptions.save({ kind: "web-push", endpoint: "https://push.example.com/phone", ...keys });
    // Characters that JSON writes six bytes each.
    env.reply("\u0001".repeat(5000));
    await env.notifier.settled();
    const plaintext = decrypt(env.sent[0]!.body, keys);
    assert.ok(plaintext.length <= 3993, `${plaintext.length} bytes`);
    assert.ok(env.sent[0]!.body.length <= 4096);
    assert.ok((JSON.parse(plaintext.toString()) as Notice).text.length > 0);
  });
});
