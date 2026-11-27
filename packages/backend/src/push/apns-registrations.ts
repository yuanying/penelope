import { ECDH } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ApnsEnvironment } from "@penelope/contract";

type Registration = { token: string; environment: ApnsEnvironment; publicKey: Buffer };
export type ApnsTarget = Registration & { id: number };

/** A hex device token and a standard-base64, uncompressed X9.63 public key on P-256. */
export function apnsRegistrationOf(value: unknown): Registration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { token, environment, public_key } = value as Record<string, unknown>;
  // Apple does not promise a fixed token size. Accept whole bytes with a generous upper bound.
  if (typeof token !== "string" || token.length < 2 || token.length > 512 || token.length % 2 !== 0 || /[^0-9a-f]/i.test(token)) return undefined;
  if (environment !== "sandbox" && environment !== "production") return undefined;
  if (typeof public_key !== "string" || !/^[A-Za-z0-9+/]{87}=$/.test(public_key)) return undefined;
  const publicKey = Buffer.from(public_key, "base64");
  if (publicKey.length !== 65 || publicKey[0] !== 4 || publicKey.toString("base64") !== public_key) return undefined;
  try {
    ECDH.convertKey(publicKey, "prime256v1");
  } catch {
    return undefined;
  }
  return { token: token.toLowerCase(), environment, publicKey };
}

export class ApnsRegistrations {
  private readonly db: DatabaseSync;
  private readonly options: { now: () => number; ownerId: number | undefined };

  constructor(db: DatabaseSync, options: { now: () => number; ownerId: number | undefined }) {
    this.db = db;
    this.options = options;
  }

  /** One registration per app device and per APNs address. Re-enrolling takes over that address. */
  save(deviceId: string, registration: Registration): void {
    this.db.prepare("INSERT OR REPLACE INTO apns_registrations (device_id, token, environment, public_key) VALUES (?, ?, ?, ?)")
      .run(deviceId, registration.token, registration.environment, registration.publicKey);
  }

  remove(deviceId: string): void {
    this.db.prepare("DELETE FROM apns_registrations WHERE device_id = ?").run(deviceId);
  }

  /** A stale response must not remove even an identical registration made after the request started. */
  removeIfSame(target: ApnsTarget): boolean {
    return Number(this.db.prepare("DELETE FROM apns_registrations WHERE id = ?").run(target.id).changes) > 0;
  }

  all(): ApnsTarget[] {
    const { now, ownerId } = this.options;
    if (ownerId === undefined) return [];
    const rows = this.db.prepare(`SELECT r.id, r.token, r.environment, r.public_key FROM apns_registrations r
      JOIN app_devices d ON r.device_id = d.id WHERE d.github_user_id = ? AND d.expires_ms > ? ORDER BY r.id`)
      .all(ownerId, now()) as { id: number; token: string; environment: ApnsEnvironment; public_key: Uint8Array }[];
    return rows.map(({ id, token, environment, public_key }) => ({ id, token, environment, publicKey: Buffer.from(public_key) }));
  }
}
