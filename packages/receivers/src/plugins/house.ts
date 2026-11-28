import timers from "node:timers/promises";

import { EVENT_PATH_SEGMENT, type HouseConversationDelivery, type HouseConversationSyncResult, type HouseImage, type HouseResident, type HouseSync, type HouseView, REPLY_IMAGE_MAX_BYTES, REPLY_IMAGES_MAX, REPLY_IMAGE_TYPES } from "@penelope/contract";

import type { IntakeFile } from "../intake.ts";
import { type ConnectionIO, type ConnectionPlugin, isObject, onlyKnown, type PluginEvent, readKey, SettingsError } from "../plugin.ts";
import { summaryLine } from "./text.ts";

const POLL_MS = 2_000;
const MAX_RETRY_MS = 30_000;
const PENDING_LIMIT = 50;
const REQUEST_MS = 5_000;
const HEARTBEAT_BYTES = 4 * 1024;
const HEARTBEAT_MOOD_CHARS = 32;

export const house: ConnectionPlugin = {
  name: "house",
  kind: "connection",
  create(settings, env) {
    onlyKnown(settings, ["url", "token_file"]);
    const url = typeof settings.url === "string" && URL.parse(settings.url);
    if (!url || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new SettingsError("url", "must be an HTTPS origin");
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
        const running = poll(io, endpoint, token, stop.signal).catch(() => {
          io.log("house connection stopped after an unexpected error");
        });
        return { async stop() { stop.abort(); await running; } };
      },
    };
  },
};

