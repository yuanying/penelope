import type { HouseActor, HouseEnterResult, HouseReply, HouseReplyResult, HouseResident, HouseView } from "@penelope/contract";

const USAGE = `Usage:
  house status
  house enter <room-id>
  house leave`;
const ROOM_ID = /^[a-z0-9_-][a-z0-9._-]{0,127}$/;

type Command = { kind: "status" } | { kind: "leave" } | { kind: "enter"; room: string };

function commandOf([kind, room, extra]: readonly string[]): Command | string {
  if (kind === "status") return room === undefined ? { kind } : "status takes no arguments";
  if (kind === "leave") return room === undefined ? { kind } : "leave takes no arguments";
  if (kind !== "enter") return "expected status, enter, or leave; see house --help";
  if (!room || !ROOM_ID.test(room)) return "use a room ID shown by house status, not a display name";
  return extra === undefined ? { kind, room } : "enter takes only a room ID";
}

export type HouseConnection = { origin: URL; token: string };

export function houseConnection(env: Readonly<Record<string, string | undefined>>): HouseConnection | undefined {
  const origin = originOf(env.HOUSE_URL);
  const token = env.HOUSE_TOKEN;
  if (origin && token && /^[a-zA-Z0-9._~+/-]+=*$/.test(token)) return { origin, token };
}

function originOf(raw: string | undefined): URL | undefined {
  const url = raw && URL.parse(raw);
  if (!url || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return;
  if (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) return url;
}

const line = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
const residentLabel = (resident: HouseActor) => `${line(resident.name)} (${line(resident.id)})`;

function residents(occupants: HouseResident[]): string[] {
  if (occupants.length === 0) return ["  (none)"];
  return occupants.map((resident) => {
    const label = `  ${residentLabel(resident)}`;
    if (!resident.status) return resident.kind === "agent" ? `${label}: status unavailable` : label;
    const { sleep, mood } = resident.status;
    const state = sleep.state === "awake" ? "awake" : sleep.state === "falling_asleep"
      ? `falling asleep, wakes at ${line(sleep.wake_at)}` : `asleep until ${line(sleep.wake_at)}`;
    return `${label}: ${state}${mood === null ? "" : `, mood: ${line(mood)}`}`;
  });
}

function describe({ name, you, rooms, away }: HouseView): string {
  return [
    `${line(name)} (you: ${line(you)})`,
    ...rooms.flatMap((room) => [
      `${line(room.name)} (${line(room.id)})${room.capacity === null ? "" : ` [${room.occupants.length}/${room.capacity}]`}: ${line(room.description)}`,
      ...residents(room.occupants),
    ]),
    "Away:", ...(away.length ? away.map((resident) => `  ${residentLabel(resident)}`) : ["  (none)"]),
  ].join("\n");
}

function refusal(status: number, kind: Command["kind"]): string {
  if (status === 401 || status === 403) return "caller authentication was rejected";
  if (status === 409 && kind === "enter") return "the room is full";
  if (status === 404 && kind === "enter") return "the room was not found";
  return "the house did not accept the request";
}

export async function postHouseReply(connection: HouseConnection, speech: HouseReply, signal?: AbortSignal): Promise<HouseReplyResult> {
  const timeout = AbortSignal.timeout(speech.images?.length ? 60_000 : 10_000);
  const unconfirmed = "the speech may already have been recorded";
  const response = await fetch(new URL("/v1/agent/reply", connection.origin), {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
    body: JSON.stringify(speech),
    redirect: "manual",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  }).catch(() => { throw new Error(`Could not confirm the reply with the house; ${unconfirmed}.`); });

  if (response.status !== 200) {
    if (response.status >= 500 || response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Reply not confirmed (house HTTP ${response.status}); ${unconfirmed}.`);
    }
    const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    const reason = typeof body?.error === "string" ? `: ${line(body.error).slice(0, 240)}` : "";
    throw new Error(`Not sent (house HTTP ${response.status})${reason}.`);
  }

  const result = await response.json().catch(() => undefined) as HouseReplyResult | undefined;
  const destination = result?.destination;
  const validDestination = destination?.kind === "room"
    ? typeof destination.room?.id === "string" && typeof destination.room?.name === "string" &&
      Array.isArray(result?.absent_to) && result.absent_to.every((id) => typeof id === "string")
    : destination?.kind === "dm" && typeof destination.dm?.owner_id === "string" && typeof destination.dm?.agent_id === "string";
  if (!result || typeof result.id !== "string" || !result.id || !validDestination ||
    !Array.isArray(result.not_delivered) || !result.not_delivered.every((actor) => typeof actor?.id === "string" && typeof actor.name === "string")) {
    throw new Error(`The house returned an invalid reply confirmation; ${unconfirmed}.`);
  }
  return result;
}

export function describeHouseReply({ id, destination, absent_to, ignored_to, not_delivered }: HouseReplyResult): string {
  const where = destination.kind === "room" ? `${line(destination.room.name)} (${line(destination.room.id)})` :
    `your owner (${line(destination.dm.owner_id)}) in a direct conversation`;
  return [
    `Sent to ${where}, id ${line(id)}.`,
    ...(destination.kind === "room" && absent_to?.length ? [`Not in the room: ${absent_to.map(line).join(", ")}`] : []),
    ...(destination.kind === "dm" && ignored_to !== undefined ? [`Ignored to: ${JSON.stringify(ignored_to)}`] : []),
    ...(not_delivered.length ? [`Not delivered (not awake): ${not_delivered.map(residentLabel).join(", ")}`] : []),
  ].join("\n");
}

const success = (text: string) => ({ code: 0, stdout: `${text}\n`, stderr: "" });
const fail = (text: string, code = 1) => ({ code, stdout: "", stderr: `house: ${text}\n` });

export async function runHouse(args: readonly string[], env: Readonly<Record<string, string | undefined>>, request = fetch) {
  if (args.length === 1 && args[0] === "--help") return success(USAGE);
  const command = commandOf(args);
  if (typeof command === "string") return fail(command, 2);
  const connection = houseConnection(env);
  if (!connection) return fail("set HOUSE_URL and HOUSE_TOKEN in the deployment", 2);
  const { origin, token } = connection;
  const path = command.kind === "status" ? "house" : command.kind === "leave" ? "room" : `rooms/${command.room}/enter`;
  const method = command.kind === "status" ? "GET" : command.kind === "leave" ? "DELETE" : "POST";
  const headers = { authorization: `Bearer ${token}` };
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await request(new URL(`/v1/agent/${path}`, origin), { method, headers, redirect: "manual", signal });
  } catch {
    return fail(signal.aborted ? "request timed out" : "could not confirm the request with the house");
  }
  if (response.status !== (command.kind === "leave" ? 204 : 200)) {
    await response.body?.cancel().catch(() => {});
    return fail(`HTTP ${response.status}: ${refusal(response.status, command.kind)}`);
  }
  try {
    switch (command.kind) {
      case "status": return success(describe(await response.json() as HouseView));
      case "enter": {
        const { occupants } = await response.json() as HouseEnterResult;
        return success([`Entered ${command.room}. Occupants:`, ...residents(occupants)].join("\n"));
      }
      case "leave": return success("You are outside the rooms.");
    }
  } catch {
    return fail(signal.aborted ? "request timed out" : "the house returned an invalid response");
  }
}

if (import.meta.main) {
  const result = await runHouse(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
