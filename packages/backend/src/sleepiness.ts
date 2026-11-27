import type { DatabaseSync } from "node:sqlite";

import type { AgentStatus, ContextUsage } from "@penelope/contract";

const DAY_SECONDS = 86_400;

type State = {
  awake_since_ms: number;
  peak: number;
  tokens: number | null;
  context_window: number | null;
};

export class Sleepiness {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
    const rotation = db.prepare(`
      SELECT at, seq FROM session_rotations WHERE agent = 'main'
        AND (stages IS NULL OR json_extract(stages, '$.session.result') = 'done')
      ORDER BY at DESC, row DESC LIMIT 1
    `).get() as { at: string; seq: number | null } | undefined;
    db.prepare("INSERT OR IGNORE INTO sleepiness VALUES (1, ?, ?, 0, NULL, NULL)")
      .run(rotation ? Date.parse(rotation.at) : now(), rotation?.seq ?? null);
  }

  status(now = this.now()): AgentStatus {
    const state = this.state();
    const context = state.tokens === null || state.context_window === null
      ? undefined
      : { tokens: state.tokens, context_window: state.context_window };
    const status = measure(state, now, context);
    if (status.sleepiness > state.peak) {
      this.db.prepare("UPDATE sleepiness SET peak = ? WHERE singleton = 1").run(status.sleepiness);
    }
    return status;
  }

  turnEnded(context: ContextUsage | undefined): void {
    const status = measure(this.state(), this.now(), context);
    this.db.prepare("UPDATE sleepiness SET peak = ?, tokens = ?, context_window = ? WHERE singleton = 1")
      .run(status.sleepiness, context?.tokens ?? null, context?.context_window ?? null);
  }

  rotated(seq: number | undefined): void {
    this.db.prepare(`
      UPDATE sleepiness SET awake_since_ms = ?, rotation_seq = coalesce(?, rotation_seq),
        peak = 0, tokens = NULL, context_window = NULL
      WHERE singleton = 1 AND (? IS NULL OR rotation_seq IS NULL OR rotation_seq < ?)
    `).run(this.now(), seq ?? null, seq ?? null, seq ?? null);
  }

  private state(): State {
    return this.db.prepare("SELECT awake_since_ms, peak, tokens, context_window FROM sleepiness WHERE singleton = 1").get() as State;
  }
}

function measure(state: State, now: number, context: ContextUsage | undefined): AgentStatus {
  const awake_seconds = Math.max(0, Math.floor((now - state.awake_since_ms) / 1000));
  const timePercent = 100 * awake_seconds / DAY_SECONDS;
  const contextPercent = context === undefined ? 0 : 100 * context.tokens / context.context_window;
  const sleepiness = Math.max(state.peak, Math.min(100, Math.floor(Math.max(timePercent, contextPercent))));
  return { sleepiness, awake_seconds, ...(context === undefined ? {} : { context }) };
}
