// The stream has no replay, so a room's record is read again on each
// connection and joined to what is held by the events' ids (docs/house.md,
// 接続と居場所).
import type { HouseEvent } from "@penelope/contract";

export type RoomLog = {
  /** Oldest first. */
  events: readonly HouseEvent[];
  /** The cursor of the older page; none when the start of the record is held. */
  before: string | undefined;
  /** False until the record was read once: the room is not known to be silent before that. */
  read: boolean;
};

export const UNREAD_LOG: RoomLog = { events: [], before: undefined, read: false };

/** An event the stream brought. */
export function appended(log: RoomLog, event: HouseEvent): RoomLog {
  if (log.events.some(({ id }) => id === event.id)) return log;
  return { ...log, events: [...log.events, event] };
}

/** `page` is newest first and was read with the log's cursor. */
export function withOlder(log: RoomLog, page: readonly HouseEvent[], before: string | undefined): RoomLog {
  const held = new Set(log.events.map(({ id }) => id));
  return { ...log, events: [...page.filter(({ id }) => !held.has(id)).reverse(), ...log.events], before };
}

/**
 * The record read again from its newest event down (`fetched`, newest first,
 * with the cursor of the page after it) until `anchor`, the newest event held
 * when the reading began. What came by the stream meanwhile stays after it.
 * When the anchor is not among what was fetched, or is no longer held, what
 * was fetched replaces what was held before it.
 */
export function caughtUp(log: RoomLog, anchor: string | undefined, fetched: readonly HouseEvent[], before: string | undefined): RoomLog {
  const anchorAt = anchor === undefined ? -1 : log.events.findIndex(({ id }) => id === anchor);
  const reached = anchorAt < 0 ? -1 : fetched.findIndex(({ id }) => id === anchor);
  const fresh = (reached < 0 ? fetched : fetched.slice(0, reached)).toReversed();
  const known = new Set(fresh.map(({ id }) => id));
  const sinceAnchor = log.events.slice(anchorAt + 1).filter(({ id }) => !known.has(id));
  return {
    events: [...(reached < 0 ? [] : log.events.slice(0, anchorAt + 1)), ...fresh, ...sinceAnchor],
    before: reached < 0 ? before : log.before,
    read: true,
  };
}
