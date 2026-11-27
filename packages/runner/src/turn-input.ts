// The input a turn's events become (docs/events.md, "ターンに入る形"): one JSON
// object a line inside <events>, each line a TurnLine of the contract. An
// inline event brings its content; any other its summary and where it was
// appended; batched events are one line per source and stream. Facts only
// (ADR-0008).
//
// The events of the sources drawn with Slack's drawing (ADR-0029) bring what
// changed in Slack, drawn as text by the Slack plugin's package from the
// lines of /sources: a `now` one on its own line, with a few messages before
// it; the batched ones of a stream in their batch line.

import { statSync } from "node:fs";
import { join } from "node:path";

import type { AgentStatus, Appended, DeliveredEvent, SourcesLine, TurnBatch, TurnEvent, TurnLine } from "@penelope/contract";
import { drawChanges, readContext, readPayload } from "@penelope/slack";

import type { ExtensionNotice } from "./extensions.ts";

/** How the events of Slack's sources are drawn. */
export type SlackDrawing = {
  /** The sources drawn with Slack's drawing. */
  sources: ReadonlySet<string>;
  sourcesDir: string;
  /** The most characters of drawn text one input carries, all its Slack lines together. */
  maxChars: number;
  /** The time zone of the times drawn. The process's own when left out. */
  timeZone?: string;
  log: (line: string) => void;
};

/** How many messages before a `now` event of Slack are drawn short beside it. */
export const SLACK_BEFORE = 3;

const where = (event: DeliveredEvent) => (event.stream ? `${event.source}/${event.stream}` : event.source);

function text(payload: unknown): string {
  if (typeof payload === "object" && payload !== null && typeof (payload as { text?: unknown }).text === "string") {
    return (payload as { text: string }).text;
  }
  return JSON.stringify(payload);
}

/** One event's line; `drawn` is the text Slack's drawing made of it, in place of the payload's. */
function single(event: DeliveredEvent, drawn?: string): TurnEvent {
  const head = {
    seq: event.seq,
    source: event.source,
    ...(event.stream ? { stream: event.stream } : {}),
    delivery: event.delivery,
    ...(event.answer_via === undefined ? {} : { answer_via: event.answer_via }),
    occurred_at: event.occurred_at,
    summary: event.summary,
  };
  const attachments = event.attachments?.length ? { attachments: event.attachments } : {};
  if (event.inline) return { ...head, text: drawn ?? text(event.payload), ...attachments };
  const { pending, status } = event.source === "heartbeat" ? event : {};
  return {
    ...head, appended: event.appended, ...attachments,
    ...(pending === undefined ? {} : { pending }),
    ...(status === undefined ? {} : { status }),
  };
}

/** The ranges of each file, in the order the files first come, with touching ranges merged. */
function places(appended: Appended[]): Appended[] {
  const byPath = new Map<string, [number, number][]>();
  for (const { path, lines } of appended) byPath.set(path, [...(byPath.get(path) ?? []), [lines[0], lines[1]]]);
  const out: Appended[] = [];
  for (const [path, ranges] of byPath) {
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    out.push(...merged.map((lines) => ({ path, lines })));
  }
  return out;
}

function batched(events: DeliveredEvent[], drawn?: string): TurnBatch {
  const first = events[0]!;
  return {
    kind: "batch",
    source: first.source,
    ...(first.stream ? { stream: first.stream } : {}),
    count: events.length,
    seqs: events.map((event) => event.seq),
    summary: events.map((event) => event.summary).join("\n"),
    appended: places(events.map((event) => event.appended)),
    ...(drawn === undefined ? {} : { text: drawn }),
  };
}

/** The line of /sources an event was written as. */
function sourcesLine(event: DeliveredEvent & { inline: true }): SourcesLine {
  return {
    seq: event.seq,
    received_at: event.received_at,
    occurred_at: event.occurred_at,
    source: event.source,
    ...(event.stream ? { stream: event.stream } : {}),
    id: event.id,
    summary: event.summary,
    ...(event.attachments?.length ? { attachments: event.attachments.map((attachment) => attachment.path) } : {}),
    payload: event.payload,
  };
}

/** Why an event of a Slack source cannot be drawn; nothing when it can. */
function undrawable(event: DeliveredEvent & { inline: true }, sourcesDir: string): string | undefined {
  if (readPayload(event.payload) === undefined) return "its payload is not of the Slack plugin's shape";
  if (!event.stream) return "it has no stream";
  try {
    if (statSync(join(sourcesDir, event.source, event.stream)).isDirectory()) return undefined;
    return "its stream under the sources is not a directory";
  } catch (error) {
    return `its stream under the sources cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`;
  }
}

