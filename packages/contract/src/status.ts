export type ContextUsage = {
  tokens: number;
  context_window: number;
};

export type AgentStatus = {
  sleepiness: number;
  awake_seconds: number;
  context?: ContextUsage;
};
