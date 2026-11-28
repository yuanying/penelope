// A stand-in for the house's API for people (docs/house.md), answered through
// the fetch and the stream the app is given. The test moves the residents,
// writes to the stream as the house would, and drops the line when it wants.
import type { HouseEvent, HousePersonEvent, HousePersonOccupant, HousePersonView, HouseSpeech, HouseSpeechResult } from "@penelope/contract";

import type { Source } from "../src/model/session.ts";

type Listener = (message: { data: string }) => void;

class FakeSource implements Source {
  readonly url: string;
  readyState = 0;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as Listener]);
  }

  close(): void {
    this.readyState = 2;
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
  }
}

export const LEE = { id: "lee", name: "Lee", kind: "person" } as const;
export const IVY = { id: "ivy", name: "Ivy", kind: "agent" } as const;
export const FERN = { id: "fern", name: "Fern", kind: "agent" } as const;

export const awake = (actor: typeof IVY | typeof FERN): HousePersonOccupant => ({
  ...actor,
  connected: true,
  status: { mood: null, sleepiness: 10, sleep: { state: "awake" } },
});
export const asleep = (actor: typeof IVY | typeof FERN, wakeAt: string): HousePersonOccupant => ({
  ...actor,
  connected: true,
  status: { mood: null, sleepiness: 80, sleep: { state: "asleep", wake_at: wakeAt } },
});
const me: HousePersonOccupant = { ...LEE, connected: true };

let counter = 0;
export function speech(room: { id: string; name: string }, actor: HouseEvent["actor"], text: string, to: string[] = []): HousePersonEvent {
  counter += 1;
  return { id: `e-${counter}`, seq: counter, occurred_at: new Date(Date.UTC(2026, 10, 27, 12, 0, counter)).toISOString(), room, actor, kind: "speech", text, to };
}

export const LIVING = { id: "living", name: "Living" };
export const BATH = { id: "bath", name: "Bath" };

type Kind = "house" | "history" | "enter" | "say" | "logout";

export class FakeHouse {
  /** The floor: Lee and Ivy in the living room, Fern in the bath, which holds one. */
  house: HousePersonView = {
    name: "Example house",
    you: LEE,
    rooms: [
      { ...LIVING, description: "A place to talk", capacity: null, occupants: [awake(IVY), me], last_speech: null },
      { ...BATH, description: "One at a time", capacity: 1, occupants: [awake(FERN)], last_speech: null },
    ],
    away: [],
  };
  signedIn = true;
  /** What GET /api/stream answers. */
  streamStatus = 200;
  /** The rooms' records, oldest first. */
  readonly records = new Map<string, HousePersonEvent[]>();
  /** How many events a page of a record holds. */
  pageSize = 50;
  /** Rooms that filled up since the floor was sent: entering them is refused. */
  readonly filled = new Set<string>();
  /** Whom the next speech does not reach. */
  notDelivered: HouseSpeechResult["not_delivered"] = [];
  /** How many of the next requests of a kind the house answers with 503, after doing nothing. */
  readonly failures: Partial<Record<Kind, number>> = {};
  /** While set, the house answers a request for a page before another with 503. */
  olderPagesFail = false;
  /** The cursors the pages of records were asked for with; none for a newest page. */
  readonly pagesAsked: Array<string | undefined> = [];
  /** The `error` the house refuses the next request of a kind with, as a 409, after doing nothing. */
  readonly refusals: Partial<Record<Kind, string>> = {};
  /** Every request but the reads, as `METHOD path`. */
  readonly writes: string[] = [];
  readonly said: Array<{ room: string; speech: HouseSpeech; connection: string | null }> = [];
  readonly sources: FakeSource[] = [];
  private readonly held = new Map<Kind, Promise<boolean>>();
  private readonly stalled = new Map<Kind, Promise<void>>();
  private connections = 0;

  readonly open = (url: string): Source => {
    const source = new FakeSource(url);
    this.sources.push(source);
    if (this.streamStatus !== 200) {
      // The browser gives up on an answer that is not 200.
      queueMicrotask(() => {
        source.readyState = 2;
        source.emit("error");
      });
    }
    return source;
  };

  private get source(): FakeSource {
    const source = this.sources.findLast(({ readyState }) => readyState !== 2);
    if (!source) throw new Error("no stream is open");
    return source;
  }

  /** The stream connected: the house gives the tab a connection and the floor. */
  ready(): string {
    const connection = `c-${++this.connections}`;
    this.source.readyState = 1;
    this.source.emit("ready", { connection, house: this.house });
    return connection;
  }

  /** The house answered the browser's next try with something other than 200: the browser gives up. */
  refuseStream(): void {
    const { source } = this;
    source.readyState = 2;
    source.emit("error");
  }

  /** The line dropped: the browser connects again by itself. */
  drop(): void {
    this.source.readyState = 0;
    this.source.emit("error");
  }

