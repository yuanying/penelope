import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  HouseActor, HouseAgentStatus, HouseDelivery, HouseEnterResult, HouseEvent, HouseResident, HouseRoom,
  HouseSpeech, HouseSpeechResult, HouseSync, HouseSyncResult, HouseView,
} from "@penelope/contract";

import type { Agent, HouseConfig } from "./config.ts";
import { InvalidInput, PENDING_LIMIT } from "./input.ts";

const STATUS_LEASE_MS = 15_000;
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE room_members (
    subject TEXT PRIMARY KEY NOT NULL,
    room TEXT NOT NULL
  );
  CREATE INDEX members_by_room ON room_members (room);
  CREATE TABLE room_events (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    room TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX history_by_room ON room_events (room, seq);
  CREATE TABLE pending (
    recipient TEXT NOT NULL,
    event_seq INTEGER NOT NULL REFERENCES room_events(seq),
    expires_ms INTEGER NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('now', 'batch')),
    answer INTEGER NOT NULL CHECK (answer IN (0, 1)),
    PRIMARY KEY (recipient, event_seq)
  );
  CREATE INDEX pending_by_expiry ON pending (expires_ms);
  CREATE TABLE agent_status (
    subject TEXT PRIMARY KEY NOT NULL,
    body TEXT NOT NULL
  );
  PRAGMA user_version = 1;
