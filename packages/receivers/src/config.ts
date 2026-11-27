// The receivers' settings (docs/receivers.md, "設定"): one JSON file, read
// once at start with the key files it points at. Anything it cannot use stops
// the start, so that a slip of the pen is never ignored.
import type { BuiltinSource } from "@penelope/contract";

import { type Connection, isObject, type PluginEnv, SettingsError, type WebhookHandler } from "./plugin.ts";
import { PLUGINS } from "./plugins/index.ts";

export const DEFAULT_CONFIG_FILE = "/etc/penelope/receivers/config.json";

/** The backend's own sources, which the intake refuses from the receivers. */
const BUILTIN_SOURCES: readonly BuiltinSource[] = ["ui", "cron", "a2a", "self", "control", "heartbeat", "wake"];

/** A path segment under /sources, as the intake takes `source` (docs/events.md). */
const SEGMENT = /^[a-z0-9_-][a-z0-9._-]{0,127}$/;

/** An activation's name, which is part of the URL /v1/webhooks/<name>. */
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** One plugin turned on under a name, with its handler or its connection made from its settings. */
export type Activation = { name: string; plugin: string; source: string } & (
  | { kind: "webhook"; handle: WebhookHandler }
  | { kind: "connection"; connection: Connection }
);

export type Config = {
  listen: { host: string; port: number };
  intake: string;
  intakeTimeoutMs: number;
  activations: Activation[];
};

/** Settings the receivers cannot start with. One line, `<field>: <why>`. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message.replace(/\s*\n\s*/g, " "));
    this.name = "ConfigError";
  }
}

const fail = (field: string, why: string): never => {
  throw new ConfigError(`${field}: ${why}`);
};

export function loadConfig(env: Readonly<Record<string, string | undefined>>, readFile: PluginEnv["readFile"]): Config {
  const file = env.PENELOPE_RECEIVERS_CONFIG || DEFAULT_CONFIG_FILE;
  let text: string;
  try {
    text = readFile(file);
  } catch (error) {
    throw new ConfigError(`cannot read the settings ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`the settings ${file} are not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(body)) throw new ConfigError(`the settings ${file} must be a JSON object`);
  only(body, ["listen", "intake", "intake_timeout_seconds", "plugins"], "");

  const timeout = body.intake_timeout_seconds ?? 10;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0) fail("intake_timeout_seconds", "must be an integer above 0");
  const intake = body.intake ?? "/run/penelope/intake/backend.sock";
  if (typeof intake !== "string" || intake === "") fail("intake", "must be the path of a Unix socket");
  const plugins = body.plugins ?? [];
  if (!Array.isArray(plugins)) fail("plugins", "must be a list");

  return {
    listen: parseListen(body.listen ?? "0.0.0.0:8081"),
    intake: intake as string,
    intakeTimeoutMs: (timeout as number) * 1000,
    activations: activate(plugins as unknown[], { readFile }),
  };
}

function only(object: Record<string, unknown>, known: readonly string[], prefix: string): void {
  for (const field of Object.keys(object)) {
    if (!known.includes(field)) fail(`${prefix}${field}`, "not a field of the settings");
  }
}

/** `host:port`, with an IPv6 host in brackets. */
function parseListen(value: unknown): Config["listen"] {
  const found = typeof value === "string" ? /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(value) : null;
  const port = Number(found?.[3]);
  if (!found || port > 65535) return fail("listen", "must be host:port, with an IPv6 host in brackets ([::]:8081)");
  return { host: (found[1] ?? found[2])!, port };
}

function activate(plugins: unknown[], env: PluginEnv): Activation[] {
  const names = new Set<string>();
  const sources = new Set<string>();
  return plugins.map((item, index) => {
    const at = `plugins[${index}]`;
    if (!isObject(item)) return fail(at, "must be an object");
    only(item, ["name", "plugin", "source", "settings"], `${at}.`);
    const plugin = typeof item.plugin === "string" ? PLUGINS.get(item.plugin) : undefined;
    if (!plugin) return fail(`${at}.plugin`, `must be one of ${[...PLUGINS.keys()].join(", ")}`);

    const { name } = item;
    if (typeof name !== "string" || !NAME.test(name)) {
      return fail(`${at}.name`, "must be 1 to 32 lower-case letters, digits and '-', not starting with '-'");
    }
    if (names.has(name)) return fail(`${at}.name`, `${name} is given twice`);
    names.add(name);

    const source = item.source ?? plugin.name;
    if (typeof source !== "string" || !SEGMENT.test(source)) {
      return fail(`${at}.source`, "must be lower-case letters, digits, '.', '_' and '-', not starting with '.'");
    }
    if ((BUILTIN_SOURCES as readonly string[]).includes(source)) return fail(`${at}.source`, `${source} is one of the backend's own sources`);
    if (sources.has(source)) return fail(`${at}.source`, `${source} is given twice`);
    sources.add(source);

    const settings = item.settings ?? {};
    if (!isObject(settings)) return fail(`${at}.settings`, "must be an object");
    try {
      if (plugin.kind === "webhook") return { name, plugin: plugin.name, source, kind: plugin.kind, handle: plugin.create(settings, env) };
      return { name, plugin: plugin.name, source, kind: plugin.kind, connection: plugin.create(settings, env) };
    } catch (error) {
      if (error instanceof SettingsError) return fail(`${at}.settings.${error.field}`, error.why);
      throw error;
    }
  });
}
