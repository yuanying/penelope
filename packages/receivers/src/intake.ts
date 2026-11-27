// Sending an event to the backend's intake: `POST /v1/events` on its Unix
// socket (docs/events.md, "取り込み口"). Only a 202 is taken; anything else,
// no connection, or no answer in time is not. An event with files goes as
// multipart/form-data: the envelope in the `event` part, each file in a
// `file` part.
import { randomBytes } from "node:crypto";
import http from "node:http";

import type { AgentStatus, Event } from "@penelope/contract";

export type IntakeAnswer = { taken: true } | { taken: false; why: string };

/** A file sent with an event, as one of its attachments. */
export type IntakeFile = { name: string; type: string; data: Uint8Array };

/** How much of a refusal's body is kept for the log. */
const KEPT_BYTES = 1024;

/** The body and its type: JSON, or multipart/form-data when there are files. */
function bodyOf(event: Event, files: readonly IntakeFile[]): { type: string; body: Buffer } {
  const json = Buffer.from(JSON.stringify(event), "utf8");
  if (files.length === 0) return { type: "application/json", body: json };
  const boundary = `penelope-${randomBytes(16).toString("hex")}`;
  // A quote, a backslash or a line break would end the header's value; the backend makes the name safe for /sources itself.
  const quoted = (name: string) => name.replace(/[\u0000-\u001f"\\\u007f]/g, "_");
  const parts: Buffer[] = [
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="event"\r\ncontent-type: application/json\r\n\r\n`),
    json,
  ];
  for (const file of files) {
    parts.push(
      Buffer.from(`\r\n--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${quoted(file.name)}"\r\ncontent-type: ${file.type || "application/octet-stream"}\r\n\r\n`),
      Buffer.from(file.data),
    );
  }
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { type: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

export function sendEvent(socketPath: string, event: Event, timeoutMs: number, files: readonly IntakeFile[] = []): Promise<IntakeAnswer> {
  const { type, body } = bodyOf(event, files);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: IntakeAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const request = http.request(
      { socketPath, path: "/v1/events", method: "POST", headers: { "content-type": type, "content-length": body.length } },
      (response) => {
        const parts: Buffer[] = [];
        let kept = 0;
        response.on("data", (part: Buffer) => {
          if (kept < KEPT_BYTES) parts.push(part);
          kept += part.length;
        });
        response.on("end", () => {
          if (response.statusCode === 202) return settle({ taken: true });
          const text = Buffer.concat(parts).toString("utf8").slice(0, KEPT_BYTES).replace(/\s+/g, " ").trim();
          settle({ taken: false, why: `answered ${response.statusCode}${text ? ` ${text}` : ""}` });
        });
        response.on("error", (error) => settle({ taken: false, why: error.message }));
      },
    );
    const timer = setTimeout(() => {
      settle({ taken: false, why: `no answer in ${timeoutMs / 1000}s` });
      request.destroy();
    }, timeoutMs);
    request.on("error", (error) => settle({ taken: false, why: error.message }));
    request.end(body);
  });
}

export async function readStatus(socketPath: string, timeoutMs: number): Promise<AgentStatus | undefined> {
  const text = await pluginRequest(socketPath, timeoutMs, "/v1/status", "GET", 200);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as AgentStatus;
  } catch {
    return undefined;
  }
}

export async function writeHeartbeatNote(socketPath: string, timeoutMs: number, source: string, note: unknown): Promise<boolean> {
  let body: string | undefined;
  if (note !== undefined) {
    try {
      body = JSON.stringify(note);
    } catch {
      return false;
    }
    if (body === undefined) return false;
  }
  const path = `/v1/heartbeat-notes/${encodeURIComponent(source)}`;
  return (await pluginRequest(socketPath, timeoutMs, path, body === undefined ? "DELETE" : "PUT", 204, body)) !== undefined;
}

async function pluginRequest(
  socketPath: string, timeoutMs: number, path: string, method: string, expected: number, body?: string,
): Promise<string | undefined> {
  try {
    const headers = body === undefined ? undefined : { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request({ socketPath, path, method, headers, signal: AbortSignal.timeout(timeoutMs) }, resolve);
      request.on("error", reject);
      request.end(body);
    });
    if (response.statusCode !== expected) {
      response.destroy();
      return undefined;
    }
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const part of response as AsyncIterable<Buffer>) {
      bytes += part.length;
      if (bytes > 4 * 1024) return undefined;
      parts.push(part);
    }
    return Buffer.concat(parts).toString("utf8");
  } catch {
    return undefined;
  }
}
