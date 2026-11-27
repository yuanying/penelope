import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  HouseActor, HouseAgentIdentity, HouseAgentStatus, HouseDelivery, HouseEvent, HouseHistory, HousePersonEvent, HousePersonFloor,
  HousePersonIdentity, HousePersonOccupant, HouseResident, HouseRoom, HouseSpeech, HouseSpeechResult,
  HouseSync, HouseSyncResult, HouseView,
} from "@penelope/contract";

import type { Agent, HouseConfig, Person, Resident } from "./config.ts";
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

const PEOPLE_SCHEMA = `
  CREATE TABLE person_profile (
    subject TEXT PRIMARY KEY NOT NULL,
    avatar_url TEXT,
    return_room TEXT
  );
  CREATE INDEX latest_speech_by_room ON room_events (room, seq DESC) WHERE json_extract(body, '$.kind') = 'speech';
  PRAGMA user_version = 2;
`;

const SESSION_SCHEMA = `
  ALTER TABLE person_profile ADD COLUMN github_user_id INTEGER;
  CREATE TABLE person_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    subject TEXT NOT NULL REFERENCES person_profile(subject),
    expires_ms INTEGER NOT NULL
  );
  CREATE INDEX person_sessions_by_subject ON person_sessions (subject);
  PRAGMA user_version = 3;
`;

const HISTORY_LIMIT = 50;

export type PersonSession = { person: Person; tokenHash: string; expires: number };

function agentIdentity({ actor, avatar_url, chat_url }: Agent): HouseAgentIdentity {
  return { ...actor, avatar_url, chat_url };
}

export class Conflict extends Error {}
export class NotFound extends Error {}

type Activity = { kind: "enter" | "leave" } | ({ kind: "speech" } & Required<HouseSpeech>);
type Occupant = { resident: Resident; status: HouseAgentStatus | null; avatar: string | null };

export class House {
  private readonly db: DatabaseSync;
  private readonly name: string;
  private readonly rooms: Map<string, HouseRoom>;
  private readonly agents: Map<string, Agent>;
  private readonly people: Map<string, Person>;
  private readonly residents: Map<string, Resident>;
  private readonly ids: Set<string>;
  private readonly seen = new Map<string, number>();

  constructor(config: HouseConfig, now: number) {
    this.name = config.name;
    this.rooms = new Map(config.rooms.map((room) => [room.id, room]));
    this.agents = new Map(config.agents.map((agent) => [agent.subject, agent]));
    this.people = new Map(config.people.map((person) => [person.subject, person]));
    this.residents = new Map<string, Resident>([...this.agents, ...this.people]);
    this.ids = new Set([...this.residents.values()].map(({ actor }) => actor.id));
    this.db = new DatabaseSync(config.database);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error("unknown house database version");
      this.transaction(() => {
        if (version === 0) this.db.exec(SCHEMA);
        if (version < 2) this.db.exec(PEOPLE_SCHEMA);
        if (version < 3) this.db.exec(SESSION_SCHEMA);
        this.reconcileConfig(now);
      });
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

  person(login: string): Person | undefined {
    return this.people.get(`github:${login.toLowerCase()}`);
  }

  hasRoom(id: string): boolean {
    return this.rooms.has(id);
  }

  createPersonSession({ person, tokenHash, expires }: PersonSession, profile: { id: number; avatar: string | null }, now: number): boolean {
    return this.transaction(() => {
      const pinned = this.db.prepare(`
        INSERT INTO person_profile (subject, github_user_id, avatar_url) VALUES (?, ?, ?)
        ON CONFLICT (subject) DO UPDATE SET github_user_id = excluded.github_user_id, avatar_url = excluded.avatar_url
        WHERE person_profile.github_user_id IS NULL OR person_profile.github_user_id = excluded.github_user_id
      `).run(person.subject, profile.id, profile.avatar);
      if (pinned.changes === 0) return false;
      this.db.prepare("DELETE FROM person_sessions WHERE expires_ms <= ?").run(now);
      this.db.prepare("INSERT INTO person_sessions (token_hash, subject, expires_ms) VALUES (?, ?, ?)").run(tokenHash, person.subject, expires);
      return true;
    });
  }

  personSession(tokenHash: string, now: number): PersonSession | undefined {
    const row = this.db.prepare("SELECT subject, expires_ms FROM person_sessions WHERE token_hash = ? AND expires_ms > ?")
      .get(tokenHash, now) as { subject: string; expires_ms: number } | undefined;
    if (!row) return;
    const person = this.people.get(row.subject);
    if (person) return { person, tokenHash, expires: row.expires_ms };
  }

  revokePersonSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM person_sessions WHERE token_hash = ?").run(tokenHash);
  }

