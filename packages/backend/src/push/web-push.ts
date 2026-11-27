// Web Push (ADR-0027): the body encrypted to the browser's subscription with
// aes128gcm (RFC 8291) and the backend named by its VAPID key (RFC 8292),
// written with node:crypto rather than taken as a dependency. The backend
// posts to the push service itself, not through the Sentinel.
import { createCipheriv, createECDH, createPrivateKey, createPublicKey, ECDH, hkdfSync, type KeyObject, randomBytes, sign } from "node:crypto";

import type { Notice } from "@penelope/contract";

import type { Channel, Delivery, StoredSubscription } from "./notifier.ts";

/** One record of rs 4096 holds this much: 4096 less the header (86), the tag (16) and the delimiter (1). */
export const WEB_PUSH_PLAINTEXT_MAX_BYTES = 3993;
const RECORD_SIZE = 4096;
const CURVE = "prime256v1";
/** How long a push service keeps a push for a browser that is away. */
const TTL_SECONDS = 24 * 3600;
const REQUEST_TIMEOUT_MS = 30_000;
const ENDPOINT_MAX_LENGTH = 2048;

export type VapidKey = { key: KeyObject; /** The public key as the browser takes it: uncompressed P-256, base64url. */ publicKey: string };

/** The deployment's VAPID key, from its PEM. Throws unless it is a P-256 private key. */
export function vapidKeyOf(pem: string): VapidKey {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error("the VAPID key is not a private key in PEM");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== CURVE) throw new Error("the VAPID key is not a P-256 key");
  const { x, y } = createPublicKey(key).export({ format: "jwk" });
  return { key, publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(x!, "base64url"), Buffer.from(y!, "base64url")]).toString("base64url") };
}

/** The `Authorization` of a push (RFC 8292): an ES256 JWT for the push service's origin, good for 12 hours, and the public key. */
export function vapidAuthorization({ vapid, endpoint, subject, now }: { vapid: VapidKey; endpoint: string; subject: string; now: number }): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode(claims)}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: vapid.key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${vapid.publicKey}`;
}

/**
 * The body of a push (RFC 8291): one aes128gcm record (RFC 8188) keyed by
 * ECDH with a key pair made for this push alone and the subscription's auth
 * secret. The fixed key and salt are for the RFC's example only.
 */
export function encryptWebPush(input: { p256dh: Buffer; auth: Buffer; plaintext: Buffer; serverPrivateKey?: Buffer; salt?: Buffer }): Buffer {
  const server = createECDH(CURVE);
  if (input.serverPrivateKey) server.setPrivateKey(input.serverPrivateKey);
  else server.generateKeys();
  const serverPublicKey = server.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), input.p256dh, serverPublicKey]);
  const ikm = Buffer.from(hkdfSync("sha256", server.computeSecret(input.p256dh), input.auth, keyInfo, 32));
  const salt = input.salt ?? randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([input.plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = serverPublicKey.length;
  return Buffer.concat([header, serverPublicKey, record]);
}

/** A browser's subscription: an https endpoint, its P-256 key and its 16-byte auth secret. */
export type WebPushSubscription = { endpoint: string; p256dh: Buffer; auth: Buffer };

/** The body of `POST /api/push/subscriptions` for Web Push, checked, or undefined. */
export function webPushSubscriptionOf(value: unknown): WebPushSubscription | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { kind, endpoint, keys } = value as { kind?: unknown; endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (kind !== "web-push" || typeof endpoint !== "string" || endpoint.length > ENDPOINT_MAX_LENGTH) return undefined;
  if (!URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:") return undefined;
  const p256dh = base64url(keys?.p256dh);
  const auth = base64url(keys?.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 0x04 || !auth || auth.length !== 16) return undefined;
  try {
    ECDH.convertKey(p256dh, CURVE);
  } catch {
    return undefined;
  }
  return { endpoint, p256dh, auth };
}

function base64url(value: unknown): Buffer | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(value) ? Buffer.from(value, "base64url") : undefined;
}

/** One push as it goes to the push service. */
export type WebPushRequest = { endpoint: string; headers: Record<string, string>; body: Buffer };

/** Sends a notice to one browser's push service, once. */
export class WebPushChannel implements Channel<StoredSubscription> {
  private readonly vapid: VapidKey;
  private readonly subject: string;
  private readonly now: () => number;
  private readonly send: (request: WebPushRequest) => Promise<number>;

  constructor({ vapid, subject, now, send = post }: { vapid: VapidKey; subject: string; now: () => number; send?: (request: WebPushRequest) => Promise<number> }) {
    this.vapid = vapid;
    this.subject = subject;
    this.now = now;
    this.send = send;
  }

  maxBytes = WEB_PUSH_PLAINTEXT_MAX_BYTES;

  async deliver(target: StoredSubscription, notice: Notice): Promise<Delivery> {
    const plaintext = Buffer.from(JSON.stringify(notice));
    const status = await this.send({
      endpoint: target.endpoint,
      headers: {
        authorization: vapidAuthorization({ vapid: this.vapid, endpoint: target.endpoint, subject: this.subject, now: this.now() }),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(TTL_SECONDS),
        urgency: "high",
      },
      body: encryptWebPush({ p256dh: target.p256dh, auth: target.auth, plaintext }),
    });
    if (status === 404 || status === 410) return { kind: "gone", status };
    if (status >= 200 && status < 300) return { kind: "sent", status };
    return { kind: "failed", status };
  }
}

async function post(request: WebPushRequest): Promise<number> {
  // A push service answers where it is asked; a redirect is not followed.
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: new Uint8Array(request.body),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await response.body?.cancel();
  return response.status;
}