async function poll(io: ConnectionIO, endpoint: URL, token: () => string, stop: AbortSignal) {
  let ack: string[] = [];
  let retryMs = POLL_MS;
  const imageRetries = new Map<string, { at: number; delay: number; problem: string }>();
  let imageProblem: string | undefined;
  let connected = false;
  let noteProblem: string | undefined;
  try {
    while (!stop.aborted) {
      let nextMs = POLL_MS;
      let result: HouseConversationSyncResult | undefined;
      let credential = "";
      try {
        const status = await io.readStatus();
        if (stop.aborted) break;
        if (!status) throw new Error("backend status is unavailable");
        const { mood, sleepiness, sleep: current } = status;
        const sleep = current.state === "awake" ? { state: current.state } : { state: current.state, wake_at: current.wake_at };
        credential = token();
        result = await sync(endpoint, credential, { protocol: 2, status: { mood, sleep, sleepiness }, ack }, stop);
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
        const visible = new Set(result.pending.map(({ event }) => event.id));
        for (const id of imageRetries.keys()) if (!visible.has(id)) imageRetries.delete(id);
        for (const pending of result.pending) {
          if (stop.aborted) break;
          const { event } = pending;
          const retry = imageRetries.get(event.id);
          if (retry && retry.at > io.now().getTime()) continue;
          if (event.actor.kind === "agent" && event.actor.id === result.house.you) {
            ack.push(event.id);
            continue;
          }
          const files: IntakeFile[] = [];
          try {
            if (event.kind === "speech") {
              for (const image of event.images ?? []) files.push(await downloadImage(endpoint, credential, image, stop));
            }
          } catch (error) {
            const delay = retry ? Math.min(retry.delay * 2, MAX_RETRY_MS) : POLL_MS;
            imageRetries.set(event.id, {
              at: io.now().getTime() + delay,
              delay,
              problem: error instanceof Error ? error.message : "request failed",
            });
            continue;
          }
          imageRetries.delete(event.id);
          if (stop.aborted || !(await io.deliver([{ ...envelope(pending), ...(files.length ? { files } : {}) }]))) break;
          ack.push(event.id);
        }
        const downloadProblem = imageRetries.values().next().value?.problem;
        const full = imageRetries.size === PENDING_LIMIT;
        const nextImageProblem = downloadProblem === undefined ? undefined :
          `cannot download a house attachment (${downloadProblem})${full ? `; all ${PENDING_LIMIT} delivery slots are blocked` : ""}`;
        if (!stop.aborted && nextImageProblem !== imageProblem) {
          io.log(nextImageProblem ?? "house attachment downloads resumed");
          imageProblem = nextImageProblem;
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
  const note = { ...view, away: view.away.map(({ id, name, kind }) => ({ id, name, kind })) };
  if (fits(note)) return note;
  const shortenMood = (resident: HouseResident): HouseResident => {
    const { status } = resident;
    if (!status?.mood) return resident;
    const chars = [...status.mood];
    if (chars.length <= HEARTBEAT_MOOD_CHARS) return resident;
    const mood = `${chars.slice(0, HEARTBEAT_MOOD_CHARS - 1).join("")}…`;
    return { ...resident, status: { ...status, mood } };
  };
  const shorter = {
    ...note,
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

async function sync(endpoint: URL, token: string, body: HouseSync, stop: AbortSignal): Promise<HouseConversationSyncResult> {
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
  }) as HouseConversationSyncResult | null;
  if (result?.protocol !== 2 || typeof result.house?.you !== "string" || !Array.isArray(result.house.rooms) || !Array.isArray(result.house.away) ||
    !Array.isArray(result.pending) || result.pending.length > PENDING_LIMIT || !result.pending.every(validDelivery)) {
    throw new Error("house did not return a protocol 2 sync result");
  }
  return result;
}

function validDelivery(pending: HouseConversationDelivery): boolean {
  const event = pending?.event;
  if (!event || typeof event.id !== "string" || !event.id ||
    typeof event.actor?.id !== "string" || typeof event.actor.name !== "string" || !["agent", "person"].includes(event.actor.kind) ||
    typeof pending.stream !== "string" || !EVENT_PATH_SEGMENT.test(pending.stream) ||
    typeof pending.owner !== "boolean" || !["now", "batch"].includes(pending.delivery)) return false;
  if ("room" in event) {
    if (typeof event.room?.name !== "string" || typeof event.room.id !== "string") return false;
    if (event.kind === "enter" || event.kind === "leave") return true;
    if (event.kind !== "speech" || !Array.isArray(event.to) || !event.to.every((id) => typeof id === "string")) return false;
  } else if (typeof event.dm?.agent_id !== "string" || typeof event.dm.owner_id !== "string") return false;
  return event.kind === "speech" && typeof event.text === "string" &&
    (event.images === undefined || (Array.isArray(event.images) && event.images.length <= REPLY_IMAGES_MAX && event.images.every(validImage)));
}

function validImage(image: HouseImage): boolean {
  return typeof image?.id === "string" && image.id !== "" && image.id !== "." && image.id !== ".." &&
    typeof image.name === "string" && REPLY_IMAGE_TYPES.includes(image.mime_type) &&
    Number.isSafeInteger(image.size) && image.size > 0 && image.size <= REPLY_IMAGE_MAX_BYTES;
}

async function downloadImage(endpoint: URL, token: string, image: HouseImage, stop: AbortSignal): Promise<IntakeFile> {
  const url = new URL(`/v1/agent/images/${encodeURIComponent(image.id)}`, endpoint);
  const deadline = new AbortController();
  const signal = AbortSignal.any([stop, deadline.signal]);
  const headerTimer = setTimeout(() => deadline.abort(), REQUEST_MS);
  const response = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    redirect: "manual",
    signal,
  }).catch((error: unknown) => { throw requestError(error, deadline.signal.aborted); })
    .finally(() => clearTimeout(headerTimer));
  if (response.status !== 200 || !response.body || response.headers.get("content-type") !== image.mime_type) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`invalid house image response (HTTP ${response.status})`);
  }

  const reader = response.body.getReader();
  const data = new Uint8Array(image.size);
  const bodyMs = REQUEST_MS + 1_000 * Math.ceil(image.size / (1024 * 1024));
  const bodyTimer = setTimeout(() => deadline.abort(), bodyMs);
  let offset = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (offset + part.value.length > data.length) throw new Error("house image size did not match the delivery");
      data.set(part.value, offset);
      offset += part.value.length;
    }
    if (offset !== data.length) throw new Error("house image size did not match the delivery");
  } catch (error) {
    if (deadline.signal.aborted) throw new Error("house image body timed out");
    throw error;
  } finally {
    clearTimeout(bodyTimer);
    await reader.cancel().catch(() => {});
  }
  return { name: image.id, type: image.mime_type, data };
}

function envelope({ event, stream, owner, delivery, answer_via }: HouseConversationDelivery): PluginEvent {
  const { actor } = event;
  const marks = [`${actor.kind} ${actor.id}`];
  if (owner) marks.push("owner");
  if (event.kind === "speech" && "room" in event && event.to.length > 0) {
    const list = event.to.join(", ");
    marks.push(`to ${list.length <= 72 ? list : `${event.to[0]} +${event.to.length - 1} more`}`);
  }
  const action = !("room" in event) ? "spoke directly to you" : event.kind === "speech" ? `spoke in ${event.room.name}` :
    event.kind === "enter" ? `entered ${event.room.name}` : `left ${event.room.name}`;
  const summary = `[${marks.join(", ")}] ${actor.name} ${action}`;
  return {
    id: event.id,
    occurred_at: event.occurred_at,
    stream,
    delivery,
    summary: summaryLine(summary.replace(/[\u2028\u2029]+/g, " ")),
    payload: { ...event, owner },
    ...(answer_via?.tool === "reply" ? { answer_via: { tool: "reply" } } : {}),
  };
}
