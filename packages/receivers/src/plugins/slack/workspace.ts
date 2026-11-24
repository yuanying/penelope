// One Slack workspace of the plugin (ADR-0028, docs/receivers.md "Slack のプラグイン"):
// Slack's events, and the messages fetched again after a (re)connection,
// made envelopes. One thing that happened is one event. The receivers keep no
// state: what Slack sends twice, and what a fill-in fetches again, get the
// same `id` and the backend drops them.
import {
  plainText,
  type SlackChannel,
  type SlackChannelType,
  type SlackFile,
  type SlackPayload,
  type SlackPerson,
  type SlackReaction,
} from "@penelope/slack";

import type { IntakeFile } from "../../intake.ts";
import type { ConnectionEvent } from "../../plugin.ts";
import { streamOf, summaryLine } from "../text.ts";
import { describeFailure, type Raw, type SlackApi } from "./api.ts";

/** The subtypes that are someone saying something. Joins, topic changes and the like are not events. */
const SPOKEN = new Set([undefined, "bot_message", "file_share", "me_message", "thread_broadcast"]);

/** The files sent with one event: under the intake's 64 MiB for the whole body. */
const FILES_BUDGET = 60 * 1024 * 1024;

export type WorkspaceOptions = {
  /** The workspace's name in the settings: the first part of each `stream` and `id`. */
  name: string;
  api: SlackApi;
  /** Channels (by name or ID) whose every message is `now`. */
  nowChannels: readonly string[];
  /** The MIME types of the files that are fetched. */
  fileTypes: ReadonlySet<string>;
  maxFileBytes: number;
  /** How far back a fill-in reads. 0 is no fill-in. */
  backfillSeconds: number;
  log: (line: string) => void;
  now: () => Date;
};

type Self = { userId: string; botId?: string; teamId: string };
type Known = { channel: SlackChannel; stream: string };
type Person = SlackPerson & { handle?: string };

/** What a fill-in did: the conversations it read, the events the intake took, the conversations Slack refused. */
export type Filled = { conversations: number; events: number; failed: number; stopped: boolean };

export class Workspace {
  private readonly options: WorkspaceOptions;
  private self: Self | undefined;
  private readonly people = new Map<string, Person>();
  private readonly channels = new Map<string, Known>();

  constructor(options: WorkspaceOptions) {
    this.options = options;
  }

  get name(): string {
    return this.options.name;
  }

  /** Who the bot is, asked once. */
  async identify(): Promise<void> {
    this.self ??= await this.options.api.whoAmI();
  }

  /** Forgets the names of people and channels, so that a rename is seen after the next connection. */
  forget(): void {
    this.people.clear();
    this.channels.clear();
  }

  private log(line: string): void {
    this.options.log(`workspace=${this.options.name} ${line}`);
  }

  /** The events of one Events API callback (the payload of an `events_api` envelope), and how many things were dropped. */
  async fromCallback(callback: Raw): Promise<{ events: ConnectionEvent[]; dropped: number }> {
    const self = this.self!;
    const event = object(callback.event);
    if (callback.team_id !== self.teamId || event === undefined) return { events: [], dropped: 1 };
    const made = await this.fromEvent(event, callback);
    return made === undefined ? { events: [], dropped: 1 } : { events: [made], dropped: 0 };
  }

