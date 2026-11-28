import {
  HOUSE_EXPRESSIONS, HOUSE_REPLY_TEXT_MAX, REPLY_IMAGE_MAX_BYTES, REPLY_IMAGES_MAX,
  type HouseAgentStatus, type HouseExpression, type HouseImage, type HouseSync,
} from "@penelope/contract";

export type ImageInput = Pick<HouseImage, "name" | "mime_type"> & { data: Buffer };
export type MessageInput = { text: string; expression?: HouseExpression; images: ImageInput[] };
export type SpeechInput = MessageInput & { to: string[] };
export type ReplyInput = MessageInput & { to: unknown };
export type SyncInput = HouseSync & { ack: string[] };

export const PENDING_LIMIT = 50;

export class InvalidInput extends Error {}

export function object(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidInput(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new InvalidInput(`${label} has an unknown field`);
  return record;
}

export function string(value: unknown, label: string, max = Infinity): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new InvalidInput(`${label} must be a non-blank string${max === Infinity ? "" : ` up to ${max} characters`}`);
  }
  return value;
}

export function array(value: unknown, label: string, max = Infinity): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new InvalidInput(`${label} must be an array${max === Infinity ? "" : ` of at most ${max} items`}`);
  return value;
}

const ID = /^[a-z0-9_-][a-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function residentId(value: unknown, label: string): string {
  const id = string(value, label);
  if (!ID.test(id)) throw new InvalidInput(`${label} is not a resident ID`);
  return id;
}

const MESSAGE_KEYS = ["text", "expression", "images"];
const SPEECH_KEYS = [...MESSAGE_KEYS, "to"];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}(?![\s\S])/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

function imageOf(value: unknown, index: number): ImageInput {
  const label = `images[${index}]`;
  const { name, data } = object(value, label, ["name", "data"]);
  const filename = string(name, `${label}.name`, 255);
  if (filename === "." || filename === ".." || /[\\/\u0000-\u001f\u007f]/.test(filename)) {
    throw new InvalidInput(`${label}.name must be a file name without a directory`);
  }
  if (typeof data !== "string" || data.length % 4 !== 0) throw new InvalidInput(`${label}.data must be base64`);
  const padding = data.endsWith("==") ? 2 : Number(data.endsWith("="));
  if (data.length / 4 * 3 - padding > REPLY_IMAGE_MAX_BYTES) throw new InvalidInput(`${label} exceeds 10 MiB`);
  if (!BASE64.test(data)) throw new InvalidInput(`${label}.data must be base64`);
  const bytes = Buffer.from(data, "base64");
  if (bytes.subarray(0, 8).equals(PNG)) return { name: filename, data: bytes, mime_type: "image/png" };
  if (bytes.subarray(0, 3).equals(JPEG)) return { name: filename, data: bytes, mime_type: "image/jpeg" };
  const head = bytes.toString("latin1", 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return { name: filename, data: bytes, mime_type: "image/gif" };
  if (head.startsWith("RIFF") && bytes.toString("latin1", 8, 12) === "WEBP") return { name: filename, data: bytes, mime_type: "image/webp" };
  throw new InvalidInput(`${label} is not a PNG, JPEG, GIF or WebP image`);
}

function mediaOf(fields: Record<string, unknown>): Omit<MessageInput, "text"> {
  const expression = HOUSE_EXPRESSIONS.find((candidate) => candidate === fields.expression);
  return {
    ...(expression === undefined ? {} : { expression }),
    images: fields.images === undefined ? [] : array(fields.images, "images", REPLY_IMAGES_MAX).map(imageOf),
  };
}

export function messageOf(value: unknown): MessageInput {
  const fields = object(value, "message", MESSAGE_KEYS);
  return { text: string(fields.text, "text", 4000), ...mediaOf(fields) };
}

export function toOf(value: unknown): string[] {
  return [...new Set(array(value === undefined ? [] : value, "to", 50).map((id) => residentId(id, "to item")))];
}

export function speechOf(value: unknown, legacy = false): SpeechInput {
  const fields = object(value, "speech", legacy ? ["text", "to"] : SPEECH_KEYS);
  return { text: string(fields.text, "text", 4000), ...mediaOf(fields), to: toOf(fields.to) };
}

export function replyOf(value: unknown): ReplyInput {
  const fields = object(value, "reply", SPEECH_KEYS);
  const { text, to } = fields;
  if (typeof text !== "string" || text.length > HOUSE_REPLY_TEXT_MAX) {
    throw new InvalidInput(`text must be a string up to ${HOUSE_REPLY_TEXT_MAX} characters`);
  }
  const media = mediaOf(fields);
  if (text.trim() === "" && media.images.length === 0) throw new InvalidInput("reply must have text or an image");
  return { text, to, ...media };
}

function sleepOf(value: unknown): HouseAgentStatus["sleep"] {
  const { state, wake_at } = object(value, "status.sleep", ["state", "wake_at"]);
  if (state === "awake" && wake_at === undefined) return { state };
  if ((state === "falling_asleep" || state === "asleep") && typeof wake_at === "string" && TIME.test(wake_at) && Number.isFinite(Date.parse(wake_at))) {
    return { state, wake_at };
  }
  throw new InvalidInput("status.sleep must be awake without wake_at, or falling_asleep or asleep with an RFC 3339 wake_at");
}

export function syncOf(value: unknown): SyncInput {
  const { status, ack, protocol } = object(value, "sync", ["status", "ack", "protocol"]);
  if (protocol !== undefined && protocol !== 2) throw new InvalidInput("unsupported sync protocol");
  const { sleep, mood, sleepiness } = object(status, "status", ["sleep", "mood", "sleepiness"]);
  if (typeof sleepiness !== "number" || !Number.isFinite(sleepiness) || sleepiness < 0 || sleepiness > 100) {
    throw new InvalidInput("status.sleepiness must be a number between 0 and 100");
  }
  const ids = array(ack === undefined ? [] : ack, "ack", PENDING_LIMIT).map((id) => {
    if (typeof id !== "string" || !UUID.test(id)) throw new InvalidInput("ack must contain event IDs");
    return id;
  });
  return {
    status: { sleep: sleepOf(sleep), mood: mood === null ? null : string(mood, "status.mood", 1024), sleepiness },
    ack: ids,
    ...(protocol === undefined ? {} : { protocol }),
  };
}
