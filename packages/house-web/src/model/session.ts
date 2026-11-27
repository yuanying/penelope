// The procedure of docs/house.md (接続と居場所): each `ready` gives the
// connection to act with and has the records of the rooms on the screen read
// again; a stream the house refuses is not opened again before the session
// was checked.
import type { HouseActor, HouseEvent, HousePersonView, HouseStreamReady } from "@penelope/contract";

import { type Api, Refused, Unauthorized } from "./api.ts";
import { appended, caughtUp, type RoomLog, UNREAD_LOG, withOlder } from "./log.ts";

/**
 * The line to the house. Only an open line has a connection, so nothing can
 * be sent with the connection of a line that dropped.
 */
export type Line =
  | { kind: "connecting" }
  | { kind: "open"; connection: string }
  /** Dropped: the browser is connecting again by itself. */
  | { kind: "down" }
  /** The house refused the stream, or could not be asked: tried again after a while. */
  | { kind: "refused" };

export type Notice = { kind: "full" | "return-failed"; room: string } | { kind: "failed" };

export type Snapshot = {
  /** Unknown until the house answered once. */
  signedIn: boolean | undefined;
  house: HousePersonView | undefined;
  line: Line;
  /** The room looked into without entering it. */
  peek: string | undefined;
  /** The records of the room the person is in and of the room peeked into. */
  logs: ReadonlyMap<string, RoomLog>;
  /** By the speech's id: the residents of the room it did not reach. */
  undelivered: ReadonlyMap<string, readonly HouseActor[]>;
  /** The newest event of the person's room that was on the screen. */
  seen: string | undefined;
  notice: Notice | undefined;
};

/** What became of a speech. `unknown`: no answer came, so it may be recorded. */
export type Said = "sent" | "refused" | "unknown" | "offline";

/** The part of EventSource the session uses; the tests give their own. */
export type Source = Pick<EventSource, "addEventListener" | "close" | "readyState">;

export type SessionOptions = {
  api: Api;
  open: (url: string) => Source;
  /** Waits before the stream is tried again. The tests do not wait. */
  wait?: (ms: number) => Promise<void>;
};

/** EventSource.CLOSED: the browser gave up, as it does when the answer is not 200. */
const CLOSED = 2;
const REFUSAL_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];

const INITIAL: Snapshot = {
  signedIn: undefined,
  house: undefined,
  line: { kind: "connecting" },
  peek: undefined,
  logs: new Map(),
  undelivered: new Map(),
  seen: undefined,
  notice: undefined,
};

/** The room a resident is in, by the floor. */
export function roomOf(house: HousePersonView | undefined, resident: string): string | undefined {
  return house?.rooms.find(({ occupants }) => occupants.some(({ id }) => id === resident))?.id;
}

/** The room the person is in. */
export function myRoom({ house }: Pick<Snapshot, "house">): string | undefined {
  return house === undefined ? undefined : roomOf(house, house.you.id);
}

/** What others said in the person's room since it was last on the screen. */
export function unread(snapshot: Snapshot): number {
  const room = myRoom(snapshot);
  const events = (room === undefined ? undefined : snapshot.logs.get(room))?.events ?? [];
  const from = snapshot.seen === undefined ? -1 : events.findIndex(({ id }) => id === snapshot.seen);
  return events.slice(from + 1).filter((event) => event.kind === "speech" && event.actor.id !== snapshot.house?.you.id).length;
}

export class Session {
  private readonly api: Api;
  private readonly open: SessionOptions["open"];
  private readonly wait: (ms: number) => Promise<void>;
  private readonly listeners = new Set<() => void>();
  private snapshot = INITIAL;
  private active: Source | undefined;
  private replacement: Source | undefined;
  private opens = 0;
  private refusals = 0;

  constructor({ api, open, wait }: SessionOptions) {
    this.api = api;
    this.open = open;
    this.wait = wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): Snapshot => this.snapshot;

  start(): void {
    this.connect();
  }

