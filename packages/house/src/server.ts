import http from "node:http";
import type { AddressInfo } from "node:net";

import { CALLBACK_PATH } from "@penelope/github-oauth";
import { GatedAssertion, identify, TokenReview, type SenderCheck } from "@penelope/service-account-auth";

import type { HouseConfig } from "./config.ts";
import { Conflict, House, NotFound } from "./house.ts";
import { InvalidInput, speechOf, syncOf } from "./input.ts";
import { PeopleLogin } from "./login.ts";
import { People } from "./people.ts";
import { serveWeb } from "./web.ts";

const ROOM = /^\/v1\/agent\/rooms\/([^/]+)\/(enter|say)$/;
const PERSON_ROOM = /^\/api\/rooms\/([^/]+)\/(enter|say|history)$/;
const BODY_LIMIT = 32 * 1024;

class BodyTooLarge extends Error {}
class WrongMediaType extends Error {}

type Options = { now?: () => number; log?: (line: string) => void; checks?: readonly SenderCheck[]; github?: typeof fetch };

export async function startHouse(config: HouseConfig, { now = Date.now, log = console.error, checks = checksOf(config, now, log), github }: Options = {}) {
  const house = new House(config, now());
  const people = new People(house, now, log);
  const login = new PeopleLogin(config.auth.github, house, now, github);
  const server = http.createServer({ headersTimeout: 15_000, requestTimeout: 15_000 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof InvalidInput) return send(response, 400, { error: error.message });
      if (error instanceof Conflict) return send(response, 409, { error: error.message });
      if (error instanceof NotFound) return send(response, 404, { error: error.message });
      if (error instanceof WrongMediaType) return send(response, 415, { error: "expected application/json" });
      if (error instanceof BodyTooLarge) {
        response.setHeader("connection", "close");
        response.once("finish", () => request.destroy());
        return send(response, 413, { error: "request body is too large" });
      }
      log(`house: request failed: ${error instanceof Error ? error.message : String(error)}`);
      send(response, 500, { error: "house request failed" });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listen, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    people.close();
    house.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    port: (server.address() as AddressInfo).port,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      people.close();
      server.close((error) => {
        house.close();
        if (error) reject(error);
        else resolve();
      });
    }),
  };

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const raw = request.url ?? "";
    const path = raw.split("?", 1)[0]!;
    const method = request.method;
    if (path === "/healthz" && (method === "GET" || method === "HEAD")) return send(response, 200, { ok: true });
    if (path.startsWith("/api/") || path.startsWith("/auth/")) {
      const query = new URLSearchParams(raw.length > path.length ? raw.slice(path.length + 1) : "");
      return handlePerson(request, response, path, query);
    }
    if (!path.startsWith("/v1/") && (method === "GET" || method === "HEAD") && await serveWeb(config.webDir, path, method === "HEAD", response)) return;

    const room = ROOM.exec(path);
    const view = path === "/v1/agent/house" && method === "GET";
    const leave = path === "/v1/agent/room" && method === "DELETE";
    const sync = path === "/v1/agent/sync" && method === "POST";
    if (!view && !leave && !sync && !(room && method === "POST")) return send(response, 404, { error: "not found" });

    const identity = await identify(checks, request.headers);
    if (identity.kind === "unavailable") return send(response, 503, { error: "authentication is unavailable" });
    const agent = identity.kind === "subject" ? house.agent(identity.subject) : undefined;
    if (!agent) return send(response, 401, { error: "unauthorized" });

    if (view) return send(response, 200, house.view(agent, now()));
    if (leave) {
      people.publish(house.leave(agent, now()));
      return send(response, 204);
    }
    if (sync) {
      const update = syncOf(await readJson(request));
      const result = house.sync(agent, update, now());
      people.publish();
      return send(response, 200, result);
    }
    const roomId = room![1]!;
    if (room![2] === "enter") {
      people.publish(house.enter(agent, roomId, now()));
      return send(response, 200, { occupants: house.visibleIn(roomId, now()) });
    }
    const speech = speechOf(await readJson(request));
    const { result, event } = house.say(agent, roomId, speech, now());
    people.publish([event]);
    return send(response, 200, result);
  }

  async function handlePerson(request: http.IncomingMessage, response: http.ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = request.method;
    if (method === "GET" && path === "/auth/github/start") {
      const result = login.start(request);
      if (result.kind === "refused") return send(response, result.status, { error: result.code });
      return redirect(response, result.location, result.cookie);
    }
    if (method === "GET" && path === CALLBACK_PATH) {
      const result = await login.callback(request, query);
      if (result.kind === "refused") {
        log(`house: login refused: ${result.code}`);
        return send(response, result.status, { error: result.code });
      }
      log("house: a resident signed in");
      people.publish();
      return redirect(response, "/", result.cookie);
    }
    if (method === "POST" && path === "/auth/logout") {
      const result = login.logout(request);
      if (result.kind === "refused") return send(response, result.status, { error: result.code });
      if (result.tokenHash) people.revoke(result.tokenHash);
      response.setHeader("set-cookie", result.cookie);
      return send(response, 204);
    }

    const room = PERSON_ROOM.exec(path);
    const read = method === "GET" && (path === "/api/house" || path === "/api/stream" || room?.[2] === "history");
    const leave = method === "DELETE" && path === "/api/room";
    const post = method === "POST" && (room?.[2] === "enter" || room?.[2] === "say");
    if (!read && !leave && !post) return send(response, 404, { error: "not found" });
    const session = login.session(request);
    if (!session) return send(response, 401, { error: "unauthorized" });
    const { person } = session;
    if (path === "/api/house") return send(response, 200, people.view(person));
    if (path === "/api/stream") {
      if (request.headers.accept !== "text/event-stream") return send(response, 406, { error: "expected text/event-stream" });
      const site = request.headers["sec-fetch-site"];
      if ((site && site !== "same-origin" && site !== "none") ||
          (request.headers.origin && request.headers.origin !== config.auth.github?.origin)) {
        return send(response, 403, { error: "wrong-origin" });
      }
      return people.connect(session, query.get("peek"), response);
    }
    if (room?.[2] === "history") return send(response, 200, house.history(room[1]!, query.get("before")));

    const connection = request.headers["x-house-connection"];
    const id = typeof connection === "string" ? connection : undefined;
    people.requireConnection(session, id);
    if (leave) {
      people.publish(house.leave(person, now(), true));
      return send(response, 204);
    }
    if (room![2] === "enter") {
      people.publish(house.enter(person, room![1]!, now()));
      return send(response, 200, people.view(person));
    }
    const speech = speechOf(await readJson(request));
    people.requireConnection(session, id);
    const { result, event } = house.say(person, room![1]!, speech, now());
    people.publish([event]);
    return send(response, 200, result);
  }
}

function redirect(response: http.ServerResponse, location: string, cookie: string): void {
  response.writeHead(302, { location, "set-cookie": cookie, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
}

function checksOf(config: HouseConfig, now: () => number, log: (line: string) => void): SenderCheck[] {
  const checks: SenderCheck[] = [];
  const { gated, tokenReview } = config.auth;
  if (config.agents.length === 0) return checks;
  if (gated) checks.push(new GatedAssertion({ ...gated, now, log: (line) => log(`house: ${line}`) }));
  if (tokenReview) checks.push(new TokenReview(tokenReview.kubernetes, tokenReview.audiences));
  return checks;
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new WrongMediaType();
  if (Number(request.headers["content-length"]) > BODY_LIMIT) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new InvalidInput("expected valid JSON");
  }
}

function send(response: http.ServerResponse, status: number, body?: unknown): void {
  response.setHeader("cache-control", "no-store");
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }).end(encoded);
}
