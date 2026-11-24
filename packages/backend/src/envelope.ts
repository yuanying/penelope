// Checking an envelope that a source sent to the intake (docs/events.md).
import type { AnswerVia, Event } from "@penelope/contract";

export type Parsed<T> = { ok: true; event: T } | { ok: false; error: string };

/**
 * A `source` or a `stream` is a path segment under /sources: lower-case
 * letters, digits, `.`, `_` and `-`, not starting with `.`. So neither can
 * point outside /sources or into another source's place.
 */
export const SEGMENT = /^[a-z0-9_-][a-z0-9._-]{0,127}$/;

/** RFC 3339 with a time and an offset (`Z` or `±hh:mm`). */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function isTime(value: unknown): value is string {
  return typeof value === "string" && RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isAnswerVia(value: unknown): value is AnswerVia {
  if (!isObject(value)) return false;
  const fields = Object.keys(value);
  const name = fields[0];
  if (fields.length !== 1 || (name !== "tool" && name !== "command")) return false;
  const route = value[name];
  return typeof route === "string" && route.trim() !== "";
}

/** The envelope, with only the fields of the contract, or why it is refused. */
export function parseEnvelope(body: unknown): Parsed<Event> {
  if (!isObject(body)) return { ok: false, error: "the event must be a JSON object" };
  const { source, id, occurred_at, summary, stream, delivery, answer_via, payload } = body;
  if (typeof source !== "string" || !SEGMENT.test(source)) {
    return { ok: false, error: "source must be lower-case letters, digits, '.', '_' and '-', not starting with '.'" };
  }
  if (typeof id !== "string" || id === "") return { ok: false, error: "id must be a non-empty string" };
  if (!isTime(occurred_at)) return { ok: false, error: "occurred_at must be an RFC 3339 time" };
  if (typeof summary !== "string") return { ok: false, error: "summary must be a string" };
  if (stream !== undefined && (typeof stream !== "string" || !SEGMENT.test(stream))) {
    return { ok: false, error: "stream must be lower-case letters, digits, '.', '_' and '-', not starting with '.'" };
  }
  if (delivery !== undefined && delivery !== "now" && delivery !== "batch") {
    return { ok: false, error: "delivery must be now or batch" };
  }
  if (answer_via !== undefined && !isAnswerVia(answer_via)) {
    return { ok: false, error: "answer_via must have exactly one non-blank string field: tool or command" };
  }
  if (!("payload" in body)) return { ok: false, error: "payload is required" };
  return {
    ok: true,
    event: {
      source,
      id,
      occurred_at,
      summary,
      ...(stream === undefined ? {} : { stream }),
      ...(delivery === undefined ? {} : { delivery }),
      ...(answer_via === undefined ? {} : { answer_via }),
      payload,
    },
  };
}
