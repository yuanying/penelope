import type { DatabaseSync } from "node:sqlite";

import type { AgentStatus, ContextUsage } from "@penelope/contract";

import { latestSleep } from "./sleep.ts";
import { iso } from "./time.ts";

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
    db.prepare("INSERT OR IGNORE INTO sleepiness (singleton, awake_since_ms, peak) VALUES (1, ?, 0)").run(now());
  }

  status(now = this.now()): AgentStatus {
    const state = this.state();
    const context = state.tokens === null || state.context_window === null
      ? undefined
      : { tokens: state.tokens, context_window: state.context_window };
    const last = latestSleep(this.db);
    const asleep = last?.woken_ms === null;
    const awakeSince = (asleep ? this.lastWake() : last?.woken_ms) ?? state.awake_since_ms;
    const status = measure(
      state.peak, (asleep ? last.requested_ms : now) - awakeSince, context,
      asleep ? { state: last.completed_ms === null ? "falling_asleep" : "asleep", wake_at: iso(last.wake_ms) } : { state: "awake" },
    );
    if (status.sleepiness > state.peak) {
      this.db.prepare("UPDATE sleepiness SET peak = ? WHERE singleton = 1").run(status.sleepiness);
    }
    return status;
  }

  turnEnded(context: ContextUsage | undefined): void {
    const last = latestSleep(this.db);
    if (last?.woken_ms === null) return;
    const state = this.state();
    const { sleepiness } = measure(state.peak, this.now() - (last?.woken_ms ?? state.awake_since_ms), context, { state: "awake" });
    this.db.prepare("UPDATE sleepiness SET peak = ?, tokens = ?, context_window = ? WHERE singleton = 1")
      .run(sleepiness, context?.tokens ?? null, context?.context_window ?? null);
  }

  reset(): void {
    this.db.prepare("UPDATE sleepiness SET peak = 0, tokens = NULL, context_window = NULL WHERE singleton = 1").run();
  }

  private lastWake(): number | undefined {
    const row = this.db.prepare("SELECT woken_ms FROM sleeps WHERE woken_ms IS NOT NULL ORDER BY control_seq DESC LIMIT 1").get() as
      | { woken_ms: number }
      | undefined;
    return row?.woken_ms;
  }

  private state(): State {
    return this.db.prepare("SELECT awake_since_ms, peak, tokens, context_window FROM sleepiness WHERE singleton = 1").get() as State;
  }
}

function measure(peak: number, awakeMs: number, context: ContextUsage | undefined, sleep: AgentStatus["sleep"]): AgentStatus {
  const awake_seconds = Math.max(0, Math.floor(awakeMs / 1000));
  const timePercent = 100 * awake_seconds / DAY_SECONDS;
  const contextPercent = context === undefined ? 0 : 100 * context.tokens / context.context_window;
  const sleepiness = Math.max(peak, Math.min(100, Math.floor(Math.max(timePercent, contextPercent))));
  return { sleep, sleepiness, awake_seconds, ...(context === undefined ? {} : { context }) };
}
