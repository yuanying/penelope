import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EVENT_PATH_SEGMENT, HOUSE_EXPRESSIONS, type HouseActor, type HouseAgentIdentity, type HouseRoom } from "@penelope/contract";
import { CALLBACK_PATH, type GitHubOAuthSettings } from "@penelope/github-oauth";
import { audienceOf, type GatedSettings, type KubernetesSettings } from "@penelope/service-account-auth";

import { array, InvalidInput, object, residentId, string } from "./input.ts";

export type Person = { subject: string; actor: HouseActor & { kind: "person" } };
export type Agent = { subject: string; actor: HouseActor & { kind: "agent" }; owner?: Person } &
  Pick<HouseAgentIdentity, "avatar_url" | "avatar_urls" | "personal_url" | "chat_url">;

export const DIRECT_STREAM_PREFIX = "dm.";
export type Resident = Agent | Person;
type Auth = {
  gated?: GatedSettings;
  tokenReview?: { kubernetes: KubernetesSettings; audiences: string[] };
  github?: GitHubOAuthSettings & { origin: string };
};
export type HouseConfig = {
  name: string;
  database: string;
  listen: { host: string; port: number };
  rooms: HouseRoom[];
  agents: Agent[];
  people: Person[];
  auth: Auth;
  webDir: string;
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

function personalUrl(value: unknown): string | undefined {
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (url?.protocol === "https:" && !url.username && !url.password && !url.hash) return url.href;
}

function loginOf(value: unknown, label: string): string {
  const login = string(value, label, 39).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(login)) throw new InvalidInput(`${label} must be a GitHub login`);
  return login;
}

function authOf(value: unknown, hasAgents: boolean, hasPeople: boolean): Auth {
  const { gated_assertion, tokenreview, github } = object(value === undefined ? {} : value, "auth", ["gated_assertion", "tokenreview", "github"]);
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
  if (github !== undefined) {
    const path = "auth.github";
    const { public_url, client_id, client_secret_file } = object(github, path, ["public_url", "client_id", "client_secret_file"]);
    const url = new URL(httpUrl(public_url, `${path}.public_url`));
    const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.pathname !== "/" || url.search || (url.protocol !== "https:" && !loopback)) {
      throw new InvalidInput(`${path}.public_url must be an HTTPS origin (HTTP is allowed on loopback)`);
    }
    const secretFile = string(client_secret_file, `${path}.client_secret_file`);
    auth.github = {
      clientId: string(client_id, `${path}.client_id`),
      clientSecret: readNonempty(secretFile, `${path}.client_secret_file`),
      callbackUrl: new URL(CALLBACK_PATH, url).href,
      origin: url.origin,
    };
  }
  if (hasAgents && !auth.gated && !auth.tokenReview) throw new InvalidInput("auth is required with a nonempty agents list");
  if (hasPeople && !auth.github) throw new InvalidInput("auth.github is required with a nonempty people list");
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
  const { name, database, listen, rooms, agents, people, auth, web_dir } = object(value, "house", ["name", "database", "listen", "rooms", "agents", "people", "auth", "web_dir"]);
  const bind = object(listen === undefined ? {} : listen, "listen", ["host", "port"]);
  const port = bind.port === undefined ? 8080 : bind.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) throw new InvalidInput("listen.port must be an integer from 0 to 65535");
  const parsedRooms = array(rooms, "rooms").map((item, i): HouseRoom => {
    const label = `rooms[${i}]`;
    const room = object(item, label, ["id", "name", "description", "capacity"]);
    const id = string(room.id, `${label}.id`);
    if (!EVENT_PATH_SEGMENT.test(id) || id.startsWith(DIRECT_STREAM_PREFIX)) throw new InvalidInput(`${label}.id is not a room stream ID`);
    const capacity = room.capacity;
    if (capacity !== null && (typeof capacity !== "number" || !Number.isSafeInteger(capacity) || capacity <= 0)) {
      throw new InvalidInput(`${label}.capacity must be null or a positive integer`);
    }
    return { id, name: string(room.name, `${label}.name`, 128), description: string(room.description, `${label}.description`, 1024), capacity };
  });
  unique(parsedRooms.map(({ id }) => id), "rooms");
  const parsedPeople = array(people === undefined ? [] : people, "people").map((item, i): Person => {
    const label = `people[${i}]`;
    const { login, name } = object(item, label, ["login", "name"]);
    const id = loginOf(login, `${label}.login`);
    return { subject: `github:${id}`, actor: { kind: "person", id, name: string(name, `${label}.name`, 128) } };
  });
  const peopleById = new Map(parsedPeople.map((person) => [person.actor.id, person]));
  const parsedAgents = array(agents, "agents").map((item, i): Agent => {
    const label = `agents[${i}]`;
    const agent = object(item, label, ["id", "name", "service_account", "avatar_url", "avatar_urls", "chat_url", "owner_login", "personal_url"]);
    const owner = agent.owner_login === undefined ? undefined : peopleById.get(loginOf(agent.owner_login, `${label}.owner_login`));
    if (agent.owner_login !== undefined && !owner) throw new InvalidInput(`${label}.owner_login must name a registered person`);
    const personal_url = personalUrl(agent.personal_url);
    const urls = agent.avatar_urls === undefined ? undefined : object(agent.avatar_urls, `${label}.avatar_urls`, HOUSE_EXPRESSIONS);
    const avatar_urls = urls === undefined ? undefined : Object.fromEntries(Object.entries(urls).map(([face, url]) => [face, httpUrl(url, `${label}.avatar_urls.${face}`)]));
    return {
      subject: subjectOf(agent.service_account, `${label}.service_account`),
      actor: { kind: "agent", id: residentId(agent.id, `${label}.id`), name: string(agent.name, `${label}.name`, 128) },
      ...(owner ? { owner } : {}),
      ...(personal_url ? { personal_url } : {}),
      ...(avatar_urls ? { avatar_urls } : {}),
      ...(agent.avatar_url === undefined ? {} : { avatar_url: httpUrl(agent.avatar_url, `${label}.avatar_url`) }),
      ...(agent.chat_url === undefined ? {} : { chat_url: httpUrl(agent.chat_url, `${label}.chat_url`) }),
    };
  });
  unique([...parsedAgents, ...parsedPeople].map(({ actor }) => actor.id), "resident IDs");
  unique(parsedAgents.map(({ subject }) => subject), "agent ServiceAccounts");
  return {
    name: string(name, "name", 128),
    database: database === undefined ? "/data/house.sqlite" : string(database, "database"),
    listen: { host: bind.host === undefined ? "0.0.0.0" : string(bind.host, "listen.host"), port },
    rooms: parsedRooms,
    agents: parsedAgents,
    people: parsedPeople,
    auth: authOf(auth, parsedAgents.length > 0, parsedPeople.length > 0),
    webDir: web_dir === undefined ? fileURLToPath(new URL("../web/", import.meta.url)) : string(web_dir, "web_dir"),
  };
}
