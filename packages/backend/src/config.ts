// The backend's settings, from environment variables (docs/backend.md).
// Secrets are read from files, named by the variables, so that their values
// never sit in the environment.
import { createPrivateKey } from "node:crypto";
import path from "node:path";

import type { Delivery } from "@penelope/contract";
import { audienceOf, type KubernetesSettings } from "@penelope/service-account-auth";

import { CALLBACK_PATH, type GitHubSettings } from "./login/github.ts";
import { Senders } from "./a2a/senders.ts";
import type { ApnsSettings } from "./push/apns.ts";
import { vapidKeyOf } from "./push/web-push.ts";
import type { SleepLimits } from "./sleep.ts";

/** A setting that cannot be used. The backend does not start. */
export class ConfigError extends Error {}

export type Config = {
  databasePath: string;
  /** Where the copies of what the agents made are kept (ADR-0032). */
  assetsDir: string;
  sourcesDir: string;
  memoryDir: string;
  intakeSocket: string;
  sandboxSocket: string;
  listen: { host: string; port: number };
  publicUrl: string | undefined;
  sandboxToken: string | undefined;
  github: GitHubSettings | undefined;
  timeZone: string;
  sleep: SleepLimits & { reportTimeoutMs: number };
  batch: { quietMs: number; maxMs: number };
  redeliverMs: number;
  /** The heartbeat's quiet time (ADR-0031); none when it is off. */
  heartbeatMs: number | undefined;
  builtinDelivery: Record<"ui" | "cron" | "a2a" | "self" | "job", Delivery>;
  inline: Set<string>;
  gitAuthor: { name: string; email: string };
  memoryView?: { ownerEmail?: string; ownerName?: string; targetBytes?: number; fileLimitBytes?: number };
  avatar: AvatarSettings;
  /** Where the built Web UI is. */
  webDir: string;
  /** The A2A way in (docs/a2a.md); none when no sender is allowed. */
  a2a: A2ASettings | undefined;
  /** Web Push (ADR-0027): the VAPID private key in PEM and the subject it names; none without the key. */
  webPush: { vapidKey: string; subject: string } | undefined;
  /** APNs (ADR-0065): provider credentials and the HTTPS URL to open from the alert. */
  apns: (ApnsSettings & { url: string }) | undefined;
};

/** The A2A way in: who may send, how they are checked (one way or both), and the limits. */
export type A2ASettings = {
  /** The allow-list: ServiceAccounts as `<namespace>/<name>`. */
  senders: string[];
  gated: { issuer: string; jwksUrl: string; audience: string } | undefined;
  tokenReview: { kubernetes: KubernetesSettings; audiences: string[] } | undefined;
  /** The Agent Card's description. Its name is the agent's. */
  description: string;
  /** Where the senders call: the public URL's /a2a/. */
  url: string;
  limits: { deadlineMs: number; maxOpenTasks: number };
};

/** The ways a sender may be checked, by their names in PENELOPE_A2A_AUTH. */
export const A2A_CHECKS = ["gated-assertion", "tokenreview"] as const;
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * Who the agent is (ADR-0036). Her name is the deployment's when it gives one
 * (ADR-0001); else her avatar's. Her avatar is the one in /memory/avatar/:
 * when it is not there, the backend copies the avatar named `chosen` from the
 * first place of `from` that has it.
 */
export type AvatarSettings = { name: string | undefined; chosen: string | undefined; from: string[] };

/** Where the backend's image keeps the avatars of the repository (assets/avatars/). */
export const IMAGE_AVATARS_DIR = "/app/avatars";

type Env = Readonly<Record<string, string | undefined>>;

const MINUTE = 60_000;

