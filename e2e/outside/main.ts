// The outside world of the end-to-end test (e2e/README.md), in one container:
//
//   :53/udp   a name server for the test's names, all of them this container
//   :443      HTTPS, by Host: the model's API, GitHub's OAuth and API, the
//             cluster's API server and gated's keys, an app under the
//             Sentinel's wildcard registration,
//             a host the Sentinel passes through, and Slack's Web API,
//             Socket Mode and files
//   :80       plain HTTP for the host the Sentinel passes through
//   :8081     the control API the test reads what came here from, on loopback
//
// What came is kept in memory. A credential is never kept or shown: each
// request is recorded with which credential it carried (`real`, `surrogate`,
// `none` or `other`).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import process from "node:process";

import { cluster, GATED, KUBERNETES } from "./cluster.ts";
import { serveDns, type Lookup } from "./dns.ts";
import { chunks, completion, E2E_PNG, type ChatMessage, script } from "./model.ts";
import { SLACK, SLACK_FILES, SLACK_SOCKET, slack } from "./slack.ts";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const secret = (name: string) => readFileSync(env(name), "utf8").trim();

/** This container's address, which every name of the test resolves to. */
const ADDRESS = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
if (!ADDRESS) throw new Error("the outside has no IPv4 address");
const MODEL_KEY = secret("OUTSIDE_MODEL_KEY_FILE");
const MODEL_SURROGATE = env("OUTSIDE_MODEL_SURROGATE");
const CLIENT_ID = env("OUTSIDE_GITHUB_CLIENT_ID");
const CLIENT_SECRET = secret("OUTSIDE_GITHUB_CLIENT_SECRET_FILE");
const OWNER_ID = Number(env("OUTSIDE_OWNER_GITHUB_ID"));

const MODEL = "model.example.com";
const HELPER = "helper.example.com";
const GITHUB = "github.com";
const GITHUB_API = "api.github.com";
const PLAIN = "plain.example.net";
/** An app under the Sentinel's wildcard registration. */
const APP = "a.apps.example.com";
const NAMES = new Set([MODEL, HELPER, GITHUB, GITHUB_API, PLAIN, KUBERNETES, GATED, APP, "backend.example.com", SLACK, SLACK_SOCKET, SLACK_FILES]);
const fakeSlack = slack({ app: secret("OUTSIDE_SLACK_APP_TOKEN_FILE"), bot: secret("OUTSIDE_SLACK_BOT_TOKEN_FILE") });
const fakeCluster = cluster({
  backend: secret("OUTSIDE_KUBE_TOKEN_FILE"),
  sender: secret("OUTSIDE_SENDER_TOKEN_FILE"),
  stranger: secret("OUTSIDE_STRANGER_TOKEN_FILE"),
});

type Credential = "real" | "surrogate" | "none" | "other";
type Seen = { at: string; scheme: "https" | "http"; host: string; method: string; path: string; credential: Credential };
type ModelCall = { at: string; credential: Credential; stream: boolean; messages: ChatMessage[]; tools: string[] };

const seen: Seen[] = [];
const modelCalls: ModelCall[] = [];
const lookups: Lookup[] = [];
/** OAuth codes handed out, by code: the PKCE challenge and where they go back to. */
const codes = new Map<string, { challenge: string; redirectUri: string }>();
const tokens = new Set<string>();

function credentialOf(request: http.IncomingMessage, real: string, surrogate?: string): Credential {
  const header = request.headers.authorization;
  if (!header) return "none";
  const value = header.replace(/^(bearer|token)\s+/i, "");
  if (value === real) return "real";
  if (surrogate !== undefined && value === surrogate) return "surrogate";
  return "other";
}