  stop(): void {
    this.opens += 1;
    this.closeSources();
    this.set({ line: { kind: "connecting" } });
  }

  retry(): void {
    if (this.snapshot.signedIn !== false) this.connect();
  }

  /** Looks into a room of the floor other than the person's own, or stops looking. */
  peek(room: string | undefined): void {
    if (room === this.snapshot.peek) return;
    this.set({ peek: room });
    this.holdShownRooms();
    // To stop looking needs no new stream: what the old one still brings of that room is dropped.
    if (room !== undefined && this.snapshot.signedIn === true) this.connect();
  }

  /** Enters a room; false when the person did not get in. */
  async enter(room: string): Promise<boolean> {
    const { line } = this.snapshot;
    if (line.kind !== "open") return false;
    try {
      this.setHouse(await this.api.enter(room, line.connection));
      this.set({ notice: undefined });
      return true;
    } catch (error) {
      if (error instanceof Refused && error.code === "room is full") this.set({ notice: { kind: "full", room } });
      else this.failed(error);
      return false;
    }
  }

  async leave(): Promise<void> {
    const { line } = this.snapshot;
    if (line.kind !== "open") return;
    try {
      await this.api.leave(line.connection);
    } catch (error) {
      this.failed(error);
    }
  }

  /** Says it in the person's room. Nothing is kept to send later, and nothing is sent twice. */
  async say(text: string, to: readonly string[]): Promise<Said> {
    const { line } = this.snapshot;
    const room = myRoom(this.snapshot);
    if (line.kind !== "open" || room === undefined) return "offline";
    try {
      const { id, not_delivered } = await this.api.say(room, { text, ...(to.length > 0 ? { to: [...to] } : {}) }, line.connection);
      if (not_delivered.length > 0) this.set({ undelivered: new Map(this.snapshot.undelivered).set(id, not_delivered) });
      return "sent";
    } catch (error) {
      if (error instanceof Unauthorized) this.signedOut();
      else if (error instanceof Refused && error.code === "connection-required") this.connect();
      return error instanceof Refused ? "refused" : "unknown";
    }
  }

  /** Reads the page before what is held of a room. */
  async older(room: string): Promise<void> {
    const before = this.snapshot.logs.get(room)?.before;
    if (before === undefined) return;
    try {
      const page = await this.api.history(room, before);
      this.updateLog(room, (log) => (log.before === before ? withOlder(log, page.events, page.before) : log));
    } catch (error) {
      this.failed(error);
    }
  }

  /** The person's room is on the screen: what is held of it, read from the record or heard, is not unread. */
  see(): void {
    const room = myRoom(this.snapshot);
    const newest = (room === undefined ? undefined : this.snapshot.logs.get(room))?.events.at(-1)?.id;
    if (newest !== undefined && newest !== this.snapshot.seen) this.set({ seen: newest });
  }

  dismiss(): void {
    this.set({ notice: undefined });
  }

  async logout(): Promise<void> {
    await this.api.logout().catch(() => {});
    this.signedOut();
  }

  private connect(): void {
    const { peek } = this.snapshot;
    const opened = ++this.opens;
    this.replacement?.close();
    // A stream that dropped is closed for the new one; one that is open stays until the new one is ready.
    if (this.snapshot.line.kind !== "open") {
      this.active?.close();
      this.active = undefined;
    }
    const source = this.open(peek === undefined ? "/api/stream" : `/api/stream?peek=${encodeURIComponent(peek)}`);
    this.replacement = source;
    const inUse = () => opened === this.opens || source === this.active;

    source.addEventListener("ready", (message) => {
      if (!inUse()) return;
      if (source === this.replacement) {
        this.active?.close();
        this.active = source;
        this.replacement = undefined;
      }
      const ready = JSON.parse((message as MessageEvent<string>).data) as HouseStreamReady;
      this.refusals = 0;
      this.set({
        signedIn: true,
        line: { kind: "open", connection: ready.connection },
        ...(ready.return_failed === undefined ? {} : { notice: { kind: "return-failed" as const, room: ready.return_failed } }),
      });
      this.setHouse(ready.house);
      for (const room of this.snapshot.logs.keys()) void this.catchUp(room);
    });
    source.addEventListener("house", (message) => {
      if (source === this.active) this.setHouse(JSON.parse((message as MessageEvent<string>).data) as HousePersonView);
    });
    source.addEventListener("room", (message) => {
      if (source !== this.active) return;
      const event = JSON.parse((message as MessageEvent<string>).data) as HouseEvent;
      this.updateLog(event.room.id, (log) => appended(log, event));
    });
    source.addEventListener("error", () => {
      if (!inUse()) return;
      if (source.readyState === CLOSED) void this.refused();
      else if (source === this.active || this.active === undefined) this.set({ line: { kind: "down" } });
    });
  }

