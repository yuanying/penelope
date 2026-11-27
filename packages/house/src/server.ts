import http from "node:http";
import type { AddressInfo } from "node:net";

import { GatedAssertion, identify, TokenReview, type SenderCheck } from "@penelope/service-account-auth";

import type { HouseConfig } from "./config.ts";
import { Conflict, House, NotFound } from "./house.ts";
import { InvalidInput, speechOf, syncOf } from "./input.ts";

const ROOM = /^\/v1\/agent\/rooms\/([^/]+)\/(enter|say)$/;
const BODY_LIMIT = 32 * 1024;

class BodyTooLarge extends Error {}
class WrongMediaType extends Error {}

type Options = { now?: () => number; log?: (line: string) => void; checks?: readonly SenderCheck[] };

export async function startHouse(config: HouseConfig, { now = Date.now, log = console.error, checks = checksOf(config, now, log) }: Options = {}) {
  const house = new House(config, now());
  const server = http.createServer({ headersTimeout: 15_000, requestTimeout: 15_000 }, (request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.destroyed) return;
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
    house.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    port: (server.address() as AddressInfo).port,
    close: () => closing ??= new Promise<void>((resolve, reject) => {
      server.close((error) => {
        house.close();
        if (error) reject(error);
        else resolve();
      });
    }),
  };

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const path = request.url?.split("?", 1)[0];
    const method = request.method;
    if (path === "/healthz" && (method === "GET" || method === "HEAD")) return send(response, 200, { ok: true });

    const room = ROOM.exec(path ?? "");
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
      house.leave(agent, now());
      return send(response, 204);
    }
    if (sync) {
      const update = syncOf(await readJson(request));
      return send(response, 200, house.sync(agent, update, now()));
    }
    const roomId = room![1]!;
    if (room![2] === "enter") return send(response, 200, house.enter(agent, roomId, now()));
    const speech = speechOf(await readJson(request));
    return send(response, 200, house.say(agent, roomId, speech, now()));
  }
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
