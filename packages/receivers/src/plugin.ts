// The boundary between the receivers and a plugin (docs/receivers.md,
// "プラグインの内側の契約"). Every plugin checks its settings once at start. A
// webhook plugin never touches the network or the intake: it turns one
// request into events. A connection plugin opens a connection of its own to
// the service it receives from (ADR-0028) and hands what it makes to the
// receivers, which send it to the intake.
import type { IncomingHttpHeaders } from "node:http";

import type { AgentStatus, Event } from "@penelope/contract";

import type { IntakeFile } from "./intake.ts";

/** An event as a plugin makes it: every field of the envelope but `source`, which the receivers add. */
export type PluginEvent = Omit<Event, "source">;

/** What a webhook plugin is given of one request. */
export type WebhookRequest = {
  headers: IncomingHttpHeaders;
  body: Uint8Array;
  /** When the receivers took the request. */
  receivedAt: Date;
};

/**
 * A request refused (no event is made), or taken with the events it made,
 * how many things it dropped and lines for the log. `reason` and `notes` are
 * written to the log, so they never carry the body's content or a key.
 */
export type WebhookOutcome =
  | { kind: "refuse"; status: 400; reason: string }
  | { kind: "refuse"; status: 401 }
  | { kind: "accept"; events: PluginEvent[]; dropped: number; notes: string[] };

export type WebhookHandler = (request: WebhookRequest) => WebhookOutcome;

/** What a plugin may do at start: read the files its settings point at. */
export type PluginEnv = { readFile: (path: string) => string };

export type WebhookPlugin = {
  /** What the settings' `plugin` names. */
  name: string;
  kind: "webhook";
  /** Checks the settings and reads the keys; throws SettingsError if it cannot run with them. */
  create: (settings: Record<string, unknown>, env: PluginEnv) => WebhookHandler;
};

/** An event a connection plugin hands over, with the files to send beside it as its attachments. */
export type ConnectionEvent = PluginEvent & { files?: IntakeFile[] };

/** What the receivers give a connection plugin once they start it. */
export type ConnectionIO = {
  /**
   * Sends the events to the intake one at a time, in order, and resolves true
   * once the intake took every one. It stops at the first the intake did not
   * take and resolves false; the plugin then does not tell the service it
   * received them, so that the service sends them again (ADR-0028).
   */
  deliver: (events: readonly ConnectionEvent[]) => Promise<boolean>;
  readStatus: () => Promise<AgentStatus | undefined>;
  setHeartbeatNote: (note: unknown) => Promise<boolean>;
  clearHeartbeatNote: () => Promise<boolean>;
  /** Writes a line to the log. Never a message's content nor a key. */
  log: (line: string) => void;
  now: () => Date;
};

/** A connection plugin running. `stop` closes its connections and resolves once what it was handing over is done. */
export type ConnectionHandle = { stop: () => Promise<void> };

/** A connection plugin's activation, made from its settings. It keeps reconnecting by itself until stopped. */
export type Connection = { start: (io: ConnectionIO) => ConnectionHandle };

export type ConnectionPlugin = {
  name: string;
  kind: "connection";
  /** Checks the settings and reads the keys; throws SettingsError if it cannot run with them. Opens nothing yet. */
  create: (settings: Record<string, unknown>, env: PluginEnv) => Connection;
};

export type Plugin = WebhookPlugin | ConnectionPlugin;

/** A plugin's settings it cannot run with. The message starts with the field, `<field>: <why>`. */
export class SettingsError extends Error {
  readonly field: string;
  readonly why: string;

  constructor(field: string, why: string) {
    super(`${field}: ${why}`);
    this.name = "SettingsError";
    this.field = field;
    this.why = why;
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Throws for the first field of `settings` that is not one of `known`. */
export function onlyKnown(settings: Record<string, unknown>, known: readonly string[]): void {
  for (const field of Object.keys(settings)) {
    if (!known.includes(field)) throw new SettingsError(field, "not a field of this plugin");
  }
}

/** The key in a file: what is left of its content without the white space around it. */
export function readKey(field: string, path: unknown, env: PluginEnv): string {
  if (typeof path !== "string" || path === "") throw new SettingsError(field, "the path of a file is required");
  let text: string;
  try {
    text = env.readFile(path);
  } catch (error) {
    throw new SettingsError(field, `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const key = text.trim();
  if (key === "") throw new SettingsError(field, `${path} is empty`);
  return key;
}
