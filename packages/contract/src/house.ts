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
  away: HouseResident[];
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

export type HouseSync = { status: HouseAgentStatus; ack?: string[] };
export type HouseSyncResult = { house: HouseView; pending: HouseDelivery[] };
