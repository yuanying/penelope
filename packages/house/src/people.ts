import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

import type { HousePersonFloor, HousePersonView, HouseStreamEvents } from "@penelope/contract";

import type { Person } from "./config.ts";
import { Conflict, House, type PersonEvent, type PersonSession } from "./house.ts";

const KEEPALIVE_MS = 25_000;

type Stream = {
  session: PersonSession;
  response: ServerResponse;
  snapshot: string;
};

export class People {
  private readonly house: House;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly streams = new Map<string, Stream>();
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

  view(person: Person, floor = this.floor()): HousePersonView {
    return { ...floor, you: this.house.identity(person), direct: this.house.directAvailability(person, this.now()) };
  }

  connect(session: PersonSession, response: ServerResponse): void {
    if (this.closed) throw new Conflict("house is closing");
    const { person } = session;
    const connection = randomUUID();
    const stream = { session, response, snapshot: "" };
    this.streams.set(connection, stream);
    response.once("close", () => this.background(() => this.disconnect(connection)));
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    const house = this.view(person);
    stream.snapshot = JSON.stringify(house);
    this.send(stream, "ready", { connection, house });
    this.publish();
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
  }

  publish(events: PersonEvent[] = []): void {
    if (this.streams.size === 0) return;
    const floor = this.floor();
    for (const stream of this.streams.values()) {
      if (!this.active(stream)) continue;
      const { person } = stream.session;
      for (const event of events) {
        if (!("dm" in event)) this.send(stream, "room", event);
        else if (event.dm.owner_id === person.actor.id) this.send(stream, "dm", event);
      }
      const snapshot = JSON.stringify(this.view(person, floor));
      if (stream.snapshot === snapshot) continue;
      stream.snapshot = snapshot;
      this.write(stream, `event: house\ndata: ${snapshot}\n\n`);
    }
  }

  private disconnect(connection: string): void {
    if (this.streams.delete(connection)) this.publish();
  }

  private active({ response, session }: Stream): boolean {
    return !response.destroyed && !response.writableEnded && session.expires > this.now();
  }

  private floor(): HousePersonFloor {
    const connected = new Set<string>();
    for (const stream of this.streams.values()) {
      if (this.active(stream)) connected.add(stream.session.person.subject);
    }
    return this.house.personFloor(this.now(), connected);
  }

  private tick(): void {
    const now = this.now();
    for (const [id, stream] of this.streams) {
      if (this.active(stream)) continue;
      stream.response.destroy();
      this.disconnect(id);
    }
    this.publish(this.house.expire(now));
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