`;

export class Conflict extends Error {}
export class NotFound extends Error {}

type Activity = { kind: "enter" | "leave" } | ({ kind: "speech" } & Required<HouseSpeech>);
type Occupant = { agent: Agent; status: HouseAgentStatus | null };

export class House {
  private readonly db: DatabaseSync;
  private readonly name: string;
  private readonly rooms: Map<string, HouseRoom>;
  private readonly agents: Map<string, Agent>;
  private readonly ids: Set<string>;
  private readonly seen = new Map<string, number>();

  constructor(config: HouseConfig, now: number) {
    this.name = config.name;
    this.rooms = new Map(config.rooms.map((room) => [room.id, room]));
    this.agents = new Map(config.agents.map((agent) => [agent.subject, agent]));
    this.ids = new Set(config.agents.map(({ actor }) => actor.id));
    this.db = new DatabaseSync(config.database);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version === 0) this.transaction(() => this.db.exec(SCHEMA));
      else if (version !== 1) throw new Error("unknown house database version");
      this.transaction(() => this.reconcileConfig(now));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  agent(subject: string): Agent | undefined {
    return this.agents.get(subject);
  }

  view(agent: Agent, now: number): HouseView {
    const membership = new Map(this.db.prepare("SELECT subject, room FROM room_members").all().map((row) => [row.subject as string, row.room as string]));
    const rooms = new Map([...this.rooms.values()].map((room) => [room.id, { ...room, occupants: [] as HouseResident[] }]));
    const statuses = new Map(this.db.prepare("SELECT subject, body FROM agent_status").all().map((row) => [row.subject as string, row.body as string]));
    const away: HouseResident[] = [];
    for (const each of this.agents.values()) {
      const room = rooms.get(membership.get(each.subject) ?? "");
      const status = statuses.get(each.subject);
      (room?.occupants ?? away).push(this.visible(each, status === undefined ? null : JSON.parse(status) as HouseAgentStatus, now));
    }
    return { name: this.name, you: agent.actor.id, rooms: [...rooms.values()], away };
  }

  enter(agent: Agent, roomId: string, now: number): HouseEnterResult {
    const room = this.room(roomId);
    return this.transaction(() => {
      const current = this.roomOf(agent);
      if (current === roomId) return { occupants: this.visibleIn(roomId, now) };
      const before = this.inRoom(roomId);
      if (room.capacity !== null && before.length >= room.capacity) throw new Conflict("room is full");
      if (current !== undefined) this.exit(agent, this.room(current), now);
      this.db.prepare("INSERT INTO room_members (subject, room) VALUES (?, ?)").run(agent.subject, roomId);
      this.record(room, agent, { kind: "enter" }, before, now);
      return { occupants: this.visibleIn(roomId, now) };
    });
  }

  leave(agent: Agent, now: number): void {
    this.transaction(() => {
      const roomId = this.roomOf(agent);
      if (roomId !== undefined) this.exit(agent, this.room(roomId), now);
    });
  }

  say(agent: Agent, roomId: string, speech: Required<HouseSpeech>, now: number): HouseSpeechResult {
    const room = this.room(roomId);
    if (speech.to.some((id) => !this.ids.has(id))) throw new InvalidInput("to contains an unknown resident ID");
    return this.transaction(() => {
      if (this.roomOf(agent) !== roomId) throw new Conflict("you are not in that room");
      const listeners: Occupant[] = [];
      const not_delivered: HouseActor[] = [];
      for (const member of this.inRoom(roomId)) {
        if (member.status && member.status.sleep.state !== "awake") not_delivered.push(member.agent.actor);
        else listeners.push(member);
      }
      const id = this.record(room, agent, { kind: "speech", ...speech }, listeners, now);
      return { id, not_delivered };
    });
  }

  sync(agent: Agent, { status, ack }: Required<HouseSync>, now: number): HouseSyncResult {
    const pending = this.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_status (subject, body) VALUES (?, ?)
        ON CONFLICT (subject) DO UPDATE SET body = excluded.body WHERE agent_status.body != excluded.body
      `).run(agent.subject, JSON.stringify(status));
      const acknowledge = this.db.prepare("DELETE FROM pending WHERE recipient = ? AND event_seq = (SELECT seq FROM room_events WHERE id = ?)");
      for (const id of ack) acknowledge.run(agent.subject, id);
      this.expire(now);
      return this.db.prepare(`
        SELECT e.body, p.delivery, p.answer FROM pending p JOIN room_events e ON e.seq = p.event_seq
        WHERE p.recipient = ? ORDER BY p.event_seq LIMIT ?
      `).all(agent.subject, PENDING_LIMIT).map((row): HouseDelivery => ({
        event: JSON.parse(row.body as string) as HouseEvent,
        delivery: row.delivery as HouseDelivery["delivery"],
        ...(row.answer === 1 ? { answer_via: { command: "house say" } } : {}),
      }));
    });
    this.seen.set(agent.subject, now);
    return { house: this.view(agent, now), pending };
  }

  private reconcileConfig(now: number): void {
    const removeMember = this.db.prepare("DELETE FROM room_members WHERE subject = ?");
    for (const { subject, room } of this.db.prepare("SELECT subject, room FROM room_members").all()) {
      if (!this.agents.has(subject as string) || !this.rooms.has(room as string)) removeMember.run(subject!);
    }
    const removePending = this.db.prepare("DELETE FROM pending WHERE recipient = ?");
    for (const { recipient } of this.db.prepare("SELECT DISTINCT recipient FROM pending").all()) {
      if (!this.agents.has(recipient as string)) removePending.run(recipient!);
    }
    const removeStatus = this.db.prepare("DELETE FROM agent_status WHERE subject = ?");
    for (const { subject } of this.db.prepare("SELECT subject FROM agent_status").all()) {
      if (!this.agents.has(subject as string)) removeStatus.run(subject!);
    }
    this.expire(now);
  }

  private expire(now: number): void {
    this.db.prepare("DELETE FROM pending WHERE expires_ms <= ?").run(now);
  }

  private room(id: string): HouseRoom {
    const room = this.rooms.get(id);
    if (room === undefined) throw new NotFound("room does not exist");
    return room;
  }

  private roomOf(agent: Agent): string | undefined {
    return this.db.prepare("SELECT room FROM room_members WHERE subject = ?").get(agent.subject)?.room as string | undefined;
  }

  private inRoom(room: string): Occupant[] {
    return this.db.prepare(`
      SELECT m.subject, s.body FROM room_members m LEFT JOIN agent_status s USING (subject) WHERE m.room = ? ORDER BY m.rowid
    `).all(room).map(({ subject, body }) => ({
      agent: this.agents.get(subject as string)!,
      status: body === null ? null : JSON.parse(body as string) as HouseAgentStatus,
    }));
  }

  private visible(agent: Agent, status: HouseAgentStatus | null, now: number): HouseResident {
    const seen = this.seen.get(agent.subject);
    return {
      ...agent.actor,
      status: status && seen !== undefined && now - seen < STATUS_LEASE_MS ? { mood: status.mood, sleep: status.sleep } : null,
    };
  }

  private visibleIn(room: string, now: number): HouseResident[] {
    return this.inRoom(room).map(({ agent, status }) => this.visible(agent, status, now));
  }

  private exit(agent: Agent, room: HouseRoom, now: number): void {
    this.db.prepare("DELETE FROM room_members WHERE subject = ?").run(agent.subject);
    this.record(room, agent, { kind: "leave" }, this.inRoom(room.id), now);
  }

  private record(room: HouseRoom, agent: Agent, activity: Activity, recipients: Occupant[], now: number): string {
    const id = randomUUID();
    const event: HouseEvent = { id, occurred_at: new Date(now).toISOString(), room: { id: room.id, name: room.name }, actor: agent.actor, ...activity };
    const { lastInsertRowid } = this.db.prepare("INSERT INTO room_events (id, room, body) VALUES (?, ?, ?)").run(id, room.id, JSON.stringify(event));
    const deliver = this.db.prepare("INSERT INTO pending (recipient, event_seq, expires_ms, delivery, answer) VALUES (?, ?, ?, ?, ?)");
    for (const { agent: listener } of recipients) {
      const own = listener.subject === agent.subject;
      const mode = event.kind === "leave" || own ? "batch" : "now";
      const answer = event.kind === "speech" && !own && event.to.includes(listener.actor.id);
      deliver.run(listener.subject, lastInsertRowid, now + DELIVERY_TTL_MS, mode, Number(answer));
    }
    return id;
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
