// The stream has no replay, so a room's record is read again on each
// connection and joined to what is held by the events' ids (docs/house.md,
// 接続と居場所). What the stream brings before that reading is done may
// stand after a gap, so it is held apart from what is known to be whole.
import type { HouseEvent } from "@penelope/contract";

export type RoomLog = {
  /** Oldest first, with nothing missing between them. */
  events: readonly HouseEvent[];
  /** What the stream brought while a reading was due: after `events`, maybe after a gap. */
  heard: readonly HouseEvent[];
  /** The cursor of the older page; none when the start of the record is held. */
  before: string | undefined;
  /** How many of the first `events` came by older pages, asked for by the reader. */
  paged: number;
  /** False until the record was read once: the room is not known to be silent before that. */
  read: boolean;
  /** The reading that will bring the log up to date; none when it is. An answer to any other reading is dropped. */
  due: number | undefined;
  /** Which showing of the room this is: an answer asked for in an earlier showing is dropped. */
  showing: number;
};

export function shownOf(log: RoomLog): readonly HouseEvent[] {
  return log.heard.length === 0 ? log.events : [...log.events, ...log.heard];
}

/** An event the stream brought. */
export function appended(log: RoomLog, event: HouseEvent): RoomLog {
  if (shownOf(log).some(({ id }) => id === event.id)) return log;
  return log.due === undefined ? { ...log, events: [...log.events, event] } : { ...log, heard: [...log.heard, event] };
}

/** `page` is newest first and was read with the log's cursor. */
export function withOlder(log: RoomLog, page: readonly HouseEvent[], before: string | undefined): RoomLog {
  const held = new Set(shownOf(log).map(({ id }) => id));
  const older = page.filter(({ id }) => !held.has(id)).reverse();
  return { ...log, events: [...older, ...log.events], before, paged: log.paged + older.length };
}

/**
 * The record read from its newest event down (`fetched`, newest first, with
 * the cursor of the page after it) until the newest of `events`. When that
 * event is not among what was fetched, what was fetched replaces `events`.
 * What was heard and is not among what was fetched came after the reading.
 */
export function caughtUp(log: RoomLog, fetched: readonly HouseEvent[], before: string | undefined): RoomLog {
  const anchor = log.events.at(-1)?.id;
  const reached = anchor === undefined ? -1 : fetched.findIndex(({ id }) => id === anchor);
  const read = reached < 0 ? fetched.toReversed() : [...log.events, ...fetched.slice(0, reached).toReversed()];
  const known = new Set(read.map(({ id }) => id));
  return {
    ...log,
    events: [...read, ...log.heard.filter(({ id }) => !known.has(id))],
    heard: [],
    before: reached < 0 ? before : log.before,
    paged: reached < 0 ? 0 : log.paged,
    read: true,
    due: undefined,
  };
}
