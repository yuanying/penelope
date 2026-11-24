// Folding the turns that have ended (ADR-0015). The session records every turn
// whole; what the model is sent has each ended turn cut down to the events,
// her own text and her replies, with every other tool call left as one short
// line and no thinking or tool output. The fold is made afresh before every
// model call from the messages alone, so the same messages always fold the
// same way, and the part before the turn just ended stays as it was sent.
//
// Where a turn ends is marked in the session by a custom message the runner
// appends when the turn is over. The markers never reach the model, folding
// on or off.

import type { ContextEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];
type Assistant = Extract<AgentMessage, { role: "assistant" }>;
type Block = Assistant["content"][number];
type ToolCall = Extract<Block, { type: "toolCall" }>;
type ToolResult = Extract<AgentMessage, { role: "toolResult" }>;

import { ANSWER_REMINDER } from "./answer-reminder.ts";

/** The custom message that marks the end of a turn. It has no content. */
export const TURN_END = "penelope.turn_end";
/** The custom message that asks, before a turn is folded, for what she wants to keep. */
export const FOLD_ASK = "penelope.fold_ask";
/** The calls kept whole, with their results: what reached her owner, or an agent she answered over A2A. */
export const KEPT_TOOLS = new Set(["reply", "reply_to_agent"]);
/** The longest a folded call, or a kept call's result, is in characters. */
export const CALL_MAX_CHARS = 200;
/** Stands before the folded calls of one answer. */
export const FOLDED = "(folded) ";
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
    const text: Block[] = [];
    const lines: string[] = [];
    const kept: ToolCall[] = [];
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) text.push({ type: "text", text: block.text });
      if (block.type !== "toolCall") continue;
      if (KEPT_TOOLS.has(block.name) && results.has(block.id)) kept.push(block);
      else lines.push(callLine(block));
    }
    const content: Block[] = [...text];
    if (lines.length > 0) content.push({ type: "text", text: `${FOLDED}${lines.join(" | ")}` });
    // The thinking a call was paired with is gone; an ID that names the pairing keeps only the call's own part.
    content.push(...kept.map((block) => ({ ...block, id: callId(block.id) })));
    if (content.length === 0) continue;
    out.push({ ...message, content });
    for (const block of kept) {
      const result = results.get(block.id)!;
      out.push({ ...result, toolCallId: callId(result.toolCallId), content: [{ type: "text", text: cut(textOf(result.content)) }] });
    }
  }
  return out;
}

/** One call as a short line: its command, or what it searched and where, or its path, or its arguments. */
function callLine(call: ToolCall): string {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
  const command = str("command");
  const pattern = str("pattern");
  const path = str("path");
  let what: string;
  if (command !== undefined) what = command;
  else if (pattern !== undefined) what = path !== undefined ? `${pattern} in ${path}` : pattern;
  else if (path !== undefined) what = path;
  else what = JSON.stringify(args);
  return cut(`${call.name}: ${what}`);
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
