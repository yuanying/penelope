// A stand-in for the backend's API for the UI (docs/ui-api.md), answered
// through the fetch the App is given. The test writes to the stream as the
// backend would, and drops the line when it wants.
import type {
  AgentResponse,
  HistoryEntry,
  PushSubscriptionRequest,
  RecordDayResponse,
  RecordNightResponse,
  RecordSubAgentResponse,
  RecordTurnResponse,
  ScheduleEntry,
  StreamEvent,
  SubAgent,
} from "@penelope/contract";

type Line = { write: (text: string) => void; end: () => void };

export class FakeBackend {
  agent: AgentResponse = { name: "Iris" };
  history: HistoryEntry[] = [];
  /** The sub-agents that are not closed, as GET /api/agents lists them. */
  agents: SubAgent[] = [];
  /** How many times GET /api/agents was read. */
  agentsRead = 0;
  /** Her schedules, as GET /api/schedules lists them. */
  schedules: ScheduleEntry[] = [];
  /** The ids DELETE /api/schedules/<id> was asked for, removed or not. */
  readonly scheduleRemovals: string[] = [];
  /** While set, DELETE /api/schedules/<id> answers 500. */
  failRemovals = false;
  /** The pages of the history GET /api/history?before= answers, by cursor. */
  readonly historyPages = new Map<string, HistoryEntry[]>();
  /** The cursors GET /api/history was read with. */
  readonly historyBefores: string[] = [];
  readonly readThrough: string[] = [];
  /** The activity record's days, by `YYYY-MM-DD`; GET /api/record without a day answers `today`. */
  readonly recordDays = new Map<string, RecordDayResponse>();
  today = "2026-11-17";
  /** The queries GET /api/record was read with. */
  readonly recordQueries: URLSearchParams[] = [];
  readonly recordTurns = new Map<string, RecordTurnResponse>();
  /** The outputs of the tools' results, by `<turn>/<call>`. */
  readonly recordResults = new Map<string, string>();
  readonly recordNights = new Map<string, RecordNightResponse>();
  /** A sub-agent's pages, by name and then by cursor ("" for the first). */
  readonly recordSubAgents = new Map<string, Map<string, RecordSubAgentResponse>>();
  unseen = 0;
  /** When the owner opened the record before, as POST /api/record/seen answers. */
  previousSeenAt = "2026-11-17T00:00:00.000Z";
  /** How many times POST /api/record/seen was sent. */
  seenTold = 0;
  signedIn = true;
  /** While down, nothing can be reached. */
  down = false;
  readonly posted: Array<{ text: string; files: string[] }> = [];
  /** The deployment's VAPID public key; without one, there is no Web Push. */
  pushKey: string | undefined = undefined;
  /** The subscriptions registered, by endpoint, as the backend keeps them. */
  readonly subscriptions = new Map<string, PushSubscriptionRequest>();
  readonly streamHeaders: Headers[] = [];
  private lines: Line[] = [];
  private nextId = 1;
  private waiters: Array<() => void> = [];

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), "http://ui.example.com");
    const method = init.method ?? "GET";
    if (this.down) throw new TypeError("network down");
    if (url.pathname === "/api/agent") return json(200, this.agent);
    if (url.pathname === "/auth/logout") {
      this.signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (!this.signedIn) return json(401, { error: "not signed in" });
    if (method === "GET" && url.pathname === "/api/history") {
      const before = url.searchParams.get("before");
      if (before === null) return json(200, { entries: [...this.history].reverse() });
      this.historyBefores.push(before);
      return json(200, { entries: this.historyPages.get(before) ?? [] });
    }
    if (method === "POST" && url.pathname === "/api/history/read") {
      this.readThrough.push((JSON.parse(String(init.body)) as { through: string }).through);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.startsWith("/api/record")) return this.record(method, url);
    if (method === "GET" && url.pathname === "/api/agents") {
      this.agentsRead++;
      return json(200, { agents: this.agents });
    }
    if (method === "GET" && url.pathname === "/api/schedules") return json(200, { schedules: this.schedules });
    const scheduleId = /^\/api\/schedules\/([^/]+)$/.exec(url.pathname)?.[1];
    if (method === "DELETE" && scheduleId !== undefined) {
      const id = decodeURIComponent(scheduleId);
      this.scheduleRemovals.push(id);
      if (this.failRemovals) return json(500, { error: "broken" });
      const before = this.schedules.length;
      this.schedules = this.schedules.filter((schedule) => schedule.id !== id);
      return this.schedules.length < before ? new Response(null, { status: 204 }) : json(404, { error: "no such schedule" });
    }
    if (method === "GET" && url.pathname === "/api/push") return json(200, this.pushKey === undefined ? {} : { web_push: { public_key: this.pushKey } });
    if (method === "POST" && url.pathname === "/api/push/subscriptions") {
      if (this.pushKey === undefined) return json(503, { error: "web-push-not-configured" });
      const subscription = JSON.parse(String(init.body)) as PushSubscriptionRequest;
      this.subscriptions.set(subscription.endpoint, subscription);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.pathname === "/api/push/subscriptions/delete") {
      this.subscriptions.delete((JSON.parse(String(init.body)) as { endpoint: string }).endpoint);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.pathname === "/api/messages") {
      let text = "";
      let sent: File[] = [];
      if (init.body instanceof FormData) {
        text = String(init.body.get("text") ?? "");
        sent = init.body.getAll("file") as File[];
      } else {
        text = (JSON.parse(String(init.body)) as { text: string }).text;
      }
      this.posted.push({ text, files: sent.map((file) => file.name) });
      const id = `m-${this.posted.length}`;
      // As the backend does (ADR-0034): the images are copied, the other files kept by name.
      const images = sent.filter((file) => file.type.startsWith("image/")).map((file, i) => ({ id: `${id}-a-${i + 1}`, mime_type: file.type, size: file.size, name: file.name }));
      const others = sent.filter((file) => !file.type.startsWith("image/")).map((file) => ({ name: file.name, size: file.size }));
      const kept = { ...(images.length === 0 ? {} : { images }), ...(others.length === 0 ? {} : { files: others }) };
      this.history.push({ kind: "owner", id, at: new Date().toISOString(), text, ...kept });
      return json(202, { id, ...kept });
    }
    if (url.pathname === "/api/stream") {
      this.streamHeaders.push(new Headers(init.headers));
      let line!: Line;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          line = {
            write: (text) => controller.enqueue(encoder.encode(text)),
            end: () => controller.close(),
          };
        },
      });
      this.lines.push(line);
      line.write(": stream\n\n");
      for (const waiter of this.waiters.splice(0)) waiter();
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return json(404, { error: "no such path" });
  };

  private record(method: string, url: URL): Response {
    const path = url.pathname;
    if (method === "GET" && path === "/api/record") {
      this.recordQueries.push(url.searchParams);
      const day = url.searchParams.get("day") ?? this.today;
      return json(200, this.recordDays.get(day) ?? { day, rows: [], turns: 0, failures: 0, agents: [] });
    }
    if (method === "GET" && path === "/api/record/unseen") return json(200, { unseen: this.unseen });
    if (method === "POST" && path === "/api/record/seen") {
      this.seenTold++;
      const answer = { unseen: this.unseen, previous_seen_at: this.previousSeenAt };
      this.unseen = 0;
      return json(200, answer);
    }
    const parts = path.split("/").slice(3).map(decodeURIComponent);
    if (method === "GET" && parts[0] === "turns" && parts.length === 4 && parts[2] === "results") {
      const output = this.recordResults.get(`${parts[1]}/${parts[3]}`);
      return output === undefined ? json(404, { error: "gone" }) : json(200, { output });
    }
    const found =
      parts.length !== 2
        ? undefined
        : parts[0] === "turns"
          ? this.recordTurns.get(parts[1]!)
          : parts[0] === "nights"
            ? this.recordNights.get(parts[1]!)
            : parts[0] === "sub-agents"
              ? this.recordSubAgents.get(parts[1]!)?.get(url.searchParams.get("before") ?? "")
              : undefined;
    return found === undefined ? json(404, { error: "no such record" }) : json(200, found);
  }

  /** Waits until the UI has the stream open, `count` times in all. */
  async connected(count = 1): Promise<void> {
    while (this.lines.length < count) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  send(event: StreamEvent): void {
    this.lines.at(-1)!.write(`id: ${this.nextId++}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  /** The line drops, and stays down until `up()`. */
  drop(): void {
    this.down = true;
    this.lines.at(-1)?.end();
  }

  up(): void {
    this.down = false;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