  private async fromEvent(event: Raw, callback: Raw): Promise<ConnectionEvent | undefined> {
    const eventId = string(callback.event_id);
    const at = typeof callback.event_time === "number" ? new Date(callback.event_time * 1000) : this.options.now();
    if (event.type === "reaction_added" || event.type === "reaction_removed") {
      const item = object(event.item);
      const user = string(event.user);
      const reaction = string(event.reaction);
      if (item?.type !== "message" || !string(item.channel) || !string(item.ts) || !user || !reaction || !eventId) return undefined;
      const where = await this.channel(item.channel as string, undefined);
      const person = await this.person(user);
      const payload: SlackPayload = {
        type: event.type,
        workspace: this.options.name,
        channel: where.channel,
        ts: item.ts as string,
        user: plainPerson(person),
        own: user === this.self!.userId,
        reaction,
      };
      const did = event.type === "reaction_added" ? "reacted" : "took off";
      return this.envelope(`${this.options.name}/${eventId}`, at, where, `${person.name} ${did} :${reaction}:`, "batch", payload);
    }
    if (event.type !== "message") return undefined;
    const channelId = string(event.channel);
    if (!channelId) return undefined;
    const subtype = string(event.subtype);
    if (subtype === "message_changed") {
      const now = object(event.message);
      const before = object(event.previous_message);
      if (!now || !string(now.ts) || !eventId) return undefined;
      // Slack tells of a change to an unfurl or a reply count the same way; only a change of text or files is an edit.
      if (before && now.text === before.text && fileIds(now) === fileIds(before)) return undefined;
      const where = await this.channel(channelId, string(event.channel_type));
      const said = await this.said(now);
      const payload: SlackPayload = { type: "message_changed", workspace: this.options.name, channel: where.channel, ts: now.ts as string, ...thread(now), ...said.fields };
      return this.envelope(`${this.options.name}/${eventId}`, at, where, `${said.who} edited: ${said.plain}`, "batch", payload);
    }
    if (subtype === "message_deleted") {
      const ts = string(event.deleted_ts);
      if (!ts || !eventId) return undefined;
      const where = await this.channel(channelId, string(event.channel_type));
      const payload: SlackPayload = { type: "message_deleted", workspace: this.options.name, channel: where.channel, ts, ...thread(object(event.previous_message) ?? {}) };
      return this.envelope(`${this.options.name}/${eventId}`, at, where, undefined, "batch", payload, ": a message was deleted");
    }
    return this.fromMessage(event, channelId, string(event.channel_type), false);
  }

  /** A message, live or fetched again: the same `id` either way. */
  private async fromMessage(message: Raw, channelId: string, channelType: string | undefined, fetched: boolean): Promise<ConnectionEvent | undefined> {
    const subtype = string(message.subtype);
    const ts = string(message.ts);
    if (!SPOKEN.has(subtype) || !ts) return undefined;
    const where = await this.channel(channelId, channelType);
    const said = await this.said(message);
    const self = this.self!;
    const mention = typeof message.text === "string" && message.text.includes(`<@${self.userId}>`);
    const files = await this.files(message);
    const reactions = fetched ? await this.reactions(message.reactions) : undefined;
    const payload: SlackPayload = {
      type: "message",
      workspace: this.options.name,
      channel: where.channel,
      ts,
      ...thread(message),
      ...(subtype ? { subtype } : {}),
      ...said.fields,
      ...(files.notes.length > 0 ? { files: files.notes } : {}),
      mention,
      ...(object(message.edited) ? { edited: true as const } : {}),
      ...(reactions && reactions.length > 0 ? { reactions } : {}),
      ...(fetched ? { fetched: true as const } : {}),
    };
    const nowChannel = this.options.nowChannels.includes(where.channel.name) || this.options.nowChannels.includes(where.channel.id);
    const delivery = !said.fields.own && (mention || where.channel.type === "im" || nowChannel) ? "now" : "batch";
    return {
      ...this.envelope(`${this.options.name}/${channelId}/${ts}`, new Date(Number(ts) * 1000), where, `${said.who}: ${said.plain}`, delivery, payload),
      ...(delivery === "now" ? { answer_via: { command: "slackctl post" } } : {}),
      ...(files.attached.length > 0 ? { files: files.attached } : {}),
    };
  }

  private envelope(id: string, at: Date, where: Known, what: string | undefined, delivery: "now" | "batch", payload: SlackPayload, after = ""): ConnectionEvent {
    return {
      id,
      occurred_at: Number.isNaN(at.getTime()) ? this.options.now().toISOString() : at.toISOString(),
      summary: summaryLine(`${this.options.name} ${describe(where.channel)}${what === undefined ? "" : ` ${what}`}${after}`),
      stream: where.stream,
      delivery,
      payload,
    };
  }

