import timers from "node:timers/promises";

import type { HouseDelivery, HouseResident, HouseSync, HouseSyncResult, HouseView } from "@penelope/contract";

import { type ConnectionIO, type ConnectionPlugin, isObject, onlyKnown, type PluginEvent, readKey, SettingsError } from "../plugin.ts";
import { summaryLine } from "./text.ts";

const POLL_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const REQUEST_MS = 5_000;
const HEARTBEAT_BYTES = 4 * 1024;
const HEARTBEAT_MOOD_CHARS = 32;
const RESIDENT_ID = /^[a-z0-9_-][a-z0-9._-]{0,63}$/;

export const house: ConnectionPlugin = {
  name: "house",
  kind: "connection",
  create(settings, env) {
    onlyKnown(settings, ["url", "token_file", "owner_id"]);
    const url = typeof settings.url === "string" && URL.parse(settings.url);
    if (!url || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new SettingsError("url", "must be an HTTPS origin");
    }
    const ownerId = settings.owner_id;
    if (ownerId !== undefined && (typeof ownerId !== "string" || !RESIDENT_ID.test(ownerId))) {
      throw new SettingsError("owner_id", "must be a house resident ID");
    }
    const token = () => {
      const value = readKey("token_file", settings.token_file, env);
      if (!/^[a-zA-Z0-9._~+/-]+=*$/.test(value)) throw new SettingsError("token_file", "must contain a Bearer token");
      return value;
    };
    token();
    const endpoint = new URL("/v1/agent/sync", url);
    return {
      start(io) {
        const stop = new AbortController();
        const running = poll(io, endpoint, token, ownerId, stop.signal).catch(() => {
          io.log("house connection stopped after an unexpected error");
        });
        return { async stop() { stop.abort(); await running; } };
      },
    };
  },
};

async function poll(io: ConnectionIO, endpoint: URL, token: () => string, ownerId: string | undefined, stop: AbortSignal) {
  let ack: string[] = [];
  let retryMs = POLL_MS;
  let connected = false;
  let noteProblem: string | undefined;
  try {
    while (!stop.aborted) {
      let nextMs = POLL_MS;
      let result: HouseSyncResult | undefined;
      try {
        const status = await io.readStatus();
        if (stop.aborted) break;
        if (!status) throw new Error("backend status is unavailable");
        const { mood, sleepiness, sleep: current } = status;
        const sleep = current.state === "awake" ? { state: current.state } : { state: current.state, wake_at: current.wake_at };
        result = await sync(endpoint, token(), { status: { mood, sleep, sleepiness }, ack }, stop);
      } catch (error) {
        if (stop.aborted) break;
        connected = false;
        await io.clearHeartbeatNote();
        nextMs = retryMs;
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        io.log(`cannot sync (${error instanceof SettingsError ? "token file is unavailable" : error instanceof Error ? error.message : "request failed"}); retrying in ${nextMs / 1000}s`);
      }
      if (result && !stop.aborted) {
        ack = [];
        retryMs = POLL_MS;
        if (!connected) io.log("connected");
        connected = true;
        const note = heartbeatView(result.house);
        const problem = note === undefined ? "house heartbeat note exceeds 4 KiB" :
          (await io.setHeartbeatNote(note)) ? undefined : "backend did not take the house heartbeat note";
        if (problem) await io.clearHeartbeatNote();
        if (problem !== noteProblem) io.log(problem ?? "house heartbeat note restored");
        noteProblem = problem;
        for (const pending of result.pending) {
          if (stop.aborted || !(await io.deliver([envelope(pending, result.house.you, ownerId)]))) break;
          ack.push(pending.event.id);
        }
      }
      if (!stop.aborted) await timers.setTimeout(nextMs, undefined, { signal: stop }).catch((error) => { if (!stop.aborted) throw error; });
    }
  } finally {
    await io.clearHeartbeatNote();
  }
}

function heartbeatView(view: HouseView) {
  const fits = (note: unknown) => Buffer.byteLength(JSON.stringify(note)) <= HEARTBEAT_BYTES;
  if (fits(view)) return view;
  const shortenMood = (resident: HouseResident): HouseResident => {
    const { status } = resident;
    if (!status?.mood) return resident;
    const chars = [...status.mood];
    if (chars.length <= HEARTBEAT_MOOD_CHARS) return resident;
    const mood = `${chars.slice(0, HEARTBEAT_MOOD_CHARS - 1).join("")}…`;
    return { ...resident, status: { ...status, mood } };
  };
  const shorter = {
    ...view,
    away: view.away.map(shortenMood),
    rooms: view.rooms.map((room) => ({ ...room, occupants: room.occupants.map(shortenMood) })),
  };
  if (fits(shorter)) return shorter;
  const withoutDescriptions = { ...shorter, rooms: shorter.rooms.map(({ description: _, ...room }) => room) };
  return fits(withoutDescriptions) ? withoutDescriptions : undefined;
}

function requestError(error: unknown, timedOut: boolean): Error {
  if (timedOut) return new Error("house request timed out");
  const code = error instanceof Error && isObject(error.cause) ? error.cause.code : undefined;
  return new Error(typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? `house request failed: ${code}` : "house request failed");
}

async function sync(endpoint: URL, token: string, body: HouseSync, stop: AbortSignal): Promise<HouseSyncResult> {
  const timeout = AbortSignal.timeout(REQUEST_MS);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.any([stop, timeout]),
  }).catch((error: unknown) => { throw requestError(error, timeout.aborted); });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`house answered HTTP ${response.status}`);
  }
  const result = await response.json().catch((error: unknown) => {
    if (error instanceof SyntaxError) throw new Error("house did not return a sync result");
    throw requestError(error, timeout.aborted);
  }) as HouseSyncResult | null;
  if (typeof result?.house?.you !== "string" || !Array.isArray(result.house.rooms) || !Array.isArray(result.house.away) ||
    !Array.isArray(result.pending) || result.pending.length > 50 ||
    result.pending.some((pending) => !pending?.event?.id || !pending.event.room || !pending.event.actor)) {
    throw new Error("house did not return a sync result");
  }
  if (result.pending.some(({ event }) => !["speech", "enter", "leave"].includes(event.kind))) {
    throw new Error("house returned an unsupported event kind");
  }
  return result;
}

function envelope({ event, delivery, answer_via }: HouseDelivery, you: string, ownerId: string | undefined): PluginEvent {
  const { actor, room } = event;
  const owner = actor.kind === "person" && actor.id === ownerId;
  const marks = [`${actor.kind} ${actor.id}`];
  if (owner) marks.push("owner");
  if (actor.id === you) marks.push("you");
  if (event.kind === "speech" && event.to.length > 0) {
    const list = event.to.join(", ");
    marks.push(`to ${list.length <= 72 ? list : `${event.to[0]} +${event.to.length - 1} more`}`);
  }
  const action = event.kind === "speech" ? `spoke in ${room.name}` :
    event.kind === "enter" ? `entered ${room.name}` : `left ${room.name}`;
  const summary = `[${marks.join(", ")}] ${actor.name} ${action}`;
  return {
    id: event.id,
    occurred_at: event.occurred_at,
    stream: room.id,
    delivery,
    summary: summaryLine(summary.replace(/[\u2028\u2029]+/g, " ")),
    payload: { ...event, owner },
    ...(answer_via?.command === "house say" ? { answer_via: { command: "house say" } } : {}),
  };
}
