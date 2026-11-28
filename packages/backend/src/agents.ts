import type { DatabaseSync } from "node:sqlite";

import type { SubAgentStatus } from "@penelope/contract";

import { iso } from "./time.ts";

export class SubAgents {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, { now }: { now: () => number }) {
    this.db = db;
    this.now = now;
  }

  record(status: SubAgentStatus): void {
    const at = iso(this.now());
    this.db
      .prepare(
        `INSERT INTO sub_agents (agent, purpose, closed, started_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent) DO UPDATE SET purpose = excluded.purpose, closed = excluded.closed,
           started_at = coalesce(started_at, excluded.started_at), updated_at = excluded.updated_at`,
      )
      .run(status.agent, status.purpose, status.closed ? 1 : 0, status.closed ? null : at, at);
  }
}
