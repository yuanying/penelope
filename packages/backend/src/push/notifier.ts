// The notices of the replies (ADR-0027, ADR-0065): every reply goes to every
// subscription the owner made, by the kind of each. A notice is sent once;
// a subscription its service says is gone is dropped, anything else is only
// logged. Taking a reply never waits for its notices.
import type { DatabaseSync } from "node:sqlite";

import type { HistoryEntry, Notice } from "@penelope/contract";

import type { Feed } from "../feed.ts";

/** How much of a reply a notice carries, in characters. */
export const NOTICE_TEXT_LENGTH = 200;

/** A Web Push subscription as the backend keeps it. */
export type StoredSubscription = { id: number; kind: "web-push"; endpoint: string; p256dh: Buffer; auth: Buffer };

/** What a channel's service said of one notice. */
export type Delivery = { kind: "sent" | "gone" | "failed"; status: number };

/** Sends the notices of one kind of subscription. */
export interface Channel<T> {
  /** The most a notice may be as JSON, if limited before mapping to the channel's wire format. */
  readonly maxBytes?: number;
  deliver(target: T, notice: Notice): Promise<Delivery>;
}

type Destination = { id: number; deliver(notice: Notice): Promise<Delivery>; removeIfSame(): boolean };
type NoticeChannel = { kind: string; maxBytes?: number; destinations(): Destination[] };

/** Bind one kind of subscription to its channel so the notifier need not know its address or keys. */
export function noticeChannel<T extends { id: number }>(
  kind: string, subscriptions: { all(): T[]; removeIfSame(target: T): boolean }, channel: Channel<T>,
): NoticeChannel {
  return {
    kind,
    ...(channel.maxBytes === undefined ? {} : { maxBytes: channel.maxBytes }),
    destinations: () => subscriptions.all().map((target) => ({
      id: target.id,
      deliver: (notice) => channel.deliver(target, notice),
      removeIfSame: () => subscriptions.removeIfSame(target),
    })),
  };
}

export class PushSubscriptions {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, { now }: { now: () => number }) {
    this.db = db;
    this.now = now;
  }

  /** One subscription per endpoint: the same endpoint again replaces its keys. */
  save(subscription: Omit<StoredSubscription, "id">): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (kind, endpoint, keys, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET kind = excluded.kind, keys = excluded.keys, updated_ms = excluded.updated_ms`,
      )
      .run(subscription.kind, subscription.endpoint, JSON.stringify({ p256dh: subscription.p256dh.toString("base64url"), auth: subscription.auth.toString("base64url") }), now, now);
  }

  /** Whether there was one with this endpoint. */
  remove(endpoint: string): boolean {
    return Number(this.db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes) > 0;
  }

  /** Drops this one, unless it was made again since. */
  removeIfSame(target: StoredSubscription): boolean {
    const keys = JSON.stringify({ p256dh: target.p256dh.toString("base64url"), auth: target.auth.toString("base64url") });
    return Number(this.db.prepare("DELETE FROM push_subscriptions WHERE id = ? AND keys = ?").run(target.id, keys).changes) > 0;
  }

  /** In the order they were first made. */
  all(): StoredSubscription[] {
    const rows = this.db.prepare("SELECT id, kind, endpoint, keys FROM push_subscriptions ORDER BY id").all() as { id: number; kind: StoredSubscription["kind"]; endpoint: string; keys: string }[];
    return rows.map((row) => {
      const keys = JSON.parse(row.keys) as { p256dh: string; auth: string };
      return { id: row.id, kind: row.kind, endpoint: row.endpoint, p256dh: Buffer.from(keys.p256dh, "base64url"), auth: Buffer.from(keys.auth, "base64url") };
    });
  }
}

/** The notice of a reply, its text cut to `length` characters. */
export function noticeOf(reply: Extract<HistoryEntry, { kind: "agent" }>, agentName: string, length = NOTICE_TEXT_LENGTH): Notice {
  const characters = Array.from(reply.text.trim());
  const text = characters.length > length ? `${characters.slice(0, length).join("")}…` : characters.join("");
  const images = reply.images?.length ?? 0;
  return {
    id: reply.id,
    agent: agentName,
    text,
    ...(reply.expression === undefined ? {} : { expression: reply.expression }),
    ...(images === 0 ? {} : { images }),
  };
}

/** The notice within `maxBytes` as JSON, its text cut shorter until it fits. */
function fittedNotice(reply: Extract<HistoryEntry, { kind: "agent" }>, agentName: string, maxBytes?: number): Notice {
  for (let length = NOTICE_TEXT_LENGTH; ; length = Math.floor(length / 2)) {
    const notice = noticeOf(reply, agentName, length);
    if (maxBytes === undefined || Buffer.byteLength(JSON.stringify(notice)) <= maxBytes || length === 0) return notice;
  }
}

export type NotifierOptions = {
  feed: Feed;
  /** The name the notices give: the agent's, from the settings. */
  agentName: string;
  channels: NoticeChannel[];
  /** Lines that name subscriptions and statuses only: never a text or an endpoint. */
  log: (line: string) => void;
};

export class Notifier {
  private readonly options: NotifierOptions;
  private readonly pending = new Set<Promise<void>>();

  constructor(options: NotifierOptions) {
    this.options = options;
  }

  /** Sends a notice of every reply from now on, until the returned function is called. */
  start(): () => void {
    return this.options.feed.subscribe(undefined, (_id, event) => {
      if (event.event !== "reply") return;
      for (const channel of this.options.channels) {
        try {
          const targets = channel.destinations();
          if (targets.length === 0) continue;
          const notice = fittedNotice(event.data, this.options.agentName, channel.maxBytes);
          for (const target of targets) {
            const sending = this.deliver(channel.kind, target, notice);
            this.pending.add(sending);
            void sending.finally(() => this.pending.delete(sending));
          }
        } catch {
          this.options.log(`push: could not prepare ${channel.kind} notices`);
        }
      }
    });
  }

  /** When the notices under way have all been answered. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async deliver(kind: string, target: Destination, notice: Notice): Promise<void> {
    const { log } = this.options;
    const name = `push: subscription ${target.id} (${kind})`;
    let delivery: Delivery;
    try {
      delivery = await target.deliver(notice);
    } catch {
      log(`${name}: not sent`);
      return;
    }
    if (delivery.kind === "gone") {
      try {
        if (target.removeIfSame()) log(`${name}: removed, its service answered ${delivery.status}`);
      } catch {
        // The database closed on the way out; the next notice tries again.
      }
    } else if (delivery.kind === "failed") {
      log(`${name}: refused with ${delivery.status}`);
    }
  }
}
