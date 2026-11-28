// What the end-to-end test drives the Pod with: Docker Compose, the backend's
// API for the UI and its stream, the fakes' control API and the Sentinel's
// record.
import { spawnSync } from "node:child_process";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const RUN_DIR = join(E2E_DIR, ".run");

export const composeEnv: Record<string, string> = {};

export type Run = { status: number; stdout: string; stderr: string };

/** `docker compose` in e2e/, with the test's variables. Throws unless asked not to. */
export function compose(args: string[], options: { input?: string; check?: boolean; timeoutMs?: number } = {}): Run {
  const result = spawnSync("docker", ["compose", ...args], {
    cwd: E2E_DIR,
    env: { ...process.env, ...composeEnv },
    input: options.input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs ?? 600_000,
  });
  const run = { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  if ((options.check ?? true) && run.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} exited ${run.status}\n${run.stdout}\n${run.stderr}`);
  }
  return run;
}

/** A shell command in a running container of the Pod. */
export function exec(service: string, command: string, options: { input?: string; check?: boolean } = {}): Run {
  return compose(["exec", "-T", service, "sh", "-c", command], options);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls `probe` until it gives something other than undefined, or throws after `timeoutMs`. */
export async function eventually<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    await sleep(500);
  }
}

export type Answer = { status: number; headers: Record<string, string>; text: string };

/** Where the outside reaches the backend: the Pod's address, set once the Pod is up. */
export const pod = { url: "" };

/** An HTTP request made from the outside container, which is where the owner's browser is. */
export function fromOutside(method: string, url: string, headers: Record<string, string> = {}, body = ""): Answer {
  const run = compose(["exec", "-T", "outside", "node", "/e2e/outside/client.ts", "request", url, method, JSON.stringify(headers)], {
    input: body,
  });
  const answer = JSON.parse(run.stdout) as { status: number; headers: Record<string, string>; body: string };
  return { status: answer.status, headers: answer.headers, text: answer.body };
}

/** The backend's API for the UI, as the owner's browser calls it. */
export class Browser {
  cookie: string | undefined;

  request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Answer {
    const headers = { ...init.headers, ...(this.cookie ? { cookie: this.cookie } : {}) };
    const answer = fromOutside(init.method ?? "GET", new URL(path, pod.url).href, headers, init.body);
    const setCookie = answer.headers["set-cookie"];
    if (setCookie) this.cookie = setCookie.split(";")[0];
    return answer;
  }

  json<T>(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): { status: number; body: T } {
    const answer = this.request(path, init);
    return { status: answer.status, body: (answer.text ? JSON.parse(answer.text) : undefined) as T };
  }
}

export type StreamEvent = { id?: string; event: string; data: unknown };

/** The backend's stream (SSE), read from the outside container, with every event it has sent kept in order. */
export class Stream {
  readonly events: StreamEvent[] = [];
  private child: ChildProcess | undefined;

  open(cookie: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        ["compose", "exec", "-T", "outside", "node", "/e2e/outside/client.ts", "stream", new URL("/api/stream", pod.url).href, cookie],
        { cwd: E2E_DIR, env: { ...process.env, ...composeEnv }, stdio: ["ignore", "pipe", "inherit"] },
      );
      this.child = child;
      let buffer = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (part: string) => {
        buffer += part;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const event = JSON.parse(buffer.slice(0, end)) as StreamEvent;
          buffer = buffer.slice(end + 1);
          if (event.event === "open") resolve();
          else this.events.push(event);
        }
      });
      child.on("exit", (code) => reject(new Error(`the stream ended (${code})`)));
    });
  }

  close(): void {
    this.child?.kill();
  }
}

/** One message of a request the fake model received, as far as the test reads it. */
export type ChatMessage = { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string };
export type ModelCall = { at: string; credential: string; stream: boolean; messages: ChatMessage[]; tools: string[] };
export type Seen = { at: string; scheme: string; host: string; method: string; path: string; credential: string };

async function control<T>(path: string, init: { method?: string; body?: string } = {}): Promise<T> {
  const answer = fromOutside(init.method ?? "GET", `http://127.0.0.1:8081${path}`, {}, init.body);
  if (answer.status !== 200) throw new Error(`the outside's control answered ${answer.status} to ${path}`);
  return JSON.parse(answer.text) as T;
}

export const outside = {
  authorize: (query: string) =>
    control<{ code: string; state: string; redirect_uri: string }>("/authorize", { method: "POST", body: JSON.stringify({ query }) }),
  modelCalls: async () => (await control<{ calls: ModelCall[] }>("/model")).calls,
  seen: async () => (await control<{ seen: Seen[] }>("/seen")).seen,
  /** The pushes the fake push service took, their bodies encrypted, in base64url. */
  pushes: async () =>
    (await control<{ pushes: { at: string; path: string; authorization: string; encoding: string; ttl: string; body: string }[] }>("/pushes")).pushes,
  /** The TokenReviews the fake API server answered. */
  reviews: async () => (await control<{ reviews: { caller: string; outcome: string }[] }>("/reviews")).reviews,
  /** What the fake Slack saw: its connections, the envelopes acknowledged, the Web API calls and the downloads. */
  slack: () =>
    control<{
      connections: number;
      open: number;
      acks: string[];
      calls: { method: string; token: string; args: Record<string, string> }[];
      downloads: { path: string; token: string }[];
      uploads: { path: string; token: string; length: number; png: boolean }[];
    }>("/slack"),
  slackHistory: (messages: unknown[]) => control("/slack/history", { method: "POST", body: JSON.stringify({ messages }) }),
  slackSend: (envelope: unknown) => control("/slack/send", { method: "POST", body: JSON.stringify(envelope) }),
  slackDisconnect: () => control("/slack/disconnect", { method: "POST" }),
  /** What the fake gated would put on a call of `subject` to `host`. */
  assertion: async (subject: string, host: string) =>
    (await control<{ assertion: string }>("/assertion", { method: "POST", body: JSON.stringify({ subject, host }) })).assertion,
};

/**
 * A JSON-RPC call of A2A to the backend's way in, from outside the Pod, as another agent makes it: in A2A 1.0, which
 * the senders name in A2A-Version (a call without it is taken as 0.3).
 */
export function a2aCall(method: string, params: unknown, headers: Record<string, string>): { status: number; body: any } {
  const answer = fromOutside("POST", new URL("/a2a/", pod.url).href, { "content-type": "application/json", "a2a-version": "1.0", ...headers }, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  return { status: answer.status, body: answer.text ? JSON.parse(answer.text) : undefined };
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** The system prompt, the last input, and how many tool results followed it: where in its turn a call is. */
export function where(call: ModelCall): { system: string; input: string; steps: number } {
  const system = call.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => textOf(message.content))
    .join("\n");
  let last = -1;
  call.messages.forEach((message, index) => {
    if (message.role === "user") last = index;
  });
  return {
    system,
    input: last < 0 ? "" : textOf(call.messages[last]!.content),
    steps: call.messages.slice(last + 1).filter((message) => message.role === "tool").length,
  };
}

/** The Sentinel's record so far: its standard output, one JSON object a line. */
export function sentinelRecords(): Record<string, unknown>[] {
  const { stdout } = compose(["logs", "--no-log-prefix", "--no-color", "sentinel"]);
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (typeof record.kind === "string" && typeof record.action === "string") records.push(record);
    } catch {
      // Not a record.
    }
  }
  return records;
}
