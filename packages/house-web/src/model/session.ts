// The procedure of docs/house.md (接続と居場所): each `ready` gives the
// connection to act with and has the records of the rooms on the screen read
// again; a stream the house refuses is not opened again before the session
// was checked.
import type { HouseActor, HousePersonEvent, HousePersonView, HouseStreamReady } from "@penelope/contract";

import { type Api, Refused, Unauthorized } from "./api.ts";
import { caughtUp, reachOf, type RoomLog, withEvent, withOlder } from "./log.ts";

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

export type Notice = { kind: "full" | "return-failed"; room: string } | { kind: "failed" | "logout-unconfirmed" };

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
  /** The `seq` of the newest event of the person's room that was on the screen. */
  seen: number | undefined;
  notice: Notice | undefined;
};

/** What became of a speech. `refused`: it was not said. `unknown`: no answer came, so it may be recorded. */
export type Said = "sent" | "refused" | "unknown";

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
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000];
/** How long the floor that follows an entering is waited for. */
const ARRIVAL_MS = 5_000;
const backoff = (tries: number) => BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)]!;

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
  const seen = snapshot.seen ?? -Infinity;
  return events.filter((event) => event.seq > seen && event.kind === "speech" && event.actor.id !== snapshot.house?.you.id).length;
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
  /** Counts the floors the stream brought. */
  private floors = 0;
  /** Numbers the readings of records and the showings of rooms. */
  private ticks = 0;

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

  /** Connects now. After a refusal the session is still asked about first. */
  retry(): void {
    if (this.snapshot.signedIn === false) return;
    if (this.snapshot.line.kind === "refused") void this.refused(true);
    else this.connect();
  }

  /** Looks into a room of the floor other than the person's own, or stops looking. */
  peek(room: string | undefined): void {
    if (room === this.snapshot.peek) return;
    this.set({ peek: room });
    this.holdShownRooms();
    // To stop looking needs no new stream: what the old one still brings of that room is dropped.
    // After a refusal the stream is opened for this room once the session was checked.
    if (room !== undefined && this.snapshot.signedIn === true && this.snapshot.line.kind !== "refused") this.connect();
  }

  /**
   * Enters a room. True once the floor shows the person in it. The stream may
   * bring that floor after the house's answer, so it is waited for a while.
   * False when the house refused, or the floor never showed the room: the
   * person went on elsewhere.
   */
  async enter(room: string): Promise<boolean> {
    const { line } = this.snapshot;
    if (line.kind !== "open") return false;
    const asked = this.floors;
    try {
      const house = await this.api.enter(room, line.connection);
      // A floor the stream brought meanwhile is newer than this answer.
      if (asked === this.floors) this.setHouse(house);
      this.set({ notice: undefined });
    } catch (error) {
      if (error instanceof Refused && error.code === "room is full") this.set({ notice: { kind: "full", room } });
      else this.failed(error, line.connection);
      return false;
    }
    return this.arrives(room);
  }

  async leave(): Promise<void> {
    const { line } = this.snapshot;
    if (line.kind !== "open") return;
    try {
      await this.api.leave(line.connection);
    } catch (error) {
      this.failed(error, line.connection);
    }
  }

  /** Says it in `room` if the person is in it. Nothing is kept to send later, and nothing is sent twice. */
  async say(room: string, text: string, to: readonly string[]): Promise<Said> {
    const { line } = this.snapshot;
    if (line.kind !== "open" || room !== myRoom(this.snapshot)) return "refused";
    try {
      const { id, not_delivered } = await this.api.say(room, { text, ...(to.length > 0 ? { to: [...to] } : {}) }, line.connection);
      if (not_delivered.length > 0) this.set({ undelivered: new Map(this.snapshot.undelivered).set(id, not_delivered) });
      return "sent";
    } catch (error) {
      if (error instanceof Unauthorized) this.signedOut();
      else this.connectionLost(error, line.connection);
      // The house refuses with a 4xx before it records anything. Any other answer, or none, may follow a recording.
      return error instanceof Refused && error.status < 500 ? "refused" : "unknown";
    }
  }

  /** Reads the page before what is held of a room. */
  async older(room: string): Promise<void> {
    const log = this.snapshot.logs.get(room);
    if (log?.before === undefined) return;
    const { before, showing } = log;
    try {
      const page = await this.api.history(room, before);
      this.updateLog(room, (now) => (now.showing === showing && now.before === before ? withOlder(now, page.events, page.before) : now));
    } catch (error) {
      this.failed(error);
    }
  }

  /** The person's room is on the screen: what is held of it, read from the record or heard, is not unread. */
  see(): void {
    const room = myRoom(this.snapshot);
    const newest = (room === undefined ? undefined : this.snapshot.logs.get(room))?.events.at(-1)?.seq;
    if (newest !== undefined && newest !== this.snapshot.seen) this.set({ seen: newest });
  }

  dismiss(): void {
    this.set({ notice: undefined });
  }

  /** Signs out once the house ended the session. When it did not, or cannot say, the person stays signed in and is told. */
  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch {
      try {
        await this.api.house();
        this.set({ notice: { kind: "logout-unconfirmed" } });
        return;
      } catch (error) {
        if (!(error instanceof Unauthorized)) {
          this.set({ notice: { kind: "logout-unconfirmed" } });
          return;
        }
      }
    }
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
      this.floors += 1;
      const held = [...this.snapshot.logs.keys()];
      this.setHouse(ready.house);
      // A gap may stand between what is held and what this stream brings. A room newly shown is being read already.
      for (const room of held) this.read(room);
    });
    source.addEventListener("house", (message) => {
      if (source !== this.active) return;
      this.floors += 1;
      this.setHouse(JSON.parse((message as MessageEvent<string>).data) as HousePersonView);
    });
    source.addEventListener("room", (message) => {
      if (source !== this.active) return;
      const event = JSON.parse((message as MessageEvent<string>).data) as HousePersonEvent;
      this.updateLog(event.room.id, (log) => withEvent(log, event));
    });
    source.addEventListener("error", () => {
      if (!inUse()) return;
      if (source.readyState === CLOSED) void this.refused();
      else if (source === this.active || this.active === undefined) this.set({ line: { kind: "down" } });
    });
  }

  /**
   * The house did not answer the stream with 200. No stream is opened before
   * the house said that the session is good: an answer that is not one about
   * the session is asked for again.
   */
  private async refused(immediately = false): Promise<void> {
    const opened = ++this.opens;
    this.closeSources();
    this.set({ line: { kind: "refused" } });
    for (;;) {
      try {
        const house = await this.api.house();
        if (opened !== this.opens) return;
        this.set({ signedIn: true });
        this.setHouse(house);
        break;
      } catch (error) {
        if (opened !== this.opens) return;
        if (error instanceof Unauthorized) {
          this.signedOut();
          return;
        }
      }
      await this.wait(backoff(this.refusals++));
      if (opened !== this.opens) return;
    }
    if (!immediately) await this.wait(backoff(this.refusals++));
    if (opened === this.opens) this.connect();
  }

  /** Starts the reading that brings a room's log up to date, in the place of any reading under way. */
  private read(room: string): void {
    const due = ++this.ticks;
    this.updateLog(room, (log) => ({ ...log, due }));
    void this.readUntilDone(room, due);
  }

  private async readUntilDone(room: string, due: number): Promise<void> {
    for (let tries = 0; ; tries += 1) {
      const log = this.snapshot.logs.get(room);
      if (log?.due !== due || this.snapshot.line.kind !== "open") return;
      const fetched: HousePersonEvent[] = [];
      let before: string | undefined;
      try {
        for (;;) {
          const page = await this.api.history(room, before);
          fetched.push(...page.events);
          before = page.before;
          // How far to go is asked after each page: the stream may have brought an older event meanwhile.
          const now = this.snapshot.logs.get(room);
          if (now?.due !== due) return;
          const reach = reachOf(now);
          const oldest = fetched.at(-1)?.seq;
          if (before === undefined || reach === undefined || oldest === undefined || oldest <= reach) break;
        }
        this.updateLog(room, (now) => (now.due === due ? caughtUp(now, fetched, before) : now));
        if (!log.read && room === myRoom(this.snapshot)) this.see();
        return;
      } catch (error) {
        if (error instanceof Unauthorized) {
          this.signedOut();
          return;
        }
      }
      await this.wait(backoff(tries));
    }
  }

  private setHouse(house: HousePersonView): void {
    const moved = roomOf(house, house.you.id) !== myRoom(this.snapshot);
    this.set({ house, ...(moved ? { seen: undefined } : {}) });
    this.holdShownRooms();
    if (moved) this.see();
  }

  /** Holds a log for each room on the screen and for no other. A room newly shown is read from its newest page. */
  private holdShownRooms(): void {
    const shown = [myRoom(this.snapshot), this.snapshot.peek].filter((room) => room !== undefined);
    const fresh = shown.filter((room) => !this.snapshot.logs.has(room));
    if (fresh.length === 0 && [...this.snapshot.logs.keys()].every((room) => shown.includes(room))) return;
    const unread = (): RoomLog => ({ events: [], before: undefined, whole: undefined, pagedBelow: undefined, read: false, due: ++this.ticks, showing: this.ticks });
    this.set({ logs: new Map(shown.map((room) => [room, this.snapshot.logs.get(room) ?? unread()])) });
    for (const room of fresh) this.read(room);
  }

  private updateLog(room: string, change: (log: RoomLog) => RoomLog): void {
    const log = this.snapshot.logs.get(room);
    if (log === undefined) return;
    const changed = change(log);
    if (changed !== log) this.set({ logs: new Map(this.snapshot.logs).set(room, changed) });
  }

  private failed(error: unknown, connection?: string): void {
    if (error instanceof Unauthorized) this.signedOut();
    else if (!this.connectionLost(error, connection)) this.set({ notice: { kind: "failed" } });
  }

  /**
   * Whether the house refused because it no longer knows the connection the
   * request carried. The stream is opened again only if that connection is
   * still the one in use: a line that dropped or was refused since is being
   * seen to already.
   */
  private connectionLost(error: unknown, connection: string | undefined): boolean {
    if (!(error instanceof Refused) || error.code !== "connection-required") return false;
    const { line } = this.snapshot;
    if (line.kind === "open" && line.connection === connection) this.connect();
    return true;
  }

  private arrives(room: string): Promise<boolean> {
    if (myRoom(this.snapshot) === room) return Promise.resolve(true);
    return new Promise((resolve) => {
      const stop = this.subscribe(() => {
        if (myRoom(this.snapshot) !== room) return;
        stop();
        resolve(true);
      });
      void this.wait(ARRIVAL_MS).then(() => {
        stop();
        resolve(false);
      });
    });
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