  identity(person: Person): HousePersonIdentity {
    const avatar = this.db.prepare("SELECT avatar_url FROM person_profile WHERE subject = ?").get(person.subject)?.avatar_url as string | null | undefined;
    return { ...person.actor, ...(avatar ? { avatar_url: avatar } : {}) };
  }

  view(agent: Agent, now: number): HouseView {
    const rooms = [...this.rooms.values()].map((room) => ({ ...room, occupants: this.visibleIn(room.id, now) }));
    return { name: this.name, you: agent.actor.id, rooms, away: this.away(rooms).map(({ actor }) => actor) };
  }

  personFloor(now: number, connectedPeople: ReadonlySet<string>): HousePersonFloor {
    const latest = this.db.prepare("SELECT body FROM room_events WHERE room = ? AND json_extract(body, '$.kind') = 'speech' ORDER BY seq DESC LIMIT 1");
    const rooms = [...this.rooms.values()].map((room) => {
      const occupants = this.inRoom(room.id).map(({ resident, status, avatar }): HousePersonOccupant => {
        const agent = this.agents.get(resident.subject);
        if (agent) {
          const connected = this.agentConnected(agent, now);
          return { ...agentIdentity(agent), connected, status: connected ? status : null };
        }
        return { ...resident.actor, kind: "person", connected: connectedPeople.has(resident.subject), ...(avatar ? { avatar_url: avatar } : {}) };
      });
      const row = latest.get(room.id);
      let last_speech = null;
      if (row) {
        const { id, actor, occurred_at, text } = JSON.parse(row.body as string) as Extract<HouseEvent, { kind: "speech" }>;
        const chars = [...text.trim().split(/\r?\n/, 1)[0]!];
        const preview = chars.length <= 200 ? chars.join("") : `${chars.slice(0, 199).join("")}…`;
        last_speech = { id, actor, occurred_at, text: preview };
      }
      return { ...room, occupants, last_speech };
    });
    const away = this.away(rooms).map(({ subject }) => {
      const agent = this.agents.get(subject);
      return agent ? agentIdentity(agent) : this.identity(this.people.get(subject)!);
    });
    return { name: this.name, rooms, away };
  }

