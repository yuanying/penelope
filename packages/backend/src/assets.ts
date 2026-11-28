// Image copies for A2A Task artifacts and legacy runner replies.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { type AgentId, REPLY_IMAGE_MAX_BYTES, REPLY_IMAGES_MAX, type ReplyImage } from "@penelope/contract";

import { imageTypeOf } from "./sources.ts";
import { iso } from "./time.ts";

/** An image a reply carries, checked: its name, its type from its first bytes, and its bytes. */
export type CheckedImage = { name: string; mime_type: string; data: Uint8Array };

/** A copy written to its file, not yet recorded. */
export type StoredImage = ReplyImage & { file: string };

/** Why the images of a reply are refused: said back to the sandbox, which sends nothing of the reply. */
export class ImageRefusal extends Error {}

/** The copies could not be written: the reply is not taken. */
export class AssetStoreError extends Error {}

const NAME_MAX = 255;
/** Base64 with its padding; the length is checked apart, a multiple of four. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}(?![\s\S])/;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * The `images` of a reply as the sandbox sent them, each checked: a list of
 * at most REPLY_IMAGES_MAX `{name, data}`, `data` the base64 of PNG, JPEG,
 * GIF or WebP bytes of at most REPLY_IMAGE_MAX_BYTES. Throws ImageRefusal,
 * naming what is wrong, at the first one that is not.
 */
export function checkImages(value: unknown, maxImages = REPLY_IMAGES_MAX, maxBytes = REPLY_IMAGE_MAX_BYTES): CheckedImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ImageRefusal("images must be a list of {name, data}");
  if (value.length > maxImages) throw new ImageRefusal(`a reply carries at most ${maxImages} images, not ${value.length}`);
  return value.map((item: unknown, index) => {
    const which = `image ${index + 1}`;
    if (typeof item !== "object" || item === null) throw new ImageRefusal(`${which} must be {name, data}`);
    const { name, data } = item as { name?: unknown; data?: unknown };
    if (typeof name !== "string" || name === "" || name.length > NAME_MAX) {
      throw new ImageRefusal(`${which} needs its file's name, a string of 1 to ${NAME_MAX} characters`);
    }
    const called = `${which} (${name})`;
    if (typeof data !== "string" || data.length % 4 !== 0) throw new ImageRefusal(`${called}: data must be the file's bytes in base64`);
    // Checked before it is decoded: base64 is four characters for three bytes.
    if ((data.length / 4) * 3 - padding(data) > maxBytes) {
      throw new ImageRefusal(`${called} is over the ${maxBytes} bytes an image may have`);
    }
    if (!BASE64.test(data)) throw new ImageRefusal(`${called}: data must be the file's bytes in base64`);
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    const mimeType = imageTypeOf(bytes);
    if (mimeType === undefined) throw new ImageRefusal(`${called} is not a PNG, JPEG, GIF or WebP image`);
    return { name, mime_type: mimeType, data: bytes };
  });
}

/** Removes a file if it can: what is left of a failed write is only an unused file. */
function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Left in place.
  }
}

function padding(data: string): number {
  return data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
}

export class Assets {
  readonly dir: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, dir: string, { now }: { now: () => number }) {
    this.db = db;
    this.dir = dir;
    this.now = now;
  }

  /**
   * Writes each image to a file of its own, `<id>.<extension>`, whole or not
   * at all: a file is written beside its place and moved there. Throws
   * AssetStoreError, with none of them left, when one cannot be written.
   */
  write(images: readonly CheckedImage[]): StoredImage[] {
    const stored: StoredImage[] = [];
    let part: string | undefined;
    try {
      mkdirSync(this.dir, { recursive: true });
      for (const image of images) {
        const id = randomUUID();
        const file = `${id}.${EXTENSIONS[image.mime_type] ?? "bin"}`;
        const where = path.join(this.dir, file);
        part = `${where}.part`;
        writeFileSync(part, image.data);
        renameSync(part, where);
        part = undefined;
        stored.push({ id, mime_type: image.mime_type, size: image.data.byteLength, name: image.name, file });
      }
    } catch (error) {
      if (part !== undefined) removeQuietly(part);
      this.discard(stored);
      throw new AssetStoreError(`the images could not be kept: ${error instanceof Error ? error.message : String(error)}`);
    }
    return stored;
  }

  /**
   * Records the written copies as the images of a line of the history, in
   * their order: a reply, made by its agent, or one of the owner's messages,
   * by none. Run in that line's transaction.
   */
  record(messageId: string, agent: AgentId | undefined, stored: readonly StoredImage[]): void {
    const insert = this.db.prepare(
      "INSERT INTO assets (id, kind, mime_type, size, name, file, agent, created_at, message_id, position) VALUES (?, 'image', ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const at = iso(this.now());
    stored.forEach((image, position) => insert.run(image.id, image.mime_type, image.size, image.name, image.file, agent ?? null, at, messageId, position));
  }

  /** Reads a stored file by its backend-generated basename, not by a sandbox path or a UI ID. */
  read(file: string): Buffer {
    return readFileSync(path.join(this.dir, file));
  }

  /** Removes the files of copies that were not recorded. */
  discard(stored: readonly StoredImage[]): void {
    for (const image of stored) removeQuietly(path.join(this.dir, image.file));
  }

  /** The images of each of the lines of the history, in their order; a line with none is not in the map. */
  ofMessages(messageIds: readonly string[]): Map<string, ReplyImage[]> {
    const found = new Map<string, ReplyImage[]>();
    if (messageIds.length === 0) return found;
    const rows = this.db
      .prepare(
        `SELECT message_id, id, mime_type, size, name FROM assets
          WHERE message_id IN (${messageIds.map(() => "?").join(", ")}) ORDER BY message_id, position`,
      )
      .all(...messageIds) as Array<ReplyImage & { message_id: string }>;
    for (const { message_id: messageId, id, mime_type, size, name } of rows) {
      const list = found.get(messageId) ?? [];
      list.push({ id, mime_type, size, name });
      found.set(messageId, list);
    }
    return found;
  }

  /** Where the bytes of a copy are, with its type and size; undefined when there is no such copy. */
  get(id: string): { file: string; mime_type: string; size: number } | undefined {
    const row = this.db.prepare("SELECT file, mime_type, size FROM assets WHERE id = ?").get(id) as
      | { file: string; mime_type: string; size: number }
      | undefined;
    return row === undefined ? undefined : { ...row, file: path.join(this.dir, row.file) };
  }
}
