// The personal-page API as seen through the App's fetch.
import type {
  AgentResponse,
  RecordDayResponse,
  RecordNightResponse,
  RecordSubAgentResponse,
  RecordTurnResponse,
} from "@penelope/contract";

export class FakeBackend {
  agent: AgentResponse = { name: "Iris" };
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
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), "http://ui.example.com");
    const method = init.method ?? "GET";
    if (url.pathname === "/api/agent") return json(200, this.agent);
    if (url.pathname === "/auth/logout") {
      this.signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (!this.signedIn) return json(401, { error: "not signed in" });
    if (url.pathname.startsWith("/api/record")) return this.record(method, url);
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

}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
