import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { ATTEMPT_TTL_MS, GitHubOAuth, refused } from "@penelope/github-oauth";

import type { HouseConfig, Person } from "./config.ts";
import type { House } from "./house.ts";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const random = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export type PersonSession = { person: Person; expires: number };

type Settings = HouseConfig["auth"]["github"];

export class PeopleLogin {
  private readonly settings: Settings;
  private readonly oauth: GitHubOAuth<string>;
  private readonly house: House;
  private readonly now: () => number;
  private readonly sessions = new Map<string, PersonSession>();
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
    const avatar = rawAvatar && URL.parse(rawAvatar);
    this.house.setAvatar(person, avatar && avatar.protocol === "https:" && !avatar.username && !avatar.password ? avatar.href : null);
    const now = this.now();
    for (const [key, session] of this.sessions) if (session.expires <= now) this.sessions.delete(key);
    const token = random();
    this.sessions.set(digest(token), { person, expires: now + SESSION_TTL_MS });
    return { kind: "signed-in" as const, cookie: this.cookie("house_session", token, SESSION_TTL_MS) };
  }

  session(request: IncomingMessage): PersonSession | undefined {
    const token = this.readCookie(request, "house_session");
    const session = token ? this.sessions.get(digest(token)) : undefined;
    return session && session.expires > this.now() ? session : undefined;
  }

  logout(request: IncomingMessage) {
    if (!this.settings || request.headers.origin !== this.settings.origin) return refused(403, "wrong-origin");
    const token = this.readCookie(request, "house_session");
    const key = token ? digest(token) : undefined;
    const session = key ? this.sessions.get(key) : undefined;
    if (key) this.sessions.delete(key);
    return { kind: "signed-out" as const, session, cookie: this.cookie("house_session", "", 0) };
  }

  private cookie(name: string, value: string, maxAge: number): string {
    return `${this.cookieName(name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge / 1000}${this.secure ? "; Secure" : ""}`;
  }

  private cookieName(name: string): string {
    return this.secure ? `__Host-${name}` : name;
  }

  private readCookie(request: IncomingMessage, name: string): string | undefined {
    const prefix = `${this.cookieName(name)}=`;
    const matches = (request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(prefix));
    const value = matches.length === 1 ? matches[0]!.slice(prefix.length) : undefined;
    return value && TOKEN.test(value) ? value : undefined;
  }
}
