import type { HouseActor, HouseEnterResult, HouseResident, HouseSpeech, HouseSpeechResult, HouseView } from "@penelope/contract";

const USAGE = `Usage:
  house status
  house enter <room-id>
  house leave
  house say <room-id> <text> [--to <resident-id> ...]`;
const ROOM_ID = /^[a-z0-9_-][a-z0-9._-]{0,127}$/;
const RESIDENT_ID = /^[a-z0-9_-][a-z0-9._-]{0,63}$/;

type Command = { kind: "status" } | { kind: "leave" } | { kind: "enter"; room: string } | { kind: "say"; room: string; speech: HouseSpeech };

function commandOf([kind, room, text, ...flags]: readonly string[]): Command | undefined {
  if (room === undefined) return kind === "status" ? { kind } : kind === "leave" ? { kind } : undefined;
  if (!ROOM_ID.test(room)) return;
  if (kind === "enter" && text === undefined) return { kind, room };
  if (kind !== "say" || !text?.trim() || text.length > 4_000) return;
  const to: string[] = [];
  for (let i = 0; i < flags.length; i += 2) {
    const id = flags[i + 1];
    if (flags[i] !== "--to" || !id || !RESIDENT_ID.test(id)) return;
    to.push(id);
  }
  if (to.length <= 50) return { kind, room, speech: to.length ? { text, to } : { text } };
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
    const state = sleep.state === "awake" ? "awake" : `${sleep.state.replaceAll("_", " ")} until ${line(sleep.wake_at)}`;
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
    "Away:", ...residents(away),
  ].join("\n");
}

function refusal(status: number, kind: Command["kind"]): string {
  if (status === 401 || status === 403) return "caller authentication was rejected";
  if (status === 409 && kind === "enter") return "the room is full";
  if (status === 409 && kind === "say") return "you are not in that room";
  if (status === 404 && (kind === "enter" || kind === "say")) return "the room was not found";
  return "the house did not accept the request";
}

const success = (text: string) => ({ code: 0, stdout: `${text}\n`, stderr: "" });
const fail = (text: string, code = 1) => ({ code, stdout: "", stderr: `house: ${text}\n` });

export async function runHouse(args: readonly string[], env: Readonly<Record<string, string | undefined>>, request = fetch) {
  if (args.length === 1 && args[0] === "--help") return success(USAGE);
  const command = commandOf(args);
  if (!command) return fail(USAGE, 2);
  const origin = originOf(env.HOUSE_URL);
  const token = env.HOUSE_TOKEN;
  if (!origin || !token || !/^[a-zA-Z0-9._~+/-]+=*$/.test(token)) return fail("set HOUSE_URL and HOUSE_TOKEN in the deployment", 2);

  const path = command.kind === "status" ? "house" : command.kind === "leave" ? "room" :
    `rooms/${command.room}/${command.kind}`;
  const method = command.kind === "status" ? "GET" : command.kind === "leave" ? "DELETE" : "POST";
  const headers = new Headers({ authorization: `Bearer ${token}` });
  const body = command.kind === "say" ? JSON.stringify(command.speech) : undefined;
  if (body !== undefined) headers.set("content-type", "application/json");
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await request(new URL(`/v1/agent/${path}`, origin), { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal });
  } catch {
    return fail(signal.aborted ? "request timed out" : "could not reach the house");
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
      case "say": {
        const { not_delivered } = await response.json() as HouseSpeechResult;
        const missed = not_delivered.map(residentLabel);
        return success(`Spoke in ${command.room}.${missed.length ? `\nNot delivered: ${missed.join(", ")}` : ""}`);
      }
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
