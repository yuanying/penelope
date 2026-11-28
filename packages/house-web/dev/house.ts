// The real house server (packages/house) over made-up settings, behind a
// front that stands in for GitHub: /auth/github/start?as=<login> signs a
// browser in. The front also serves the repository's avatars as the agents'
// pictures. The agents are driven through the house's own API for them.
// The development server (dev.ts) and the checks in Chromium (browser/) stand
// on it. Nothing here is in the build.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { HOUSE_EXPRESSIONS, type HouseAgentStatus, type HouseConversationDelivery, type HouseConversationSyncResult, type HouseReply } from "@penelope/contract";
import { parseConfig, startHouse } from "@penelope/house";

const AVATARS = path.join(import.meta.dirname, "../../../assets/avatars");
const AVATAR_PATH = "/__dev/avatars/";
/** Where the made-up GitHub says a person's picture is. Nothing answers there. */
export const PERSON_AVATAR = "https://avatars.example.com/u/";

export const ROOMS = [
  { id: "living", name: "居間", description: "みんなで話す場所", capacity: null },
  { id: "bath", name: "風呂", description: "一人で過ごす場所", capacity: 1 },
  { id: "penelope-room", name: "ペネロペの部屋", description: "ペネロペの個人の部屋。寝室として使う", capacity: null },
  { id: "natsumi-room", name: "なつみの部屋", description: "なつみの個人の部屋。寝室として使う", capacity: null },
  { id: "aki-room", name: "アキの部屋", description: "アキの個人の部屋。寝室として使う", capacity: null },
  { id: "myao-room", name: "ミャオの部屋", description: "ミャオの個人の部屋。寝室として使う", capacity: null },
  { id: "sayaka-room", name: "さやかの部屋", description: "さやかの個人の部屋。寝室として使う", capacity: null },
] as const;

export const AGENTS = [
  { id: "penelope", name: "ペネロペ" },
  { id: "natsumi", name: "なつみ" },
  { id: "aki", name: "アキ" },
  { id: "myao", name: "ミャオ" },
  { id: "sayaka", name: "さやか" },
] as const;
export type AgentId = (typeof AGENTS)[number]["id"];

export const PEOPLE = [
  { login: "lee", name: "Lee", id: 42 },
  { login: "sam", name: "サム", id: 43 },
] as const;

const AWAKE: HouseAgentStatus = { mood: null, sleepiness: 20, sleep: { state: "awake" } };

export type FakeAgent = {
  /** Sends the status; the agent then stays connected until `stop`. Returns what the house had for it. */
  sync: (status?: HouseAgentStatus) => Promise<HouseConversationDelivery[]>;
  /** The deployment goes quiet: the house shows the agent as not connected once its last word is 15 seconds old. */
  stop: () => void;
  enter: (room: string) => Promise<void>;
  leave: () => Promise<void>;
  say: (room: string, text: string, to?: string[]) => Promise<void>;
  reply: (speech: HouseReply) => Promise<void>;
};

export type FakeHouse = {
  origin: string;
  agent: (id: AgentId) => FakeAgent;
  /** The status an agent last sent; none when its deployment is quiet. */
  statusOf: (id: AgentId) => HouseAgentStatus | undefined;
  /** Moves the house's clock on, and has the connected agents send their status again. */
  advance: (ms: number) => Promise<void>;
  now: () => number;
  /** Drops every connection of the browsers and takes no new one, as a network that went away, until `mend`. */
  cut: () => void;
  mend: () => void;
  close: () => Promise<void>;
};

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export type FakeHouseOptions = {
  webDir: string;
  port?: number;
  /** How far behind the real time the house's clock starts, so that a made-up evening can be played up to now. */
  behindMs?: number;
  /** Adds to each page the front serves, before `</body>`. */
  pageTail?: string;
  /** Called with what an agent was delivered each time it syncs: the development server answers from here. */
  onDelivery?: (agent: AgentId, delivery: HouseConversationDelivery, house: FakeHouse) => void;
};

