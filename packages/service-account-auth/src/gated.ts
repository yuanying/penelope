// The `gated-assertion` check (ADR-0018, docs/a2a.md). gated, the cluster's
// gate in front of the Ingress, takes a ServiceAccount token of its own
// audience off the call and puts in its place a `Gated-Assertion` that it
// signs, naming the ServiceAccount. This checks that assertion as the agents of
// fraction-agents do (their ADR 0021 and 0030); the subject is then the
// allow-list's to judge. The algorithm is fixed to EdDSA (Ed25519), so Node's
// own crypto is enough.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type http from "node:http";

import type { SenderCheck, Verdict } from "./senders.ts";

export const ASSERTION_HEADER = "gated-assertion";

const ALGORITHM = "EdDSA";
const TYPE = "gated-assertion+jwt";
const CLOCK_SKEW_MS = 30_000;
/** The keys are fetched again after at most this long, whatever the answer says. */
const MAX_CACHE_MS = 300_000;
/** An unknown key fetches the keys again only when the last fetch is at least this old. */
const REFETCH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export type GatedSettings = {
  /** gated's issuer, compared with `iss`. */
  issuer: string;
  /** Where gated publishes its keys. Never taken from an assertion. */
  jwksUrl: string;
  /** The service's public host name, compared with `aud`: never the call's `Host`. */
  audience: string;
  now?: () => number;
  log?: (line: string) => void;
};

export class GatedAssertion implements SenderCheck {
  readonly name = "gated-assertion";
  /** gated puts its assertion in place of the token it took: when there is one, it decides. */
  readonly precedence = 0;
  private readonly settings: GatedSettings;
  private readonly now: () => number;
  private keys = new Map<string, KeyObject>();
  private fetchedAt: number | undefined;
  private expiresAt = 0;
  private fetching: Promise<void> | undefined;

  constructor(settings: GatedSettings) {
    this.settings = settings;
    this.now = settings.now ?? Date.now;
  }

  carries(headers: http.IncomingHttpHeaders): boolean {
    return headers[ASSERTION_HEADER] !== undefined;
  }

  async check(headers: http.IncomingHttpHeaders): Promise<Verdict> {
    const refuse = (reason: string): Verdict => ({ kind: "refused", reason });
    const assertion = headers[ASSERTION_HEADER];
    if (typeof assertion !== "string" || assertion === "") return refuse("no assertion");
    const parts = assertion.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return refuse("not a compact JWS");
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJson(encodedHeader);
    const payload = decodeJson(encodedPayload);
    if (!header || !payload) return refuse("not a compact JWS");
    if (header.alg !== ALGORITHM) return refuse(`the algorithm is not ${ALGORITHM}`);
    if (header.typ !== TYPE) return refuse(`the type is not ${TYPE}`);
    if (typeof header.kid !== "string" || header.kid === "") return refuse("no key ID");
    const key = await this.key(header.kid);
    if (!key) return refuse(`the key ${JSON.stringify(header.kid)} is not gated's`);
    const signature = Buffer.from(encodedSignature, "base64url");
    // Only the one encoding of a 64-byte signature: decoding alone would let trailing characters through.
    if (
      signature.length !== 64 ||
      signature.toString("base64url") !== encodedSignature ||
      !verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), key, signature)
    ) {
      return refuse("bad signature");
    }
    if (payload.iss !== this.settings.issuer) return refuse("another issuer");
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.settings.audience)) return refuse("for another host");
    const now = this.now();
    if (typeof payload.exp !== "number" || payload.exp * 1000 + CLOCK_SKEW_MS < now) return refuse("expired");
    if (typeof payload.iat !== "number" || payload.iat * 1000 - CLOCK_SKEW_MS > now) return refuse("issued in the future");
    if (typeof payload.sub !== "string") return refuse("no subject");
    return { kind: "subject", subject: payload.sub };
  }

  /**
   * The public key of the ID. The keys are fetched when the cache has run out,
   * and once more for an unknown ID when the last fetch is a minute old. When
   * they cannot be fetched, the cached ones go on being used.
   */
  private async key(kid: string): Promise<KeyObject | undefined> {
    const now = this.now();
    if (this.fetchedAt === undefined || now >= this.expiresAt) await this.refresh();
    else if (!this.keys.has(kid) && now - this.fetchedAt >= REFETCH_INTERVAL_MS) await this.refresh();
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.fetching ??= this.fetchKeys().finally(() => (this.fetching = undefined));
    return this.fetching;
  }

  private async fetchKeys(): Promise<void> {
    const startedAt = this.now();
    try {
      const response = await fetch(this.settings.jwksUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { keys?: unknown };
      if (!Array.isArray(body.keys)) throw new Error("no keys");
      const keys = new Map<string, KeyObject>();
      for (const jwk of body.keys) {
        const key = publicKey(jwk);
        if (key) keys.set(key.kid, key.key);
      }
      this.keys = keys;
      this.expiresAt = startedAt + Math.min(maxAge(response.headers.get("cache-control")) ?? MAX_CACHE_MS, MAX_CACHE_MS);
    } catch (error) {
      this.settings.log?.(`gated's keys could not be fetched from ${this.settings.jwksUrl}: ${error instanceof Error ? error.message : String(error)}`);
      // The cached keys stay, and the fetch is tried again a minute later, not on every call meanwhile.
      this.expiresAt = startedAt + REFETCH_INTERVAL_MS;
    } finally {
      this.fetchedAt = startedAt;
    }
  }
}

/** The audience gated asserts for: the host name of the public URL, in lower case, without the port. */
export function audienceOf(publicUrl: string): string {
  return new URL(publicUrl).hostname.toLowerCase();
}

function decodeJson(part: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** An Ed25519 key of the JWKS, with its ID. Keys of other types are left out. */
function publicKey(jwk: unknown): { kid: string; key: KeyObject } | undefined {
  if (typeof jwk !== "object" || jwk === null) return undefined;
  const { kty, crv, x, kid } = jwk as Record<string, unknown>;
  if (kty !== "OKP" || crv !== "Ed25519" || typeof x !== "string" || typeof kid !== "string") return undefined;
  try {
    return { kid, key: createPublicKey({ key: { kty, crv, x }, format: "jwk" }) };
  } catch {
    return undefined;
  }
}

function maxAge(cacheControl: string | null): number | undefined {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? "");
  return match ? Number(match[1]) * 1000 : undefined;
}
