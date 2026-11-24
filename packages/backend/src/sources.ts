// /sources: where the backend appends what every event carried (ADR-0013,
// docs/events.md). Only the backend writes it, and only by appending.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Appended, DeliveredAttachment, SourcesLine } from "@penelope/contract";

import { dayIn } from "./time.ts";

/** A file that came with an event: its name and media type as the sender gave them ("" for none). */
export type Attachment = { name: string; type: string; data: Uint8Array };

/**
 * The files under /sources. Writes are synchronous so that the queue can keep
 * an event only once its line is on disk, in the same transaction.
 */
export class Sources {
  readonly dir: string;
  private readonly timeZone: string;
  /** Lines in each file this process has appended to. It is the only writer. */
  private readonly lineCounts = new Map<string, number>();

  constructor(dir: string, timeZone: string) {
    this.dir = dir;
    this.timeZone = timeZone;
  }

  /**
   * Appends the line to `<source>[/<stream>]/<YYYY-MM-DD>.jsonl`, dated by
   * when the backend received it in the backend's time zone. Throws when it
   * cannot write.
   */
  append(line: SourcesLine): Appended {
    const day = dayIn(Date.parse(line.received_at), this.timeZone);
    const folder = path.join(this.dir, line.source, ...(line.stream === undefined ? [] : [line.stream]));
    const file = path.join(folder, `${day}.jsonl`);
    mkdirSync(folder, { recursive: true });
    const before = this.lineCounts.get(file) ?? countLines(file);
    appendFileSync(file, `${JSON.stringify(ordered(line))}\n`);
    const number = before + 1;
    this.lineCounts.set(file, number);
    return { path: file, lines: [number, number] };
  }

  /**
   * Writes the files to `<source>/files/<seq>-<name>` and returns where, with
   * each one's media type and size. The name keeps only letters, digits, `.`,
   * `_` and `-` of its last segment; a name that comes twice gets `-2`, `-3`…
   * before its extension.
   */
  saveAttachments(source: string, seq: number, files: readonly Attachment[]): DeliveredAttachment[] {
    if (files.length === 0) return [];
    const folder = path.join(this.dir, source, "files");
    mkdirSync(folder, { recursive: true });
    const taken = new Set<string>();
    return files.map((file) => {
      const name = uniqueFileName(file.name, taken);
      const where = path.join(folder, `${seq}-${name}`);
      writeFileSync(where, file.data);
      return { path: where, mime_type: mediaType(file), size: file.data.byteLength };
    });
  }
}

function countLines(file: string): number {
  if (!existsSync(file)) return 0;
  let count = 0;
  for (const byte of readFileSync(file)) if (byte === 0x0a) count += 1;
  return count;
}

/** The fields in the order docs/events.md lists them, the payload last. */
function ordered(line: SourcesLine): SourcesLine {
  const { seq, received_at, occurred_at, source, stream, id, summary, answer_via, attachments, payload } = line;
  return {
    seq,
    received_at,
    occurred_at,
    source,
    ...(stream === undefined ? {} : { stream }),
    id,
    summary,
    ...(answer_via === undefined ? {} : { answer_via }),
    ...(attachments === undefined ? {} : { attachments }),
    payload,
  };
}

function safeName(name: string): string {
  const last = name.split(/[/\\]/).pop() ?? "";
  const safe = last.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100);
  return safe === "" ? "file" : safe;
}

/** A safe basename that is not already in this batch. */
export function uniqueFileName(original: string, taken: Set<string>): string {
  const name = safeName(original);
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) {
    const dot = name.lastIndexOf(".");
    candidate = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
  }
  taken.add(candidate);
  return candidate;
}

/** The image types the runner can put into a turn, and a reply can carry, by their first bytes. */
const SIGNATURES: Array<[type: string, matches: (bytes: Uint8Array) => boolean]> = [
  ["image/png", (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["image/jpeg", (b) => starts(b, [0xff, 0xd8, 0xff])],
  ["image/gif", (b) => starts(b, [...Buffer.from("GIF87a")]) || starts(b, [...Buffer.from("GIF89a")])],
  ["image/webp", (b) => starts(b, [...Buffer.from("RIFF")]) && starts(b.subarray(8), [...Buffer.from("WEBP")])],
];

const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(\s*;.*)?$/i;

/**
 * PNG, JPEG, GIF and WebP by their first bytes, whatever the sender said.
 * Otherwise the type the sender gave, unless it is one of those images that
 * the bytes do not bear out, so that what is said to be an image is one.
 * application/octet-stream when nothing else will do.
 */
function mediaType(file: Attachment): string {
  const found = imageTypeOf(file.data);
  if (found) return found;
  const said = file.type.trim();
  if (!MEDIA_TYPE.test(said) || SIGNATURES.some(([type]) => said.toLowerCase().startsWith(type))) return "application/octet-stream";
  return said;
}

/** PNG, JPEG, GIF or WebP, by the first bytes; undefined for anything else. */
export function imageTypeOf(bytes: Uint8Array): string | undefined {
  return SIGNATURES.find(([, matches]) => matches(bytes))?.[0];
}

function starts(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}
