import type { DatabaseSync } from "node:sqlite";

import { sendEmpty, type Handler } from "./http.ts";
import type { Sleepiness } from "./sleepiness.ts";

const SEVEN_DAYS_MS = 7 * 86_400_000;

export function metricsHandler(db: DatabaseSync, sleepiness: Sleepiness, now: () => number): Handler {
  const lastCompletion = db.prepare("SELECT MAX(completed_ms) AS completed FROM sleeps");
  const requests = db.prepare(`
    SELECT count(*) FILTER (WHERE requested_by = 'agent') AS agent,
           count(*) FILTER (WHERE requested_by = 'safety_net') AS safety_net
    FROM sleeps WHERE requested_ms > ?
  `);

  return async (request, response) => {
    if (request.url !== "/metrics") return sendEmpty(response, 404);
    if (request.method !== "GET") return sendEmpty(response, 405, { allow: "GET" });

    const at = now();
    const { sleep, sleepiness: value, awake_seconds, context } = sleepiness.status(at);
    const { completed } = lastCompletion.get() as { completed: number | null };
    const { agent, safety_net } = requests.get(at - SEVEN_DAYS_MS) as { agent: number; safety_net: number };
    const body = [
      "# TYPE penelope_sleep_last_completed_timestamp_seconds gauge",
      `penelope_sleep_last_completed_timestamp_seconds ${(completed ?? 0) / 1_000}`,
      "# TYPE penelope_sleepiness gauge",
      `penelope_sleepiness ${value}`,
      "# TYPE penelope_awake_seconds gauge",
      `penelope_awake_seconds ${awake_seconds}`,
      ...(context === undefined ? [] : [
        "# TYPE penelope_context_tokens gauge",
        `penelope_context_tokens ${context.tokens}`,
        "# TYPE penelope_context_window_tokens gauge",
        `penelope_context_window_tokens ${context.context_window}`,
      ]),
      "# TYPE penelope_sleep_state gauge",
      ...(["awake", "falling_asleep", "asleep"] as const).map((state) => `penelope_sleep_state{state="${state}"} ${Number(state === sleep.state)}`),
      "# TYPE penelope_sleep_wake_timestamp_seconds gauge",
      `penelope_sleep_wake_timestamp_seconds ${sleep.state === "awake" ? 0 : Date.parse(sleep.wake_at) / 1_000}`,
      "# TYPE penelope_sleep_requests_7d gauge",
      `penelope_sleep_requests_7d{requested_by="agent"} ${agent}`,
      `penelope_sleep_requests_7d{requested_by="safety_net"} ${safety_net}`,
      "",
    ].join("\n");
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  };
}
