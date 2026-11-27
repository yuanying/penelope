import { createCipheriv, createECDH, hkdfSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { type ClientHttp2Session, connect, constants, sensitiveHeaders } from "node:http2";

import type { ApnsEnvironment, ApnsReplyPayload, ApnsReplyPreview, Notice } from "@penelope/contract";

import type { ApnsTarget } from "./apns-registrations.ts";
import type { Channel, Delivery } from "./notifier.ts";

const ORIGINS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
const TOPIC = "io.github.yuanying.penelope.phone";
const JWT_LIFETIME_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PAYLOAD_MAX_BYTES = 4096;

export type ApnsSettings = { key: KeyObject; keyId: string; teamId: string };
export type ApnsRequest = { environment: ApnsEnvironment; token: string; body: string };
export type ApnsResponse = { status: number; reason?: string };

/** Sends each alert once. Keep one HTTP/2 connection per APNs environment. */
export class ApnsClient {
  private readonly sessions = new Map<ApnsEnvironment, ClientHttp2Session>();
  private token?: { jwt: string; issuedAt: number };

  private readonly settings: ApnsSettings;
  private readonly now: () => number;
  private readonly origins: Record<ApnsEnvironment, string>;

  constructor(settings: ApnsSettings, now: () => number, origins = ORIGINS) {
    this.settings = settings;
    this.now = now;
    this.origins = origins;
  }

  send({ environment, token, body }: ApnsRequest): Promise<ApnsResponse> {
    return new Promise((resolve, reject) => {
      const stream = this.session(environment).request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${this.jwt()}`,
        [sensitiveHeaders]: ["authorization", ":path"],
        "apns-topic": TOPIC,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
      });
      const timer = setTimeout(() => {
        reject(new Error("APNs request timed out"));
        stream.close(constants.NGHTTP2_CANCEL);
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      let status = 0;
      let text = "";
      stream.setEncoding("utf8");
      stream.on("response", (headers) => { status = Number(headers[":status"]); });
      stream.on("data", (chunk: string) => {
        if (text.length + chunk.length <= 1024) text += chunk;
        else stream.close(constants.NGHTTP2_CANCEL);
      });
      stream.once("error", reject);
      stream.once("end", () => {
        if (!status) return;
        let reason: unknown;
        try { reason = JSON.parse(text)?.reason; } catch { /* Successful responses have no body. */ }
        resolve(typeof reason === "string" ? { status, reason } : { status });
      });
      stream.once("close", () => {
        clearTimeout(timer);
        reject(new Error("APNs stream closed"));
      });
      stream.end(body);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.destroy();
    this.sessions.clear();
  }

  private jwt(): string {
    const now = this.now();
    if (!this.token || now - this.token.issuedAt >= JWT_LIFETIME_MS) {
      const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const { key, keyId, teamId } = this.settings;
      const claims = `${encode({ alg: "ES256", kid: keyId })}.${encode({ iss: teamId, iat: Math.floor(now / 1000) })}`;
      const signature = sign("sha256", Buffer.from(claims), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
      this.token = { jwt: `${claims}.${signature}`, issuedAt: now };
    }
    return this.token.jwt;
  }

  private session(environment: ApnsEnvironment): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(this.origins[environment]);
    session.on("error", () => session.destroy());
    session.once("close", () => {
      if (this.sessions.get(environment) === session) this.sessions.delete(environment);
    });
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }
}

export class ApnsChannel implements Channel<ApnsTarget> {
  private readonly url: string;
  private readonly send: (request: ApnsRequest) => Promise<ApnsResponse>;

  constructor(url: string, send: (request: ApnsRequest) => Promise<ApnsResponse>) {
    this.url = url;
    this.send = send;
  }

  async deliver({ token, environment, publicKey }: ApnsTarget, notice: Notice): Promise<Delivery> {
    const body = alertOf(notice, this.url, publicKey);
    const { status, reason } = await this.send({ token, environment, body });
    if (status === 200) return { kind: "sent", status };
    if (status === 410 || (status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"))) return { kind: "gone", status };
    return { kind: "failed", status };
  }
}

function alertOf(notice: Notice, url: string, publicKey: Buffer): string {
  const { id: messageId, agent, text, expression, images } = notice;
  const aps = { alert: { title: agent, body: "返事があります" }, "mutable-content": 1, sound: "default" } as const;
  const characters = Array.from(text);
  for (let length = characters.length; ; length = Math.floor(length / 2)) {
    const preview = length === characters.length ? text : length === 0 ? "" : `${characters.slice(0, length).join("")}…`;
    const plaintext = JSON.stringify({ text: preview, ...(expression === undefined ? {} : { expression }), ...(images === undefined ? {} : { images }), url } satisfies ApnsReplyPreview);
    const e = seal(publicKey, messageId, plaintext);
    const body = JSON.stringify({ aps, messageId, kind: "reply", e } satisfies ApnsReplyPayload);
    if (Buffer.byteLength(body) <= PAYLOAD_MAX_BYTES) return body;
    if (length === 0) throw new Error("APNs alert metadata exceeds its payload limit");
  }
}

/** The natsumi v1 envelope: X9.63 salt, message ID as AAD, and the tag appended to the ciphertext. */
function seal(publicKey: Buffer, messageId: string, plaintext: string): ApnsReplyPayload["e"] {
  const ephemeral = createECDH("prime256v1");
  const epk = ephemeral.generateKeys();
  const salt = Buffer.concat([epk, publicKey]);
  const key = Buffer.from(hkdfSync("sha256", ephemeral.computeSecret(publicKey), salt, "natsumi-push-v1", 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(messageId, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, epk: epk.toString("base64"), nonce: nonce.toString("base64"), ct: ct.toString("base64") };
}
