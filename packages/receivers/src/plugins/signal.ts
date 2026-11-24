// The Signal plugin (docs/receivers.md, "Signal のプラグイン"). Signal has no
// bot API, so the deployment runs signal-cli's daemon beside the receivers
// with its JSON-RPC on a Unix socket, and this plugin keeps a connection to it
// open: the daemon pushes each message it receives as a `receive`
// notification, and a message or a reaction in a direct conversation from one
// of the allowed senders becomes an event. Groups and everyone else are
// dropped.
//
// The agent answers through a second Unix socket the plugin serves, `POST
// /v1/send`, which the Sentinel reaches as a registered host's upstream (the
// sandbox does not mount it, ADR-0014). It sends only to the allowed senders.
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

type Raw = Record<string, unknown>;

/** A file that came with a message, as signal-cli names it. */
type Attachment = { id: string; name: string; type: string; size?: number };

/** The payload of a Signal event. */
export type SignalPayload = {
  type: "message" | "reaction";
  from: { number?: string; uuid?: string; name?: string };
  /** Signal's timestamp of the message (ms). A reaction or a quote points back at it. */
  timestamp: number;
  text?: string;
  quote?: { timestamp: number; text?: string };
  files?: { name: string; mimetype: string; size?: number; attached: boolean }[];
  reaction?: { emoji: string; target_timestamp: number; removed: boolean };
};

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * The event a received envelope makes, with the files to fetch for it, or
 * nothing when it is not one this plugin reads: not a data message, in a
 * group, from someone not allowed, or empty.
 */
export function eventOf(
  envelope: unknown,
  allowed: ReadonlySet<string>,
): { event: ConnectionEvent & { payload: SignalPayload }; attachments: Attachment[] } | undefined {
  if (!isObject(envelope) || !isObject(envelope.dataMessage)) return undefined;
  const message = envelope.dataMessage;
  if (message.groupInfo !== undefined && message.groupInfo !== null) return undefined;
  const number = str(envelope.sourceNumber);
  const uuid = str(envelope.sourceUuid);
  if (!(number && allowed.has(number)) && !(uuid && allowed.has(uuid))) return undefined;
  const timestamp = num(message.timestamp) ?? num(envelope.timestamp);
  if (timestamp === undefined) return undefined;

  const from = { ...(number ? { number } : {}), ...(uuid ? { uuid } : {}), ...(str(envelope.sourceName) ? { name: str(envelope.sourceName) } : {}) };
  const who = from.name ?? number ?? uuid!;
  const base = {
    id: `${number ?? uuid}/${timestamp}`,
    occurred_at: new Date(timestamp).toISOString(),
    stream: streamOf(`dm.${(number ?? uuid!).replace(/^\+/, "")}`),
  };

  if (isObject(message.reaction)) {
    const emoji = str(message.reaction.emoji);
    const target = num(message.reaction.targetSentTimestamp);
    if (!emoji || target === undefined) return undefined;
    const removed = message.reaction.isRemove === true;
    return {
      event: {
        ...base,
        delivery: "batch",
        summary: summaryLine(`Signal ${who} ${removed ? "took off" : "reacted"} ${emoji}`),
        payload: { type: "reaction", from, timestamp, reaction: { emoji, target_timestamp: target, removed } },
      },
      attachments: [],
    };
  }

  const text = str(message.message);
  const attachments: Attachment[] = (Array.isArray(message.attachments) ? message.attachments : []).flatMap((item, index) => {
    if (!isObject(item) || !str(item.id)) return [];
    const size = num(item.size);
    return [{ id: item.id as string, name: str(item.filename) ?? `attachment-${index + 1}`, type: str(item.contentType) ?? "application/octet-stream", ...(size !== undefined ? { size } : {}) }];
  });
  if (text === undefined && attachments.length === 0) return undefined;
  const quote = isObject(message.quote) && num(message.quote.id) !== undefined
    ? { timestamp: message.quote.id as number, ...(str(message.quote.text) ? { text: message.quote.text as string } : {}) }
    : undefined;
  const files = attachments.length === 0 ? "" : ` (${attachments.length} file${attachments.length === 1 ? "" : "s"})`;
  return {
    event: {
      ...base,
      delivery: "now",
      summary: summaryLine(`Signal ${who}:${text !== undefined ? ` ${text}` : ""}${files}`),
      payload: {
        type: "message",
        from,
        timestamp,
        ...(text !== undefined ? { text } : {}),
        ...(quote ? { quote } : {}),
        ...(attachments.length > 0 ? { files: attachments.map((file) => ({ name: file.name, mimetype: file.type, ...(file.size !== undefined ? { size: file.size } : {}), attached: false })) } : {}),
      },
    },
    attachments,
  };
}

