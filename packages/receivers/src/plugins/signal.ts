// The Signal plugin (docs/receivers.md, "Signal のプラグイン"). Signal has no
// bot API, so the deployment runs signal-cli's daemon beside the receivers
// with its JSON-RPC on a Unix socket, and this plugin keeps a connection to it
// open: the daemon pushes each message it receives as a `receive`
// notification, and a message or a reaction in a direct conversation from one
// of the allowed senders, or from anyone in one of the allowed groups, becomes
// an event. Other groups and everyone else are dropped.
//
// The agent answers through a second Unix socket the plugin serves, `POST
// /v1/send`, which the Sentinel reaches as a registered host's upstream (the
// sandbox does not mount it, ADR-0014). It sends only to the allowed senders
// and groups.
//
// While the agent works on a message that came `now`, the conversation shows
// her typing: the receivers cannot see the turn, so it lasts until she sends
// there or `typing_seconds` pass.
//
// signal-cli takes no answer back for a `receive` notification, and its
// documentation gives no way to have one pushed again: an event the intake
// does not take is sent again here until it is (for 30 minutes at most), and a
// read receipt goes to the sender once it is.
import { chmodSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";

import { isObject, onlyKnown, SettingsError, type ConnectionEvent, type ConnectionPlugin } from "../plugin.ts";
import type { IntakeFile } from "../intake.ts";
import { backoff } from "./slack/socket.ts";
import { streamOf, summaryLine } from "./text.ts";

const MIB = 1024 * 1024;
const MAX_FILE_BYTES = 60 * MIB;
const MAX_SEND_BYTES = 64 * MIB;
const NUMBER = /^\+[1-9][0-9]{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long an event the intake keeps refusing is handed over again before it is dropped. */
const REDELIVER_MS = 30 * 60 * 1000;
const GROUP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const GROUP_ID = /^[A-Za-z0-9+/]+={0,2}$/;
/** What signal-cli leaves in the text where a mention is. */
const MENTION_MARK = "\uFFFC";
/** How long after the agent's own post in a group what others say there comes `now`. */
export const FOLLOW_UP_MS = 10 * 60_000;
/** Signal's apps stop showing "typing" about 15 s after the last one, so it is sent again this often. */
const TYPING_REFRESH_MS = 10_000;

type Raw = Record<string, unknown>;

/** A file that came with a message, as signal-cli names it. */
type Attachment = { id: string; name: string; type: string; size?: number };

/** The payload of a Signal event. */
export type SignalPayload = {
  type: "message" | "reaction";
  from: { number?: string; uuid?: string; name?: string };
  /** In a group: its name in the settings, and its title on Signal when signal-cli gives it. */
  group?: { name: string; title?: string };
  /** In a group: the message mentions the agent. */
  mentions_me?: boolean;
  /** In a group: the agent's own post, as it was sent. */
  own?: boolean;
  /** Signal's timestamp of the message (ms). A reaction or a quote points back at it. */
  timestamp: number;
  text?: string;
  /** `author` is the number (or UUID) a quoted reply names; `mine` when it quotes the agent. */
  quote?: { timestamp: number; text?: string; author?: string; mine?: boolean };
  files?: { name: string; mimetype: string; size?: number; attached: boolean }[];
  reaction?: { emoji: string; target_timestamp: number; removed: boolean };
};

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** Who the plugin reads, and how a group's message is told to be the agent's. */
export type Audience = {
  account: string;
  senders: ReadonlySet<string>;
  /** The allowed groups: Signal's group ID to its name in the settings. */
  groups: ReadonlyMap<string, string>;
  /** The agent's names, folded (`fold`): a group message with one comes `now`. */
  names?: readonly string[];
  /** Whether a message at this time in this group follows the agent's own post there. */
  followsOwn?: (groupId: string, timestamp: number) => boolean;
};

/** NFKC, lower case, katakana as hiragana: the form names are looked for in. */
export function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\u30a1-\u30f6]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60));
}

/**
 * The event a received envelope makes, with the files to fetch for it, or
 * nothing when it is not one this plugin reads: not a data message, in a
 * group not allowed, from someone not allowed in a direct conversation, or
 * empty. In an allowed group, anyone's message is read.
 */
