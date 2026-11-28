// The procedure of docs/house.md (接続と居場所): each `ready` gives the
// connection to act with and has the records of the conversations on the screen read
// again; a stream the house refuses is not opened again before the session
// was checked.
import type { HouseActor, HousePersonDirectEvent, HousePersonEvent, HousePersonView, HouseSpeech, HouseStreamReady } from "@penelope/contract";

import { type Api, Refused, Unauthorized } from "./api.ts";
import { caughtUp, type Conversation, type ConversationLog, EMPTY_LOG, logKey, reachOf, withEvent, withOlder, withPage } from "./log.ts";

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

export type Notice = { kind: "full" | "enter-failed"; room: string } | { kind: "failed" | "logout-unconfirmed" };

export type Snapshot = {
  /** Unknown until the house answered once. */
  signedIn: boolean | undefined;
  house: HousePersonView | undefined;
  line: Line;
  logs: ReadonlyMap<string, ConversationLog>;
  /** By the speech's id: the residents of the room it did not reach. */
  undelivered: ReadonlyMap<string, readonly HouseActor[]>;
  /** The `seq` of the newest event of the person's room that was on the screen. */
  seen: number | undefined;
  /** Replies received live while their direct conversation was closed, by resident. */
  directUnread: ReadonlyMap<string, number>;
  notice: Notice | undefined;
};

/** What became of a speech. `refused`: it was not said. `unknown`: no answer came, so it may be recorded. */
export type Said = "sent" | "refused" | "unknown" | "in-room" | "deployment-unsupported" | "invalid-images";

export function directWith(house: HousePersonView | undefined, agent: string) {
  return house?.direct.find(({ agent_id }) => agent_id === agent);
}

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
const backoff = (tries: number) => BACKOFF_MS[Math.min(tries, BACKOFF_MS.length - 1)]!;

