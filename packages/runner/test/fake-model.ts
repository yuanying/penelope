// A model that answers from a script, so that the tests run Pi's real session
// and tools without any network. It is registered as its own provider in a
// ModelRuntime, the same way a deployment registers a real one.

import { join } from "node:path";

import { getSystemMessageText, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, AssistantMessageEvent, JsonObject, Message, SystemMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** One answer of the model: hidden thinking, visible text, then tool calls. */
export interface Answer {
  thinking?: string;
  text?: string;
  tokens?: number;
  calls?: { tool: string; args: Record<string, unknown> }[];
  /** The request fails with this message, as when the model's API answers with an error. */
  error?: string;
}

/** What the model was given for one call. */
export interface Call {
  modelId: string;
  reasoning: string | undefined;
  systemPrompt: string;
  /** The text of every user message so far, in order. */
  userTexts: string[];
  /** The role of the last message: `user` for a new input, `toolResult` after a tool ran. */
  lastRole: string;
  /** The text of the last message. */
  lastText: string;
  /** The mime types of the images in the last message. */
  lastImages: string[];
  /** Every message but the system prompt, as the provider was given them. */
  messages: Message[];
  /** The names of the tools the model was given. */
  tools: string[];
}

/** Decides each answer from the call. Called once per model request. */
export type Script = (call: Call) => Answer | Promise<Answer>;

export const PROVIDER = "fake";
export const MODEL = "scripted";
export const OTHER_MODEL = "org/other";

let counter = 0;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: { type: string }) => part.type === "text")
    .map((part: { text: string }) => part.text)
    .join("");
}

function userTexts(messages: Message[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") {
      texts.push(message.content);
      continue;
    }
    texts.push(
      message.content
        .filter((part) => part.type === "text")
        .map((part) => (part as { text: string }).text)
        .join(""),
    );
  }
  return texts;
}

/** The tools the system messages declare, replayed in order. */
function toolsOf(system: SystemMessage[]): string[] {
  const tools = new Set<string>();
  for (const message of system) {
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return [...tools].sort();
}

/** A runtime with the scripted model in it, under a directory of its own. */
export async function fakeRuntime(root: string, script: Script): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider(PROVIDER, {
    name: "Scripted model",
    baseUrl: "http://127.0.0.1:9",
    api: "openai-completions",
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const push = (event: AssistantMessageEvent) => stream.push(event);
      void (async () => {
        if (options?.signal?.aborted) {
          message.stopReason = "aborted";
          push({ type: "error", reason: "aborted", error: message });
          return;
        }
        const system = context.messages.filter((m) => m.role === "system") as SystemMessage[];
        const rest = context.messages.filter((m) => m.role !== "system");
        const last = rest.at(-1);
        const call = script({
          modelId: model.id,
          reasoning: options?.reasoning,
          systemPrompt: system.map((m) => getSystemMessageText(m)).join("\n"),
          userTexts: userTexts(rest),
          lastRole: last?.role ?? "",
          lastText: textOf(last?.content),
          lastImages: Array.isArray(last?.content)
            ? (last.content as { type: string; mimeType?: string }[])
                .filter((part) => part.type === "image")
                .map((part) => part.mimeType ?? "")
            : [],
          messages: structuredClone(rest),
          tools: toolsOf(system),
        });
        // A request cancelled while the script is still deciding ends as Pi's own aborted ones do.
        const answer = await new Promise<Answer | undefined>((resolve, reject) => {
          options?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
          Promise.resolve(call).then(resolve, reject);
        });
        if (!answer) {
          message.stopReason = "aborted";
          push({ type: "error", reason: "aborted", error: message });
          return;
        }
        if (answer.error) {
          message.stopReason = "error";
          message.errorMessage = answer.error;
          push({ type: "error", reason: "error", error: message });
          return;
        }
        message.usage.totalTokens = answer.tokens ?? 0;
        push({ type: "start", partial: message });
        if (answer.thinking) {
          const index = message.content.length;
          message.content.push({ type: "thinking", thinking: answer.thinking });
          push({ type: "thinking_start", contentIndex: index, partial: message });
          push({ type: "thinking_delta", contentIndex: index, delta: answer.thinking, partial: message });
          push({ type: "thinking_end", contentIndex: index, content: answer.thinking, partial: message });
        }
        if (answer.text) {
          const index = message.content.length;
          message.content.push({ type: "text", text: answer.text });
          push({ type: "text_start", contentIndex: index, partial: message });
          push({ type: "text_delta", contentIndex: index, delta: answer.text, partial: message });
          push({ type: "text_end", contentIndex: index, content: answer.text, partial: message });
        }
        for (const call of answer.calls ?? []) {
          const index = message.content.length;
          const toolCall = {
            type: "toolCall" as const,
            id: `call-${++counter}`,
            name: call.tool,
            arguments: call.args as JsonObject,
          };
          message.content.push(toolCall);
          push({ type: "toolcall_start", contentIndex: index, partial: message });
          push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
        }
        const reason = (answer.calls ?? []).length > 0 ? "toolUse" : "stop";
        message.stopReason = reason;
        push({ type: "done", reason, message });
      })();
      return stream;
    },
    models: [MODEL, OTHER_MODEL].map((id) => ({
        id,
        name: id,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
    })),
  });
  await runtime.setRuntimeApiKey(PROVIDER, "unused");
  return runtime;
}
