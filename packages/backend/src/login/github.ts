// The owner's login through GitHub OAuth (ADR-0010, ADR-0064). It
// follows natsumi's: a one-time state and a PKCE verifier of the backend's
// own per attempt, the account matched by its numeric user ID, and GitHub's
// access token used once to read that ID and never kept.
import { createHash, randomBytes } from "node:crypto";

import type { LoginSessions, Session } from "./sessions.ts";

export type GitHubEndpoints = { authorizeUrl: string; tokenUrl: string; userUrl: string };

export const GITHUB_ENDPOINTS: GitHubEndpoints = {
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userUrl: "https://api.github.com/user",
};

export const CALLBACK_PATH = "/auth/github/callback";

/** The OAuth App and the one account let in. */
export type GitHubSettings = { clientId: string; clientSecret: string; ownerId: number; callbackUrl: string };

export const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 64;
const UPSTREAM_TIMEOUT_MS = 10_000;

export type Start = { kind: "redirect"; location: string } | Refused;
export type Finish = { kind: "signed-in"; session: Session } | { kind: "app-login"; userId: number; challenge: string } | Refused;
export type Refused = { kind: "refused"; status: number; code: string };

const random = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const refused = (status: number, code: string): Refused => ({ kind: "refused", status, code });

export class GitHubLogin {
  /** Attempts in flight, by the hash of their state. In memory: a restart drops them. */
  private readonly attempts = new Map<string, { verifier: string; expiresMs: number; appChallenge: string | undefined }>();
  private readonly settings: GitHubSettings | undefined;
  private readonly endpoints: GitHubEndpoints;
  private readonly sessions: LoginSessions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: {
    settings: GitHubSettings | undefined;
    endpoints?: GitHubEndpoints;
    sessions: LoginSessions;
    now: () => number;
    log?: (line: string) => void;
  }) {
    this.settings = options.settings;
    this.endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
    this.sessions = options.sessions;
    this.now = options.now;
    this.log = options.log ?? console.error;
  }

  start(appChallenge?: string): Start {
    const settings = this.settings;
    if (!settings) return refused(503, "login-not-configured");
    const now = this.now();
    for (const [key, attempt] of this.attempts) if (attempt.expiresMs <= now) this.attempts.delete(key);
    if (this.attempts.size >= MAX_ATTEMPTS) return refused(429, "too-many-logins");
    const state = random();
    const verifier = random();
    this.attempts.set(digest(state), { verifier, expiresMs: now + ATTEMPT_TTL_MS, appChallenge });
    const url = new URL(this.endpoints.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: settings.clientId,
      redirect_uri: settings.callbackUrl,
      state,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      allow_signup: "false",
    }).toString();
    return { kind: "redirect", location: url.href };
  }

  async callback(query: URLSearchParams): Promise<Finish> {
    const outcome = await this.finish(query);
    if (outcome.kind === "refused") this.log(`login refused: ${outcome.code}`);
    else this.log("login: the owner signed in");
    return outcome;
  }

  private async finish(query: URLSearchParams): Promise<Finish> {
    const settings = this.settings;
    if (!settings) return refused(503, "login-not-configured");
    const state = query.get("state");
    const key = state === null ? undefined : digest(state);
    const attempt = key === undefined ? undefined : this.attempts.get(key);
    if (key === undefined || !attempt) return refused(400, "invalid-state");
    this.attempts.delete(key); // One use, whatever happens next.
    if (attempt.expiresMs <= this.now()) return refused(400, "login-expired");
    if (query.has("error")) return refused(403, "github-denied");
    const code = query.get("code");
    if (!code) return refused(400, "invalid-request");

    const exchanged = await this.exchange(settings, code, attempt.verifier);
    if (exchanged === "rejected") return refused(502, "github-exchange-failed");
    if (exchanged === "unavailable") return refused(502, "github-unavailable");
    const userId = await this.userId(exchanged);
    if (userId === undefined) return refused(502, "github-unavailable");
    if (userId !== settings.ownerId) return refused(403, "account-not-allowed");
    if (attempt.appChallenge !== undefined) return { kind: "app-login", userId, challenge: attempt.appChallenge };
    return { kind: "signed-in", session: this.sessions.create(userId) };
  }

  /** GitHub's access token, or why there is none. Nothing of GitHub's answer is logged. */
  private async exchange(settings: GitHubSettings, code: string, verifier: string): Promise<string | "rejected" | "unavailable"> {
    try {
      const response = await fetch(this.endpoints.tokenUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "penelope" },
        body: new URLSearchParams({
          client_id: settings.clientId,
          client_secret: settings.clientSecret,
          code,
          redirect_uri: settings.callbackUrl,
          code_verifier: verifier,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return "unavailable";
      }
      const { access_token } = (await response.json()) as { access_token?: unknown };
      // GitHub answers a bad code or verifier with 200 and an `error` field.
      return typeof access_token === "string" && access_token !== "" ? access_token : "rejected";
    } catch {
      return "unavailable";
    }
  }

  private async userId(accessToken: string): Promise<number | undefined> {
    try {
      const response = await fetch(this.endpoints.userUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${accessToken}`,
          "user-agent": "penelope",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const { id } = (await response.json()) as { id?: unknown };
      return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }
}