async function body(request: http.IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

async function bytes(request: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const hostOf = (request: http.IncomingMessage) => (request.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();

async function model(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const credential = credentialOf(request, MODEL_KEY, MODEL_SURROGATE);
  const text = await body(request);
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) return json(response, 404, { error: "not found" });
  const parsed = JSON.parse(text) as { model: string; stream?: boolean; messages: ChatMessage[]; tools?: { function: { name: string } }[] };
  const tools = (parsed.tools ?? []).map((tool) => tool.function.name);
  modelCalls.push({ at: new Date().toISOString(), credential, stream: parsed.stream === true, messages: parsed.messages, tools });
  if (credential !== "real") return json(response, 401, { error: { message: "the model's key is not the real one" } });
  const answer = script(parsed.messages);
  if (!parsed.stream) return json(response, 200, completion(answer, parsed.model));
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const chunk of chunks(answer, parsed.model)) response.write(chunk);
  response.end();
}

let askedHelper = false;

async function helper(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/.well-known/agent-card.json") {
    return json(response, 200, {
      name: "E2E Helper", description: "Returns a diagram.", version: "1", skills: [], capabilities: {},
      defaultInputModes: ["text/plain", "image/png"], defaultOutputModes: ["text/plain", "image/png"],
      supportedInterfaces: [{ url: `https://${HELPER}/a2a/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    });
  }
  if (credentialOf(request, MODEL_KEY) !== "real") return json(response, 401, { error: "wrong credential" });
  if (request.method !== "POST" || request.url !== "/a2a/") return json(response, 404, { error: "not found" });
  const call = JSON.parse(await body(request));
  const ok = (result: unknown) => json(response, 200, { jsonrpc: "2.0", id: call.id, result });
  const task = { id: "e2e-helper-task", contextId: "e2e-helper-context" };
  if (call.method === "SendMessage" && call.params.configuration?.returnImmediately === true &&
      call.params.message?.parts?.some((part: { text?: string }) => part.text === "Describe this diagram") &&
      call.params.message?.parts?.some((part: { raw?: string }) => part.raw === E2E_PNG)) {
    askedHelper = true;
    return ok({ task: { ...task, status: { state: "TASK_STATE_WORKING" } } });
  }
  if (call.method === "GetTask" && call.params.id === task.id && askedHelper) {
    return ok({ ...task, status: { state: "TASK_STATE_COMPLETED" }, artifacts: [{
      artifactId: "e2e-helper-artifact", parts: [{ text: "E2E-ASK-AGENT-DONE" }, { raw: E2E_PNG, mediaType: "image/png", filename: "../diagram.png" }],
    }] });
  }
  return json(response, 400, { error: "unexpected helper request" });
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

async function github(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  if (request.method !== "POST" || request.url !== "/login/oauth/access_token") return json(response, 404, { error: "not found" });
  const form = new URLSearchParams(await body(request));
  const code = codes.get(form.get("code") ?? "");
  codes.delete(form.get("code") ?? "");
  const verifier = form.get("code_verifier") ?? "";
  // GitHub answers a bad exchange with 200 and an `error`.
  if (
    form.get("client_id") !== CLIENT_ID ||
    form.get("client_secret") !== CLIENT_SECRET ||
    !code ||
    code.redirectUri !== form.get("redirect_uri") ||
    s256(verifier) !== code.challenge
  ) {
    return json(response, 200, { error: "bad_verification_code" });
  }
  const token = `gho_e2e_${randomBytes(16).toString("hex")}`;
  tokens.add(token);
  json(response, 200, { access_token: token, token_type: "bearer", scope: "" });
}

function githubApi(request: http.IncomingMessage, response: http.ServerResponse): void {
  const token = (request.headers.authorization ?? "").replace(/^(bearer|token)\s+/i, "");
  if (request.method !== "GET" || request.url !== "/user") return json(response, 404, { error: "not found" });
  if (!tokens.has(token)) return json(response, 401, { message: "Bad credentials" });
  json(response, 200, { id: OWNER_ID, login: "e2e-owner" });
}

function outside(scheme: "https" | "http") {
  return (request: http.IncomingMessage, response: http.ServerResponse) => {
    const host = hostOf(request);
    seen.push({
      at: new Date().toISOString(),
      scheme,
      host,
      method: request.method ?? "",
      path: (request.url ?? "").split("?")[0]!,
      credential: credentialOf(request, MODEL_KEY, MODEL_SURROGATE),
    });
    const handle = async () => {
      if (scheme === "https" && host === MODEL) return model(request, response);
      if (scheme === "https" && host === HELPER) return helper(request, response);
      if (scheme === "https" && host === GITHUB) return github(request, response);
      if (scheme === "https" && host === GITHUB_API) return githubApi(request, response);
      if (scheme === "https" && host === KUBERNETES) return fakeCluster.tokenReview(request, await body(request), response);
      if (scheme === "https" && host === GATED) return fakeCluster.gatedKeys(request, response);
      if (scheme === "https" && host === SLACK) return fakeSlack.api(request, await body(request), response);
      if (scheme === "https" && host === SLACK_FILES) return fakeSlack.file(request, await bytes(request), response);
      if (scheme === "https" && host === APP) {
        await body(request);
        response.writeHead(200, { "content-type": "text/plain" });
        return response.end(`app ${host} ${credentialOf(request, MODEL_KEY, MODEL_SURROGATE)}\n`);
      }
      if (host === PLAIN) {
        await body(request);
        response.writeHead(200, { "content-type": "text/plain" });
        return response.end(`plain over ${scheme}\n`);
      }
      json(response, 404, { error: `no such host here: ${host}` });
    };
    handle().catch((error: unknown) => {
      process.stderr.write(`outside: ${String(error)}\n`);
      if (!response.headersSent) json(response, 500, { error: "the fake failed" });
      else response.end();
    });
  };
}

/** What the test asks: the first step of a login, and what came here. */
async function control(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://control");
  if (request.method === "POST" && url.pathname === "/authorize") {
    // The browser's visit to GitHub's authorize page, where the owner says yes.
    const query = new URLSearchParams((JSON.parse(await body(request)) as { query: string }).query);
    if (query.get("client_id") !== CLIENT_ID || query.get("code_challenge_method") !== "S256") {
      return json(response, 400, { error: "bad authorize request" });
    }
    const code = randomBytes(16).toString("hex");
    codes.set(code, { challenge: query.get("code_challenge") ?? "", redirectUri: query.get("redirect_uri") ?? "" });
    return json(response, 200, { code, state: query.get("state"), redirect_uri: query.get("redirect_uri") });
  }
  if (request.method === "GET" && url.pathname === "/seen") return json(response, 200, { seen, lookups });
  if (request.method === "GET" && url.pathname === "/model") return json(response, 200, { calls: modelCalls });
  if (request.method === "GET" && url.pathname === "/reviews") return json(response, 200, { reviews: fakeCluster.reviews });
  if (request.method === "POST" && url.pathname === "/assertion") {
    // What gated would put on a call of the subject to the host, in place of the token it took.
    const { subject, host } = JSON.parse(await body(request)) as { subject: string; host: string };
    return json(response, 200, { assertion: fakeCluster.assertion(subject, host) });
  }
  const slackAnswer = fakeSlack.control(request.method ?? "", url.pathname, request.method === "POST" ? await body(request) : "");
  if (slackAnswer) return json(response, slackAnswer.status, slackAnswer.value);
  json(response, 404, { error: "not found" });
}

const tls = { cert: readFileSync(env("OUTSIDE_CERT_FILE")), key: readFileSync(env("OUTSIDE_KEY_FILE")) };
https
  .createServer(tls, outside("https"))
  .on("upgrade", (request, socket) => {
    if (hostOf(request) === SLACK_SOCKET) fakeSlack.upgrade(request, socket);
    else socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
  })
  .listen(443);
http.createServer(outside("http")).listen(80);
http.createServer((request, response) => void control(request, response)).listen(8081, "127.0.0.1");
serveDns(53, NAMES, ADDRESS, (lookup) => lookups.push(lookup));
process.stderr.write(`outside: listening on ${ADDRESS}\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => process.exit(0));