  /** Who said it and what, with the names of the IDs its markup mentions. */
  private async said(message: Raw): Promise<{ fields: { user: SlackPerson; own: boolean; text: string; names?: Record<string, string> }; who: string; plain: string }> {
    const self = this.self!;
    const userId = string(message.user);
    const botId = string(message.bot_id);
    const person: SlackPerson = userId
      ? plainPerson(await this.person(userId))
      : { name: string(message.username) ?? string(object(message.bot_profile)?.name) ?? botId ?? "bot", bot: true };
    const text = string(message.text) ?? "";
    const names: Record<string, string> = {};
    for (const [, id] of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) names[id!] ??= (await this.person(id!)).name;
    for (const [, id, label] of text.matchAll(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g)) if (!label) names[id!] ??= (await this.channel(id!, undefined)).channel.name;
    const own = (userId !== undefined && userId === self.userId) || (botId !== undefined && botId === self.botId);
    return {
      fields: { user: person, own, text, ...(Object.keys(names).length > 0 ? { names } : {}) },
      who: person.name,
      plain: plainText(text, names),
    };
  }

  /** A person's name: the display name, the real name, or the user name. Their ID when Slack will not say. */
  private async person(id: string): Promise<Person> {
    const known = this.people.get(id);
    if (known) return known;
    let person: Person;
    try {
      const user = await this.options.api.user(id);
      const profile = object(user.profile) ?? {};
      const name = [profile.display_name, user.real_name, profile.real_name, user.name].find((value) => typeof value === "string" && value.trim() !== "") as string | undefined;
      person = { id, name: clean(name ?? id), ...(user.is_bot === true ? { bot: true as const } : {}), ...(typeof user.name === "string" ? { handle: user.name } : {}) };
    } catch (error) {
      this.log(`cannot name a person (${describeFailure(error)})`);
      person = { id, name: id };
    }
    this.people.set(id, person);
    return person;
  }

  /** A channel, with its stream: `<workspace>.<channel>`, or `<workspace>.dm.<user name>` for a DM. */
  private async channel(id: string, type: string | undefined, info?: Raw): Promise<Known> {
    const known = this.channels.get(id);
    if (known) return known;
    let raw = info;
    if (raw === undefined) {
      try {
        raw = await this.options.api.conversation(id);
      } catch (error) {
        this.log(`cannot name a channel (${describeFailure(error)})`);
        raw = {};
      }
    }
    const kind = channelType(type, raw);
    let name = string(raw.name) ?? id;
    let part = name;
    if (kind === "im" && string(raw.user)) {
      const person = await this.person(raw.user as string);
      name = person.name;
      part = `dm.${person.handle ?? person.id}`;
    } else if (kind === "im") {
      part = `dm.${id}`;
    }
    const channel: Known = { channel: { id, name: clean(name), type: kind }, stream: streamOf(`${this.options.name}.${part}`)! };
    this.channels.set(id, channel);
    return channel;
  }

  private async reactions(value: unknown): Promise<SlackReaction[]> {
    if (!Array.isArray(value)) return [];
    const found: SlackReaction[] = [];
    for (const item of value) {
      const reaction = object(item);
      const name = string(reaction?.name);
      if (!reaction || !name) continue;
      const users = Array.isArray(reaction.users) ? reaction.users.filter((user): user is string => typeof user === "string") : [];
      const people: SlackPerson[] = [];
      for (const user of users) people.push(plainPerson(await this.person(user)));
      found.push({ name, users: people, count: typeof reaction.count === "number" ? reaction.count : people.length });
    }
    return found;
  }