const INITIAL: Snapshot = {
  signedIn: undefined,
  house: undefined,
  line: { kind: "connecting" },
  logs: new Map(),
  undelivered: new Map(),
  seen: undefined,
  directUnread: new Map(),
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
  private source: Source | undefined;
  private viewed: Conversation | undefined;
  private opens = 0;
  private refusals = 0;
  /** Counts the floors the stream brought. */
  private floors = 0;

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
    this.closeSource();
    this.set({ line: { kind: "connecting" } });
  }

  /** Connects now. After a refusal the session is still asked about first. */
  retry(): void {
    if (this.snapshot.signedIn === false) return;
    if (this.snapshot.line.kind === "refused") void this.refused(true);
    else this.connect();
  }

  show(conversation: Conversation | undefined): void {
    this.viewed = conversation;
    if (conversation?.kind === "dm" && this.snapshot.directUnread.has(conversation.id)) {
      const directUnread = new Map(this.snapshot.directUnread);
      directUnread.delete(conversation.id);
      this.set({ directUnread });
    }
    this.refreshShown();
  }

  async enter(room: string): Promise<void> {
    const { line } = this.snapshot;
    if (line.kind !== "open") {
      this.set({ notice: { kind: "enter-failed", room } });
      return;
    }
    this.dismiss();
    const asked = this.floors;
    try {
      const house = await this.api.enter(room, line.connection);
      if (asked === this.floors) this.setHouse(house);
    } catch (error) {
      if (error instanceof Unauthorized) {
        this.signedOut();
        return;
      }
      this.connectionLost(error, line.connection);
      const kind = error instanceof Refused && error.code === "room is full" ? "full" : "enter-failed";
      this.set({ notice: { kind, room } });
    }
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

  async say(conversation: Conversation, speech: HouseSpeech): Promise<Said> {
    const { line, house } = this.snapshot;
    if (line.kind !== "open") return "refused";
    if (conversation.kind === "room") {
      if (conversation.id !== myRoom(this.snapshot)) return "refused";
    } else {
      const access = directWith(house, conversation.id)?.send;
      if (access !== "ready") return access ?? "refused";
    }
    try {
      const { id, not_delivered } = await this.api.say(conversation, speech, line.connection);
      if (not_delivered.length > 0) this.set({ undelivered: new Map(this.snapshot.undelivered).set(id, not_delivered) });
      return "sent";
    } catch (error) {
      if (error instanceof Unauthorized) this.signedOut();
      else this.connectionLost(error, line.connection);
      if (error instanceof Refused) {
        if (error.code === "agent-in-room") return "in-room";
        if (error.code === "deployment-unsupported") return error.code;
        if (error.status === 413 && speech.images?.length) return "invalid-images";
        if (error.status < 500) return "refused";
      }
      return error instanceof Unauthorized ? "refused" : "unknown";
    }
  }

  async older(conversation: Conversation): Promise<void> {
    const key = logKey(conversation);
    const log = this.snapshot.logs.get(key);
    if (log?.before === undefined) return;
    const { before } = log;
    try {
      const page = await this.api.history(conversation, before);
      this.updateLog(key, (now) => (now.before === before ? withOlder(now, page.events, page.before) : now));
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
    this.opens += 1;
    this.closeSource();
    this.set({ line: { kind: "connecting" } });
    const source = this.open("/api/stream");
    this.source = source;

    source.addEventListener("ready", (message) => {
      if (source !== this.source) return;
      const ready = JSON.parse((message as MessageEvent<string>).data) as HouseStreamReady;
      this.refusals = 0;
      this.floors += 1;
      this.setHouse(ready.house, { signedIn: true, line: { kind: "open", connection: ready.connection } });
    });
    source.addEventListener("house", (message) => {
      if (source !== this.source) return;
      this.floors += 1;
      this.setHouse(JSON.parse((message as MessageEvent<string>).data) as HousePersonView);
    });
    source.addEventListener("room", (message) => {
      const { line } = this.snapshot;
      if (source !== this.source || line.kind !== "open") return;
      const event = JSON.parse((message as MessageEvent<string>).data) as HousePersonEvent;
      this.updateLog(event.room.id, (log) => withEvent(log, event, line.connection));
    });
    source.addEventListener("dm", (message) => {
      const { house, line } = this.snapshot;
      if (source !== this.source || line.kind !== "open") return;
      const event = JSON.parse((message as MessageEvent<string>).data) as HousePersonDirectEvent;
      const agent = event.dm.agent_id;
      if (event.dm.owner_id !== house?.you.id || !directWith(house, agent)) return;
      const key = logKey({ kind: "dm", id: agent });
      const log = this.snapshot.logs.get(key) ?? EMPTY_LOG;
      const next = withEvent(log, event, line.connection);
      if (next === log) return;
      const open = this.viewed?.kind === "dm" && this.viewed.id === agent;
      const unread = event.actor.kind === "agent" && !open;
      this.set({
        logs: new Map(this.snapshot.logs).set(key, next),
        ...(unread ? { directUnread: new Map(this.snapshot.directUnread).set(agent, (this.snapshot.directUnread.get(agent) ?? 0) + 1) } : {}),
      });
    });
    source.addEventListener("error", () => {
      if (source !== this.source) return;
      if (source.readyState === CLOSED) void this.refused();
      else this.set({ line: { kind: "down" } });
    });
  }

  /**
   * The house did not answer the stream with 200. No stream is opened before
   * the house said that the session is good: an answer that is not one about
   * the session is asked for again.
   */
  private async refused(immediately = false): Promise<void> {
    const opened = ++this.opens;
    this.closeSource();
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

  private refreshShown(): void {
    const { line } = this.snapshot;
    if (line.kind !== "open") return;
    const room = myRoom(this.snapshot);
    const own: Conversation | undefined = room === undefined ? undefined : { kind: "room", id: room };
    for (const conversation of [own, this.viewed]) {
      if (!conversation || (conversation.kind === "dm" && !directWith(this.snapshot.house, conversation.id))) continue;
      const key = logKey(conversation);
      const log = this.snapshot.logs.get(key);
      if (log?.sync?.connection === line.connection) continue;
      this.updateLog(key, (now) => ({ ...now, sync: { connection: line.connection, phase: "reading" } }));
      void this.read(conversation, line.connection);
    }
  }

  private async read(conversation: Conversation, connection: string): Promise<void> {
    const key = logKey(conversation);
    const current = () => this.snapshot.line.kind === "open" && this.snapshot.line.connection === connection && this.snapshot.logs.get(key)?.sync?.connection === connection;
    let before: string | undefined;
    for (let tries = 0; current(); ) {
      try {
        const page = await this.api.history(conversation, before);
        if (!current()) return;
        const log = this.snapshot.logs.get(key)!;
        const reach = reachOf(log);
        const lowest = page.events.at(-1)?.seq;
        before = page.before;
        const more = before !== undefined && reach !== undefined && lowest !== undefined && lowest > reach;
        this.updateLog(key, (now) => {
          const merged = withPage(now, page.events);
          return more ? merged : caughtUp(merged, before, connection);
        });
        if (!more) {
          if (log.whole === undefined && conversation.kind === "room" && conversation.id === myRoom(this.snapshot)) this.see();
          return;
        }
        tries = 0;
      } catch (error) {
        if (!current()) return;
        if (error instanceof Unauthorized) {
          this.signedOut();
          return;
        }
        if (conversation.kind === "dm" && error instanceof Refused && error.status === 404) {
          this.updateLog(key, () => ({ ...EMPTY_LOG, sync: { connection, phase: "unavailable" } }));
          return;
        }
        await this.wait(backoff(tries++));
      }
    }
  }

  private setHouse(house: HousePersonView, change?: Partial<Snapshot>): void {
    const moved = roomOf(house, house.you.id) !== myRoom(this.snapshot);
    const removed = this.snapshot.house?.direct.filter(({ agent_id }) => !directWith(house, agent_id)) ?? [];
    let { logs, directUnread } = this.snapshot;
    if (removed.length > 0) {
      const remainingLogs = new Map(logs);
      const remainingUnread = new Map(directUnread);
      for (const { agent_id: id } of removed) {
        remainingLogs.delete(logKey({ kind: "dm", id }));
        remainingUnread.delete(id);
      }
      logs = remainingLogs;
      directUnread = remainingUnread;
    }
    this.set({ ...change, logs, directUnread, house, ...(moved ? { seen: undefined } : {}) });
    this.refreshShown();
    if (moved) this.see();
  }

  private updateLog(key: string, change: (log: ConversationLog) => ConversationLog): void {
    const log = this.snapshot.logs.get(key) ?? EMPTY_LOG;
    const changed = change(log);
    if (changed !== log) this.set({ logs: new Map(this.snapshot.logs).set(key, changed) });
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

  private signedOut(): void {
    this.opens += 1;
    this.closeSource();
    this.snapshot = { ...INITIAL, signedIn: false };
    this.emit();
  }

  private closeSource(): void {
    this.source?.close();
    this.source = undefined;
  }

  private set(change: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
