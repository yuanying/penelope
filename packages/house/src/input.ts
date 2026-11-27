import type { HouseAgentStatus, HouseSpeech, HouseSync } from "@penelope/contract";

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

export function speechOf(value: unknown): Required<HouseSpeech> {
  const { text, to } = object(value, "speech", ["text", "to"]);
  return {
    text: string(text, "text", 4000),
    to: [...new Set(array(to === undefined ? [] : to, "to", 50).map((id) => residentId(id, "to item")))],
  };
}

function sleepOf(value: unknown): HouseAgentStatus["sleep"] {
  const { state, wake_at } = object(value, "status.sleep", ["state", "wake_at"]);
  if (state === "awake" && wake_at === undefined) return { state };
  if ((state === "falling_asleep" || state === "asleep") && typeof wake_at === "string" && TIME.test(wake_at) && Number.isFinite(Date.parse(wake_at))) {
    return { state, wake_at };
  }
  throw new InvalidInput("status.sleep must be awake without wake_at, or falling_asleep or asleep with an RFC 3339 wake_at");
}

export function syncOf(value: unknown): Required<HouseSync> {
  const { status, ack } = object(value, "sync", ["status", "ack"]);
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
  };
}
