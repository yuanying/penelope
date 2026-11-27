import type { HouseActor, HouseEnterResult, HouseResident, HouseSpeech, HouseSpeechResult, HouseView } from "@penelope/contract";

const USAGE = `Usage:
  house status
  house enter <room-id>
  house leave
  house say <room-id> <text> [--to <resident-id> ...]`;
const ROOM_ID = /^[a-z0-9_-][a-z0-9._-]{0,127}$/;
const RESIDENT_ID = /^[a-z0-9_-][a-z0-9._-]{0,63}$/;

type Command = { kind: "status" } | { kind: "leave" } | { kind: "enter"; room: string } | { kind: "say"; room: string; speech: HouseSpeech };

function commandOf([kind, room, text, ...flags]: readonly string[]): Command | string {
  if (kind === "status") return room === undefined ? { kind } : "status takes no arguments";
  if (kind === "leave") return room === undefined ? { kind } : "leave takes no arguments";
  if (kind !== "enter" && kind !== "say") return "expected status, enter, leave, or say; see house --help";
  if (!room || !ROOM_ID.test(room)) return "use a room ID shown by house status, not a display name";
  if (kind === "enter") return text === undefined ? { kind, room } : "enter takes only a room ID";
  if (!text?.trim() || text.length > 4_000) return "speech text must be non-blank and at most 4,000 characters";
  const to: string[] = [];
  for (let i = 0; i < flags.length; i += 2) {
    const id = flags[i + 1];
    if (flags[i] !== "--to") return "only --to <resident-id> may follow the speech text";
    if (!id || !RESIDENT_ID.test(id)) return "--to takes a resident ID shown by house status, not a display name";
    to.push(id);
  }
  if (to.length > 50) return "say takes at most 50 --to arguments";
  return { kind, room, speech: to.length ? { text, to } : { text } };
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
    "Away:", ...residents(away),
  ].join("\n");
}

function refusal(status: number, kind: Command["kind"]): string {
  if (status === 400 && kind === "say") return "the house rejected the speech text or a --to resident ID";
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
  if (typeof command === "string") return fail(command, 2);
  const noConfirmation = (reason: string) => fail(command.kind === "say" ? `${reason}; the speech may already have been recorded` : reason);
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
    return noConfirmation(signal.aborted ? "request timed out" : "could not confirm the request with the house");
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
        const { id, not_delivered } = await response.json() as HouseSpeechResult;
        if (typeof id !== "string" || id === "" || !Array.isArray(not_delivered)) return noConfirmation("the house returned an invalid response");
        const missed = not_delivered.map(residentLabel);
        return success(`Spoke in ${command.room}.${missed.length ? `\nNot delivered (not awake): ${missed.join(", ")}` : ""}`);
      }
    }
  } catch {
    return noConfirmation(signal.aborted ? "request timed out" : "the house returned an invalid response");
  }
}

if (import.meta.main) {
  const result = await runHouse(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