export function eventOf(
  envelope: unknown,
  audience: Audience,
): { event: ConnectionEvent & { payload: SignalPayload }; attachments: Attachment[]; groupId?: string; sender?: string } | undefined {
  if (!isObject(envelope) || !isObject(envelope.dataMessage)) return undefined;
  const message = envelope.dataMessage;
  const number = str(envelope.sourceNumber);
  const uuid = str(envelope.sourceUuid);
  let group: { id: string; name: string; title?: string } | undefined;
  if (message.groupInfo !== undefined && message.groupInfo !== null) {
    const id = isObject(message.groupInfo) ? str(message.groupInfo.groupId) : undefined;
    const name = id === undefined ? undefined : audience.groups.get(id);
    if (id === undefined || name === undefined) return undefined;
    const title = str((message.groupInfo as Raw).groupName);
    group = { id, name, ...(title ? { title } : {}) };
  } else if (!(number && audience.senders.has(number)) && !(uuid && audience.senders.has(uuid))) {
    return undefined;
  }
  if (!number && !uuid) return undefined;
  /** In a direct conversation, the `senders` entry that let it in: the address to answer and to show typing to. */
  const sender = group ? undefined : number && audience.senders.has(number) ? number : uuid!;
  const timestamp = num(message.timestamp) ?? num(envelope.timestamp);
  if (timestamp === undefined) return undefined;

  const from = { ...(number ? { number } : {}), ...(uuid ? { uuid } : {}), ...(str(envelope.sourceName) ? { name: str(envelope.sourceName) } : {}) };
  const who = from.name ?? number ?? uuid!;
  const author = number ?? uuid!;
  const base = group
    ? { id: `group.${group.name}/${author}/${timestamp}`, occurred_at: new Date(timestamp).toISOString(), stream: streamOf(`group.${group.name}`) }
    : { id: `${author}/${timestamp}`, occurred_at: new Date(timestamp).toISOString(), stream: streamOf(`dm.${author.replace(/^\+/, "")}`) };
  const where = group ? `Signal ${group.name} ${who}` : `Signal ${who}`;
  const inGroup = group ? { group: { name: group.name, ...(group.title ? { title: group.title } : {}) } } : {};

  if (isObject(message.reaction)) {
    const emoji = str(message.reaction.emoji);
    const target = num(message.reaction.targetSentTimestamp);
    if (!emoji || target === undefined) return undefined;
    const removed = message.reaction.isRemove === true;
    return {
      event: {
        ...base,
        delivery: "batch",
        summary: summaryLine(`${where} ${removed ? "took off" : "reacted"} ${emoji}`),
        payload: { type: "reaction", from, ...inGroup, timestamp, reaction: { emoji, target_timestamp: target, removed } },
      },
      attachments: [],
      ...(group ? { groupId: group.id } : { sender }),
    };
  }

  const mentions = (Array.isArray(message.mentions) ? message.mentions : []).filter(isObject);
  const mentionsMe = group !== undefined && mentions.some((mention) => mention.number === audience.account);
  const text = mentions.length === 0 ? str(message.message) : withNames(str(message.message), mentions, audience.account);
  const attachments: Attachment[] = (Array.isArray(message.attachments) ? message.attachments : []).flatMap((item, index) => {
    if (!isObject(item) || !str(item.id)) return [];
    const size = num(item.size);
    return [{ id: item.id as string, name: str(item.filename) ?? `attachment-${index + 1}`, type: str(item.contentType) ?? "application/octet-stream", ...(size !== undefined ? { size } : {}) }];
  });
  if (text === undefined && attachments.length === 0) return undefined;
  const quoteAuthor = isObject(message.quote) ? str(message.quote.authorNumber) ?? str(message.quote.authorUuid) : undefined;
  const quote = isObject(message.quote) && num(message.quote.id) !== undefined
    ? {
        timestamp: message.quote.id as number,
        ...(str(message.quote.text) ? { text: message.quote.text as string } : {}),
        ...(group && quoteAuthor ? { author: quoteAuthor, ...(quoteAuthor === audience.account ? { mine: true } : {}) } : {}),
      }
    : undefined;
  // In a group, what is for the agent comes now (a mention, a quote of hers, her name, or what follows her post); the rest is batched.
  const now = !group
    || mentionsMe
    || quote?.mine === true
    || (text !== undefined && (audience.names ?? []).some((name) => fold(text).includes(name)))
    || (audience.followsOwn?.(group.id, timestamp) ?? false);
  const files = attachments.length === 0 ? "" : ` (${attachments.length} file${attachments.length === 1 ? "" : "s"})`;
  return {
    event: {
      ...base,
      delivery: now ? "now" : "batch",
      summary: summaryLine(`${where}:${text !== undefined ? ` ${text}` : ""}${files}`),
      payload: {
        type: "message",
        from,
        ...inGroup,
        ...(mentionsMe ? { mentions_me: true } : {}),
        timestamp,
        ...(text !== undefined ? { text } : {}),
        ...(quote ? { quote } : {}),
        ...(attachments.length > 0 ? { files: attachments.map((file) => ({ name: file.name, mimetype: file.type, ...(file.size !== undefined ? { size: file.size } : {}), attached: false })) } : {}),
      },
    },
    attachments,
    ...(group ? { groupId: group.id } : { sender }),
  };
}

