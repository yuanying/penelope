import type { Delivery } from "./events.ts";
import type { SleepStatus } from "./status.ts";

export type HouseActor = { id: string; name: string; kind: "agent" | "person" };
export type HouseRoom = { id: string; name: string; description: string; capacity: number | null };

export type HouseAgentStatus = {
  mood: string | null;
  sleepiness: number;
  sleep: SleepStatus;
};

export type HouseResident = HouseActor & {
  status: { mood: string | null; sleep: HouseAgentStatus["sleep"] } | null;
};

export type HouseView = {
  name: string;
  you: string;
  rooms: (HouseRoom & { occupants: HouseResident[] })[];
  away: HouseActor[];
};

export type HouseSpeech = { text: string; to?: string[] };
export type HouseSpeechResult = { id: string; not_delivered: HouseActor[] };
export type HouseEnterResult = { occupants: HouseResident[] };

export type HouseEvent = { id: string; occurred_at: string; room: Pick<HouseRoom, "id" | "name">; actor: HouseActor } & (
  | { kind: "speech"; text: string; to: string[] }
  | { kind: "enter" | "leave" }
);

export type HouseDelivery = {
  event: HouseEvent;
  delivery: Delivery;
  answer_via?: { command: "house say" };
};

export type HouseAgentIdentity = HouseActor & { kind: "agent"; avatar_url?: string; chat_url?: string };
export type HousePersonIdentity = HouseActor & { kind: "person"; avatar_url?: string };
export type HousePublicIdentity = HouseAgentIdentity | HousePersonIdentity;
export type HousePersonOccupant = (
  | (HouseAgentIdentity & { status: HouseAgentStatus | null })
  | HousePersonIdentity
) & { connected: boolean };
export type HouseSpeechPreview = Pick<Extract<HouseEvent, { kind: "speech" }>, "id" | "actor" | "text" | "occurred_at">;
export type HousePersonFloor = {
  name: string;
  rooms: (HouseRoom & { occupants: HousePersonOccupant[]; last_speech: HouseSpeechPreview | null })[];
  away: HousePublicIdentity[];
};
export type HousePersonView = HousePersonFloor & { you: HousePersonIdentity };
/** An event as people are given it. `seq` is its place in the house's record: a later event has a greater one. */
export type HousePersonEvent = HouseEvent & { seq: number };
export type HouseHistory = { events: HousePersonEvent[]; before?: string };
export type HouseStreamReady = { connection: string; house: HousePersonView; return_failed?: string };
export type HouseStreamEvents = { ready: HouseStreamReady; house: HousePersonView; room: HousePersonEvent };

export type HouseSync = { status: HouseAgentStatus; ack?: string[] };
export type HouseSyncResult = { house: HouseView; pending: HouseDelivery[] };
