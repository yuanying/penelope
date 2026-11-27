import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { HouseEvent, HousePersonFloor, HousePersonView, HouseStreamEvents } from "@penelope/contract";

import type { Person } from "./config.ts";
import { Conflict, House, NotFound, type PersonSession } from "./house.ts";

const GRACE_MS = 30_000;
const KEEPALIVE_MS = 25_000;

type Stream = {
  session: PersonSession;
  response: ServerResponse;
  peek: string | null;
  snapshot: string;
};

export class People {
  private readonly house: House;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly streams = new Map<string, Stream>();
  private readonly departures = new Map<Person, number>();
  private readonly timer: NodeJS.Timeout;
  private keepaliveAt: number;
  private closed = false;

  constructor(house: House, now: () => number, log: (line: string) => void) {
    this.house = house;
    this.now = now;
    this.log = log;
    this.keepaliveAt = now() + KEEPALIVE_MS;
    this.timer = setInterval(() => this.background(() => this.tick()), 1_000).unref();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const { response } of this.streams.values()) response.destroy();
    this.streams.clear();
  }

  view(person: Person): HousePersonView {
    return { ...this.floor(), you: this.house.identity(person) };
  }

  connect(session: PersonSession, peek: string | null, response: ServerResponse): void {
    if (this.closed) throw new Conflict("house is closing");
    if (peek !== null && !this.house.hasRoom(peek)) throw new NotFound("room does not exist");
    const { person } = session;
    const now = this.now();
    const events = this.expireDepartures(now);
    const stillPresent = this.departures.delete(person) || this.connected(person);
    let return_failed: string | undefined;
    const previous = stillPresent ? undefined : this.house.returnRoom(person);
    if (previous !== undefined) {
      try {
        events.push(...this.house.enter(person, previous, now));
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
        this.house.leave(person, now, true);
        return_failed = previous;
      }
    }

    const connection = randomUUID();
    const stream = { session, response, peek, snapshot: "" };
    this.streams.set(connection, stream);
    response.once("close", () => this.background(() => this.disconnect(connection)));
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    const house = this.view(person);
    stream.snapshot = JSON.stringify(house);
    this.send(stream, "ready", { connection, house, return_failed });
    this.publish(events);
  }

  requireConnection(session: PersonSession, connection: string | undefined): void {
    const stream = connection ? this.streams.get(connection) : undefined;
    if (!stream || stream.session.tokenHash !== session.tokenHash || !this.active(stream)) throw new Conflict("connection-required");
  }

  revoke(tokenHash: string): void {
    for (const [id, stream] of this.streams) {
      if (stream.session.tokenHash !== tokenHash) continue;
      stream.response.destroy();
      this.disconnect(id);
    }
    this.publish();
  }

  publish(events: HouseEvent[] = []): void {
    if (this.streams.size === 0) return;
    const floor = this.floor();
    for (const stream of this.streams.values()) {
      if (!this.active(stream)) continue;
      const { person } = stream.session;
      const room = floor.rooms.find(({ occupants }) => occupants.some(({ id }) => id === person.actor.id))?.id;
      for (const event of events) {
        if (event.actor.id === person.actor.id || event.room.id === room || event.room.id === stream.peek) this.send(stream, "room", event);
      }
      const snapshot = JSON.stringify({ ...floor, you: this.house.identity(person) } satisfies HousePersonView);
      if (stream.snapshot === snapshot) continue;
      stream.snapshot = snapshot;
      this.write(stream, `event: house\ndata: ${snapshot}\n\n`);
    }
  }

  private disconnect(connection: string): void {
    const stream = this.streams.get(connection);
    if (!stream) return;
    this.streams.delete(connection);
    const { person } = stream.session;
    if (!this.connected(person)) {
      if (!this.departures.has(person)) this.departures.set(person, this.now() + GRACE_MS);
      this.publish();
    }
  }

  private active({ response, session }: Stream): boolean {
    return !response.destroyed && !response.writableEnded && session.expires > this.now();
  }

  private connected(person: Person): boolean {
    for (const stream of this.streams.values()) {
      if (stream.session.person === person && this.active(stream)) return true;
    }
    return false;
  }

  private floor(): HousePersonFloor {
    const connected = new Set<string>();
    for (const stream of this.streams.values()) {
      if (this.active(stream)) connected.add(stream.session.person.subject);
    }
    return this.house.personFloor(this.now(), connected);
  }

  private expireDepartures(now: number): HouseEvent[] {
    const events: HouseEvent[] = [];
    for (const [person, at] of this.departures) {
      if (now < at) continue;
      events.push(...this.house.leave(person, now));
      this.departures.delete(person);
    }
    return events;
  }

  private tick(): void {
    const now = this.now();
    for (const [id, stream] of this.streams) {
      if (this.active(stream)) continue;
      stream.response.destroy();
      this.disconnect(id);
    }
    this.publish(this.expireDepartures(now));
    if (now < this.keepaliveAt) return;
    this.keepaliveAt = now + KEEPALIVE_MS;
    for (const stream of this.streams.values()) this.write(stream, ": keepalive\n\n");
  }

  private background(task: () => void): void {
    try {
      task();
    } catch (error) {
      this.log(`house: presence update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private send<K extends keyof HouseStreamEvents>(stream: Stream, kind: K, data: HouseStreamEvents[K]): void {
    this.write(stream, `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private write(stream: Stream, frame: string): void {
    if (!this.active(stream)) return;
    if (stream.response.writableLength > 1024 * 1024) stream.response.destroy();
    else stream.response.write(frame);
  }
}
