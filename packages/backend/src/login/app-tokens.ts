// The iPhone's one-use login codes and device credentials (ADR-0064).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { AppDevice, AppTokenRequest, AppTokenResponse } from "@penelope/contract";

import { iso } from "../time.ts";
import { TOKEN } from "./sessions.ts";

const CODE_TTL_MS = 5 * 60_000;
const DEVICE_TTL_MS = 365 * 24 * 60 * 60_000;
const MAX_CODES = 64;
const random = () => randomBytes(32).toString("base64url");
const hash = (secret: string) => createHash("sha256").update(secret);

export function appChallengeOf(query: URLSearchParams): string | undefined {
  if (query.getAll("code_challenge_method").length !== 1 || query.get("code_challenge_method") !== "S256") return undefined;
  const [challenge, duplicate] = query.getAll("code_challenge");
  return duplicate === undefined && challenge !== undefined && TOKEN.test(challenge) ? challenge : undefined;
}

export function appTokenRequestOf(body: unknown): AppTokenRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { code, code_verifier, device_name } = body as Record<string, unknown>;
  if (typeof code !== "string" || !TOKEN.test(code)) return undefined;
  if (typeof code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier)) return undefined;
  if (typeof device_name !== "string" || /\p{Cc}/u.test(device_name)) return undefined;
  const name = device_name.trim();
  if (name.length === 0 || [...name].length > 100) return undefined;
  return { code, code_verifier, device_name: name };
}

export class AppTokens {
  private readonly codes = new Map<string, { challenge: string; userId: number; expiresMs: number }>();
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, { now }: { now: () => number }) {
    this.db = db;
    this.now = now;
  }

  /** A restart invalidates codes, but not exchanged device credentials. */
  issueCode(userId: number, challenge: string): string | undefined {
    const now = this.now();
    for (const [key, entry] of this.codes) if (entry.expiresMs <= now) this.codes.delete(key);
    if (this.codes.size >= MAX_CODES) return undefined;
    const code = random();
    this.codes.set(hash(code).digest("hex"), { userId, challenge, expiresMs: now + CODE_TTL_MS });
    return code;
  }

  exchange(request: AppTokenRequest, ownerId: number | undefined): AppTokenResponse | undefined {
    const key = hash(request.code).digest("hex");
    const entry = this.codes.get(key);
    const now = this.now();
    if (!entry || entry.userId !== ownerId || entry.expiresMs <= now || entry.challenge !== hash(request.code_verifier).digest("base64url")) return undefined;
    // No await between checking and consuming the code: at most one exchange wins.
    this.codes.delete(key);
    const token = random();
    const expiresMs = now + DEVICE_TTL_MS;
    this.db.prepare("DELETE FROM app_devices WHERE expires_ms <= ?").run(now);
    this.db.prepare("INSERT INTO app_devices (id, name, token_hash, github_user_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), request.device_name, hash(token).digest("hex"), entry.userId, now, expiresMs);
    return { token, expires_at: iso(expiresMs) };
  }

  /** The device ID of a live token, for this owner only. */
  authenticate(token: string, ownerId: number | undefined): string | undefined {
    if (ownerId === undefined || !TOKEN.test(token)) return undefined;
    const device = this.db.prepare("SELECT id FROM app_devices WHERE token_hash = ? AND github_user_id = ? AND expires_ms > ?")
      .get(hash(token).digest("hex"), ownerId, this.now()) as { id: string } | undefined;
    return device?.id;
  }

  list(ownerId: number): AppDevice[] {
    const rows = this.db.prepare("SELECT id, name, created_ms, expires_ms FROM app_devices WHERE github_user_id = ? AND expires_ms > ? ORDER BY created_ms DESC, id")
      .all(ownerId, this.now()) as { id: string; name: string; created_ms: number; expires_ms: number }[];
    return rows.map((row) => ({ id: row.id, name: row.name, created_at: iso(row.created_ms), expires_at: iso(row.expires_ms) }));
  }

  revoke(id: string, ownerId: number): void {
    this.db.prepare("DELETE FROM app_devices WHERE id = ? AND github_user_id = ?").run(id, ownerId);
  }
}