/**
 * The characters each drawing may take so that all of them take at most
 * `budget`: those under an even share keep their size, and what they leave
 * is shared among the rest.
 */
function shares(sizes: readonly number[], budget: number): number[] {
  const out = [...sizes];
  let left = budget;
  let rest = sizes.length;
  for (const index of sizes.map((_, i) => i).sort((a, b) => sizes[a]! - sizes[b]!)) {
    out[index] = Math.min(sizes[index]!, Math.floor(left / rest));
    left -= out[index]!;
    rest--;
  }
  return out;
}

/** One line to be: an event on its own, or the batched events of a source and stream. `drawn` when Slack's drawing draws it. */
type Piece = { events: DeliveredEvent[]; drawn: boolean; text?: string };

/** Draws the drawn pieces' changes, all of them within the limit together. */
function drawPieces(pieces: Piece[], slack: SlackDrawing): void {
  if (pieces.length === 0) return;
  const changes = pieces.map((piece) => piece.events.map((event) => sourcesLine(event as DeliveredEvent & { inline: true })));
  const context = readContext(slack.sourcesDir, changes.flat());
  const draw = (index: number, maxChars: number) => {
    // A `now` event comes with what led up to it; batched changes are drawn by themselves.
    const before = pieces[index]!.events[0]!.delivery === "now" ? SLACK_BEFORE : 0;
    return drawChanges(changes[index]!, context, { maxChars, before, ...(slack.timeZone ? { timeZone: slack.timeZone } : {}) }).text;
  };
  const whole = pieces.map((_, index) => draw(index, Number.POSITIVE_INFINITY));
  const allowed = shares(
    whole.map((text) => text.length),
    slack.maxChars,
  );
  pieces.forEach((piece, index) => {
    piece.text = whole[index]!.length <= allowed[index]! ? whole[index]! : draw(index, allowed[index]!);
  });
}

/** The lines for the events handed over together: in seq order, the batches last. */
export function turnLines(events: DeliveredEvent[], slack?: SlackDrawing): TurnLine[] {
  const drawable = (event: DeliveredEvent): boolean => {
    if (!slack || !event.inline || !slack.sources.has(event.source)) return false;
    const why = undrawable(event, slack.sourcesDir);
    if (why !== undefined) slack.log(`slack: event ${event.seq} of ${where(event)} is not drawn: ${why}`);
    return why === undefined;
  };
  const singles: Piece[] = [];
  const batches = new Map<string, Piece>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const drawn = drawable(event);
    if (event.delivery !== "batch" || event.answer_via !== undefined || (event.inline && !drawn)) {
      singles.push({ events: [event], drawn });
      continue;
    }
    const key = `${drawn ? "drawn" : "plain"}\u0000${where(event)}`;
    const batch = batches.get(key);
    if (batch) batch.events.push(event);
    else batches.set(key, { events: [event], drawn });
  }
  if (slack) {
    const drawn = [...singles, ...batches.values()].filter((piece) => piece.drawn);
    try {
      drawPieces(drawn, slack);
    } catch (error) {
      // Not drawn, but not dropped: each comes as it would without the drawing.
      for (const piece of drawn) delete piece.text;
      slack.log(`slack: events ${drawn.flatMap((piece) => piece.events.map((event) => event.seq)).join(",")} are not drawn: ${(error as Error).message}`);
    }
  }
  return [
    ...singles.map(({ events: [event], text }) => single(event!, text)),
    ...[...batches.values()].map(({ events: grouped, text }) => batched(grouped, text)),
  ];
}

/** Runner notes outside the event block, not part of any event. */
export function withRunnerNotes(input: string, notices: readonly ExtensionNotice[], previousModelError?: string, status?: AgentStatus): string {
  if (notices.length === 0 && previousModelError === undefined && status === undefined) return input;
  const note = {
    ...(status === undefined ? {} : { status }),
    ...(notices.length > 0 ? {
      extensions: notices.slice(-5).map(({ kind, path, reason }) => ({
        kind, path: path.slice(0, 240), reason: reason.split("\n")[0]!.slice(0, 240),
      })),
      total: notices.length,
    } : {}),
    ...(previousModelError === undefined ? {} : {
      model_error: `The previous model request failed: ${previousModelError.length > 1_000
        ? `${previousModelError.slice(0, 999)}…`
        : previousModelError}`,
    }),
  };
  return `${input}\n\n<runner_notes>\n${JSON.stringify(note).replaceAll("<", "\\u003c")}\n</runner_notes>`;
}

/** One input for the events handed over together. */
export function formatEvents(events: DeliveredEvent[], slack?: SlackDrawing): string {
  return `<events>\n${turnLines(events, slack)
    .map((line) => JSON.stringify(line))
    .join("\n")}\n</events>`;
}
