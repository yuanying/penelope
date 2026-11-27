// A client of the backend's API for the sandbox (docs/sandbox-api.md). Every
// request carries the agent and the surrogate token; the Sentinel puts the
// real token in its place.

import type {
  A2AReplyRequest,
  A2AReplyResponse,
  Activity,
  AgentId,
  AgentStatus,
  DeliveredEvent,
  JobEventRequest,
  MemoryRepairRequest,
  ModelCatalog,
  ModelSelectionResponse,
  PollResponse,
  ReplyRequest,
  ReplyResponse,
  Schedule,
  ScheduleListResponse,
  ScheduleWhen,
  SelfEventRequest,
  SessionRotatedRequest,
  SleepRequest,
  SleepResponse,
  SubAgentStatus,
  TurnEndRequest,
} from "@penelope/contract";

export class BackendError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BackendError";
    this.status = status;
  }
}

export interface BackendOptions {
  url: string;
  token: string;
  agent: AgentId;
}

type Without<T> = Omit<T, "agent">;

export class Backend {
  private readonly url: string;
  private readonly token: string;
  readonly agent: AgentId;
  private turns: { last: Promise<void>; prepare?: () => Promise<void> } = { last: Promise.resolve() };

  constructor(options: BackendOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.agent = options.agent;
  }

  /** The same API, called as another agent: a sub-agent's requests carry its name. */
  as(agent: AgentId): Backend {
    const client = new Backend({ url: this.url, token: this.token, agent });
    client.turns = this.turns;
    return client;
  }

  /** `GET /v1/events`: waits up to `wait` seconds for events after `after`. */
  async poll(after: number, wait: number, signal?: AbortSignal): Promise<DeliveredEvent[]> {
    const query = new URLSearchParams({ agent: this.agent, after: String(after), wait: String(wait) });
    const response = (await this.request("GET", `/v1/events?${query}`, undefined, signal)) as PollResponse;
    return response.events;
  }

  async status(signal: AbortSignal): Promise<AgentStatus> {
    const query = new URLSearchParams({ agent: this.agent });
    return (await this.request("GET", `/v1/status?${query}`, undefined, signal)) as AgentStatus;
  }

  async readModelSelection(signal: AbortSignal): Promise<ModelSelectionResponse> {
    const query = new URLSearchParams({ agent: this.agent });
    return (await this.request("GET", `/v1/model-settings?${query}`, undefined, signal)) as ModelSelectionResponse;
  }

  async reportModels(catalog: ModelCatalog, signal: AbortSignal): Promise<ModelSelectionResponse> {
    return (await this.request("PUT", "/v1/model-settings", { agent: this.agent, ...catalog }, signal)) as ModelSelectionResponse;
  }

  async ack(seqs: number[]): Promise<void> {
    await this.post("/v1/events/ack", { seqs });
  }

  async activity(activities: Activity[]): Promise<void> {
    await this.post("/v1/activity", { activities });
  }

  beforeTurnEnd(prepare: () => Promise<void>): void {
    this.turns.prepare = prepare;
  }

  /** `POST /v1/turns/end`: the backend commits /memory, and records how the turn went (ADR-0038). */
  async turnEnd(end: Without<TurnEndRequest>, afterCommit?: () => Promise<void>): Promise<void> {
    // A sub-agent's turn end commits the entire working tree too. Keep it
    // from committing a curator turn's reference edits before their own commit.
    const next = this.turns.last.then(async () => {
      await this.turns.prepare?.();
      await this.post("/v1/turns/end", end);
      await afterCommit?.();
    });
    this.turns.last = next.catch(() => {});
    await next;
  }

  async commitMemoryRepairs(repair: Without<MemoryRepairRequest>): Promise<void> {
    await this.post("/v1/memory/repairs", repair);
  }

  async reply(reply: Without<ReplyRequest>): Promise<ReplyResponse> {
    return (await this.post("/v1/replies", reply)) as ReplyResponse;
  }

  async sleep(request: Without<SleepRequest>): Promise<SleepResponse> {
    return (await this.post("/v1/sleep", request)) as SleepResponse;
  }

  async a2aReply(reply: Without<A2AReplyRequest>): Promise<A2AReplyResponse> {
    return (await this.post("/v1/a2a/replies", reply)) as A2AReplyResponse;
  }

  async selfEvent(event: Without<SelfEventRequest>): Promise<void> {
    await this.post("/v1/self-events", event);
  }

  /** `POST /v1/job-events`: a background job of the main agent ended. */
  async jobEvent(event: Without<JobEventRequest>): Promise<void> {
    await this.post("/v1/job-events", event);
  }

  /** `POST /v1/agents`: this agent, a sub-agent, was started or closed. */
  async subAgentStatus(status: Without<SubAgentStatus>): Promise<void> {
    await this.post("/v1/agents", status);
  }

  async createSchedule(schedule: { reason: string } & ScheduleWhen): Promise<Schedule> {
    return (await this.post("/v1/schedules", schedule)) as Schedule;
  }

  async listSchedules(): Promise<Schedule[]> {
    const query = new URLSearchParams({ agent: this.agent });
    return ((await this.request("GET", `/v1/schedules?${query}`)) as ScheduleListResponse).schedules;
  }

  async deleteSchedule(id: string): Promise<void> {
    const query = new URLSearchParams({ agent: this.agent });
    await this.request("DELETE", `/v1/schedules/${encodeURIComponent(id)}?${query}`);
  }

  /** `POST /v1/sessions/rotated`: the nightly switch of `seq` was run, its steps as `stages` (ADR-0038). */
  async rotated(rotation: Without<SessionRotatedRequest>): Promise<void> {
    await this.post("/v1/sessions/rotated", rotation);
  }

  private post(path: string, body: object): Promise<unknown> {
    return this.request("POST", path, { agent: this.agent, ...body });
  }

  private async request(method: string, path: string, body?: object, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // Not JSON: keep the text as it came.
      }
      throw new BackendError(response.status, `${method} ${path.split("?")[0]}: ${response.status} ${detail}`.trim());
    }
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
}
