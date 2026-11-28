// A stand-in for the backend's API for the sandbox (docs/sandbox-api.md), on a
// loopback port. It keeps what it was sent so that the tests can look at it,
// and hands events over the way the backend does: in seq order, one never
// handed over whatever `after` says, and one handed over but not acked again
// after a while (the backend's 5 minutes are `redeliverMs` here).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { AgentStatus, DeliveredEvent, JobEventRequest, ModelSelection, Schedule, SelfEventRequest, SleepResponse } from "@penelope/contract";

export const TOKEN = "real-token-example";

export interface Received {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | undefined;
  /** For a poll, the seqs it answered with, once it has answered. */
  answered?: number[];
}

export class FakeBackend {
  readonly received: Received[] = [];
  readonly url: Promise<string>;
  modelSelection: ModelSelection | null = null;
  status: AgentStatus | undefined;
  sleepResponse: SleepResponse | undefined;
  /** Seqs whose ack is dropped, as if the runner had stopped before it reached the backend. */
  readonly dropAcks = new Set<number>();
  private readonly events: DeliveredEvent[] = [];
  private readonly acked = new Set<number>();
  /** When each event was last handed over. */
  private readonly handed = new Map<number, number>();
  redeliverMs = 300;
  /** How many of the next self-events are refused with a 503, as if the backend were away. */
  failSelfEvents = 0;
  /** The self-events the backend took, in order. */
  readonly selfEvents: SelfEventRequest[] = [];
  /** How many of the next job events are refused with a 503. */
  failJobEvents = 0;
  /** The job events the backend took, in order; one sent again is there again. */
  readonly jobEvents: JobEventRequest[] = [];
  private readonly schedules: Schedule[] = [];
  private waiters: (() => void)[] = [];
  private replies = 0;
  refuseReplies: string | undefined;
  houseReplyResult: unknown;
  refuseMemoryRepairs = false;
  failRotationReports = 0;
  private readonly server: Server;

