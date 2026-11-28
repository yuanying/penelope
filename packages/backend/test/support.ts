// What the tests share: temporary places, a clock the test moves, and an
// HTTP client that talks over a Unix socket or a TCP port.
import { mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/** A fresh directory, removed when the test ends. */
export function tempDir(t: { after: (fn: () => void) => void }): string {
  // Unix socket paths are short (about 100 bytes), so this stays near /tmp.
  const dir = mkdtempSync(path.join(tmpdir(), "pb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Makes `file` impossible to append to until the returned function is called:
 * a directory takes its place. Unlike a file mode, this holds for root too.
 */
export function unwritable(file: string): () => void {
  renameSync(file, `${file}.away`);
  mkdirSync(file);
  return () => {
    rmdirSync(file);
    renameSync(`${file}.away`, file);
  };
}

/** A clock that only moves when the test says so. */
export class FakeClock {
  ms: number;
  constructor(iso: string) {
    this.ms = Date.parse(iso);
  }
  now = (): number => this.ms;
  advance(minutes: number): void {
    this.ms += minutes * 60_000;
  }
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
}

export type Target = { socketPath: string } | { port: number };

export type Answer = { status: number; headers: http.IncomingHttpHeaders; text: string; body: Buffer; json: () => any };

export type Ask = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array;
  json?: unknown;
};

/** One HTTP request; the whole answer is read. */
export function ask(target: Target, pathname: string, options: Ask = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...options.headers };
  let body = options.body;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["content-type"] ??= "application/json";
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      { ...target, host: "localhost", path: pathname, method: options.method ?? (body ? "POST" : "GET"), headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          const text = body.toString("utf8");
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, body, json: () => JSON.parse(text) });
        });
        response.on("error", reject);
      },
    );
    // A server that answers before it has read the whole body (413) closes
    // the connection under the rest of it; that is not the request failing.
    const closedUnder = (error: NodeJS.ErrnoException) => error.code === "EPIPE" || error.code === "ECONNRESET";
    request.on("error", (error: NodeJS.ErrnoException) => {
      if (!closedUnder(error)) reject(error);
    });
    request.on("socket", (socket) => socket.on("error", () => {}));
    request.end(body);
  });
}

/** A multipart/form-data body, built the way the platform builds one. */
export async function multipart(parts: Array<[name: string, value: string | Blob, filename?: string]>): Promise<{
  body: Buffer;
  contentType: string;
}> {
  const form = new FormData();
  for (const [name, value, filename] of parts) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value, filename);
  }
  const request = new Request("http://localhost/", { method: "POST", body: form });
  return {
    body: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get("content-type") ?? "",
  };
}
