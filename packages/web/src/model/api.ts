// The backend's API for the UI (docs/ui-api.md), over a fetch that the tests
// replace.
import type {
  AgentResponse,
  AgentStatus,
  MemoryChangeResponse,
  MemoryChangesResponse,
  MemoryCompareResponse,
  MemoryFileDiff,
  MemoryFileResponse,
  MemoryHistoryResponse,
  MemoryOverviewResponse,
  MemorySaveRequest,
  MemorySaveResponse,
  MemorySearchResponse,
  MemoryWriterFilter,
  ModelSelection,
  RecordDayResponse,
  RecordKind,
  RecordNightResponse,
  RecordResultResponse,
  RecordSeenResponse,
  RecordSubAgentResponse,
  RecordTurnResponse,
  RecordUnseenResponse,
  SchedulesResponse,
  SettingsResponse,
  SubAgentsResponse,
} from "@penelope/contract";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The session is gone or never was: the owner has to log in. */
export class Unauthorized extends Error {}
/** The backend could not be reached. */
export class Unreachable extends Error {}
/** The backend answered with a refusal. */
export class Refused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Api = {
  agent(): Promise<AgentResponse>;
  logout(): Promise<void>;
  status(): Promise<AgentStatus>;
  agents(): Promise<SubAgentsResponse>;
  schedules(): Promise<SchedulesResponse>;
  removeSchedule(id: string): Promise<void>;
  settings(): Promise<SettingsResponse>;
  saveSettings(selection: ModelSelection): Promise<SettingsResponse>;
  /** One day of the activity record, newest first, narrowed as asked; today when no day is given. */
  record(query: RecordQuery): Promise<RecordDayResponse>;
  recordTurn(id: string): Promise<RecordTurnResponse>;
  /** The whole output of one tool's result in a turn; Refused with 404 when it is gone. */
  recordResult(turn: string, call: string): Promise<RecordResultResponse>;
  recordNight(id: string): Promise<RecordNightResponse>;
  recordSubAgent(name: string, before?: string): Promise<RecordSubAgentResponse>;
  /** How many failures the owner has not seen. */
  recordUnseen(): Promise<RecordUnseenResponse>;
  /** The owner opened the record now: what was unseen until now, and when she opened it before. */
  recordSeen(): Promise<RecordSeenResponse>;
  memory(tz: string): Promise<MemoryOverviewResponse>;
  memoryFile(path: string, head?: string): Promise<MemoryFileResponse>;
  memoryChanges(writer: MemoryWriterFilter, tz: string, head?: string, before?: string): Promise<MemoryChangesResponse>;
  memoryChange(id: string): Promise<MemoryChangeResponse>;
  memoryDiff(id: string, path: string): Promise<MemoryFileDiff>;
  memoryHistory(path: string, head?: string, before?: string): Promise<MemoryHistoryResponse>;
  memoryCompare(path: string, from: string, to: string): Promise<MemoryCompareResponse>;
  memorySearch(q: string, head?: string): Promise<MemorySearchResponse>;
  memorySave(body: MemorySaveRequest): Promise<MemorySaveResponse>;
};

/** The narrowing of `GET /api/record` (docs/ui-api.md, "活動の記録"). */
export type RecordQuery = { day?: string; tz: string; failed?: boolean; agent?: string; kind?: RecordKind };

export function createApi(fetch: Fetch): Api {
  const call = async (path: string, init: RequestInit = {}, accepted: readonly number[] = []): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(path, { credentials: "same-origin", ...init });
    } catch (error) {
      throw new Unreachable(error instanceof Error ? error.message : String(error));
    }
    if (response.status === 401) throw new Unauthorized();
    if (!response.ok && !accepted.includes(response.status)) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Refused(response.status, body.error ?? response.statusText);
    }
    return response;
  };

  const memory = async <T,>(path: string, params: Record<string, string | undefined> = {}): Promise<T> => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, value);
    return (await call(`/api/memory${path}${query.size === 0 ? "" : `?${query}`}`)).json() as Promise<T>;
  };

  return {
    memory: (tz) => memory("", { tz }),
    memoryFile: (path, head) => memory("/file", { path, head }),
    memoryChanges: (writer, tz, head, before) => memory("/changes", { writer, tz, head, before }),
    memoryChange: (id) => memory(`/changes/${encodeURIComponent(id)}`),
    memoryDiff: (id, path) => memory(`/changes/${encodeURIComponent(id)}/diff`, { path }),
    memoryHistory: (path, head, before) => memory("/history", { path, head, before }),
    memoryCompare: (path, from, to) => memory("/compare", { path, from, to }),
    memorySearch: (q, head) => memory("/search", { q, head }),
    memorySave: async (body) => {
      const response = await call("/api/memory/save", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }, [403, 409, 422]);
      const result = await response.json() as MemorySaveResponse | { error: string };
      if (!("kind" in result)) throw new Refused(response.status, result.error);
      return result;
    },
    agent: async () => (await call("/api/agent")).json() as Promise<AgentResponse>,
    logout: async () => {
      await call("/auth/logout", { method: "POST" });
    },
    status: async () => (await call("/api/status")).json() as Promise<AgentStatus>,
    agents: async () => (await call("/api/agents")).json() as Promise<SubAgentsResponse>,
    schedules: async () => (await call("/api/schedules")).json() as Promise<SchedulesResponse>,
    removeSchedule: async (id) => {
      await call(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    settings: async () => (await call("/api/settings")).json() as Promise<SettingsResponse>,
    saveSettings: async (selection) => (await call("/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(selection),
    })).json() as Promise<SettingsResponse>,
    record: async ({ day, tz, failed, agent, kind }) => {
      const query = new URLSearchParams({ tz });
      if (day !== undefined) query.set("day", day);
      if (failed) query.set("failed", "1");
      if (agent !== undefined) query.set("agent", agent);
      if (kind !== undefined) query.set("kind", kind);
      return (await call(`/api/record?${query}`)).json() as Promise<RecordDayResponse>;
    },
    recordTurn: async (id) => (await call(`/api/record/turns/${encodeURIComponent(id)}`)).json() as Promise<RecordTurnResponse>,
    recordResult: async (turn, callId) =>
      (await call(`/api/record/turns/${encodeURIComponent(turn)}/results/${encodeURIComponent(callId)}`)).json() as Promise<RecordResultResponse>,
    recordNight: async (id) => (await call(`/api/record/nights/${encodeURIComponent(id)}`)).json() as Promise<RecordNightResponse>,
    recordSubAgent: async (name, before) =>
      (
        await call(`/api/record/sub-agents/${encodeURIComponent(name)}${before === undefined ? "" : `?before=${encodeURIComponent(before)}`}`)
      ).json() as Promise<RecordSubAgentResponse>,
    recordUnseen: async () => (await call("/api/record/unseen")).json() as Promise<RecordUnseenResponse>,
    recordSeen: async () => (await call("/api/record/seen", { method: "POST" })).json() as Promise<RecordSeenResponse>,
  };
}