  history(roomId: string, before: string | null): HouseHistory {
    this.room(roomId);
    const limit = before === null ? undefined : this.db.prepare("SELECT seq FROM room_events WHERE room = ? AND id = ?").get(roomId, before)?.seq;
    if (before !== null && limit === undefined) throw new InvalidInput("unknown history cursor");
    const rows = limit === undefined
      ? this.db.prepare("SELECT seq, body FROM room_events WHERE room = ? ORDER BY seq DESC LIMIT ?").all(roomId, HISTORY_LIMIT + 1)
      : this.db.prepare("SELECT seq, body FROM room_events WHERE room = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(roomId, limit, HISTORY_LIMIT + 1);
    const events = rows.slice(0, HISTORY_LIMIT).map(({ seq, body }): HousePersonEvent => ({ ...(JSON.parse(body as string) as HouseEvent), seq: seq as number }));
    return { events, before: rows.length > HISTORY_LIMIT ? events.at(-1)?.id : undefined };
  }

  returnRoom(person: Person): string | undefined {
    const room = this.db.prepare("SELECT return_room FROM person_profile WHERE subject = ?").get(person.subject)?.return_room;
    return typeof room === "string" ? room : undefined;
  }

  enter(resident: Resident, roomId: string, now: number): HousePersonEvent[] {
    const room = this.room(roomId);
    return this.transaction(() => {
      const current = this.roomOf(resident);
      if (current === roomId) return [];
      const before = this.inRoom(roomId);
      if (room.capacity !== null && before.length >= room.capacity) throw new Conflict("room is full");
      const events: HousePersonEvent[] = [];
      if (current !== undefined) events.push(this.exit(resident, this.room(current), now));
      this.db.prepare("INSERT INTO room_members (subject, room) VALUES (?, ?)").run(resident.subject, roomId);
      if (resident.actor.kind === "person") {
        this.db.prepare(`
          INSERT INTO person_profile (subject, return_room) VALUES (?, ?)
          ON CONFLICT (subject) DO UPDATE SET return_room = excluded.return_room
        `).run(resident.subject, roomId);
      }
      events.push(this.record(room, resident, { kind: "enter" }, before, now));
      return events;
    });
  }

  leave(resident: Resident, now: number, forget = false): HousePersonEvent[] {
    return this.transaction(() => {
      if (forget) this.db.prepare("UPDATE person_profile SET return_room = NULL WHERE subject = ?").run(resident.subject);
      const roomId = this.roomOf(resident);
      return roomId === undefined ? [] : [this.exit(resident, this.room(roomId), now)];
    });
  }

  say(resident: Resident, roomId: string, speech: Required<HouseSpeech>, now: number): { result: HouseSpeechResult; event: HousePersonEvent } {
    const room = this.room(roomId);
    if (speech.to.some((id) => !this.ids.has(id))) throw new InvalidInput("to contains an unknown resident ID");
    return this.transaction(() => {
      if (this.roomOf(resident) !== roomId) throw new Conflict("you are not in that room");
      const listeners: Occupant[] = [];
      const not_delivered: HouseActor[] = [];
      for (const member of this.inRoom(roomId)) {
        if (member.status && member.status.sleep.state !== "awake") not_delivered.push(member.resident.actor);
        else listeners.push(member);
      }
      const event = this.record(room, resident, { kind: "speech", ...speech }, listeners, now);
      return { result: { id: event.id, not_delivered }, event };
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
    const members = this.db.prepare("SELECT subject, room FROM room_members").all();
    for (const { subject, room } of members) {
      if (!this.residents.has(subject as string) || !this.rooms.has(room as string)) removeMember.run(subject!);
    }
    for (const { subject, room } of members) {
      const person = this.people.get(subject as string);
      const location = this.rooms.get(room as string);
      if (person && location) this.exit(person, location, now);
    }
    for (const { subject, return_room } of this.db.prepare("SELECT subject, return_room FROM person_profile").all()) {
      if (!this.people.has(subject as string)) {
        this.db.prepare("DELETE FROM person_sessions WHERE subject = ?").run(subject!);
        this.db.prepare("UPDATE person_profile SET avatar_url = NULL, return_room = NULL WHERE subject = ?").run(subject!);
      } else if (return_room !== null && !this.hasRoom(return_room as string)) {
        this.db.prepare("UPDATE person_profile SET return_room = NULL WHERE subject = ?").run(subject!);
      }
    }
    this.db.prepare("DELETE FROM person_sessions WHERE expires_ms <= ?").run(now);
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

  roomOf(resident: Resident): string | undefined {
    return this.db.prepare("SELECT room FROM room_members WHERE subject = ?").get(resident.subject)?.room as string | undefined;
  }

  private away(rooms: { occupants: HouseActor[] }[]): Resident[] {
    const present = new Set(rooms.flatMap(({ occupants }) => occupants.map(({ id }) => id)));
    return [...this.residents.values()].filter(({ actor }) => !present.has(actor.id));
  }

  private inRoom(room: string): Occupant[] {
    return this.db.prepare(`
      SELECT m.subject, s.body, p.avatar_url FROM room_members m
      LEFT JOIN agent_status s USING (subject) LEFT JOIN person_profile p USING (subject)
      WHERE m.room = ? ORDER BY m.rowid
    `).all(room).map(({ subject, body, avatar_url }) => ({
      resident: this.residents.get(subject as string)!,
      status: body === null ? null : JSON.parse(body as string) as HouseAgentStatus,
      avatar: avatar_url as string | null,
    }));
  }

  private agentConnected(resident: Resident, now: number): boolean {
    const seen = this.seen.get(resident.subject);
    return seen !== undefined && now - seen < STATUS_LEASE_MS;
  }

  visibleIn(room: string, now: number): HouseResident[] {
    return this.inRoom(room).map(({ resident, status }) => ({
      ...resident.actor,
      status: status && this.agentConnected(resident, now) ? { mood: status.mood, sleep: status.sleep } : null,
    }));
  }

  private exit(resident: Resident, room: HouseRoom, now: number): HousePersonEvent {
    this.db.prepare("DELETE FROM room_members WHERE subject = ?").run(resident.subject);
    return this.record(room, resident, { kind: "leave" }, this.inRoom(room.id), now);
  }

  /** The body kept, and what agents are given, has no `seq`: the row's own number is the event's place in the record. */
  private record(room: HouseRoom, resident: Resident, activity: Activity, recipients: Occupant[], now: number): HousePersonEvent {
    const id = randomUUID();
    const event: HouseEvent = { id, occurred_at: new Date(now).toISOString(), room: { id: room.id, name: room.name }, actor: resident.actor, ...activity };
    const { lastInsertRowid } = this.db.prepare("INSERT INTO room_events (id, room, body) VALUES (?, ?, ?)").run(id, room.id, JSON.stringify(event));
    const deliver = this.db.prepare("INSERT INTO pending (recipient, event_seq, expires_ms, delivery, answer) VALUES (?, ?, ?, ?, ?)");
    for (const { resident: listener } of recipients) {
      if (listener.actor.kind !== "agent") continue;
      const own = listener.subject === resident.subject;
      const mode = event.kind === "leave" || own ? "batch" : "now";
      const answer = event.kind === "speech" && !own && event.to.includes(listener.actor.id);
      deliver.run(listener.subject, lastInsertRowid, now + DELIVERY_TTL_MS, mode, Number(answer));
    }
    return { ...event, seq: Number(lastInsertRowid) };
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
