// The conversation and the record of the turns (ADR-0002, docs/ui-api.md):
// the owner's messages and the replies as history, what the turns did block
// by block. What is new also goes down the feed.
// The images of a reply and of the owner's messages are kept by the assets
// (ADR-0032, ADR-0034).
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Activity, AgentId, AgentState, AgentSummary, HistoryEntry, HistoryResponse, OwnerFile, OwnerFiles, ReplyImage, ReplyRequest, Trigger } from "@penelope/contract";

import { type Assets, type CheckedImage, splitOwnerFiles, type StoredImage } from "./assets.ts";
import { transaction } from "./db.ts";
import type { Feed } from "./feed.ts";
import { MainActivity, preview } from "./main-activity.ts";
import type { Attachment } from "./sources.ts";
import { iso } from "./time.ts";

export const DEFAULT_PAGE = 50;

type Row = {
  row: number;
  id: string;
  kind: "owner" | "agent";
  agent: string | null;
  at: string;
  text: string;
  expression: string | null;
  trigger_source: string | null;
  trigger_summary: string | null;
  files: string | null;
  turn_id: string | null;
};

export class Conversation {
  private readonly db: DatabaseSync;
  private readonly feed: Feed;
  private readonly now: () => number;
  private readonly assets: Assets | undefined;
  private readonly main: MainActivity;
  private readonly summaryListeners = new Set<() => void>();

  /** Without `assets`, a reply carries no images. */
  constructor(db: DatabaseSync, feed: Feed, { now, assets }: { now: () => number; assets?: Assets }) {
    this.db = db;
    this.feed = feed;
    this.now = now;
    this.assets = assets;
    this.main = new MainActivity(db);
  }

  /**
   * The owner's message, kept under the id of the `ui` event it became, with
   * copies of the images sent with it and the names of its other files
   * (ADR-0034). `enqueue` puts the event in the queue in the same transaction:
   * all of it is kept or none. When the copies cannot be written, it throws
   * AssetStoreError before anything is kept.
   */
  ownerMessage({ id, text, files = [] }: { id: string; text: string; files?: readonly Attachment[] }, enqueue: () => void = () => {}): OwnerFiles {
    const { images, others } = splitOwnerFiles(files);
    if (images.length > 0 && this.assets === undefined) throw new Error("this conversation keeps no images");
    const stored = images.length === 0 ? [] : this.assets!.write(images);
    try {
      transaction(this.db, () => {
        enqueue();
        this.db
          .prepare("INSERT INTO history (id, kind, at, text, files) VALUES (?, 'owner', ?, ?, ?)")
          .run(id, iso(this.now()), text, others.length === 0 ? null : JSON.stringify(others));
        if (stored.length > 0) this.assets!.record(id, undefined, stored);
      });
    } catch (error) {
      this.assets?.discard(stored);
      throw error;
    }
    this.summaryChanged();
    return ownerFiles(kept(stored), others);
  }

  /**
   * Keeps the reply with copies of its images, tied to it, and sends it down
   * the feed, tied to the turn it was sent in when that is known (ADR-0038).
   * All of it is kept or none: when the copies cannot be written, it throws
   * AssetStoreError and the reply is not taken (ADR-0032).
   */
  reply(request: Omit<ReplyRequest, "images">, images: readonly CheckedImage[] = []): { id: string } {
    const id = randomUUID();
    const at = iso(this.now());
    if (images.length > 0 && this.assets === undefined) throw new Error("this conversation keeps no images");
    const stored = images.length === 0 ? [] : this.assets!.write(images);
    try {
      transaction(this.db, () => {
        this.db
          .prepare("INSERT INTO history (id, kind, agent, at, text, expression, in_reply_to, turn_id) VALUES (?, 'agent', ?, ?, ?, ?, ?, ?)")
          .run(id, request.agent, at, request.text, request.expression ?? null, request.in_reply_to ?? null, request.turn_id ?? null);
        if (stored.length > 0) this.assets!.record(id, request.agent, stored);
      });
    } catch (error) {
      this.assets?.discard(stored);
      throw error;
    }
    const copies = kept(stored);
    const trigger = request.in_reply_to === undefined ? undefined : this.triggerOf(request.in_reply_to);
    this.feed.publish({
      event: "reply",
      data: {
        kind: "agent",
        id,
        at,
        text: request.text,
        agent: request.agent,
        ...(request.expression === undefined ? {} : { expression: request.expression }),
        ...(trigger === undefined ? {} : { trigger }),
        ...(request.turn_id === undefined ? {} : { turn_id: request.turn_id }),
        ...(copies.length === 0 ? {} : { images: copies }),
      },
    });
    this.summaryChanged();
    return { id };
  }

  /** The owner read through a known history message. Older acknowledgements cannot move it back. */
  markRead(through: string): boolean {
    const line = this.db.prepare("SELECT row FROM history WHERE id = ?").get(through) as { row: number } | undefined;
    if (line === undefined) return false;
    const updated = this.db.prepare("UPDATE conversation_read SET through_row = ? WHERE through_row < ?")
      .run(line.row, line.row);
    if (Number(updated.changes) > 0) this.summaryChanged();
    return true;
  }

