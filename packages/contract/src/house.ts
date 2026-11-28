import type { Delivery } from "./events.ts";
import type { REPLY_IMAGE_TYPES } from "./images.ts";
import type { ReplyImageUpload } from "./sandbox.ts";
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

export const HOUSE_EXPRESSIONS = ["neutral", "happy", "laughing", "surprised", "thinking", "worried", "sad", "sleepy", "angry"] as const;
export const HOUSE_REPLY_TEXT_MAX = 20_000;
export type HouseExpression = typeof HOUSE_EXPRESSIONS[number];
export type HouseImage = { id: string; name: string; mime_type: typeof REPLY_IMAGE_TYPES[number]; size: number };
export type HouseMessage = { text: string; expression?: HouseExpression; images?: ReplyImageUpload[] };
export type HouseSpeech = HouseMessage & { to?: string[] };
export type HouseReply = Omit<HouseMessage, "expression"> & { expression?: string; to?: unknown };
export type HouseSpeechResult = { id: string; not_delivered: HouseActor[] };
export type HouseDirect = { agent_id: string; owner_id: string };
export type HouseReplyResult = HouseSpeechResult & (
  | { destination: { kind: "room"; room: Pick<HouseRoom, "id" | "name"> }; absent_to: string[]; ignored_to?: never }
  | { destination: { kind: "dm"; dm: HouseDirect }; absent_to?: never; ignored_to?: unknown }
);
export type HouseEnterResult = { occupants: HouseResident[] };

type HouseEventBase = { id: string; occurred_at: string; actor: HouseActor };
type HouseSpokenMessage = { kind: "speech"; text: string; expression?: HouseExpression; images?: HouseImage[] };
export type HouseEvent = HouseEventBase & { room: Pick<HouseRoom, "id" | "name"> } & (
  | (HouseSpokenMessage & { to: string[] })
  | { kind: "enter" | "leave" }
);
export type HouseDirectEvent = HouseEventBase & HouseSpokenMessage & { dm: HouseDirect };

export type HouseDelivery = {
  event: HouseEvent;
  delivery: Delivery;
  answer_via?: { command: "house say" };
};

export type HouseConversationDelivery = {
  event: HouseEvent | HouseDirectEvent;
  stream: string;
  delivery: Delivery;
  owner: boolean;
  answer_via?: { tool: "reply" };
};

export type HouseAgentIdentity = HouseActor & {
  kind: "agent";
  avatar_url?: string;
  avatar_urls?: Partial<Record<HouseExpression, string>>;
  personal_url?: string;
  chat_url?: string;
};
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
export type HouseDirectAvailability = {
  agent_id: string;
  send: "ready" | "in-room" | "deployment-unsupported";
  sleeping: boolean;
  connected: boolean;
};
export type HousePersonView = HousePersonFloor & { you: HousePersonIdentity; direct: HouseDirectAvailability[] };
/** An event as people are given it. `seq` is its place in the house's record: a later event has a greater one. */
export type HousePersonEvent = HouseEvent & { seq: number };
export type HouseDirectDeliveryStatus = "pending" | "delivered" | "expired";
export type HousePersonDirectEvent = HouseDirectEvent & { seq: number; delivery_status?: HouseDirectDeliveryStatus };
export type HouseHistory = { events: HousePersonEvent[]; before?: string };
export type HouseDirectHistory = { events: HousePersonDirectEvent[]; before?: string };
export type HouseStreamReady = { connection: string; house: HousePersonView };
export type HouseStreamEvents = { ready: HouseStreamReady; house: HousePersonView; room: HousePersonEvent; dm: HousePersonDirectEvent };

export type HouseSync = { status: HouseAgentStatus; ack?: string[]; protocol?: 2 };
export type HouseSyncResult = { house: HouseView; pending: HouseDelivery[] };
export type HouseConversationSyncResult = { protocol: 2; house: HouseView; pending: HouseConversationDelivery[] };
