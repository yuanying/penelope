// ADR-0060: an answer route is a hint. Observe attempts without executing the
// route, interpreting shell syntax, or checking the result or destination.
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AnswerVia, DeliveredEvent } from "@penelope/contract";

export const ANSWER_REMINDER = "penelope.answer_reminder";

type Target = Pick<DeliveredEvent, "seq" | "source"> & { answer_via: AnswerVia };
type Attempt = { name: string; command?: string };

function matches(attempt: Attempt, route: AnswerVia): boolean {
  if (route.tool !== undefined) return attempt.name === route.tool;
  if (attempt.command === undefined) return false;
  // Match command words even after a pipe or another shell separator. Err
  // toward counting an attempt (e.g. in a comment), not prompting a resend.
  const prefix = route.command.trim().split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\S\\n]+");
  return new RegExp(`(?:^|[\\s|&;()])${prefix}(?=$|[\\s|&;()<>])`).test(attempt.command);
}

export class AnswerReminder {
  private readonly pending = new Map<string, Target[]>();
  private readonly delivered: Target[] = [];
  private readonly attempts: Attempt[] = [];
  private finalText = false;

  /** Track only our input blocks, and count them only after Pi takes them from its queue. */
  input(block: string, events: readonly DeliveredEvent[]): void {
    const targets = events.flatMap(({ seq, source, answer_via }) => answer_via === undefined ? [] : [{ seq, source, answer_via }]);
    if (targets.length) this.pending.set(block, targets);
  }

  observe(event: AgentSessionEvent): void {
    if (event.type === "message_start" && event.message.role === "user") {
      const { content } = event.message;
      const text = typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      for (const [block, targets] of this.pending) {
        // Pi can append image hints, and the runner can join queued inputs.
        if (text.includes(block)) {
          this.delivered.push(...targets);
          this.pending.delete(block);
        }
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      this.finalText = event.message.content.some((part) => part.type === "text" && part.text.trim() !== "");
    } else if (event.type === "tool_execution_start") {
      const name = event.toolName;
      const args = event.args as { command?: unknown } | null;
      const command = (name === "bash" || name === "job_start") && typeof args?.command === "string" ? args.command : undefined;
      this.attempts.push({ name, ...(command === undefined ? {} : { command }) });
    }
  }

  notice(): string | undefined {
    if (this.delivered.length === 0 || !this.finalText || this.attempted()) return undefined;
    return `Runner note: No send attempt was seen via the answer_via routes for these events: ${JSON.stringify(this.events())}. Your turn text was not delivered as a reply. In this continuation, you can send a reply via the indicated route or finish without sending.`;
  }

  private events(): { seq: number; source: string }[] {
    return this.delivered.map(({ seq, source }) => ({ seq, source }));
  }

  private attempted(attempts = this.attempts): boolean {
    return this.delivered.some(({ answer_via }) => attempts.some((attempt) => matches(attempt, answer_via)));
  }

  get toolCalls(): number { return this.attempts.length; }

  result(since: number, result: "done" | "failed" | "stopped"): string {
    const attempts = this.attempts.slice(since);
    return `answer reminder: ${JSON.stringify({ events: this.events(), attempted: this.attempted(attempts), tool_calls: attempts.length, result })}`;
  }
}
