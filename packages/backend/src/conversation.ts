import type { DatabaseSync } from "node:sqlite";

import type { Activity, AgentId, AgentState } from "@penelope/contract";

export class Conversation {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
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
