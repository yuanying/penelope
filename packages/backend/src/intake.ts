// The intake (docs/events.md): `POST /v1/events` on a Unix socket that only
// the backend and receivers mount. The backend's own sources do not come
// this way; they call the queue directly.
import { type AgentStatus, type BuiltinSource, EVENT_PATH_SEGMENT } from "@penelope/contract";

import { parseEnvelope } from "./envelope.ts";
import { type Handler, HttpError, isMultipart, readForm, readJson, sendEmpty, sendJson } from "./http.ts";
import type { PluginNotes } from "./plugin-notes.ts";
import type { Queue } from "./queue.ts";
import type { Attachment } from "./sources.ts";

export const BUILTIN_SOURCES: ReadonlySet<BuiltinSource> = new Set(["ui", "cron", "a2a", "self", "job", "control", "heartbeat", "wake"]);

/** The envelope with its files: 64 MiB in all by default. */
export const DEFAULT_INTAKE_BYTES = 64 * 1024 * 1024;

const NOTE_PREFIX = "/v1/heartbeat-notes/";
const MAX_NOTE_BYTES = 4 * 1024;

type PluginPorts = { now: () => number; readStatus: () => AgentStatus; notes: PluginNotes };

export function intakeHandler(
  queue: Queue,
  { maxBytes = DEFAULT_INTAKE_BYTES, log = console.error, plugins }: { maxBytes?: number; log?: (line: string) => void; plugins?: PluginPorts } = {},
): Handler {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://intake");
    if (plugins && url.pathname === "/v1/status") {
      if (request.method !== "GET") throw new HttpError(405, "only GET");
      sendJson(response, 200, plugins.readStatus());
      return;
    }
    if (plugins && url.pathname.startsWith(NOTE_PREFIX)) {
      const source = url.pathname.slice(NOTE_PREFIX.length);
      if (!EVENT_PATH_SEGMENT.test(source) || BUILTIN_SOURCES.has(source as BuiltinSource)) {
        throw new HttpError(400, "not a receiver source");
      }
      if (request.method === "DELETE") {
        plugins.notes.delete(source);
      } else if (request.method === "PUT") {
        const note = await readJson(request, MAX_NOTE_BYTES);
        if (Buffer.byteLength(JSON.stringify(note)) > MAX_NOTE_BYTES) {
          throw new HttpError(413, `the note is over ${MAX_NOTE_BYTES} bytes as JSON`);
        }
        if (!plugins.notes.set(source, note, plugins.now())) throw new HttpError(503, "too many sources have a note");
      } else {
        throw new HttpError(405, "only PUT and DELETE");
      }
      sendEmpty(response, 204);
      return;
    }
    if (url.pathname !== "/v1/events") throw new HttpError(404, "no such path");
    if (request.method !== "POST") throw new HttpError(405, "only POST");

    const { body, attachments } = isMultipart(request)
      ? await fromForm(await readForm(request, maxBytes))
      : { body: await readJson(request, maxBytes), attachments: [] };
    const parsed = parseEnvelope(body);
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    if (BUILTIN_SOURCES.has(parsed.event.source as BuiltinSource)) {
      throw new HttpError(400, `${parsed.event.source} is one of the backend's own sources`);
    }
    try {
      queue.accept(parsed.event, { attachments });
    } catch (error) {
      // Not taken: the source keeps it and sends it again with the same id.
      log(`intake: ${parsed.event.source}/${parsed.event.id} not kept: ${error instanceof Error ? error.message : String(error)}`);
      throw new HttpError(503, "the event could not be written to /sources");
    }
    sendEmpty(response, 202);
  };
}

/** The envelope from the `event` part, a field or a JSON file, and the files of the `file` parts. */
async function fromForm(form: FormData): Promise<{ body: unknown; attachments: Attachment[] }> {
  const part = form.get("event");
  if (part === null) throw new HttpError(400, "the multipart body has no event part");
  const text = typeof part === "string" ? part : await part.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "the event part is not JSON");
  }
  const attachments: Attachment[] = [];
  for (const file of form.getAll("file")) {
    if (typeof file === "string") throw new HttpError(400, "a file part must be a file");
    attachments.push({ name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) });
  }
  return { body, attachments };
}