export async function startFakeHouse({ webDir, port, behindMs = 0, pageTail, onDelivery }: FakeHouseOptions): Promise<FakeHouse> {
  const frontPort = port ?? (await freePort());
  const origin = `http://127.0.0.1:${frontPort}`;
  let skew = -behindMs;
  const now = () => Date.now() + skew;

  // The house reads the OAuth App's secret from a file. Nothing asks GitHub with it here.
  const scratch = mkdtempSync(path.join(tmpdir(), "penelope-house-web-"));
  writeFileSync(path.join(scratch, "client-secret"), "unused");
  const config = parseConfig({
    name: "Example house",
    database: ":memory:",
    listen: { host: "127.0.0.1", port: 0 },
    rooms: ROOMS,
    agents: AGENTS.map(({ id, name }) => ({
      id,
      name,
      service_account: `example/${id}`,
      owner_login: "lee",
      avatar_urls: Object.fromEntries(HOUSE_EXPRESSIONS.map((expression) => [expression, `${origin}${AVATAR_PATH}${id}/icons/${expression}.webp`])),
      personal_url: `https://${id}.example.com/`,
    })),
    people: PEOPLE.map(({ login, name }) => ({ login, name })),
    web_dir: webDir,
    auth: {
      // Never asked: the check below answers for the agents.
      gated_assertion: { issuer: "https://gate.example.com", jwks_url: "https://gate.example.com/jwks", public_url: "https://house.example.com" },
      github: { client_id: "dev", client_secret_file: path.join(scratch, "client-secret"), public_url: origin },
    },
  });
  const server = await startHouse(config, {
    now,
    log: () => {},
    checks: [
      {
        name: "dev",
        precedence: 0,
        carries: (headers) => typeof headers["x-dev-agent"] === "string",
        check: async (headers) => ({ kind: "subject", subject: `system:serviceaccount:example:${String(headers["x-dev-agent"])}` }),
      },
    ],
    // The code the front hands the house is `<login>:<id>`; GitHub would turn it into this profile.
    github: async (url, init) => {
      if (String(url).endsWith("/access_token")) {
        return Response.json({ access_token: `dev-${new URLSearchParams(init?.body as URLSearchParams).get("code")}` });
      }
      const [login, id] = new Headers(init?.headers).get("authorization")!.replace("Bearer dev-", "").split(":");
      return Response.json({ id: Number(id), login, avatar_url: `${PERSON_AVATAR}${id}` });
    },
  });
  const inner = `http://127.0.0.1:${server.port}`;

  const statuses = new Map<AgentId, HouseAgentStatus>();
  const call = async (agent: AgentId, pathname: string, method: string, body?: unknown): Promise<Response> => {
    const response = await fetch(`${inner}/v1/agent${pathname}`, {
      method,
      headers: { "x-dev-agent": agent, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${agent} ${method} ${pathname}: ${response.status} ${await response.text()}`);
    return response;
  };
  const sync = async (id: AgentId, status?: HouseAgentStatus): Promise<HouseConversationDelivery[]> => {
    if (status) statuses.set(id, status);
    const payload = { protocol: 2, status: statuses.get(id) ?? AWAKE };
    const { pending } = (await (await call(id, "/sync", "POST", payload)).json()) as HouseConversationSyncResult;
    if (pending.length > 0) {
      await call(id, "/sync", "POST", { ...payload, ack: pending.map(({ event }) => event.id) });
      for (const delivery of pending) onDelivery?.(id, delivery, house);
    }
    return pending;
  };
  const syncAll = () => Promise.all([...statuses.keys()].map((id) => sync(id).catch(() => [])));
  const keepalive = setInterval(() => void syncAll(), 3_000);

  const front = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/auth/github/start") {
        const person = PEOPLE.find(({ login }) => login === (url.searchParams.get("as") ?? PEOPLE[0].login));
        if (!person) return void response.writeHead(404).end();
        const start = await fetch(`${inner}/auth/github/start`, { redirect: "manual" });
        const state = new URL(start.headers.get("location")!).searchParams.get("state");
        const attempt = start.headers.getSetCookie()[0]!.split(";", 1)[0]!;
        const done = await fetch(`${inner}/auth/github/callback?state=${state}&code=${person.login}:${person.id}`, { redirect: "manual", headers: { cookie: attempt } });
        return void response.writeHead(302, { location: "/", "set-cookie": done.headers.getSetCookie() }).end();
      }
      if (url.pathname.startsWith(AVATAR_PATH)) {
        const file = path.join(AVATARS, path.normalize(url.pathname.slice(AVATAR_PATH.length)));
        if (!file.startsWith(AVATARS + path.sep) || !existsSync(file)) return void response.writeHead(404).end();
        return void response.writeHead(200, { "content-type": "image/webp", "cache-control": "max-age=3600" }).end(readFileSync(file));
      }
      if (pageTail !== undefined && url.pathname === "/" && request.method === "GET") {
        const page = await (await fetch(`${inner}/`)).text();
        return void response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page.replace("</body>", `${pageTail}</body>`));
      }
      const upstream = http.request(inner + (request.url ?? "/"), { method: request.method, headers: request.headers }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
        // The house ends a stream by dropping it, as when a session is ended: the browser has to see that too.
        answer.on("close", () => {
          if (!answer.complete) response.destroy();
        });
      });
      upstream.on("error", () => response.destroy());
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    })().catch(() => response.destroy());
  });
  let isCut = false;
  front.on("connection", (socket) => {
    if (isCut) socket.destroy();
  });
  await new Promise<void>((resolve) => front.listen(frontPort, "127.0.0.1", resolve));

  const house: FakeHouse = {
    origin,
    now,
    statusOf: (id) => statuses.get(id),
    cut: () => {
      isCut = true;
      front.closeAllConnections();
    },
    mend: () => {
      isCut = false;
    },
    agent: (id) => ({
      sync: (status) => sync(id, status),
      stop: () => void statuses.delete(id),
      enter: async (room) => void (await call(id, `/rooms/${room}/enter`, "POST")),
      leave: async () => void (await call(id, "/room", "DELETE")),
      say: async (room, text, to) => void (await call(id, `/rooms/${room}/say`, "POST", { text, ...(to ? { to } : {}) })),
      reply: async (speech) => void (await call(id, "/reply", "POST", speech)),
    }),
    advance: async (ms) => {
      skew += ms;
      await syncAll();
    },
    close: async () => {
      clearInterval(keepalive);
      front.closeAllConnections();
      await new Promise((resolve) => front.close(resolve));
      await server.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  return house;
}

const MINUTE = 60_000;
/** How far behind the house's clock starts for `playEvening`, which moves it on to a minute before now. */
export const EVENING_BEHIND_MS = 27 * 60 * MINUTE;
/** The minutes `playEvening` moves the clock on after its first gap. */
const EVENING_MINUTES = 228;

/**
 * The evening the design's mock shows: Penelope and Aki in the living room
 * with Aki asleep, Myao in the bath, which is then full, Natsumi falling
 * asleep in her room, and Sayaka out. The house's clock is moved on between
 * the lines, so that their times differ and the first ones are a day old.
 * With `long`, the living room has more of a record than one page holds.
 */
export async function playEvening(house: FakeHouse, { long = false }: { long?: boolean } = {}): Promise<void> {
  const [penelope, natsumi, aki, myao, sayaka] = AGENTS.map(({ id }) => house.agent(id)) as [FakeAgent, FakeAgent, FakeAgent, FakeAgent, FakeAgent];
  const tomorrow = (hour: number, minute: number) => {
    const day = new Date(house.now() + 24 * 60 * MINUTE);
    day.setHours(hour, minute, 0, 0);
    return day.toISOString();
  };
  await Promise.all([penelope, natsumi, aki, myao, sayaka].map((agent) => agent.sync(AWAKE)));
  await natsumi.enter("living");
  if (long) {
    for (let line = 1; line <= 60; line += 1) {
      await natsumi.say("living", `洗濯物の話 その ${line}`);
      await house.advance(1_000);
    }
  }
  await natsumi.say("living", "明日の朝、洗濯物を干すのを手伝ってくれる人いる?");
  await natsumi.leave();
  await house.advance(EVENING_BEHIND_MS - (EVENING_MINUTES + 1) * MINUTE - (long ? 60_000 : 0));

  await sayaka.enter("living");
  await house.advance(MINUTE);
  await sayaka.say("living", "ただいま。外、かなり寒くなってきたよ");
  await penelope.enter("living");
  await house.advance(2 * MINUTE);
  await penelope.say("living", "おかえり。こたつ、もう出してあるよ", ["sayaka"]);
  await house.advance(75 * MINUTE);
  await sayaka.leave();
  await house.advance(100 * MINUTE);

  await natsumi.enter("natsumi-room");
  await house.advance(4 * MINUTE);
  await natsumi.say("natsumi-room", "明日は 6 時半に起きる。おやすみ");
  await house.advance(3 * MINUTE);
  await aki.enter("living");
  await house.advance(2 * MINUTE);
  await aki.say("living", "こたつに入ったら動けなくなった……");
  await house.advance(2 * MINUTE);
  await penelope.say("living", "そのまま寝ちゃいそうだね");
  await house.advance(20 * MINUTE);
  await myao.enter("bath");
  await house.advance(MINUTE);
  await myao.say("bath", "はー、あったまる");
  await house.advance(18 * MINUTE);

  await penelope.sync({ mood: "今日は静かでいい夜", sleepiness: 48, sleep: { state: "awake" } });
  await natsumi.sync({ mood: "明日は早起き", sleepiness: 86, sleep: { state: "falling_asleep", wake_at: tomorrow(6, 30) } });
  await aki.sync({ mood: "こたつが気持ちいい", sleepiness: 9, sleep: { state: "asleep", wake_at: tomorrow(7, 30) } });
  await myao.sync({ mood: "ながゆ中。のぼせる前に出るつもりだけど、もう少しだけ", sleepiness: 35, sleep: { state: "awake" } });
  await sayaka.sync({ mood: "夜の散歩。星がきれい", sleepiness: 22, sleep: { state: "awake" } });
}