  constructor() {
    this.server = createServer((request, response) => void this.handle(request, response));
    this.url = new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(this.server.address() as AddressInfo).port}`);
      });
    });
  }

  /** Queue an event; the next poll hands it over. */
  push(event: DeliveredEvent): void {
    this.events.push(event);
    this.events.sort((a, b) => a.seq - b.seq);
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** What was sent to one path, in order. */
  sent(method: string, path: string): unknown[] {
    return this.received.filter((r) => r.method === method && r.path === path).map((r) => r.body);
  }

  /**
   * Whether the runner has polled again since `seq` was handed over for the
   * `times`th time. The runner takes a poll's events in before it polls
   * again, so this is the moment it has them, with no waiting on the clock.
   */
  polledAfter(seq: number, times = 1): boolean {
    const polls = this.received.filter((r) => r.method === "GET" && r.path === "/v1/events");
    const handed = polls.filter((r) => r.answered?.includes(seq));
    if (handed.length < times) return false;
    return polls.indexOf(handed[times - 1]!) < polls.length - 1;
  }

  /** The order of the requests that change something, as `METHOD path`. */
  order(): string[] {
    return this.received.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
  }

  async close(): Promise<void> {
    for (const wake of this.waiters.splice(0)) wake();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private available(after: number): DeliveredEvent[] {
    const now = Date.now();
    return this.events.filter((event) => {
      if (this.acked.has(event.seq)) return false;
      const handed = this.handed.get(event.seq);
      return handed === undefined || event.seq > after || now - handed >= this.redeliverMs;
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://backend");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? (JSON.parse(text) as unknown) : undefined;
    const received: Received = {
      method: request.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      authorization: request.headers.authorization,
    };
    this.received.push(received);
    const answer = (status: number, value?: unknown) => {
      if (value === undefined) {
        response.writeHead(status).end();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    if (received.authorization !== `Bearer ${TOKEN}`) return answer(401, { error: "unauthorized" });

    const key = `${received.method} ${received.path}`;
    if (key === "GET /v1/events") {
      const after = Number(received.query.after ?? "0");
      const wait = Math.min(Number(received.query.wait ?? "0"), 2);
      if (this.available(after).length === 0 && wait > 0) {
        const again = setInterval(() => {
          if (this.available(after).length > 0) for (const wake of this.waiters.splice(0)) wake();
        }, 50);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, wait * 1000);
          this.waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        clearInterval(again);
      }
      const events = this.available(after);
      for (const event of events) this.handed.set(event.seq, Date.now());
      received.answered = events.map((event) => event.seq);
      return answer(200, { events });
    }
    if (key === "GET /v1/status" && this.status) return answer(200, this.status);
    if (key === "PUT /v1/model-settings") return answer(200, { selection: this.modelSelection });
    if (key === "POST /v1/events/ack") {
      for (const seq of (body as { seqs: number[] }).seqs) if (!this.dropAcks.has(seq)) this.acked.add(seq);
      return answer(204);
    }
    if (key === "POST /v1/sleep" && this.sleepResponse) return answer(200, this.sleepResponse);
    if (key === "POST /v1/mood") return answer(204);
    if (key === "POST /v1/agent/reply") {
      if (this.refuseReplies !== undefined) return answer(400, { error: this.refuseReplies });
      return answer(200, this.houseReplyResult ?? {
        id: `r-${++this.replies}`,
        destination: { kind: "dm", dm: { agent_id: "ivy", owner_id: "lee" } },
        not_delivered: [],
      });
    }
    if (key === "POST /v1/a2a/replies") {
      const { in_reply_to, state } = body as { in_reply_to: number; state: string };
      return in_reply_to === 404 ? answer(404, { error: "the event 404 is not a message of an A2A task" }) : answer(200, { task_id: "t-1", state });
    }
    if (key === "POST /v1/schedules") {
      const { agent, reason, cron, at } = body as Schedule;
      const schedule = { id: `s-${this.schedules.length + 1}`, agent, reason, ...(cron ? { cron } : { at }) } as Schedule;
      this.schedules.push(schedule);
      return answer(201, schedule);
    }
    if (key === "GET /v1/schedules") return answer(200, { schedules: this.schedules });
    if (received.method === "DELETE" && received.path.startsWith("/v1/schedules/")) {
      const id = decodeURIComponent(received.path.slice("/v1/schedules/".length));
      const index = this.schedules.findIndex((s) => s.id === id);
      if (index < 0) return answer(404, { error: "no such schedule" });
      this.schedules.splice(index, 1);
      return answer(204);
    }
    if (key === "POST /v1/self-events" && this.failSelfEvents > 0) {
      this.failSelfEvents--;
      return answer(503, { error: "unavailable" });
    }
    if (key === "POST /v1/self-events") this.selfEvents.push(body as SelfEventRequest);
    if (key === "POST /v1/job-events" && this.failJobEvents > 0) {
      this.failJobEvents--;
      return answer(503, { error: "unavailable" });
    }
    if (key === "POST /v1/job-events") {
      this.jobEvents.push(body as JobEventRequest);
      return answer(202);
    }
    if (key === "POST /v1/memory/repairs") {
      return this.refuseMemoryRepairs ? answer(503, { error: "unavailable" }) : answer(204);
    }
    if (key === "POST /v1/sessions/rotated" && this.failRotationReports > 0) {
      this.failRotationReports--;
      return answer(503, { error: "unavailable" });
    }
    if (
      key === "POST /v1/agents" ||
      key === "POST /v1/activity" ||
      key === "POST /v1/turns/end" ||
      key === "POST /v1/self-events" ||
      key === "POST /v1/sessions/rotated"
    ) {
      return answer(204);
    }
    return answer(404, { error: "not found" });
  }
}

/** Wait until `check` holds, or fail after `ms`. */
export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