/** The text with each mention's mark as `@<name>` (`@you` for the agent), from the end so the earlier places stay put. */
function withNames(text: string | undefined, mentions: Raw[], account: string): string | undefined {
  if (text === undefined) return undefined;
  let out = text;
  const placed = mentions.filter((mention) => num(mention.start) !== undefined && num(mention.length) !== undefined);
  for (const mention of placed.sort((a, b) => (b.start as number) - (a.start as number))) {
    const start = mention.start as number;
    const end = start + (mention.length as number);
    if (out.slice(start, end) !== MENTION_MARK) continue;
    const name = mention.number === account ? "you" : str(mention.name) && !NUMBER.test(mention.name as string) ? (mention.name as string) : "someone";
    out = `${out.slice(0, start)}@${name}${out.slice(end)}`;
  }
  return out;
}

function settingsOf(settings: Record<string, unknown>) {
  onlyKnown(settings, ["socket", "account", "senders", "groups", "names", "send_socket", "max_file_bytes", "rpc_timeout_seconds", "typing_seconds"]);
  const path = (field: string, value: unknown, required: boolean) => {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !value.startsWith("/")) throw new SettingsError(field, "must be the absolute path of a Unix socket");
    return value;
  };
  const socket = path("socket", settings.socket, true)!;
  const sendSocket = path("send_socket", settings.send_socket, false);
  if (typeof settings.account !== "string" || !NUMBER.test(settings.account)) throw new SettingsError("account", "must be a phone number in E.164 (+81…)");
  const { senders } = settings;
  if (!Array.isArray(senders) || senders.length === 0) throw new SettingsError("senders", "must be a list of one or more phone numbers or UUIDs");
  senders.forEach((sender, index) => {
    if (typeof sender !== "string" || !(NUMBER.test(sender) || UUID.test(sender))) throw new SettingsError(`senders[${index}]`, "must be a phone number in E.164 or a UUID");
  });
  const groups = new Map<string, string>();
  const rawGroups = settings.groups ?? {};
  if (!isObject(rawGroups)) throw new SettingsError("groups", "must map a name to a group ID");
  for (const [name, id] of Object.entries(rawGroups)) {
    if (!GROUP_NAME.test(name)) throw new SettingsError(`groups.${name}`, "the name must be 1-32 of a-z, 0-9 and -, not starting with -");
    if (typeof id !== "string" || !GROUP_ID.test(id)) throw new SettingsError(`groups.${name}`, "must be a group ID as signal-cli's listGroups gives it (base64)");
    if (groups.has(id)) throw new SettingsError(`groups.${name}`, "the same group ID is named twice");
    groups.set(id, name);
  }
  const names = settings.names ?? [];
  if (!Array.isArray(names)) throw new SettingsError("names", "must be a list of the agent's names");
  names.forEach((name, index) => {
    if (typeof name !== "string" || [...fold(name).trim()].length < 2) throw new SettingsError(`names[${index}]`, "must be a name of 2 characters or more");
  });
  const maxFileBytes = settings.max_file_bytes ?? 20 * MIB;
  if (typeof maxFileBytes !== "number" || !Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) {
    throw new SettingsError("max_file_bytes", `must be an integer from 1 to ${MAX_FILE_BYTES}`);
  }
  const timeout = settings.rpc_timeout_seconds ?? 30;
  if (typeof timeout !== "number" || !(timeout > 0)) throw new SettingsError("rpc_timeout_seconds", "must be a number greater than 0");
  const typing = settings.typing_seconds ?? 300;
  if (typeof typing !== "number" || !(typing >= 0) || typing > 3600) throw new SettingsError("typing_seconds", "must be a number from 0 to 3600");
  return {
    socket,
    sendSocket,
    account: settings.account,
    senders: senders as string[],
    groups,
    names: (names as string[]).map((name) => fold(name).trim()),
    maxFileBytes,
    rpcTimeoutMs: timeout * 1000,
    typingMs: typing * 1000,
  };
}

