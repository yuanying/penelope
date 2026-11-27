// The house's API for people (docs/house.md, 人の画面の API). To enter, to
// leave and to speak carry the connection of the stream open in this tab.
import type { HouseHistory, HousePersonView, HouseSpeech, HouseSpeechResult } from "@penelope/contract";

export type Fetch = typeof fetch;

export class Unauthorized extends Error {}

/** `code` is the `error` of the house's answer. */
export class Refused extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

export type Api = {
  house: () => Promise<HousePersonView>;
  /** A page of a room's record, newest first. `before` is the cursor the page read before it gave. */
  history: (room: string, before?: string) => Promise<HouseHistory>;
  enter: (room: string, connection: string) => Promise<HousePersonView>;
  leave: (connection: string) => Promise<void>;
  say: (room: string, speech: HouseSpeech, connection: string) => Promise<HouseSpeechResult>;
  logout: () => Promise<void>;
};

export function createApi(fetch: Fetch): Api {
  const call = async (path: string, init: { method?: string; connection?: string; body?: unknown } = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init.connection !== undefined) headers["x-house-connection"] = init.connection;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (response.status === 401) throw new Unauthorized();
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new Refused(response.status, typeof body.error === "string" ? body.error : "");
    }
    return response;
  };
  const room = (id: string) => `/api/rooms/${encodeURIComponent(id)}`;
  return {
    house: async () => (await (await call("/api/house")).json()) as HousePersonView,
    history: async (id, before) =>
      (await (await call(`${room(id)}/history${before === undefined ? "" : `?before=${encodeURIComponent(before)}`}`)).json()) as HouseHistory,
    enter: async (id, connection) => (await (await call(`${room(id)}/enter`, { method: "POST", connection })).json()) as HousePersonView,
    leave: async (connection) => {
      await call("/api/room", { method: "DELETE", connection });
    },
    say: async (id, speech, connection) =>
      (await (await call(`${room(id)}/say`, { method: "POST", connection, body: speech })).json()) as HouseSpeechResult,
    logout: async () => {
      await call("/auth/logout", { method: "POST" });
    },
  };
}
