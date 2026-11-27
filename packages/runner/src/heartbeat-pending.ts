// The runner's part of the main agent's heartbeat and wake notices.
import { type DeliveredEvent, HEARTBEAT_PENDING_LIMIT, type HeartbeatPending, type HeartbeatPendingList, isPresenceSource, RECORD_COMMAND_MAX } from "@penelope/contract";

import type { Jobs } from "./jobs.ts";
import type { SubAgents } from "./subagents.ts";

const hasPresenceNotes = (event: DeliveredEvent): event is Extract<DeliveredEvent, { inline: false }> =>
  isPresenceSource(event.source) && !event.inline;

function bounded<T>(items: T[], compare: (a: T, b: T) => number): HeartbeatPendingList<T> | undefined {
  if (items.length === 0) return undefined;
  return { items: items.sort(compare).slice(0, HEARTBEAT_PENDING_LIMIT), omitted: Math.max(0, items.length - HEARTBEAT_PENDING_LIMIT) };
}

export function withHeartbeatPending(
  events: DeliveredEvent[],
  jobs: Pick<Jobs, "list">,
  subAgents: Pick<SubAgents, "heartbeatState">,
  log: (line: string) => void,
): DeliveredEvent[] {
  if (!events.some(hasPresenceNotes)) return events;

  function gather<K extends "jobs" | "subagents">(kind: K, collect: () => HeartbeatPending[K]): HeartbeatPending[K] {
    try {
      return collect();
    } catch (error) {
      log(`heartbeat: ${kind} not collected: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  const running = gather("jobs", () => bounded(
    jobs.list().map(({ id, started_at, command }) => ({
      job: id, started_at, command: [...command.split("\n", 1)[0]!].slice(0, RECORD_COMMAND_MAX).join(""),
    })),
    (a, b) => a.started_at.localeCompare(b.started_at) || a.job.localeCompare(b.job),
  ));
  const open = gather("subagents", () => bounded(
    subAgents.heartbeatState(),
    (a, b) => a.since.localeCompare(b.since) || a.name.localeCompare(b.name),
  ));
  if (!running && !open) return events;
  return events.map((event) => hasPresenceNotes(event) ? {
    ...event,
    pending: { ...event.pending, ...(running ? { jobs: running } : {}), ...(open ? { subagents: open } : {}) },
  } : event);
}