class RpcError extends Error {}

export type SignalPluginOptions = {
  /** The wait before the `attempt`-th try in a row that failed: to connect, or to hand an event over. */
  backoffMs?: (attempt: number) => number;
};

export function signalPlugin(options: SignalPluginOptions = {}): ConnectionPlugin {
  const backoffMs = options.backoffMs ?? backoff;
  return {
    name: "signal",
    kind: "connection",
    create(raw) {
      const settings = settingsOf(raw);
      return {
        start(io) {
          /** The conversations shown as typing, by `dm:<sender>` or `group:<ID>`. */
          const typing = new Map<string, { refresh: NodeJS.Timeout; end: NodeJS.Timeout }>();
          const typingTo = (key: string): Raw => (key.startsWith("group:") ? { groupId: [key.slice(6)] } : { recipient: [key.slice(3)] });
          const sendTyping = (key: string, stop: boolean) =>
            call("sendTyping", { ...typingTo(key), ...(stop ? { stop: true } : {}) }).catch((error: unknown) =>
              io.log(`cannot send typing (${error instanceof Error ? error.message : "error"})`),
            );
          /** Ends the typing; `tell` sends Signal the stop, which a message sent there makes needless. */
          const endTyping = (key: string, tell: boolean) => {
            const shown = typing.get(key);
            if (!shown) return;
            clearInterval(shown.refresh);
            clearTimeout(shown.end);
            typing.delete(key);
            if (tell) void sendTyping(key, true);
          };
          // ponytail: the receivers do not see the turn end, so a turn that sends nothing leaves "typing" up to typing_seconds;
          // tell the plugin of turn ends (a runner hook, or the Sentinel's log of the backend's /v1/turns/end) if that matters.
          const startTyping = (key: string) => {
            if (settings.typingMs === 0 || stopped) return;
            endTyping(key, false);
            void sendTyping(key, false);
            const refresh = setInterval(() => void sendTyping(key, false), TYPING_REFRESH_MS);
            const end = setTimeout(() => endTyping(key, true), settings.typingMs);
            refresh.unref();
            end.unref();
            typing.set(key, { refresh, end });
          };

          /** Per group ID: when the agent last posted there, and whether hers is still the last message. */
          const ownPosts = new Map<string, { at: number; last: boolean }>();
          const audience: Audience = {
            account: settings.account,
            senders: new Set(settings.senders),
            groups: settings.groups,
            names: settings.names,
            followsOwn: (groupId, timestamp) => {
              const own = ownPosts.get(groupId);
              return own !== undefined && (own.last || (timestamp >= own.at && timestamp - own.at <= FOLLOW_UP_MS));
            },
          };
          let stopped = false;
          let current: net.Socket | undefined;
          /** The sleeps in progress (a redelivery's and a reconnection's can overlap); stop() wakes them all. */
          const wakers = new Set<() => void>();
          let nextId = 0;
          const pending = new Map<number, { method: string; resolve: (result: unknown) => void; reject: (error: Error) => void }>();
          /** The notifications in hand, one after another. */
          let chain: Promise<void> = Promise.resolve();

          const sleep = (ms: number) =>
            new Promise<void>((resolve) => {
              const timer = setTimeout(done, ms);
              function done() {
                clearTimeout(timer);
                wakers.delete(done);
                resolve();
              }
              wakers.add(done);
            });

          const call = (method: string, params: Raw) =>
            new Promise<unknown>((resolve, reject) => {
              const socket = current;
              if (!socket) return reject(new RpcError("signal-cli is not connected"));
              const id = ++nextId;
              const timer = setTimeout(() => {
                pending.delete(id);
                reject(new RpcError(`${method}: no answer in time`));
              }, settings.rpcTimeoutMs);
              pending.set(id, {
                method,
                resolve: (result) => (clearTimeout(timer), resolve(result)),
                reject: (error) => (clearTimeout(timer), reject(error)),
              });
              socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { account: settings.account, ...params } })}\n`);
            });

          // Neither signal-cli (a received envelope) nor Signal (the agent's own post) gives it again, so
          // an event is handed over until the intake takes it, for REDELIVER_MS at most; one that comes
          // while the plugin stops is tried once. Resolves whether it was taken.
          const handOver = async (event: ConnectionEvent, what: string) => {
            const since = io.now().getTime();
            for (let attempt = 1; !(await io.deliver([event])); attempt++) {
              if (stopped) {
                io.log(`${what} events=1 dropped=0 taken=false (stopping)`);
                return false;
              }
              if (io.now().getTime() - since >= REDELIVER_MS) {
                io.log(`${what} events=1 dropped=1 taken=false (refused for ${REDELIVER_MS / 60000} minutes, ${attempt} tries)`);
                return false;
              }
              await sleep(backoffMs(attempt));
            }
            return true;
          };

          const receive = async (params: unknown) => {
            // A daemon with several numbers names the one it came to; only the configured one's are
            // taken, before any file is fetched or receipt sent. A single-number daemon (`-a`) leaves it out.
            if (isObject(params) && params.account !== undefined && params.account !== settings.account) {
              io.log("envelope events=0 dropped=1 (another account)");
              return;
            }
            const made = isObject(params) ? eventOf(params.envelope, audience) : undefined;
            if (made?.groupId !== undefined && made.event.payload.type === "message") {
              const own = ownPosts.get(made.groupId);
              if (own) own.last = false;
            }
            if (!made) {
              io.log("envelope events=0 dropped=1");
              return;
            }
            const { event, attachments } = made;
            const files: IntakeFile[] = [];
            let total = 0;
            for (const [index, attachment] of attachments.entries()) {
              if (attachment.size !== undefined && (attachment.size > settings.maxFileBytes || total + attachment.size > MAX_FILE_BYTES)) continue;
              try {
                const result = await call("getAttachment", { id: attachment.id });
                const data = isObject(result) && typeof result.data === "string" ? Buffer.from(result.data, "base64") : undefined;
                if (!data || data.length > settings.maxFileBytes || total + data.length > MAX_FILE_BYTES) continue;
                total += data.length;
                files.push({ name: attachment.name, type: attachment.type, data });
                event.payload.files![index]!.attached = true;
              } catch (error) {
                io.log(`cannot fetch a file (${error instanceof Error ? error.message : "error"})`);
              }
            }
            if (!(await handOver({ ...event, ...(files.length > 0 ? { files } : {}) }, "envelope"))) return;
            io.log(`envelope events=1 dropped=0 taken=true`);
            const sender = event.payload.from.number ?? event.payload.from.uuid!;
            // Keyed by the `senders` entry, as the send endpoint's `to` is, so that a reply there ends it.
            // In a group, only a mention of the agent or a quote of hers shows typing, not every message that comes now.
            const forHer = event.payload.mentions_me === true || event.payload.quote?.mine === true;
            if (event.delivery === "now" && (made.groupId === undefined || forHer)) startTyping(made.groupId !== undefined ? `group:${made.groupId}` : `dm:${made.sender}`);
            if (event.payload.type === "message") {
              await call("sendReceipt", { recipient: sender, targetTimestamp: [event.payload.timestamp], type: "read" }).catch((error: unknown) =>
                io.log(`cannot send a read receipt (${error instanceof Error ? error.message : "error"})`),
              );
            }
          };

          /** One connection, until it closes. Resolves whether it was opened. */
          const session = () =>
            new Promise<boolean>((resolve) => {
              const socket = net.createConnection(settings.socket);
              let opened = false;
              let buffer = "";
              socket.setEncoding("utf8");
              socket.on("connect", () => {
                opened = true;
                current = socket;
                io.log("connected");
              });
              socket.on("error", (error: NodeJS.ErrnoException) => io.log(`connection error (${error.code ?? error.name})`));
              socket.on("close", () => {
                if (current === socket) current = undefined;
                for (const [id, call] of pending) {
                  pending.delete(id);
                  call.reject(new RpcError(`${call.method}: the connection closed`));
                }
                resolve(opened);
              });
              socket.on("data", (chunk: string) => {
                buffer += chunk;
                let end: number;
                while ((end = buffer.indexOf("\n")) >= 0) {
                  const line = buffer.slice(0, end).trim();
                  buffer = buffer.slice(end + 1);
                  if (line === "") continue;
                  let message: Raw;
                  try {
                    message = JSON.parse(line) as Raw;
                  } catch {
                    io.log("a line that is not JSON was passed over");
                    continue;
                  }
                  if (typeof message.id === "number" && pending.has(message.id)) {
                    const call = pending.get(message.id)!;
                    pending.delete(message.id);
                    if (isObject(message.error)) call.reject(new RpcError(`${call.method}: signal-cli error ${String(message.error.code)}`));
                    else call.resolve(message.result);
                  } else if (message.method === "receive") {
                    chain = chain.then(() => receive(message.params)).catch((error: unknown) => io.log(`an envelope could not be handled (${error instanceof Error ? error.message : "error"})`));
                  }
                }
              });
            });

          const running = (async () => {
            let failures = 0;
            while (!stopped) {
              const opened = await session();
              if (stopped) break;
              failures = opened ? 1 : failures + 1;
              const ms = backoffMs(failures);
              io.log(`connecting again in ${Math.round(ms / 100) / 10}s`);
              await sleep(ms);
            }
          })();

          /** The agent's own post in a group: it is written into the group's stream as anyone's is, and starts the follow-up window. */
          const posted = (group: { id: string; name: string }, timestamp: number, text: string | undefined, files: number) => {
            endTyping(`group:${group.id}`, false);
            ownPosts.set(group.id, { at: timestamp, last: true });
            const event: ConnectionEvent & { payload: SignalPayload } = {
              id: `group.${group.name}/${settings.account}/${timestamp}`,
              occurred_at: new Date(timestamp).toISOString(),
              stream: streamOf(`group.${group.name}`),
              delivery: "batch",
              summary: summaryLine(`Signal ${group.name} (you):${text !== undefined ? ` ${text}` : ""}${files > 0 ? ` (${files} file${files === 1 ? "" : "s"})` : ""}`),
              payload: { type: "message", from: { number: settings.account }, group: { name: group.name }, own: true, timestamp, ...(text !== undefined ? { text } : {}) },
            };
            // Only the hand-over is tried again, in the background: the send itself went through and is answered 200.
            chain = chain.then(async () => {
              await handOver(event, "own post");
            });
          };
          const sender = settings.sendSocket ? sendServer(settings.sendSocket, { senders: settings.senders, groups: settings.groups, call, log: io.log, posted, sent: (to) => endTyping(`dm:${to}`, false) }) : undefined;

          return {
            async stop() {
              stopped = true;
              for (const wake of wakers) wake();
              for (const key of [...typing.keys()]) endTyping(key, false);
              await sender?.close();
              await chain;
              current?.end();
              await running;
              // What came while the connection was closing.
              await chain;
            },
          };
        },
      };
    },
  };
}

/** By the name's extension, for a file sent with no type: curl's `-F file=@…` knows png, jpg and gif, and sends a WebP or an MP4 as octet-stream, which Signal shows as a file, not as media. */
const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", m4a: "audio/mp4", ogg: "audio/ogg", pdf: "application/pdf",
};
/** The form's type as `type/subtype` (its parameters dropped), or by the extension, or octet-stream. */
const typeOf = (file: File) => {
  const given = file.type.split(";")[0]!.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(given) && given !== "application/octet-stream") return given;
  return TYPES[/\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? ""] ?? "application/octet-stream";
};
/**
 * A file as signal-cli's data URI. signal-cli URL-decodes the parameter values
 * (DataURI.java), so the name is percent-encoded: a `%` or a `+` in it would
 * otherwise be read as an escape or a space.
 */
const dataUri = async (file: File) =>
  `data:${typeOf(file)};filename=${encodeURIComponent(file.name)};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;

/**
 * `POST /v1/send` on a Unix socket: the text and files of a form
 * (multipart/form-data or urlencoded) sent to one of the allowed senders or
 * groups. Fields: `text`, `to` (a sender) or `group` (a group's name; with
 * neither, the first sender), `file` (repeated), and `quote_timestamp` with
 * `quote_author` to send it as a quoted reply.
 */
function sendServer(
  path: string,
  options: {
    senders: readonly string[];
    groups: ReadonlyMap<string, string>;
    call: (method: string, params: Raw) => Promise<unknown>;
    log: (line: string) => void;
    posted: (group: { id: string; name: string }, timestamp: number, text: string | undefined, files: number) => void;
    /** A direct message went to this sender. */
    sent: (to: string) => void;
  },
) {
  const { senders, groups, call, log } = options;
  const answer = (response: http.ServerResponse, status: number, body: Raw) => {
    log(`send status=${status}`);
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    if (request.url !== "/v1/send") return answer(response, 404, { error: "not found" });
    if (request.method !== "POST") return answer(response, 405, { error: "POST only" });
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of request as AsyncIterable<Buffer>) {
      size += part.length;
      if (size > MAX_SEND_BYTES) return answer(response, 413, { error: `the body is larger than ${MAX_SEND_BYTES} bytes` });
      parts.push(part);
    }
    let form: FormData;
    try {
      form = await new Response(Buffer.concat(parts), { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData();
    } catch {
      return answer(response, 400, { error: "the body is not a form (multipart/form-data or urlencoded)" });
    }
    const raw = form.get("text");
    const text = typeof raw === "string" && raw.trim() !== "" ? raw.trimEnd() : undefined;
    const groupName = form.get("group");
    if (groupName !== null && form.get("to") !== null) return answer(response, 400, { error: "to and group: one or the other" });
    const groupId = typeof groupName === "string" ? [...groups].find(([, name]) => name === groupName)?.[0] : undefined;
    if (groupName !== null && groupId === undefined) return answer(response, 403, { error: "group: not one of the groups this agent may write to" });
    const to = form.get("to") ?? senders[0]!;
    if (groupId === undefined && (typeof to !== "string" || !senders.includes(to))) return answer(response, 403, { error: "to: not one of the senders this agent may write to" });
    const files = form.getAll("file").filter((file): file is File => typeof file !== "string");
    if (text === undefined && files.length === 0) return answer(response, 400, { error: "neither text nor a file" });
    const quoteTimestamp = form.get("quote_timestamp");
    const quoteAuthor = form.get("quote_author");
    if ((quoteTimestamp === null) !== (quoteAuthor === null)) return answer(response, 400, { error: "quote_timestamp and quote_author: both or neither" });
    const quote = quoteTimestamp === null ? undefined : { timestamp: Number(quoteTimestamp), author: quoteAuthor };
    if (quote && (!Number.isSafeInteger(quote.timestamp) || quote.timestamp <= 0 || typeof quote.author !== "string" || !(NUMBER.test(quote.author) || UUID.test(quote.author)))) {
      return answer(response, 400, { error: "quote_timestamp must be a Signal timestamp and quote_author a number in E.164 or a UUID" });
    }
    const attachments = await Promise.all(files.map(dataUri));
    try {
      const result = await call("send", {
        ...(groupId !== undefined ? { groupId } : { recipient: [to] }),
        ...(text !== undefined ? { message: text } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(quote ? { quoteTimestamp: quote.timestamp, quoteAuthor: quote.author } : {}),
      });
      const results = isObject(result) && Array.isArray(result.results) ? (result.results as Raw[]) : [];
      // A group's send has a result per member; it failed only when no one took it.
      const failed = groupId === undefined ? results.find((item) => item.type !== "SUCCESS") : results.length > 0 && results.every((item) => item.type !== "SUCCESS") ? results[0] : undefined;
      if (failed) return answer(response, 502, { error: `Signal did not take it (${String(failed.type)})` });
      const timestamp = isObject(result) ? num(result.timestamp) : undefined;
      if (groupId !== undefined && timestamp !== undefined) options.posted({ id: groupId, name: groupName as string }, timestamp, text, files.length);
      if (groupId === undefined) options.sent(to as string);
      return answer(response, 200, { timestamp });
    } catch (error) {
      const message = error instanceof Error ? error.message : "error";
      return answer(response, error instanceof RpcError && message.includes("not connected") ? 503 : 502, { error: message });
    }
  };
  // A body cut off midway (the client gone) rejects the read; that request ends there and the
  // process, with the other receivers in it, goes on.
  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      log(`send aborted (${error instanceof Error ? error.message : "error"})`);
      if (!response.headersSent && !response.destroyed) answer(response, 400, { error: "the body could not be read" });
      else response.destroy();
    });
  });
  server.on("error", (error: NodeJS.ErrnoException) => log(`cannot serve ${path} (${error.code ?? error.name})`));
  rmSync(path, { force: true });
  server.listen(path, () => chmodSync(path, 0o666));
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

export const signal = signalPlugin();
