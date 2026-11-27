import { createHash, randomBytes } from "node:crypto";

export type GitHubEndpoints = { authorizeUrl: string; tokenUrl: string; userUrl: string };

export const GITHUB_ENDPOINTS: GitHubEndpoints = {
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userUrl: "https://api.github.com/user",
};

export const CALLBACK_PATH = "/auth/github/callback";

export type GitHubOAuthSettings = { clientId: string; clientSecret: string; callbackUrl: string };

export const ATTEMPT_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 64;
const UPSTREAM_TIMEOUT_MS = 10_000;

export type Start = { kind: "redirect"; location: string } | Refused;
export type GitHubProfile = { id: number; login?: string; avatarUrl?: string };
type Finish<T> = { kind: "authenticated"; profile: GitHubProfile; context: T } | Refused;
export type Refused = { kind: "refused"; status: number; code: string };

const random = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
export const refused = (status: number, code: string): Refused => ({ kind: "refused", status, code });

export class GitHubOAuth<T> {
  private readonly attempts = new Map<string, { verifier: string; expiresMs: number; context: T }>();
  private readonly settings: GitHubOAuthSettings | undefined;
  private readonly endpoints: GitHubEndpoints;
  private readonly now: () => number;
  private readonly request: typeof fetch;

  constructor(options: {
    settings: GitHubOAuthSettings | undefined;
    endpoints?: GitHubEndpoints;
    now: () => number;
    request?: typeof fetch;
  }) {
    this.settings = options.settings;
    this.endpoints = options.endpoints ?? GITHUB_ENDPOINTS;
    this.now = options.now;
    this.request = options.request ?? fetch;
  }

  start(context: T): Start {
    const settings = this.settings;
    if (!settings) return refused(503, "login-not-configured");
    const now = this.now();
    for (const [key, attempt] of this.attempts) if (attempt.expiresMs <= now) this.attempts.delete(key);
    if (this.attempts.size >= MAX_ATTEMPTS) return refused(429, "too-many-logins");
    const state = random();
    const verifier = random();
    this.attempts.set(digest(state), { verifier, expiresMs: now + ATTEMPT_TTL_MS, context });
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

  async callback(query: URLSearchParams, matches = (_context: T) => true): Promise<Finish<T>> {
    const settings = this.settings;
    if (!settings) return refused(503, "login-not-configured");
    const state = query.get("state");
    const key = state === null ? undefined : digest(state);
    const attempt = key === undefined ? undefined : this.attempts.get(key);
    if (key === undefined || !attempt || !matches(attempt.context)) return refused(400, "invalid-state");
    this.attempts.delete(key);
    if (attempt.expiresMs <= this.now()) return refused(400, "login-expired");
    if (query.has("error")) return refused(403, "github-denied");
    const code = query.get("code");
    if (!code) return refused(400, "invalid-request");

    const exchanged = await this.exchange(settings, code, attempt.verifier);
    if (exchanged === "rejected") return refused(502, "github-exchange-failed");
    if (exchanged === "unavailable") return refused(502, "github-unavailable");
    const profile = await this.profile(exchanged);
    if (!profile) return refused(502, "github-unavailable");
    return { kind: "authenticated", profile, context: attempt.context };
  }

  private async exchange(settings: GitHubOAuthSettings, code: string, verifier: string): Promise<string | "rejected" | "unavailable"> {
    try {
      const response = await this.request(this.endpoints.tokenUrl, {
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
      return typeof access_token === "string" && access_token !== "" ? access_token : "rejected";
    } catch {
      return "unavailable";
    }
  }

  private async profile(accessToken: string): Promise<GitHubProfile | undefined> {
    try {
      const response = await this.request(this.endpoints.userUrl, {
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
      const { id, login, avatar_url } = (await response.json()) as { id?: unknown; login?: unknown; avatar_url?: unknown };
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return;
      return { id, login: typeof login === "string" ? login : undefined, avatarUrl: typeof avatar_url === "string" ? avatar_url : undefined };
    } catch {
      return undefined;
    }
  }
}
