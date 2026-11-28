import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  HouseActor, HouseAgentIdentity, HouseAgentStatus, HouseConversationDelivery, HouseConversationSyncResult, HouseDelivery,
  HouseDirectAvailability, HouseDirectDeliveryStatus, HouseDirectEvent, HouseDirectHistory, HouseEvent, HouseHistory, HouseImage,
  HousePersonDirectEvent, HousePersonEvent, HousePersonFloor, HousePersonIdentity, HousePersonOccupant, HouseReplyResult,
  HouseResident, HouseRoom, HouseSpeechResult, HouseSyncResult, HouseView,
} from "@penelope/contract";

import { DIRECT_STREAM_PREFIX, type Agent, type HouseConfig, type Person, type Resident } from "./config.ts";
import { InvalidInput, PENDING_LIMIT, toOf, type ImageInput, type MessageInput, type ReplyInput, type SpeechInput, type SyncInput } from "./input.ts";

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

const DIRECT_SCHEMA = `
  ALTER TABLE room_events RENAME TO events;
  ALTER TABLE events RENAME COLUMN room TO stream;
  ALTER TABLE events ADD COLUMN dm_owner TEXT;
  ALTER TABLE events ADD COLUMN dm_agent TEXT;
  ALTER TABLE events ADD COLUMN delivery_status TEXT CHECK (delivery_status IN ('pending', 'delivered', 'expired'));
  CREATE TABLE images (
    id TEXT PRIMARY KEY NOT NULL,
    event_seq INTEGER NOT NULL REFERENCES events(seq),
    mime_type TEXT NOT NULL,
    bytes BLOB NOT NULL
  );
  PRAGMA user_version = 4;
`;

const PROTOCOL_SCHEMA = `
  ALTER TABLE agent_status ADD COLUMN protocol INTEGER CHECK (protocol = 2);
  PRAGMA user_version = 5;
`;

const HISTORY_LIMIT = 50;

export type PersonSession = { person: Person; tokenHash: string; expires: number };
export type PersonEvent = HousePersonEvent | HousePersonDirectEvent;

function agentIdentity({ actor, avatar_url, avatar_urls, personal_url, chat_url }: Agent): HouseAgentIdentity {
  return { ...actor, avatar_url, avatar_urls, personal_url, chat_url };
}

function directEvent({ seq, body, delivery_status }: DirectRow): HousePersonDirectEvent {
  return { ...(JSON.parse(body) as HouseDirectEvent), seq, ...(delivery_status === null ? {} : { delivery_status }) };
}

export class Conflict extends Error {}
export class NotFound extends Error {}

type Activity = { kind: "enter" | "leave" } | ({ kind: "speech" } & SpeechInput);
type Occupant = { resident: Resident; status: HouseAgentStatus | null; avatar: string | null };
type DirectPair = { agent: Agent; owner: Person; stream: string };
type DirectRow = { seq: number; body: string; delivery_status: HouseDirectDeliveryStatus | null };
type PendingRow = { body: string; stream: string; delivery: HouseDelivery["delivery"]; answer: number };
type ImageCopy = { mime_type: HouseImage["mime_type"]; bytes: Uint8Array };

function conversationDelivery({ body, stream, delivery, answer }: PendingRow, owner: Person | undefined): HouseConversationDelivery {
  const event = JSON.parse(body) as HouseEvent | HouseDirectEvent;
  return {
    event, stream, delivery, owner: event.actor.kind === "person" && event.actor.id === owner?.actor.id,
    ...(answer === 1 ? { answer_via: { tool: "reply" } } : {}),
  };
}

function legacyDelivery({ body, delivery, answer }: PendingRow): HouseDelivery {
  let event = JSON.parse(body) as HouseEvent;
  if (event.kind === "speech") {
    const { images: _images, expression: _expression, ...legacy } = event;
    event = legacy;
  }
  return { event, delivery, ...(answer === 1 ? { answer_via: { command: "house say" } } : {}) };
}

export class House {
  private readonly db: DatabaseSync;
  private readonly name: string;
  private readonly rooms: Map<string, HouseRoom>;
  private readonly agents: Map<string, Agent>;
  private readonly people: Map<string, Person>;
  private readonly residents: Map<string, Resident>;
  private readonly ids: Set<string>;
  private readonly directByAgent = new Map<string, DirectPair>();
  private readonly seen = new Map<string, number>();

