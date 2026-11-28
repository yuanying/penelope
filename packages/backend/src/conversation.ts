import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Activity, AgentId, AgentState, ReplyRequest } from "@penelope/contract";

import type { Assets, CheckedImage } from "./assets.ts";
import { transaction } from "./db.ts";
import { iso } from "./time.ts";

export class Conversation {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly assets: Assets | undefined;

  /** Without `assets`, a reply carries no images. */
  constructor(db: DatabaseSync, { now, assets }: { now: () => number; assets?: Assets }) {
    this.db = db;
    this.now = now;
    this.assets = assets;
  }

  /** Stores a legacy runner's reply and its image copies in one transaction. */
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
    return { id };
  }

  activities(agent: AgentId, activities: readonly Activity[]): void {
    const insert = this.db.prepare("INSERT INTO activities (agent, turn_id, kind, at, body) VALUES (?, ?, ?, ?, ?)");
    for (const activity of activities) {
      insert.run(agent, activity.turn_id, activity.kind, activity.at, JSON.stringify(activity));
    }
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
