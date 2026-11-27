export type ContextUsage = {
  tokens: number;
  context_window: number;
};

export type SleepStatus = { state: "awake" } | { state: "falling_asleep" | "asleep"; wake_at: string };

export const MOOD_MAX_LENGTH = 160;

export type AgentStatus = {
  mood: string | null;
  sleep: SleepStatus;
  sleepiness: number;
  awake_seconds: number;
  context?: ContextUsage;
};