export function loadConfig(env: Env, readFile: (file: string) => string, log = console.error): Config {
  const get = (name: string) => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const secret = (name: string) => {
    const file = get(name);
    if (file === undefined) return undefined;
    let value: string;
    try {
      value = readFile(file).trim();
    } catch (error) {
      throw new ConfigError(`${name}: ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (value === "") throw new ConfigError(`${name}: ${file} is empty`);
    return value;
  };
  const bytes = (name: string, fallback: number) => {
    const value = get(name);
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ConfigError(`${name} must be a positive integer`);
    return Number(value);
  };
  const minutes = (name: string, fallback: number) => {
    const value = get(name);
    if (value === undefined) return fallback * MINUTE;
    const ms = Number(value) * MINUTE;
    if (!/^\d+$/.test(value) || ms <= 0 || !Number.isSafeInteger(ms)) throw new ConfigError(`${name} must be a whole number of minutes above 0`);
    return ms;
  };
  // The heartbeat's quiet time, in minutes, or in seconds for the tests (e2e/README.md); never both.
  const heartbeatOf = () => {
    const inSeconds = get("PENELOPE_HEARTBEAT_SECONDS");
    if (inSeconds === undefined) return get("PENELOPE_HEARTBEAT_MINUTES") === undefined ? undefined : minutes("PENELOPE_HEARTBEAT_MINUTES", 0);
    if (get("PENELOPE_HEARTBEAT_MINUTES") !== undefined) throw new ConfigError("PENELOPE_HEARTBEAT_MINUTES and PENELOPE_HEARTBEAT_SECONDS are not both set");
    if (!/^\d+$/.test(inSeconds) || Number(inSeconds) <= 0) throw new ConfigError("PENELOPE_HEARTBEAT_SECONDS must be a whole number of seconds above 0");
    return Number(inSeconds) * 1_000;
  };
  const delivery = (name: string): Delivery => {
    const value = get(name) ?? "now";
    if (value !== "now" && value !== "batch") throw new ConfigError(`${name} must be now or batch`);
    return value;
  };

  const timeZone = get("PENELOPE_TIME_ZONE") ?? get("TZ") ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new ConfigError(`PENELOPE_TIME_ZONE: ${timeZone} is not a time zone`);
  }
  const threshold = get("PENELOPE_SLEEPINESS_LIMIT") ?? "90";
  if (!/^\d{1,2}$/.test(threshold)) throw new ConfigError("PENELOPE_SLEEPINESS_LIMIT must be an integer from 0 to 99");
  const maxMs = minutes("PENELOPE_SLEEP_MAX_MINUTES", 720);
  const defaultMs = minutes("PENELOPE_SLEEP_DEFAULT_MINUTES", 480);
  if (defaultMs > maxMs) throw new ConfigError("PENELOPE_SLEEP_DEFAULT_MINUTES must not exceed PENELOPE_SLEEP_MAX_MINUTES");

  let publicUrl = get("PENELOPE_PUBLIC_URL");
  if (publicUrl !== undefined) {
    if (!URL.canParse(publicUrl) || !/^https?:$/.test(new URL(publicUrl).protocol)) {
      throw new ConfigError("PENELOPE_PUBLIC_URL must be an http or https URL");
    }
    publicUrl = publicUrl.replace(/\/+$/, "");
  }

  const ownerText = get("PENELOPE_OWNER_GITHUB_ID");
  if (ownerText !== undefined && !/^[1-9]\d*$/.test(ownerText)) {
    throw new ConfigError("PENELOPE_OWNER_GITHUB_ID must be the owner's numeric GitHub user ID");
  }
  // The login is set up with all of these, or left off with none of them.
  const login = {
    PENELOPE_GITHUB_CLIENT_ID: get("PENELOPE_GITHUB_CLIENT_ID"),
    PENELOPE_GITHUB_CLIENT_SECRET_FILE: secret("PENELOPE_GITHUB_CLIENT_SECRET_FILE"),
    PENELOPE_OWNER_GITHUB_ID: ownerText,
  };
  let github: GitHubSettings | undefined;
  if (Object.values(login).some((value) => value !== undefined)) {
    const missing = Object.entries({ ...login, PENELOPE_PUBLIC_URL: publicUrl })
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    if (missing.length > 0) throw new ConfigError(`the GitHub login is half set up: ${missing.join(", ")} missing`);
    github = {
      clientId: login.PENELOPE_GITHUB_CLIENT_ID!,
      clientSecret: login.PENELOPE_GITHUB_CLIENT_SECRET_FILE!,
      ownerId: Number(ownerText),
      callbackUrl: `${publicUrl}${CALLBACK_PATH}`,
    };
  }

  const chosen = get("PENELOPE_AVATAR");
  if (chosen !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(chosen)) {
    throw new ConfigError("PENELOPE_AVATAR must be the name of a directory: lower-case letters, digits, ., _ and -");
  }
  const avatarsDir = get("PENELOPE_AVATARS_DIR");
  const databasePath = get("PENELOPE_DATABASE") ?? "/var/lib/penelope/backend.sqlite";

  return {
    databasePath,
    // Beside the database by default: the same persistent place, which the backend alone mounts.
    assetsDir: get("PENELOPE_ASSETS_DIR") ?? path.join(path.dirname(databasePath), "assets"),
    sourcesDir: get("PENELOPE_SOURCES_DIR") ?? "/sources",
    memoryDir: get("PENELOPE_MEMORY_DIR") ?? "/memory",
    intakeSocket: get("PENELOPE_INTAKE_SOCKET") ?? "/run/penelope/intake/backend.sock",
    sandboxSocket: get("PENELOPE_SANDBOX_SOCKET") ?? "/run/penelope/sandbox/backend.sock",
    listen: listenOf(get("PENELOPE_LISTEN") ?? "0.0.0.0:8080"),
    publicUrl,
    sandboxToken: secret("PENELOPE_SANDBOX_TOKEN_FILE"),
    github,
    timeZone,
    sleep: { threshold: Number(threshold), defaultMs, maxMs, reportTimeoutMs: minutes("PENELOPE_SLEEP_REPORT_TIMEOUT_MINUTES", 60) },
    batch: { quietMs: minutes("PENELOPE_BATCH_QUIET_MINUTES", 5), maxMs: minutes("PENELOPE_BATCH_MAX_MINUTES", 30) },
    redeliverMs: minutes("PENELOPE_REDELIVER_MINUTES", 5),
    heartbeatMs: heartbeatOf(),
    builtinDelivery: {
      ui: delivery("PENELOPE_DELIVERY_UI"),
      cron: delivery("PENELOPE_DELIVERY_CRON"),
      a2a: delivery("PENELOPE_DELIVERY_A2A"),
      self: delivery("PENELOPE_DELIVERY_SELF"),
      job: delivery("PENELOPE_DELIVERY_JOB"),
    },
    inline: new Set([
      ...(get("PENELOPE_INLINE_SOURCES") ?? "ui,job")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
      "control",
    ]),
    gitAuthor: {
      name: get("PENELOPE_GIT_AUTHOR_NAME") ?? "penelope-backend",
      email: get("PENELOPE_GIT_AUTHOR_EMAIL") ?? "backend@penelope.invalid",
    },
    memoryView: {
      ownerEmail: get("PENELOPE_MEMORY_OWNER_EMAIL"),
      ownerName: get("PENELOPE_MEMORY_OWNER_NAME"),
      targetBytes: bytes("PENELOPE_PROMPT_LAYER_TARGET_BYTES", 16384),
      fileLimitBytes: bytes("PENELOPE_PROMPT_FILE_MAX_BYTES", 65536),
    },
    // The deployment's own avatars come first (ADR-0036).
    avatar: { name: get("PENELOPE_AGENT_NAME"), chosen, from: avatarsDir === undefined ? [IMAGE_AVATARS_DIR] : [avatarsDir, IMAGE_AVATARS_DIR] },
    webDir: get("PENELOPE_WEB_DIR") ?? "/app/web",
    a2a: a2aOf(get, readFile, publicUrl),
    webPush: webPushOf(secret("PENELOPE_WEB_PUSH_VAPID_KEY_FILE"), publicUrl),
    apns: apnsOf(get, secret, publicUrl, log),
  };
}

/** Missing or unusable APNs settings leave the backend and Web Push running. */
function apnsOf(get: (name: string) => string | undefined, secret: (name: string) => string | undefined, url: string | undefined, log: (line: string) => void): Config["apns"] {
  const keyFile = "PENELOPE_APNS_KEY_FILE";
  const keyId = get("PENELOPE_APNS_KEY_ID");
  const teamId = get("PENELOPE_APNS_TEAM_ID");
  if (keyId === undefined && teamId === undefined && get(keyFile) === undefined) return undefined;
  const appleId = /^[A-Z0-9]{10}$/;
  if (!keyId || !appleId.test(keyId) || !teamId || !appleId.test(teamId) || !url?.startsWith("https:") || get(keyFile) === undefined) {
    log("backend: APNs disabled; check PENELOPE_APNS_KEY_ID, PENELOPE_APNS_TEAM_ID, PENELOPE_APNS_KEY_FILE and the HTTPS public URL");
    return undefined;
  }
  try {
    const key = createPrivateKey(secret(keyFile)!);
    if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return { key, keyId, teamId, url };
  } catch {
    // Neither the secret's path nor its content belongs in the log.
  }
  log("backend: APNs disabled; PENELOPE_APNS_KEY_FILE must be a readable P-256 private key");
  return undefined;
}

/**
 * Web Push is there with the deployment's VAPID key, which names the backend
 * by its public URL. A key it cannot use stops the start (ADR-0027).
 */
function webPushOf(vapidKey: string | undefined, publicUrl: string | undefined): Config["webPush"] {
  if (vapidKey === undefined) return undefined;
  try {
    vapidKeyOf(vapidKey);
  } catch (error) {
    throw new ConfigError(`PENELOPE_WEB_PUSH_VAPID_KEY_FILE: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (publicUrl === undefined) throw new ConfigError("Web Push needs PENELOPE_PUBLIC_URL, the subject of its VAPID tokens");
  return { vapidKey, subject: publicUrl };
}

/**
 * The A2A way in, open only with senders: then it needs the public URL and at
 * least one way to check them, each with all it needs. Anything less is a
 * mistake, so that the backend never starts with a way in that lets nobody in
 * without saying so.
 */
function a2aOf(get: (name: string) => string | undefined, readFile: (file: string) => string, publicUrl: string | undefined): A2ASettings | undefined {
  const list = (name: string) =>
    (get(name) ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  const senders = list("PENELOPE_A2A_SENDERS");
  if (senders.length === 0) return undefined;
  try {
    new Senders(senders);
  } catch (error) {
    throw new ConfigError(`PENELOPE_A2A_SENDERS: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (publicUrl === undefined) throw new ConfigError("the A2A way in needs PENELOPE_PUBLIC_URL, for its Agent Card");
  const checks = list("PENELOPE_A2A_AUTH");
  if (checks.length === 0) throw new ConfigError(`PENELOPE_A2A_SENDERS needs PENELOPE_A2A_AUTH: ${A2A_CHECKS.join(", ")}, or both`);
  for (const check of checks) {
    if (!(A2A_CHECKS as readonly string[]).includes(check)) throw new ConfigError(`PENELOPE_A2A_AUTH: ${check} is not one of ${A2A_CHECKS.join(", ")}`);
  }
  const required = (name: string) => {
    const value = get(name);
    if (value === undefined) throw new ConfigError(`${name} is needed for ${checks.join(", ")}`);
    return value;
  };
  const url = (name: string) => {
    const value = required(name);
    if (!URL.canParse(value)) throw new ConfigError(`${name} must be a URL`);
    return value;
  };
  const readable = (name: string, file: string) => {
    try {
      return readFile(file);
    } catch (error) {
      throw new ConfigError(`${name}: ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const whole = (name: string, fallback: number) => {
    const value = get(name);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || Number(value) <= 0) throw new ConfigError(`${name} must be a whole number above 0`);
    return Number(value);
  };

  let gated: A2ASettings["gated"];
  if (checks.includes("gated-assertion")) {
    gated = { issuer: required("PENELOPE_A2A_GATED_ISSUER"), jwksUrl: url("PENELOPE_A2A_GATED_JWKS_URL"), audience: audienceOf(publicUrl) };
  }
  let tokenReview: A2ASettings["tokenReview"];
  if (checks.includes("tokenreview")) {
    let apiServer = get("PENELOPE_KUBERNETES_URL");
    if (apiServer === undefined) {
      const host = get("KUBERNETES_SERVICE_HOST");
      if (host === undefined) throw new ConfigError("tokenreview needs the API server: PENELOPE_KUBERNETES_URL, or KUBERNETES_SERVICE_HOST in the cluster");
      apiServer = `https://${host.includes(":") ? `[${host}]` : host}:${get("KUBERNETES_SERVICE_PORT") ?? "443"}`;
    }
    if (!URL.canParse(apiServer)) throw new ConfigError("PENELOPE_KUBERNETES_URL must be a URL");
    const tokenFile = get("PENELOPE_KUBERNETES_TOKEN_FILE") ?? `${SA_DIR}/token`;
    // Read now only to stop at the start when it is not there; it is read again for every review.
    readable("PENELOPE_KUBERNETES_TOKEN_FILE", tokenFile);
    const caFile = get("PENELOPE_KUBERNETES_CA_FILE") ?? `${SA_DIR}/ca.crt`;
    // The API server's own audience would take the token every Pod of the ServiceAccount has mounted.
    const audiences = list("PENELOPE_A2A_AUDIENCES");
    if (audiences.length === 0) throw new ConfigError("tokenreview needs PENELOPE_A2A_AUDIENCES: the audiences the senders' tokens are made for");
    tokenReview = {
      kubernetes: { url: apiServer, tokenFile, ca: readable("PENELOPE_KUBERNETES_CA_FILE", caFile) },
      audiences,
    };
  }
  return {
    senders,
    gated,
    tokenReview,
    description: get("PENELOPE_A2A_DESCRIPTION") ?? "",
    url: `${publicUrl}/a2a/`,
    limits: { deadlineMs: whole("PENELOPE_A2A_DEADLINE_HOURS", 24) * 3_600_000, maxOpenTasks: whole("PENELOPE_A2A_MAX_OPEN_TASKS", 3) },
  };
}

/** `host:port`, the host in brackets when it is IPv6. */
function listenOf(value: string): { host: string; port: number } {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(value);
  const port = Number(match?.[3]);
  if (!match || port > 65535) throw new ConfigError("PENELOPE_LISTEN must be host:port");
  return { host: match[1] ?? match[2]!, port };
}