  /** The message's files noted, and those of the types and size set fetched to be sent beside it. */
  private async files(message: Raw): Promise<{ notes: SlackFile[]; attached: IntakeFile[] }> {
    const notes: SlackFile[] = [];
    const attached: IntakeFile[] = [];
    let budget = FILES_BUDGET;
    for (const item of Array.isArray(message.files) ? message.files : []) {
      const file = object(item);
      if (!file) continue;
      const note: SlackFile = {
        id: string(file.id) ?? "",
        name: clean(string(file.name) ?? string(file.title) ?? "file"),
        mimetype: string(file.mimetype) ?? "",
        size: typeof file.size === "number" ? file.size : 0,
        attached: false,
      };
      const url = string(file.url_private_download) ?? string(file.url_private);
      const limit = Math.min(this.options.maxFileBytes, budget);
      if (url && this.options.fileTypes.has(note.mimetype) && note.size <= limit) {
        try {
          const data = await this.options.api.download(url, limit);
          if (data !== undefined) {
            attached.push({ name: note.name, type: note.mimetype, data });
            budget -= data.length;
            note.attached = true;
          }
        } catch (error) {
          this.log(`cannot fetch a file (${describeFailure(error)})`);
        }
      }
      notes.push(note);
    }
    return { notes, attached };
  }

  /**
   * Fetches again what was said in the last `backfillSeconds` in every
   * conversation the bot is in, the replies of threads with a reply in that
   * time included, and hands each conversation's events to `deliver` (ADR-0028).
   * It stops at the first the intake does not take.
   */
  async backfill(deliver: (events: readonly ConnectionEvent[]) => Promise<boolean>, stopped: () => boolean = () => false): Promise<Filled> {
    const filled: Filled = { conversations: 0, events: 0, failed: 0, stopped: false };
    if (this.options.backfillSeconds <= 0) return filled;
    const oldest = String(Math.floor(this.options.now().getTime() / 1000) - this.options.backfillSeconds);
    for (const conversation of await this.options.api.conversations()) {
      if (stopped()) return { ...filled, stopped: true };
      const id = string(conversation.id);
      if (!id) continue;
      const events: ConnectionEvent[] = [];
      try {
        await this.channel(id, undefined, conversation);
        for (const message of await this.options.api.messages(id, oldest)) {
          const made = await this.fromMessage(message, id, undefined, true);
          if (made) events.push(made);
          const latest = string(message.latest_reply);
          if (typeof message.reply_count !== "number" || message.reply_count === 0 || !latest || Number(latest) <= Number(oldest)) continue;
          for (const reply of await this.options.api.replies(id, message.ts as string, oldest)) {
            if (reply.ts === message.ts) continue;
            const replied = await this.fromMessage(reply, id, undefined, true);
            if (replied) events.push(replied);
          }
        }
      } catch (error) {
        filled.failed++;
        this.log(`cannot fill in a conversation (${describeFailure(error)})`);
        continue;
      }
      filled.conversations++;
      if (stopped() || !(await deliver(events))) return { ...filled, stopped: true };
      filled.events += events.length;
    }
    return filled;
  }
}

function describe(channel: SlackChannel): string {
  return channel.type === "im" ? `DM with ${channel.name}` : channel.type === "mpim" ? `group DM ${channel.name}` : `#${channel.name}`;
}

function channelType(type: string | undefined, raw: Raw): SlackChannelType {
  if (type === "channel" || type === "group" || type === "im" || type === "mpim") return type;
  if (raw.is_im === true) return "im";
  if (raw.is_mpim === true) return "mpim";
  if (raw.is_private === true || raw.is_group === true) return "group";
  return "channel";
}

/** `thread_ts` of a reply. A parent's own, equal to its `ts`, is left out. */
function thread(message: Raw): { thread_ts?: string } {
  const threadTs = string(message.thread_ts);
  return threadTs && threadTs !== message.ts ? { thread_ts: threadTs } : {};
}

function fileIds(message: Raw): string {
  return (Array.isArray(message.files) ? message.files : []).map((file) => string(object(file)?.id) ?? "").join(",");
}

function plainPerson({ handle: _, ...person }: Person): SlackPerson {
  return person;
}

/** A name on one line: control characters made spaces. */
const clean = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim() || "someone";

const string = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const object = (value: unknown): Raw | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