  summary(unseenFailures: number): AgentSummary {
    const last = this.db.prepare("SELECT kind, at, substr(text, 1, 201) AS text FROM history ORDER BY row DESC LIMIT 1")
      .get() as AgentSummary["last_message"] | undefined;
    const { unread } = this.db.prepare(
      "SELECT count(*) AS unread FROM history WHERE kind = 'agent' AND row > (SELECT through_row FROM conversation_read WHERE singleton = 1)",
    ).get() as { unread: number };
    return {
      state: this.main.state(),
      last_message: last == null ? null : { ...last, text: preview(last.text) },
      unread,
      unseen_failures: unseenFailures,
    };
  }

  onSummaryChange(listener: () => void): () => void {
    this.summaryListeners.add(listener);
    return () => this.summaryListeners.delete(listener);
  }

  private summaryChanged(): void {
    for (const listener of this.summaryListeners) listener();
  }

  /** The event a reply answers, as the UI shows it: its source and summary, not its payload. */
  private triggerOf(seq: number): Trigger | undefined {
    const row = this.db.prepare("SELECT source, summary FROM events WHERE seq = ?").get(seq) as Trigger | undefined;
    return row === undefined ? undefined : { source: row.source, summary: row.summary };
  }

  /**
   * Newest first. `before` is the cursor a page gave for the next, older one;
   * the last page gives none.
   */
  page(before?: string, limit = DEFAULT_PAGE): HistoryResponse {
    let below = Number.MAX_SAFE_INTEGER;
    if (before !== undefined) {
      below = Number(before);
      if (!/^\d+$/.test(before) || !Number.isSafeInteger(below)) throw new Error("before is not a cursor of the history");
    }
    const rows = this.db
      .prepare(
        `SELECT h.row, h.id, h.kind, h.agent, h.at, h.text, h.expression, h.files, h.turn_id, e.source AS trigger_source, e.summary AS trigger_summary
           FROM history h LEFT JOIN events e ON e.seq = h.in_reply_to
          WHERE h.row < ? ORDER BY h.row DESC LIMIT ?`,
      )
      .all(below, limit + 1) as Row[];
    const more = rows.length > limit;
    const entries = rows.slice(0, limit);
    const images = this.assets?.ofMessages(entries.map((row) => row.id)) ?? new Map<string, ReplyImage[]>();
    return { entries: entries.map((row) => entry(row, images.get(row.id))), ...(more ? { before: String(entries.at(-1)!.row) } : {}) };
  }

  /**
   * Keeps the blocks and sends each down the feed. A turn's start sets the
   * agent thinking and its end waiting.
   */
  activities(agent: AgentId, activities: readonly Activity[]): void {
    const insert = this.db.prepare("INSERT INTO activities (agent, turn_id, kind, at, body) VALUES (?, ?, ?, ?, ?)");
    for (const activity of activities) {
      insert.run(agent, activity.turn_id, activity.kind, activity.at, JSON.stringify(activity));
      if (activity.kind === "turn_start") this.feed.publish({ event: "state", data: { agent, state: "thinking" } });
      this.feed.publish({ event: "activity", data: { agent, activity } });
      if (activity.kind === "turn_end") this.feed.publish({ event: "state", data: { agent, state: "waiting" } });
      if (agent === "main" && this.main.accept(activity)) this.summaryChanged();
    }
  }

  /** The turn is over: the agent waits for events again. */
  turnEnded(agent: AgentId, turnId?: string): void {
    this.feed.publish({ event: "state", data: { agent, state: "waiting" } });
    if (agent === "main" && this.main.end(turnId)) this.summaryChanged();
  }

  /**
   * Whether the agent is in a turn, and since when: its last turn_start
   * (thinking) or turn_end (waiting) in the record, at that block's time.
   * Waiting, with no time, when it has had no turn.
   */
  stateOf(agent: AgentId): { state: AgentState; since?: string } {
    const row = this.db
      .prepare("SELECT kind, at FROM activities WHERE agent = ? AND kind IN ('turn_start', 'turn_end') ORDER BY row DESC LIMIT 1")
      .get(agent) as { kind: "turn_start" | "turn_end"; at: string } | undefined;
    if (row === undefined) return { state: "waiting" };
    return { state: row.kind === "turn_start" ? "thinking" : "waiting", since: row.at };
  }
}

function entry(row: Row, images: ReplyImage[] | undefined): HistoryEntry {
  if (row.kind === "owner") {
    return { kind: "owner", id: row.id, at: row.at, text: row.text, ...ownerFiles(images ?? [], row.files === null ? [] : (JSON.parse(row.files) as OwnerFile[])) };
  }
  return {
    kind: "agent",
    id: row.id,
    at: row.at,
    text: row.text,
    agent: row.agent ?? "main",
    ...(row.expression === null ? {} : { expression: row.expression }),
    ...(row.trigger_source === null || row.trigger_summary === null ? {} : { trigger: { source: row.trigger_source, summary: row.trigger_summary } }),
    ...(row.turn_id === null ? {} : { turn_id: row.turn_id }),
    ...(images === undefined ? {} : { images }),
  };
}

function kept(stored: readonly StoredImage[]): ReplyImage[] {
  return stored.map(({ id, mime_type, size, name }) => ({ id, mime_type, size, name }));
}

/** The lists of an owner's message, each left out when it is empty. */
function ownerFiles(images: ReplyImage[], files: OwnerFile[]): OwnerFiles {
  return { ...(images.length === 0 ? {} : { images }), ...(files.length === 0 ? {} : { files }) };
}