  constructor(config: HouseConfig, now: number) {
    this.name = config.name;
    this.rooms = new Map(config.rooms.map((room) => [room.id, room]));
    this.agents = new Map(config.agents.map((agent) => [agent.subject, agent]));
    this.people = new Map(config.people.map((person) => [person.subject, person]));
    this.residents = new Map<string, Resident>([...this.agents, ...this.people]);
    this.ids = new Set([...this.residents.values()].map(({ actor }) => actor.id));
    for (const agent of config.agents) {
      const { owner } = agent;
      if (!owner) continue;
      const hash = createHash("sha256").update(JSON.stringify([owner.subject, agent.subject])).digest("hex");
      this.directByAgent.set(agent.actor.id, { agent, owner, stream: `${DIRECT_STREAM_PREFIX}${hash}` });
    }
    this.db = new DatabaseSync(config.database);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
      if (typeof version !== "number" || !Number.isInteger(version) || version < 0 || version > 5) throw new Error("unknown house database version");
      this.transaction(() => {
        if (version === 0) this.db.exec(SCHEMA);
        if (version < 2) this.db.exec(PEOPLE_SCHEMA);
        if (version < 3) this.db.exec(SESSION_SCHEMA);
        if (version < 4) this.db.exec(DIRECT_SCHEMA);
        if (version < 5) this.db.exec(PROTOCOL_SCHEMA);
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
    const latest = this.db.prepare("SELECT body FROM events WHERE stream = ? AND json_extract(body, '$.kind') = 'speech' ORDER BY seq DESC LIMIT 1");
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

  directAvailability(person: Person, now: number): HouseDirectAvailability[] {
    return [...this.directByAgent.values()].filter(({ owner }) => owner.subject === person.subject).map(({ agent }) => {
      const connected = this.agentConnected(agent, now);
      const deployment = this.deployment(agent);
      const modern = deployment?.protocol === 2;
      const inRoom = this.roomOf(agent) !== undefined;
      const send = inRoom ? "in-room" : modern ? "ready" : "deployment-unsupported";
      const sleeping = connected && !inRoom && modern && (JSON.parse(deployment.body) as HouseAgentStatus).sleep.state !== "awake";
      return { agent_id: agent.actor.id, send, sleeping, connected };
    });
  }

  history(roomId: string, before: string | null): HouseHistory {
    this.room(roomId);
    return this.historyPage(roomId, before, null, ({ seq, body }): HousePersonEvent => ({ ...(JSON.parse(body) as HouseEvent), seq }));
  }

  directHistory(owner: Person, agentId: string, before: string | null, now: number): HouseDirectHistory {
    const { stream } = this.directPair(owner, agentId);
    return this.historyPage(stream, before, now, directEvent);
  }

  private historyPage<T extends PersonEvent>(stream: string, before: string | null, now: number | null, parse: (row: DirectRow) => T): { events: T[]; before?: string } {
    const bound = before === null ? null : this.db.prepare("SELECT seq FROM events WHERE stream = ? AND id = ?").get(stream, before)?.seq;
    if (bound === undefined) throw new InvalidInput("unknown history cursor");
    const rows = this.db.prepare(`
      SELECT e.seq, e.body,
        CASE WHEN e.delivery_status = 'pending' AND p.expires_ms <= ? THEN 'expired' ELSE e.delivery_status END AS delivery_status
      FROM events e LEFT JOIN pending p ON p.recipient = e.dm_agent AND p.event_seq = e.seq
      WHERE e.stream = ? ${bound === null ? "" : "AND e.seq < ?"} ORDER BY e.seq DESC LIMIT ?
    `).all(now, stream, ...(bound === null ? [] : [bound]), HISTORY_LIMIT + 1) as DirectRow[];
    const events = rows.slice(0, HISTORY_LIMIT).map(parse);
    return { events, before: rows.length > HISTORY_LIMIT ? events.at(-1)?.id : undefined };
  }

  personImage(person: Person, id: string): ImageCopy {
    const row = this.db.prepare(`
      SELECT i.mime_type, i.bytes, e.stream, e.dm_owner, e.dm_agent
      FROM images i JOIN events e ON i.event_seq = e.seq WHERE i.id = ?
    `).get(id) as (ImageCopy & { stream: string; dm_owner: string | null; dm_agent: string | null }) | undefined;
    const allowed = row && (row.dm_owner === null ? this.hasRoom(row.stream) :
      row.dm_owner === person.subject && this.agents.get(row.dm_agent!)?.owner?.subject === person.subject);
    if (!allowed) throw new NotFound("image not found");
    return row;
  }

  agentImage(agent: Agent, id: string, now: number): ImageCopy {
    const row = this.db.prepare(`
      SELECT i.mime_type, i.bytes FROM images i
      JOIN events e ON i.event_seq = e.seq JOIN pending p ON p.event_seq = e.seq
      WHERE i.id = ? AND p.recipient = ? AND p.expires_ms > ?
        AND (e.dm_owner IS NULL OR (e.dm_owner = ? AND e.dm_agent = ?))
    `).get(id, agent.subject, now, agent.owner?.subject ?? null, agent.subject) as ImageCopy | undefined;
    if (!row) throw new NotFound("image not found");
    return row;
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
      events.push(this.record(room, resident, { kind: "enter" }, before, now));
      return events;
    });
  }

  leave(resident: Resident, now: number): HousePersonEvent[] {
    return this.transaction(() => {
      const roomId = this.roomOf(resident);
      return roomId === undefined ? [] : [this.exit(resident, this.room(roomId), now)];
    });
  }

  say(resident: Resident, roomId: string, speech: SpeechInput, now: number, echo = false): { result: HouseSpeechResult; event: HousePersonEvent } {
    const room = this.room(roomId);
    return this.transaction(() => {
      if (this.roomOf(resident) !== roomId) throw new Conflict("you are not in that room");
      return this.sayInRoom(resident, room, speech, now, echo);
    });
  }

  reply(agent: Agent, { to, ...message }: ReplyInput, now: number): { result: HouseReplyResult; event: PersonEvent } {
    return this.transaction(() => {
      const roomId = this.roomOf(agent);
      if (roomId !== undefined) {
        const room = this.room(roomId);
        const { result, event, absent_to } = this.sayInRoom(agent, room, { ...message, to: toOf(to) }, now);
        return { result: { ...result, destination: { kind: "room", room: event.room }, absent_to }, event };
      }
      const pair = this.directByAgent.get(agent.actor.id);
      if (!pair) throw new Conflict("owner-not-configured");
      const event = this.recordDirect(pair, agent, message, now);
      const destination = { kind: "dm", dm: event.dm } as const;
      return { result: { id: event.id, destination, not_delivered: [], ...(to === undefined ? {} : { ignored_to: to }) }, event };
    });
  }

  sayDirect(owner: Person, agentId: string, message: MessageInput, now: number): HousePersonDirectEvent {
    const pair = this.directPair(owner, agentId);
    return this.transaction(() => {
      if (this.roomOf(pair.agent) !== undefined) throw new Conflict("agent-in-room");
      if (this.deployment(pair.agent)?.protocol !== 2) throw new Conflict("deployment-unsupported");
      return this.recordDirect(pair, owner, message, now);
    });
  }

  private sayInRoom(resident: Resident, room: HouseRoom, speech: SpeechInput, now: number, echo = false): {
    result: HouseSpeechResult; event: HousePersonEvent; absent_to: string[];
  } {
    if (speech.to.some((id) => !this.ids.has(id))) throw new InvalidInput("to contains an unknown resident ID");
    const listeners: Occupant[] = [];
    const not_delivered: HouseActor[] = [];
    const members = this.inRoom(room.id);
    for (const member of members) {
      if (!echo && member.resident.subject === resident.subject) continue;
      if (member.status && member.status.sleep.state !== "awake") not_delivered.push(member.resident.actor);
      else listeners.push(member);
    }
    const event = this.record(room, resident, { kind: "speech", ...speech }, listeners, now);
    const absent_to = speech.to.filter((id) => !members.some(({ resident }) => resident.actor.id === id));
    return { result: { id: event.id, not_delivered }, event, absent_to };
  }

  sync(agent: Agent, { status, ack, protocol }: SyncInput, now: number): {
    result: HouseSyncResult | HouseConversationSyncResult;
    updates: HousePersonDirectEvent[];
  } {
    const updates: HousePersonDirectEvent[] = [];
    const owner = protocol === 2 ? agent.owner?.subject ?? null : null;
    const rows = this.transaction(() => {
      this.db.prepare(`
        INSERT INTO agent_status (subject, body, protocol) VALUES (?, ?, ?)
        ON CONFLICT (subject) DO UPDATE SET body = excluded.body, protocol = excluded.protocol
        WHERE agent_status.body != excluded.body OR agent_status.protocol IS NOT excluded.protocol
      `).run(agent.subject, JSON.stringify(status), protocol ?? null);
      const acknowledge = this.db.prepare(`
        DELETE FROM pending WHERE recipient = ? AND expires_ms > ? AND event_seq = (
          SELECT seq FROM events WHERE id = ? AND (dm_owner IS NULL OR (dm_owner = ? AND dm_agent = ?))
        ) RETURNING event_seq
      `);
      const delivered = this.db.prepare(`
        UPDATE events SET delivery_status = 'delivered' WHERE seq = ? AND delivery_status = 'pending'
        RETURNING seq, body, delivery_status
      `);
      for (const id of ack) {
        const seq = acknowledge.get(agent.subject, now, id, owner, agent.subject)?.event_seq;
        if (seq === undefined) continue;
        const row = delivered.get(seq) as DirectRow | undefined;
        if (row) updates.push(directEvent(row));
      }
      if (protocol === 2) this.db.prepare(`
        DELETE FROM pending WHERE recipient = ? AND delivery = 'batch' AND EXISTS (
          SELECT 1 FROM events WHERE seq = pending.event_seq AND json_extract(body, '$.kind') = 'speech'
        )
      `).run(agent.subject);
      return this.db.prepare(`
        SELECT e.body, e.stream, p.delivery, p.answer FROM pending p JOIN events e ON e.seq = p.event_seq
        WHERE p.recipient = ? AND p.expires_ms > ? AND (e.dm_owner IS NULL OR (e.dm_owner = ? AND e.dm_agent = ?))
        ORDER BY p.event_seq LIMIT ?
      `).all(agent.subject, now, status.sleep.state === "awake" ? owner : null, agent.subject, PENDING_LIMIT) as PendingRow[];
    });
    this.seen.set(agent.subject, now);
    const house = this.view(agent, now);
    const result = protocol === 2
      ? { house, protocol, pending: rows.map((row) => conversationDelivery(row, agent.owner)) }
      : { house, pending: rows.map(legacyDelivery) };
    return { result, updates };
  }

  expire(now: number): HousePersonDirectEvent[] {
    return this.transaction(() => this.expirePending(now));
  }

  private reconcileConfig(now: number): void {
    const removeMember = this.db.prepare("DELETE FROM room_members WHERE subject = ?");
    const members = this.db.prepare("SELECT subject, room FROM room_members").all();
    for (const { subject, room } of members) {
      if (!this.residents.has(subject as string) || !this.rooms.has(room as string)) removeMember.run(subject!);
    }
    for (const { subject } of this.db.prepare("SELECT subject FROM person_profile").all()) {
      if (!this.people.has(subject as string)) {
        this.db.prepare("DELETE FROM person_sessions WHERE subject = ?").run(subject!);
        this.db.prepare("UPDATE person_profile SET avatar_url = NULL WHERE subject = ?").run(subject!);
      }
    }
    this.db.prepare("DELETE FROM person_sessions WHERE expires_ms <= ?").run(now);
    const removePending = this.db.prepare(`
      DELETE FROM pending WHERE recipient = ? AND EXISTS (SELECT 1 FROM events WHERE seq = pending.event_seq AND dm_owner IS NULL)
    `);
    for (const { recipient } of this.db.prepare("SELECT DISTINCT recipient FROM pending").all()) {
      if (!this.agents.has(recipient as string)) removePending.run(recipient!);
    }
    const removeStatus = this.db.prepare("DELETE FROM agent_status WHERE subject = ?");
    for (const { subject } of this.db.prepare("SELECT subject FROM agent_status").all()) {
      if (!this.agents.has(subject as string)) removeStatus.run(subject!);
    }
    this.expirePending(now);
  }

  private expirePending(now: number): HousePersonDirectEvent[] {
    const expired = this.db.prepare(`
      UPDATE events SET delivery_status = 'expired' WHERE delivery_status = 'pending' AND seq IN (
        SELECT event_seq FROM pending WHERE expires_ms <= ?
      ) RETURNING seq, body, delivery_status, dm_owner, dm_agent
    `).all(now) as (DirectRow & { dm_owner: string; dm_agent: string })[];
    this.db.prepare("DELETE FROM pending WHERE expires_ms <= ?").run(now);
    return expired.filter(({ dm_agent, dm_owner }) => this.agents.get(dm_agent)?.owner?.subject === dm_owner).map(directEvent);
  }

  private directPair(person: Person, agentId: string): DirectPair {
    const pair = this.directByAgent.get(agentId);
    if (!pair || pair.owner.subject !== person.subject) throw new NotFound("direct conversation not found");
    return pair;
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

  private deployment(agent: Agent): { body: string; protocol: 2 | null } | undefined {
    return this.db.prepare("SELECT body, protocol FROM agent_status WHERE subject = ?").get(agent.subject) as
      { body: string; protocol: 2 | null } | undefined;
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

  private record(room: HouseRoom, resident: Resident, activity: Activity, recipients: Occupant[], now: number): HousePersonEvent {
    const base = { id: randomUUID(), occurred_at: new Date(now).toISOString(), room: { id: room.id, name: room.name }, actor: resident.actor };
    let event: HousePersonEvent;
    if (activity.kind === "speech") {
      const { images, ...speech } = activity;
      event = this.save(room.id, { ...base, ...speech }, images);
    } else {
      event = this.save(room.id, { ...base, ...activity });
    }
    const deliver = this.db.prepare("INSERT INTO pending (recipient, event_seq, expires_ms, delivery, answer) VALUES (?, ?, ?, ?, ?)");
    for (const { resident: listener } of recipients) {
      if (listener.actor.kind !== "agent") continue;
      const own = listener.subject === resident.subject;
      const mode = event.kind === "leave" || own ? "batch" : "now";
      const answer = event.kind === "speech" && !own && event.to.includes(listener.actor.id);
      deliver.run(listener.subject, event.seq, now + DELIVERY_TTL_MS, mode, Number(answer));
    }
    return event;
  }

  private recordDirect(pair: DirectPair, sender: Agent | Person, { text, expression, images }: MessageInput, now: number): HousePersonDirectEvent {
    const { agent, owner, stream } = pair;
    const outgoing = sender.actor.kind === "person";
    const event: HouseDirectEvent = {
      id: randomUUID(), kind: "speech", occurred_at: new Date(now).toISOString(), actor: sender.actor,
      dm: { agent_id: agent.actor.id, owner_id: owner.actor.id }, text, ...(expression === undefined ? {} : { expression }),
    };
    const saved = this.save(stream, event, images, pair, outgoing ? "pending" : null);
    if (!outgoing) return saved;
    this.db.prepare("INSERT INTO pending (recipient, event_seq, expires_ms, delivery, answer) VALUES (?, ?, ?, 'now', 1)")
      .run(agent.subject, saved.seq, now + DELIVERY_TTL_MS);
    return { ...saved, delivery_status: "pending" };
  }

  private save<E extends HouseEvent | HouseDirectEvent>(stream: string, event: E, images: ImageInput[] = [], pair?: DirectPair, status: "pending" | null = null): E & { seq: number } {
    const copies = images.map(({ data, ...file }) => ({ data, image: { ...file, id: randomUUID(), size: data.byteLength } }));
    const body = copies.length === 0 ? event : { ...event, images: copies.map(({ image }) => image) };
    const { lastInsertRowid } = this.db.prepare("INSERT INTO events (id, stream, body, dm_owner, dm_agent, delivery_status) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, stream, JSON.stringify(body), pair?.owner.subject ?? null, pair?.agent.subject ?? null, status);
    if (copies.length > 0) {
      const insert = this.db.prepare("INSERT INTO images (id, event_seq, mime_type, bytes) VALUES (?, ?, ?, ?)");
      for (const { data, image } of copies) insert.run(image.id, lastInsertRowid, image.mime_type, data);
    }
    return { ...body, seq: Number(lastInsertRowid) };
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
