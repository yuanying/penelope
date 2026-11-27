// What the backend's HTTP servers share: reading a body within a
// limit, answering JSON, and listening on a Unix socket or a TCP port.
import { chmodSync, rmSync } from "node:fs";
import http from "node:http";

import type { ErrorBody } from "@penelope/contract";

export type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => Promise<void>;

/** A refusal with its status, answered as `{error}`. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The whole body, or 413 when it is longer than `limit` bytes. */
export async function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, `the body is over ${limit} bytes`);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > limit) throw new HttpError(413, `the body is over ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The body parsed as JSON, or 400. */
export async function readJson(request: http.IncomingMessage, limit: number): Promise<unknown> {
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}

/** A multipart/form-data body, parsed by the platform. 400 when it cannot be. */
export async function readForm(request: http.IncomingMessage, limit: number): Promise<FormData> {
  const body = await readBody(request, limit);
  try {
    return await new Response(new Uint8Array(body), { headers: { "content-type": String(request.headers["content-type"]) } }).formData();
  } catch {
    throw new HttpError(400, "the body is not multipart/form-data");
  }
}

export function isMultipart(request: http.IncomingMessage): boolean {
  return (request.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data");
}

export function sendJson(response: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(text);
}

export function sendError(response: http.ServerResponse, status: number, error: string, headers: http.OutgoingHttpHeaders = {}): void {
  sendJson(response, status, { error } satisfies ErrorBody, headers);
}

export function sendEmpty(response: http.ServerResponse, status: number, headers: http.OutgoingHttpHeaders = {}): void {
  response.writeHead(status, headers);
  response.end();
}

/**
 * The handler wrapped so that an HttpError becomes its answer and anything
 * else a 500 that says nothing of what went wrong; that is logged instead.
 */
export function serve(handler: Handler, log: (line: string) => void = console.error): http.RequestListener {
  return (request, response) => {
    handler(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message);
        return;
      }
      log(`${request.method} ${request.url}: ${error instanceof Error ? error.stack : String(error)}`);
      sendError(response, 500, "internal error");
    });
  };
}

/**
 * Listens on a Unix socket. A socket left by an earlier run is removed first.
 * The socket is writable by everyone who can see it: who may send is decided
 * by which containers mount its volume (ADR-0002, ADR-0014).
 */
export async function listenUnix(handler: Handler, socketPath: string, log?: (line: string) => void): Promise<http.Server> {
  rmSync(socketPath, { force: true });
  const server = http.createServer(serve(handler, log));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(socketPath, 0o666);
  return server;
}

export async function listenTcp(handler: Handler, host: string, port: number, log?: (line: string) => void): Promise<http.Server> {
  const server = http.createServer(serve(handler, log));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/** Closes the server, cutting the connections still open (long polls and streams). */
export function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
