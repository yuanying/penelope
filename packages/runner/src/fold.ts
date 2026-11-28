// Folding the turns that have ended (ADR-0015). The session records every turn
// whole; what the model is sent has each ended turn cut down to the events,
// her own text and her replies, with other tool calls paired with placeholder
// results. The fold is made afresh before every model call from the messages
// alone, so the same messages always fold the same way, and the part before
// the turn just ended stays as it was sent.
//
// Where a turn ends is marked in the session by a custom message the runner
// appends when the turn is over. The markers never reach the model, folding
// on or off.

import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { ANSWER_REMINDER } from "./answer-reminder.ts";

type AgentMessage = ContextEvent["messages"][number];
type Assistant = Extract<AgentMessage, { role: "assistant" }>;
type Block = Assistant["content"][number];
type ToolCall = Extract<Block, { type: "toolCall" }>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

/** The custom message that marks the end of a turn. It has no content. */
export const TURN_END = "penelope.turn_end";
/** The custom message that asks, before a turn is folded, for what she wants to keep. */
export const FOLD_ASK = "penelope.fold_ask";
/** The calls kept whole, with their results: what reached her owner, or an agent she answered over A2A. */
export const KEPT_TOOLS = new Set(["reply", "reply_to_agent"]);
const CALL_MAX_CHARS = 200;
const FOLDED_OUTPUT = "(output folded)";
const FOLDED_CALL_AND_OUTPUT = "(call and output folded)";
/** What a call refused while the fold request is answered gets back. */
export const NO_TOOLS = "No tool runs while the turn is being folded.";

const isCustom = (message: AgentMessage, type: string) =>
  message.role === "custom" && (message as { customType?: string }).customType === type;

/**
 * The messages as the model is sent them, and how many ended turns were
 * folded. A turn has ended at its marker; what comes after the last marker is
 * the turn now running, and is sent as it is.
 */
export function foldTurns(messages: readonly AgentMessage[]): { messages: AgentMessage[]; folded: number } {
  const out: AgentMessage[] = [];
  let folded = 0;
  let start = 0;
  messages.forEach((message, index) => {
    if (!isCustom(message, TURN_END)) return;
    const turn = messages.slice(start, index);
    if (turn.length > 0) {
      out.push(...foldTurn(turn));
      folded++;
    }
    start = index + 1;
  });
  out.push(...messages.slice(start).filter((message) => !isCustom(message, TURN_END)));
  return { messages: out, folded };
}

/** The messages with only the markers taken out: what is sent while folding is off. */
export function withoutMarkers(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => !isCustom(message, TURN_END));
}

function foldTurn(turn: AgentMessage[]): AgentMessage[] {
  const results = new Map<string, ToolResult>();
  for (const message of turn) if (message.role === "toolResult") results.set(message.toolCallId, message);
  const out: AgentMessage[] = [];
  for (const message of turn) {
    if (message.role === "toolResult" || isCustom(message, FOLD_ASK) || isCustom(message, ANSWER_REMINDER)) continue;
    if (message.role !== "assistant") {
      out.push(message);
      continue;
    }
    // Pi drops incomplete assistant messages on replay, so their results must not be sent either.
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const content: Block[] = [];
    const toolResults: ToolResult[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) content.push({ type: "text", text: block.text });
      if (block.type !== "toolCall") continue;
      const result = results.get(block.id);
      const id = callId(block.id);
      const keep = result !== undefined && KEPT_TOOLS.has(block.name);
      const args = block.arguments ?? {};
      const foldCall = !keep && exceedsCallLimit(args);
      const name = foldCall ? "folded" : block.name;
      content.push({
        type: "toolCall", id, name,
        arguments: foldCall ? { tool: block.name } : args,
        ...(foldCall || block.namespace === undefined ? {} : { namespace: block.namespace }),
      });
      if (keep) {
        toolResults.push({ ...result, toolCallId: id, content: [{ type: "text", text: cut(textOf(result.content)) }] });
      } else {
        toolResults.push({
          role: "toolResult", toolCallId: id, toolName: name,
          content: [{ type: "text", text: foldCall ? FOLDED_CALL_AND_OUTPUT : FOLDED_OUTPUT }],
          timestamp: result?.timestamp ?? message.timestamp,
          isError: result?.isError ?? true,
        });
      }
    }
    if (content.length > 0) out.push({ ...message, content }, ...toolResults);
  }
  return out;
}

function exceedsCallLimit(args: ToolCall["arguments"]): boolean {
  let length = 0;
  for (const _ of JSON.stringify(args)) {
    if (++length > CALL_MAX_CHARS) return true;
  }
  return false;
}

/** On one line, and no longer than the limit, with a mark where it was cut. */
function cut(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  const characters = [...line];
  return characters.length <= CALL_MAX_CHARS ? line : `${characters.slice(0, CALL_MAX_CHARS - 1).join("")}…`;
}

const callId = (id: string) => id.split("|")[0]!;

function textOf(content: ToolResult["content"]): string {
  return content.map((part) => (part.type === "text" ? part.text : `[${part.mimeType}]`)).join("\n");
}

/** What the extension asks the runner, before every model call and every tool call. */
export interface FoldState {
  /** Whether ended turns are folded. */
  folding(): boolean;
  /** Whether the model is answering the request before folding, when no tool runs. */
  asking(): boolean;
  /** How many ended turns the context of a model call had folded. */
  folded(count: number): void;
}

/** The fold and the refusal, as the extension the runner gives Pi. */
export function foldExtension(state: FoldState): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      if (!state.folding()) return { messages: withoutMarkers(event.messages) };
      const { messages, folded } = foldTurns(event.messages);
      state.folded(folded);
      return { messages };
    });
    pi.on("tool_call", () => (state.asking() ? { block: true, reason: NO_TOOLS, terminate: true } : undefined));
  };
}
