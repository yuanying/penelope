import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { ATTEMPT_TTL_MS, GitHubOAuth, refused } from "@penelope/github-oauth";

import type { HouseConfig } from "./config.ts";
import type { House } from "./house.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const random = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

type CookieName = "house_oauth" | "house_session";
type Settings = HouseConfig["auth"]["github"];

export class PeopleLogin {
  private readonly settings: Settings;
  private readonly oauth: GitHubOAuth<string>;
  private readonly house: House;
  private readonly now: () => number;
  private readonly secure: boolean;

  constructor(settings: Settings, house: House, now: () => number, request?: typeof fetch) {
    this.settings = settings;
    this.oauth = new GitHubOAuth({ settings, now, request });
    this.house = house;
    this.now = now;
    this.secure = settings?.origin.startsWith("https:") ?? false;
  }

  start(request: IncomingMessage) {
    const nonce = this.readCookie(request, "house_oauth") ?? random();
    const result = this.oauth.start(nonce);
    return result.kind === "refused" ? result : { ...result, cookie: this.cookie("house_oauth", nonce, ATTEMPT_TTL_MS) };
  }

  async callback(request: IncomingMessage, query: URLSearchParams) {
    const nonce = this.readCookie(request, "house_oauth");
    const result = await this.oauth.callback(query, (context) => context === nonce);
    if (result.kind === "refused") return result;
    const person = result.profile.login ? this.house.person(result.profile.login) : undefined;
    if (!person) return refused(403, "account-not-allowed");
    const rawAvatar = result.profile.avatarUrl;
    const url = rawAvatar && URL.parse(rawAvatar);
    const avatar = url && url.protocol === "https:" && !url.username && !url.password ? url.href : null;
    const now = this.now();
    const token = random();
    const session = { person, tokenHash: digest(token), expires: now + SESSION_TTL_MS };
    if (!this.house.createPersonSession(session, { id: result.profile.id, avatar }, now)) {
      return refused(403, "account-not-allowed");
    }
    return { kind: "signed-in" as const, cookie: this.cookie("house_session", token, SESSION_TTL_MS) };
  }

  session(request: IncomingMessage) {
    const token = this.readCookie(request, "house_session");
    return token ? this.house.personSession(digest(token), this.now()) : undefined;
  }

  logout(request: IncomingMessage) {
    if (!this.settings || request.headers.origin !== this.settings.origin) return refused(403, "wrong-origin");
    const token = this.readCookie(request, "house_session");
    const tokenHash = token ? digest(token) : undefined;
    if (tokenHash) this.house.revokePersonSession(tokenHash);
    return { kind: "signed-out" as const, tokenHash, cookie: this.cookie("house_session", "", 0) };
  }

  private cookie(name: CookieName, value: string, maxAge: number): string {
    const sameSite = name === "house_oauth" ? "Lax" : "Strict";
    return `${this.cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge / 1000}${this.secure ? "; Secure" : ""}`;
  }

  private cookieName(name: CookieName): string {
    return this.secure ? `__Host-${name}` : name;
  }

  private readCookie(request: IncomingMessage, name: CookieName): string | undefined {
    const prefix = `${this.cookieName(name)}=`;
    const matches = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(prefix));
    const value = matches.length === 1 ? matches[0]!.slice(prefix.length) : undefined;
    return value && TOKEN.test(value) ? value : undefined;
  }
}
