import { readFileSync } from "node:fs";

import { EVENT_PATH_SEGMENT, type HouseActor, type HouseRoom } from "@penelope/contract";
import { audienceOf, type GatedSettings, type KubernetesSettings } from "@penelope/service-account-auth";

import { array, InvalidInput, object, residentId, string } from "./input.ts";

export type Agent = { subject: string; actor: HouseActor & { kind: "agent" } };
type Auth = {
  gated?: GatedSettings;
  tokenReview?: { kubernetes: KubernetesSettings; audiences: string[] };
};
export type HouseConfig = {
  name: string;
  database: string;
  listen: { host: string; port: number };
  rooms: HouseRoom[];
  agents: Agent[];
  auth: Auth;
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function subjectOf(value: unknown, label: string): string {
  const account = string(value, label);
  const [namespace, name, extra] = account.split("/");
  if (!namespace || !LABEL.test(namespace) || !name || name.length > 253 || !name.split(".").every((part) => LABEL.test(part)) || extra !== undefined) {
    throw new InvalidInput(`${label} must be <namespace>/<ServiceAccount name>`);
  }
  return `system:serviceaccount:${namespace}:${name}`;
}

function unique(values: Iterable<string>, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new InvalidInput(`${label} contains a duplicate`);
    seen.add(value);
  }
}

function httpUrl(value: unknown, label: string): string {
  const raw = string(value, label);
  const url = URL.parse(raw);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new InvalidInput(`${label} must be an HTTP or HTTPS URL without credentials or a fragment`);
  }
  return raw;
}

function authOf(value: unknown, hasAgents: boolean): Auth {
  const { gated_assertion, tokenreview } = object(value === undefined ? {} : value, "auth", ["gated_assertion", "tokenreview"]);
  const auth: Auth = {};
  if (gated_assertion !== undefined) {
    const { issuer, jwks_url, public_url } = object(gated_assertion, "auth.gated_assertion", ["issuer", "jwks_url", "public_url"]);
    auth.gated = {
      issuer: string(issuer, "auth.gated_assertion.issuer"),
      jwksUrl: httpUrl(jwks_url, "auth.gated_assertion.jwks_url"),
      audience: audienceOf(httpUrl(public_url, "auth.gated_assertion.public_url")),
    };
  }
  if (tokenreview !== undefined) {
    const path = "auth.tokenreview";
    const { url, token_file, ca_file, audiences } = object(tokenreview, path, ["url", "token_file", "ca_file", "audiences"]);
    const tokenFile = string(token_file, `${path}.token_file`);
    const requested = array(audiences, `${path}.audiences`).map((item) => string(item, `${path}.audiences item`));
    if (requested.length === 0) throw new InvalidInput(`${path}.audiences must have at least one item`);
    const apiUrl = httpUrl(url, `${path}.url`);
    if (new URL(apiUrl).protocol !== "https:") throw new InvalidInput(`${path}.url must use HTTPS`);
    readNonempty(tokenFile, `${path}.token_file`);
    auth.tokenReview = {
      kubernetes: {
        url: apiUrl,
        tokenFile,
        ca: ca_file === undefined ? undefined : readNonempty(string(ca_file, `${path}.ca_file`), `${path}.ca_file`),
      },
      audiences: requested,
    };
  }
  if (hasAgents && !auth.gated && !auth.tokenReview) throw new InvalidInput("auth is required with a nonempty agents list");
  return auth;
}

function readNonempty(path: string, label: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch {
    throw new InvalidInput(`${label} must point to a readable file`);
  }
  if (text === "") throw new InvalidInput(`${label} must not be empty`);
  return text;
}

export function parseConfig(value: unknown): HouseConfig {
  const { name, database, listen, rooms, agents, auth } = object(value, "house", ["name", "database", "listen", "rooms", "agents", "auth"]);
  const bind = object(listen === undefined ? {} : listen, "listen", ["host", "port"]);
  const port = bind.port === undefined ? 8080 : bind.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) throw new InvalidInput("listen.port must be an integer from 0 to 65535");
  const parsedRooms = array(rooms, "rooms").map((item, i): HouseRoom => {
    const label = `rooms[${i}]`;
    const room = object(item, label, ["id", "name", "description", "capacity"]);
    const id = string(room.id, `${label}.id`);
    if (!EVENT_PATH_SEGMENT.test(id)) throw new InvalidInput(`${label}.id is not an event stream ID`);
    const capacity = room.capacity;
    if (capacity !== null && (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity <= 0)) {
      throw new InvalidInput(`${label}.capacity must be null or a positive integer`);
    }
    return { id, name: string(room.name, `${label}.name`, 128), description: string(room.description, `${label}.description`, 1024), capacity };
  });
  unique(parsedRooms.map(({ id }) => id), "rooms");
  const parsedAgents = array(agents, "agents").map((item, i): Agent => {
    const label = `agents[${i}]`;
    const agent = object(item, label, ["id", "name", "service_account"]);
    return {
      subject: subjectOf(agent.service_account, `${label}.service_account`),
      actor: { kind: "agent", id: residentId(agent.id, `${label}.id`), name: string(agent.name, `${label}.name`, 128) },
    };
  });
  unique(parsedAgents.map(({ actor }) => actor.id), "agent IDs");
  unique(parsedAgents.map(({ subject }) => subject), "agent ServiceAccounts");
  return {
    name: string(name, "name", 128),
    database: database === undefined ? "/data/house.sqlite" : string(database, "database"),
    listen: { host: bind.host === undefined ? "0.0.0.0" : string(bind.host, "listen.host"), port },
    rooms: parsedRooms,
    agents: parsedAgents,
    auth: authOf(auth, parsedAgents.length > 0),
  };
}