  /** The house did not answer the stream with 200: whether there is a session is asked before anything else. */
  private async refused(): Promise<void> {
    const opened = ++this.opens;
    this.closeSources();
    this.set({ line: { kind: "refused" } });
    try {
      const house = await this.api.house();
      if (opened !== this.opens) return;
      this.set({ signedIn: true });
      this.setHouse(house);
    } catch (error) {
      if (opened !== this.opens) return;
      if (error instanceof Unauthorized) {
        this.signedOut();
        return;
      }
    }
    await this.wait(REFUSAL_BACKOFF_MS[Math.min(this.refusals++, REFUSAL_BACKOFF_MS.length - 1)]!);
    if (opened === this.opens) this.connect();
  }

  private async catchUp(room: string): Promise<void> {
    const anchor = this.snapshot.logs.get(room)?.events.at(-1)?.id;
    const fetched: HouseEvent[] = [];
    let before: string | undefined;
    try {
      do {
        const page = await this.api.history(room, before);
        fetched.push(...page.events);
        before = page.before;
      } while (anchor !== undefined && before !== undefined && !fetched.some(({ id }) => id === anchor));
    } catch (error) {
      if (error instanceof Unauthorized) this.signedOut();
      // Otherwise the next `ready` reads it again.
      return;
    }
    const first = this.snapshot.logs.get(room)?.read === false;
    this.updateLog(room, (log) => caughtUp(log, anchor, fetched, before));
    if (first && room === myRoom(this.snapshot)) this.see();
  }

  private setHouse(house: HousePersonView): void {
    const moved = roomOf(house, house.you.id) !== myRoom(this.snapshot);
    this.set({ house, ...(moved ? { seen: undefined } : {}) });
    this.holdShownRooms();
    if (moved) this.see();
  }

  private holdShownRooms(): void {
    const shown = [myRoom(this.snapshot), this.snapshot.peek].filter((room) => room !== undefined);
    const fresh = shown.filter((room) => !this.snapshot.logs.has(room));
    if (fresh.length === 0 && [...this.snapshot.logs.keys()].every((room) => shown.includes(room))) return;
    this.set({ logs: new Map(shown.map((room) => [room, this.snapshot.logs.get(room) ?? UNREAD_LOG])) });
    if (this.snapshot.line.kind === "open") for (const room of fresh) void this.catchUp(room);
  }

  private updateLog(room: string, change: (log: RoomLog) => RoomLog): void {
    const log = this.snapshot.logs.get(room);
    if (log === undefined) return;
    const changed = change(log);
    if (changed !== log) this.set({ logs: new Map(this.snapshot.logs).set(room, changed) });
  }

  private failed(error: unknown): void {
    if (error instanceof Unauthorized) this.signedOut();
    // The house no longer knows the connection: the stream is opened again.
    else if (error instanceof Refused && error.code === "connection-required") this.connect();
    else this.set({ notice: { kind: "failed" } });
  }

  private signedOut(): void {
    this.opens += 1;
    this.closeSources();
    this.snapshot = { ...INITIAL, signedIn: false };
    this.emit();
  }

  private closeSources(): void {
    this.active?.close();
    this.replacement?.close();
    this.active = undefined;
    this.replacement = undefined;
  }

  private set(change: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
