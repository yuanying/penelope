import { isTime } from "./envelope.ts";

/** `YYYY-MM-DD` of the instant in the time zone. */
export function dayIn(ms: number, timeZone: string): string {
  // en-CA writes dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Format a stored RFC 3339 time for delivery, without changing its instant. */
export function deliveryTimeIn(timeZone: string): (value: string) => string {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  return (value) => {
    // An invalid old row should not prevent the whole batch from being delivered.
    if (!isTime(value)) return value;
    const ms = Date.parse(value);
    const zone = format.formatToParts(ms).find((part) => part.type === "timeZoneName")?.value;
    // Some historical offsets have seconds and cannot be written in RFC 3339.
    const offset = zone === "GMT" ? "+00:00" : zone?.match(/^GMT([+-]\d{2}:\d{2})$/)?.[1];
    if (!offset) return value;
    const minutes = Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6));
    const local = iso(ms + (offset[0] === "-" ? -minutes : minutes) * 60_000);
    if (local.length !== 24) return value; // RFC 3339 requires a four-digit year.
    // Keep the input's fractional seconds, even beyond Date's millisecond precision.
    const fraction = value.match(/\.\d+/)?.[0] ?? "";
    return local.slice(0, 19) + fraction + offset;
  };
}

/**
 * How often a clock ticks that watches for a time `everyMs` apart: every
 * 15 s, or every second when that is under a minute, as only the tests set.
 */
export function tickMs(everyMs: number): number {
  return everyMs < 60_000 ? 1_000 : 15_000;
}