  /** Something happened in a room: recorded, and sent to the tab when the line is up. */
  happen(event: HousePersonEvent, { heard = true } = {}): void {
    this.records.set(event.room.id, [...(this.records.get(event.room.id) ?? []), event]);
    if (heard) this.tell(event);
  }

  /** The stream brings an event that is in the record already. */
  tell(event: HousePersonEvent): void {
    this.source.emit("room", event);
  }

  /** The floor changed. */
  floor(house: HousePersonView): void {
    this.house = house;
    this.source.emit("house", house);
  }

  /** The floor with Lee in a room, or in none. */
  withLeeIn(room: string | undefined): HousePersonView {
    return {
      ...this.house,
      rooms: this.house.rooms.map((each) => ({
        ...each,
        occupants: [...each.occupants.filter(({ id }) => id !== LEE.id), ...(each.id === room ? [me] : [])],
      })),
      away: room === undefined ? [LEE] : [],
    };
  }

  /**
   * The house does what the next request of a kind asks at once, but its
   * answer is on the way until it is given, or lost.
   */
  hold(kind: Kind): { give: () => void; lose: () => void } {
    let settle!: (arrives: boolean) => void;
    this.held.set(kind, new Promise((resolve) => (settle = resolve)));
    return { give: () => settle(true), lose: () => settle(false) };
  }

  /** The next request of a kind is on its way to the house until it is let through: the house knows nothing of it yet. */
  stall(kind: Kind): () => void {
    let through!: () => void;
    this.stalled.set(kind, new Promise((resolve) => (through = resolve)));
    return through;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "http://house.example.com");
    const method = init?.method ?? "GET";
    const room = /^\/api\/rooms\/([^/]+)\/(history|enter|say)$/.exec(url.pathname);
    const kind: Kind | undefined =
      url.pathname === "/api/house" ? "house" : url.pathname === "/auth/logout" ? "logout" : (room?.[2] as Kind | undefined);
    if (kind !== undefined && (this.failures[kind] ?? 0) > 0) {
      this.failures[kind]! -= 1;
      return Response.json({ error: "unavailable" }, { status: 503 });
    }
    const stalled = kind === undefined ? undefined : this.stalled.get(kind);
    if (stalled !== undefined) {
      this.stalled.delete(kind!);
      await stalled;
    }
    if (kind === "history") {
      const before = url.searchParams.get("before") ?? undefined;
      this.pagesAsked.push(before);
      if (before !== undefined && this.olderPagesFail) return Response.json({ error: "unavailable" }, { status: 503 });
    }
    const refusal = kind === undefined ? undefined : this.refusals[kind];
    if (refusal !== undefined) delete this.refusals[kind!];
    const answer = refusal === undefined ? this.answer(url, method, init, room) : Response.json({ error: refusal }, { status: 409 });
    const held = kind === undefined ? undefined : this.held.get(kind);
    if (held !== undefined) {
      this.held.delete(kind!);
      if (!(await held)) throw new TypeError("network error");
    }
    return answer;
  };

  private answer(url: URL, method: string, init: RequestInit | undefined, room: RegExpExecArray | null): Response {
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    if (!this.signedIn) return json({ error: "unauthorized" }, 401);
    if (method !== "GET") this.writes.push(`${method} ${url.pathname}`);
    const connection = new Headers(init?.headers).get("x-house-connection");
    if (url.pathname === "/api/house") return json(this.house);
    if (url.pathname === "/auth/logout") {
      this.signedIn = false;
      return new Response(null, { status: 204 });
    }
    if (room?.[2] === "history") {
      const newestFirst = (this.records.get(room[1]!) ?? []).toReversed();
      const before = url.searchParams.get("before");
      const from = before === null ? 0 : newestFirst.findIndex(({ id }) => id === before) + 1;
      const events = newestFirst.slice(from, from + this.pageSize);
      return json({ events, ...(from + this.pageSize < newestFirst.length ? { before: events.at(-1)!.id } : {}) });
    }
    if (room?.[2] === "enter") {
      if (this.filled.has(room[1]!)) return json({ error: "room is full" }, 409);
      this.house = this.withLeeIn(room[1]!);
      return json(this.house);
    }
    if (room?.[2] === "say") {
      const said = JSON.parse(String(init?.body)) as HouseSpeech;
      if (!this.house.rooms.find(({ id }) => id === room[1])?.occupants.some(({ id }) => id === LEE.id)) return json({ error: "you are not in that room" }, 409);
      this.said.push({ room: room[1]!, speech: said, connection });
      const event = speech(this.house.rooms.find(({ id }) => id === room[1])!, LEE, said.text, said.to ?? []);
      this.happen(event);
      return json({ id: event.id, not_delivered: this.notDelivered } satisfies HouseSpeechResult);
    }
    return json({ error: "not found" }, 404);
  }
}
