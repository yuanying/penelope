// A conversation's record as the screen holds it: one set of events, each id once,
// in the order of `seq`, their place in the house's record. The stream has
// no replay (docs/house.md, 接続と居場所), so the record is read again on each
// connection. Where an event goes never depends on when it arrived.
import type { HousePersonDirectEvent, HousePersonEvent } from "@penelope/contract";

export type Conversation = { kind: "room" | "dm"; id: string };
export type ConversationEvent = HousePersonEvent | HousePersonDirectEvent;
export const logKey = ({ kind, id }: Conversation): string => kind === "dm" ? `dm.${id}` : id;

export type ConversationLog = {
  /** In the order of `seq`. */
  events: readonly ConversationEvent[];
  /** The cursor of the page before the oldest event read from the record; none when the start is held. */
  before: string | undefined;
  /** No gaps up to this seq. Zero for an empty record, undefined before the first reading. */
  whole: number | undefined;
  /** Events below this `seq` came by older pages, asked for by the reader. */
  pagedBelow: number | undefined;
  sync?: { connection: string; phase: "reading" | "caught-up" | "unavailable" };
};

export const EMPTY_LOG: ConversationLog = { events: [], before: undefined, whole: undefined, pagedBelow: undefined };

function joined(held: readonly ConversationEvent[], more: readonly ConversationEvent[]): readonly ConversationEvent[] {
  const events = new Map(held.map((event) => [event.id, event]));
  let changed = false;
  for (const event of more) {
    const current = events.get(event.id);
    if (!current || (deliveryOf(current) === "pending" && (deliveryOf(event) === "expired" || deliveryOf(event) === "delivered"))) {
      events.set(event.id, event);
      changed = true;
    }
  }
  return changed ? [...events.values()].sort((a, b) => a.seq - b.seq) : held;
}

export function withEvent(log: ConversationLog, event: ConversationEvent, connection: string): ConversationLog {
  const events = joined(log.events, [event]);
  if (events === log.events) return log;
  const live = log.sync?.connection === connection && log.sync.phase === "caught-up";
  return { ...log, events, whole: live ? Math.max(log.whole ?? 0, event.seq) : log.whole };
}

/** A page read with the log's cursor. */
export function withOlder(log: ConversationLog, page: readonly ConversationEvent[], before: string | undefined): ConversationLog {
  return { ...log, events: joined(log.events, page), before, pagedBelow: log.pagedBelow ?? log.events[0]?.seq };
}

/** A page of the reading that is due: shown at once, though a gap may still stand under it. */
export function withPage(log: ConversationLog, page: readonly ConversationEvent[]): ConversationLog {
  const events = joined(log.events, page);
  return events === log.events ? log : { ...log, events };
}

/**
 * How far down a reading of the record has to go before nothing is missing:
 * to where nothing was missing before it, or, before the first reading, to
 * the oldest event held. A reading that stops above that leaves a gap under
 * what it read.
 */
export function reachOf(log: ConversationLog): number | undefined {
  const reached = log.whole ?? log.events[0]?.seq;
  const pending = log.events.find((event) => deliveryOf(event) === "pending");
  return pending && reached !== undefined ? Math.min(pending.seq, reached) : reached;
}

function deliveryOf(event: ConversationEvent) {
  return "dm" in event ? event.delivery_status : undefined;
}

export function caughtUp(log: ConversationLog, before: string | undefined, connection: string): ConversationLog {
  return {
    ...log,
    // A reading that stopped at what was whole leaves the older cursor as it was. One that went to the start, or
    // the first one, sets it.
    before: log.whole !== undefined && before !== undefined ? log.before : before,
    whole: log.events.at(-1)?.seq ?? 0,
    sync: { connection, phase: "caught-up" },
  };
}
