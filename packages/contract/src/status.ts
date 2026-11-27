export type ContextUsage = {
  tokens: number;
  context_window: number;
};

export type SleepStatus = { state: "awake" } | { state: "falling_asleep" | "asleep"; wake_at: string };

export type AgentStatus = {
  sleep: SleepStatus;
  sleepiness: number;
  awake_seconds: number;
  context?: ContextUsage;
};
