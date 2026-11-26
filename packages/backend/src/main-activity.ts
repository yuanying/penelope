// The main agent's live state for the list, without retaining thoughts or tool output.
import type { DatabaseSync } from "node:sqlite";

import type { Activity, SummaryState } from "@penelope/contract";

export class MainActivity {
  private turn: string | undefined;
  private readonly tools = new Map<string, string>();

  constructor(db: DatabaseSync) {
    // A backend restart need not stop a turn that the runner is still running.
    const last = db.prepare(
      `SELECT a.kind, a.turn_id, t.ended_at, t.result FROM activities a
         LEFT JOIN turns t ON t.turn_id = a.turn_id
        WHERE a.agent = 'main' AND a.kind IN ('turn_start', 'turn_end') ORDER BY a.row DESC LIMIT 1`,
    ).get() as { kind: string; turn_id: string; ended_at: string | null; result: string | null } | undefined;
    if (last?.kind !== "turn_start" || last.ended_at !== null || last.result !== null) return;
    this.turn = last.turn_id;
    const blocks = db.prepare(
      `SELECT CASE WHEN kind = 'tool_result' THEN json_extract(body, '$.call_id') END AS done,
              CASE WHEN kind = 'tool_call' THEN body END AS call
         FROM activities WHERE turn_id = ? AND agent = 'main' AND kind IN ('tool_call', 'tool_result') ORDER BY row`,
    ).iterate(last.turn_id) as Iterable<{ done: string | null; call: string | null }>;
    for (const { done, call } of blocks) {
      if (done !== null) this.tools.delete(done);
      if (call !== null) this.accept(JSON.parse(call) as Activity);
    }
  }

  /** True when the block can change the list's state. */
  accept(activity: Activity): boolean {
    if (activity.kind === "turn_start") {
      this.turn = activity.turn_id;
      this.tools.clear();
      return true;
    }
    if (activity.turn_id !== this.turn) return false;
    if (activity.kind === "turn_end") return this.end(activity.turn_id);
    if (activity.kind === "tool_call") {
      const { name, arguments: args, call_id } = activity;
      const fields = args as { command?: unknown; pattern?: unknown; path?: unknown } | null;
      const detail = [args, fields?.command, fields?.pattern, fields?.path].find((value) => typeof value === "string");
      this.tools.set(call_id, preview(detail === undefined ? name : `${name}: ${detail}`));
      return true;
    }
    return activity.kind === "tool_result" && this.tools.delete(activity.call_id);
  }

  end(turn: string | undefined): boolean {
    if (this.turn === undefined || (turn !== undefined && turn !== this.turn)) return false;
    this.turn = undefined;
    this.tools.clear();
    return true;
  }

  state(): SummaryState {
    if (this.turn === undefined) return { kind: "waiting" };
    const tool = [...this.tools.values()].at(-1);
    return tool === undefined ? { kind: "thinking" } : { kind: "tool", tool };
  }
}

/** The first line of a message or call, bounded in Unicode code points. */
export function preview(text: string): string {
  let count = 0;
  let head = "";
  for (const ch of text) {
    if (ch === "\r" || ch === "\n") break;
    if (++count > 200) return `${head.trimEnd()}…`;
    head += ch;
  }
  return head.trim();
}
