// A room's record as the screen holds it: one set of events, each id once,
// in the order of `seq`, their place in the house's record. The stream has
// no replay (docs/house.md, 接続と居場所), so the record is read again on each
// connection. Where an event goes never depends on when it arrived.
import type { HousePersonEvent } from "@penelope/contract";

export type RoomLog = {
  /** In the order of `seq`. */
  events: readonly HousePersonEvent[];
  /** The cursor of the page before the oldest event read from the record; none when the start is held. */
  before: string | undefined;
  /** No gaps up to this seq. Zero for an empty record, undefined before the first reading. */
  whole: number | undefined;
  /** Events below this `seq` came by older pages, asked for by the reader. */
  pagedBelow: number | undefined;
  sync?: { connection: string; phase: "reading" | "caught-up" };
};

export const EMPTY_LOG: RoomLog = { events: [], before: undefined, whole: undefined, pagedBelow: undefined };

function joined(held: readonly HousePersonEvent[], more: readonly HousePersonEvent[]): readonly HousePersonEvent[] {
  const ids = new Set(held.map(({ id }) => id));
  const fresh = more.filter(({ id }) => !ids.has(id));
  return fresh.length === 0 ? held : [...held, ...fresh].sort((a, b) => a.seq - b.seq);
}

export function withEvent(log: RoomLog, event: HousePersonEvent, connection: string): RoomLog {
  const events = joined(log.events, [event]);
  if (events === log.events) return log;
  const live = log.sync?.connection === connection && log.sync.phase === "caught-up";
  return { ...log, events, whole: live ? Math.max(log.whole ?? 0, event.seq) : log.whole };
}

/** A page read with the log's cursor. */
export function withOlder(log: RoomLog, page: readonly HousePersonEvent[], before: string | undefined): RoomLog {
  return { ...log, events: joined(log.events, page), before, pagedBelow: log.pagedBelow ?? log.events[0]?.seq };
}

/** A page of the reading that is due: shown at once, though a gap may still stand under it. */
export function withPage(log: RoomLog, page: readonly HousePersonEvent[]): RoomLog {
  const events = joined(log.events, page);
  return events === log.events ? log : { ...log, events };
}

/**
 * How far down a reading of the record has to go before nothing is missing:
 * to where nothing was missing before it, or, before the first reading, to
 * the oldest event held. A reading that stops above that leaves a gap under
 * what it read.
 */
export function reachOf(log: RoomLog): number | undefined {
  return log.whole ?? log.events[0]?.seq;
}

export function caughtUp(log: RoomLog, before: string | undefined, connection: string): RoomLog {
  return {
    ...log,
    // A reading that stopped at what was whole leaves the older cursor as it was. One that went to the start, or
    // the first one, sets it.
    before: log.whole !== undefined && before !== undefined ? log.before : before,
    whole: log.events.at(-1)?.seq ?? 0,
    sync: { connection, phase: "caught-up" },
  };
}