function settingsOf(settings: Record<string, unknown>) {
  onlyKnown(settings, ["socket", "account", "senders", "send_socket", "max_file_bytes", "rpc_timeout_seconds"]);
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
  const maxFileBytes = settings.max_file_bytes ?? 20 * MIB;
  if (typeof maxFileBytes !== "number" || !Number.isInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) {
    throw new SettingsError("max_file_bytes", `must be an integer from 1 to ${MAX_FILE_BYTES}`);
  }
  const timeout = settings.rpc_timeout_seconds ?? 30;
  if (typeof timeout !== "number" || !(timeout > 0)) throw new SettingsError("rpc_timeout_seconds", "must be a number greater than 0");
  return { socket, sendSocket, account: settings.account, senders: senders as string[], maxFileBytes, rpcTimeoutMs: timeout * 1000 };
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
      const allowed = new Set(settings.senders);
      return {
        start(io) {
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

          const receive = async (params: unknown) => {
            // A daemon with several numbers names the one it came to; only the configured one's are
            // taken, before any file is fetched or receipt sent. A single-number daemon (`-a`) leaves it out.
            if (isObject(params) && params.account !== undefined && params.account !== settings.account) {
              io.log("envelope events=0 dropped=1 (another account)");
              return;
            }
            const made = isObject(params) ? eventOf(params.envelope, allowed) : undefined;
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
            // signal-cli does not push it again, so it is handed over until the intake takes it, for
            // REDELIVER_MS at most; one that comes while the plugin stops is tried once.
            const since = io.now().getTime();
            for (let attempt = 1; !(await io.deliver([{ ...event, ...(files.length > 0 ? { files } : {}) }])); attempt++) {
              if (stopped) {
                io.log("envelope events=1 dropped=0 taken=false (stopping)");
                return;
              }
              if (io.now().getTime() - since >= REDELIVER_MS) {
                io.log(`envelope events=1 dropped=1 taken=false (refused for ${REDELIVER_MS / 60000} minutes, ${attempt} tries)`);
                return;
              }
              await sleep(backoffMs(attempt));
            }
            io.log(`envelope events=1 dropped=0 taken=true`);
            const sender = event.payload.from.number ?? event.payload.from.uuid!;
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

          const sender = settings.sendSocket ? sendServer(settings.sendSocket, settings.senders, call, io.log) : undefined;

          return {
            async stop() {
              stopped = true;
              for (const wake of wakers) wake();
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
 * (multipart/form-data or urlencoded) sent to one of the allowed senders.
 * Fields: `text`, `to` (left out, the first sender), `file` (repeated).
 */
function sendServer(path: string, senders: readonly string[], call: (method: string, params: Raw) => Promise<unknown>, log: (line: string) => void) {
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
    const text = form.get("text");
    const to = form.get("to") ?? senders[0]!;
    const files = form.getAll("file").filter((file): file is File => typeof file !== "string");
    if (typeof to !== "string" || !senders.includes(to)) return answer(response, 403, { error: "to: not one of the senders this agent may write to" });
    if ((typeof text !== "string" || text.trim() === "") && files.length === 0) return answer(response, 400, { error: "neither text nor a file" });
    const attachments = await Promise.all(files.map(dataUri));
    try {
      const result = await call("send", { recipient: [to], ...(typeof text === "string" && text.trim() !== "" ? { message: text.trimEnd() } : {}), ...(attachments.length > 0 ? { attachments } : {}) });
      const results = isObject(result) && Array.isArray(result.results) ? (result.results as Raw[]) : [];
      const failed = results.find((item) => item.type !== "SUCCESS");
      if (failed) return answer(response, 502, { error: `Signal did not take it (${String(failed.type)})` });
      return answer(response, 200, { timestamp: isObject(result) ? result.timestamp : undefined });
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
