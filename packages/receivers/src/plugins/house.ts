import timers from "node:timers/promises";

import type { HouseDelivery, HouseSync, HouseSyncResult } from "@penelope/contract";

import { type ConnectionIO, type ConnectionPlugin, onlyKnown, type PluginEvent, readKey, SettingsError } from "../plugin.ts";
import { summaryLine } from "./text.ts";

const POLL_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const REQUEST_MS = 5_000;
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
        const running = poll(io, endpoint, token, ownerId, stop.signal);
        return { async stop() { stop.abort(); await running; } };
      },
    };
  },
};

async function poll(io: ConnectionIO, endpoint: URL, token: () => string, ownerId: string | undefined, stop: AbortSignal) {
  let ack: string[] = [];
  let retryMs = POLL_MS;
  let connected = false;
  try {
    while (!stop.aborted) {
      let nextMs = POLL_MS;
      let result: HouseSyncResult | undefined;
      try {
        const status = await io.readStatus();
        if (stop.aborted) break;
        if (!status) throw new Error("backend status is unavailable");
        const { mood, sleep, sleepiness } = status;
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
        if (!(await io.setHeartbeatNote(result.house))) {
          await io.clearHeartbeatNote();
          io.log("backend did not take the house heartbeat note");
        }
        for (const pending of result.pending) {
          if (stop.aborted || !(await io.deliver([envelope(pending, ownerId)]))) break;
          ack.push(pending.event.id);
        }
      }
      if (!stop.aborted) await timers.setTimeout(nextMs, undefined, { signal: stop }).catch((error) => { if (!stop.aborted) throw error; });
    }
  } finally {
    await io.clearHeartbeatNote();
  }
}

async function sync(endpoint: URL, token: string, body: HouseSync, stop: AbortSignal): Promise<HouseSyncResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.any([stop, AbortSignal.timeout(REQUEST_MS)]),
  }).catch(() => { throw new Error("house request failed"); });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`house answered HTTP ${response.status}`);
  }
  const result = await response.json().catch(() => undefined) as HouseSyncResult | undefined;
  if (!result?.house || !Array.isArray(result.pending) || result.pending.length > 50 ||
    result.pending.some((pending) => !pending?.event?.id || !pending.event.room || !pending.event.actor)) {
    throw new Error("house did not return a sync result");
  }
  return result;
}

function envelope({ event, delivery, answer_via }: HouseDelivery, ownerId: string | undefined): PluginEvent {
  const { actor, room } = event;
  const owner = actor.kind === "person" && actor.id === ownerId;
  const action = event.kind === "speech" ? `in ${room.name}: ${event.text}` :
    event.kind === "enter" ? `entered ${room.name}` : `left ${room.name}`;
  const summary = `[${actor.kind} ${actor.id}${owner ? ", owner" : ""}] ${actor.name} ${action}`;
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
