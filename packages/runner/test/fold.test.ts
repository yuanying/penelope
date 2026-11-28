import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeContext, type JsonObject, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { convertToLlm, type ContextEvent } from "@earendil-works/pi-coding-agent";

import { FOLD_ASK, foldTurns, TURN_END } from "../src/fold.ts";

type AgentMessage = ContextEvent["messages"][number];

let clock = 1;

const user = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: clock++ });

const marker = (): AgentMessage => ({ role: "custom", customType: TURN_END, content: "", display: false, timestamp: clock++ });

const ask = (): AgentMessage => ({
  role: "custom",
  customType: FOLD_ASK,
  content: "This turn is about to be folded.",
  display: false,
  timestamp: clock++,
});

type Block =
  | { type: "text"; text: string; textSignature?: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string }
  | { type: "toolCall"; id: string; name: string; arguments: JsonObject };

const assistant = (...content: Block[]): Extract<AgentMessage, { role: "assistant" }> =>
  ({
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "example",
    model: "example",
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: clock++,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

const result = (id: string, name: string, text: string, isError = false): AgentMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: clock++,
});

const call = (id: string, name: string, args: JsonObject): Block => ({ type: "toolCall", id, name, arguments: args });

/** A turn with thinking, the shell, a read, a reply and her text. */
function workingTurn(): AgentMessage[] {
  return [
    user("[seq 1] ui, 2026-11-14T09:00:00Z\nPods は元気？"),
    assistant(
      { type: "thinking", thinking: "look at the pods", thinkingSignature: "rs_1" },
      call("call_1|fc_1", "bash", { command: "kubectl get pods -n monitoring" }),
      call("call_2|fc_2", "read", { path: "/memory/cluster.md" }),
    ),
    result("call_1|fc_1", "bash", "NAME READY\nprometheus-0 1/1\n".repeat(50)),
    result("call_2|fc_2", "read", "# cluster\n"),
    assistant(
      { type: "thinking", thinking: "all fine", thinkingSignature: "rs_2" },
      { type: "text", text: "All pods are up.", textSignature: "msg_1" },
      call("call_3|fc_3", "reply", { text: "元気です", in_reply_to: 1 }),
    ),
    result("call_3|fc_3", "reply", "Sent (id r-1)."),
    assistant({ type: "text", text: "Replied." }),
  ];
}

const roles = (messages: AgentMessage[]) => messages.map((message) => message.role);

test("nothing is folded until a turn has ended; the markers never reach the model", () => {
  const turn = workingTurn();
  const { messages, folded } = foldTurns(turn);
  assert.equal(folded, 0);
  assert.deepEqual(messages, turn);

  const ended = [...turn, marker()];
  const after = foldTurns(ended);
  assert.equal(after.folded, 1);
  assert.ok(after.messages.every((message) => message.role !== "custom"));
});

test("an ended turn keeps the events, her text and her replies; thinking and tool output go", () => {
  const turn = workingTurn();
  const next = user("[seq 2] ui, 2026-11-14T10:00:00Z\nありがとう");
  const { messages, folded } = foldTurns([...turn, marker(), next]);
  assert.equal(folded, 1);
  assert.deepEqual(roles(messages), ["user", "assistant", "toolResult", "toolResult", "assistant", "toolResult", "assistant", "user"]);

  assert.deepEqual(messages[0], turn[0], "the event stays as it is");
  assert.deepEqual((messages[4] as { content: unknown }).content, [
    { type: "text", text: "All pods are up." },
    { type: "toolCall", id: "call_3", name: "reply", arguments: { text: "元気です", in_reply_to: 1 } },
  ]);
  const reply = messages[5] as { toolCallId: string; content: unknown };
  assert.equal(reply.toolCallId, "call_3");
  assert.deepEqual(reply.content, [{ type: "text", text: "Sent (id r-1)." }]);
  assert.deepEqual((messages[6] as { content: unknown }).content, [{ type: "text", text: "Replied." }]);
  assert.deepEqual(messages[7], next, "the turn now running is not folded");

  const text = JSON.stringify(messages);
  assert.ok(!text.includes("prometheus-0"), "no tool output is left");
  assert.ok(!text.includes("look at the pods"), "no thinking is left");
});

const providerCases = [
  {
    api: "openai-completions",
    expected: {
      messages: [
        { role: "assistant", tool_calls: [
          { type: "function", id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } },
          { type: "function", id: "call_2", function: { name: "folded", arguments: '{"tool":"read"}' } },
        ] },
        { role: "tool", tool_call_id: "call_1", content: "(output folded)" },
        { role: "tool", tool_call_id: "call_2", content: "(call and output folded)" },
      ],
    },
  },
  {
    api: "openai-responses",
    expected: {
      input: [
        { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
        { type: "function_call", call_id: "call_2", name: "folded", arguments: '{"tool":"read"}' },
        { type: "function_call_output", call_id: "call_1", output: "(output folded)" },
        { type: "function_call_output", call_id: "call_2", output: "(call and output folded)" },
      ],
    },
  },
  {
    api: "anthropic-messages",
    expected: {
      messages: [
        { role: "assistant", content: [
          { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "call_2", name: "folded", input: { tool: "read" } },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_1", content: "(output folded)" },
          { type: "tool_result", tool_use_id: "call_2", content: "(call and output folded)" },
        ] },
      ],
    },
  },
] as const;

for (const { api, expected } of providerCases) {
  test(`${api} receives folded calls and their matching results as tool messages`, async () => {
    const model = {
      provider: "example", id: "example", name: "Example", baseUrl: "https://example.com",
      reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } satisfies Omit<Model<typeof api>, "api">;
    const { messages } = foldTurns([
      user("go"),
      { ...assistant(call("call_1|fc_1", "bash", { command: "ls" }), call("call_2|fc_2", "read", { path: "x".repeat(200) })), api },
      result("call_1|fc_1", "bash", "original tool output"),
      result("call_2|fc_2", "read", "more output"),
      marker(),
      user("next"),
    ]);
    let body: unknown;
    const context = normalizeContext({ messages: convertToLlm(messages) });
    const options: SimpleStreamOptions = {
      apiKey: "test",
      maxRetries: 0,
      fetch: async (input, init) => {
        body = await new Request(input, init).json();
        return Response.json({ error: { message: "end of test" } }, { status: 400 });
      },
    };
    const stream = api === "openai-completions" ? completions({ ...model, api }, context, options)
      : api === "openai-responses" ? responses({ ...model, api }, context, options)
      : anthropic({ ...model, api }, context, options);
    const response = await stream.result();
    assert.ok(body, response.errorMessage);
    assert.partialDeepStrictEqual(body, expected);
  });
}

test("a call with arguments at the 200-code-point JSON limit keeps them intact", () => {
  const args = { command: "🌱".repeat(200 - JSON.stringify({ command: "" }).length) };
  const original = call("c1", "bash", args);
  const { messages } = foldTurns([assistant(original), result("c1", "bash", "ok"), marker()]);
  const [sent] = messages;
  assert.ok(sent?.role === "assistant");
  assert.deepEqual(sent.content, [original]);
});

test("a call above the JSON limit keeps an ID-matched placeholder pair", () => {
  const args = { command: "🌱".repeat(200 - JSON.stringify({ command: "" }).length) + "x" };
  const { messages } = foldTurns([
    assistant(call("call_1|fc_1", "bash", args)),
    result("call_1|fc_1", "bash", "ok"),
    marker(),
  ]);
  assert.partialDeepStrictEqual(messages, [
    { role: "assistant", content: [call("call_1", "folded", { tool: "bash" })] },
    { role: "toolResult", toolCallId: "call_1", toolName: "folded", content: [{ type: "text", text: "(call and output folded)" }] },
  ]);
});

test("the request before folding goes; her answer to it stays", () => {
  const { messages } = foldTurns([
    user("go"),
    assistant(call("c1", "bash", { command: "ls" })),
    result("c1", "bash", "a\nb"),
    assistant(),
    ask(),
    assistant({ type: "text", text: "ls shows a and b." }),
    marker(),
  ]);
  assert.deepEqual(roles(messages), ["user", "assistant", "toolResult", "assistant"]);
  assert.deepEqual((messages[3] as { content: unknown }).content, [{ type: "text", text: "ls shows a and b." }]);
});

test("a compaction summary passes as it is", () => {
  const summary: AgentMessage = { role: "compactionSummary", summary: "Earlier: pods checked.", tokensBefore: 1000, timestamp: clock++ };
  const { messages } = foldTurns([summary, assistant(call("c1", "bash", { command: "ls" })), result("c1", "bash", "a"), marker(), user("next")]);
  assert.deepEqual(messages[0], summary);
  assert.deepEqual(roles(messages), ["compactionSummary", "assistant", "toolResult", "user"]);
});

test("an ended turn keeps her answers to other agents whole, as it keeps her replies", () => {
  // Guards against: what she told an agent over A2A folded away, so that she forgets she answered it.
  const answer = call("call_9", "reply_to_agent", { in_reply_to: 7, state: "completed", text: "Two alerts, both resolved. ".repeat(10).trimEnd() });
  const { messages } = foldTurns([user("go"), assistant(answer), result("call_9", "reply_to_agent", "Sent: the task is completed."), marker()]);
  assert.deepEqual((messages[1] as { content: unknown }).content, [answer]);
  assert.deepEqual((messages[2] as { content: unknown }).content, [{ type: "text", text: "Sent: the task is completed." }]);
});

test("a reply that has no result is folded like any other call", () => {
  const { messages } = foldTurns([user("go"), assistant(call("c1", "reply", { text: "hi" })), marker()]);
  assert.partialDeepStrictEqual(messages.slice(1), [
    { role: "assistant", content: [call("c1", "reply", { text: "hi" })] },
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "(output folded)" }], isError: true },
  ]);
});

test("folding the next turn leaves what was folded before as it was", () => {
  const first = [...workingTurn(), marker()];
  const second = [user("[seq 2] ui\nもう一度"), assistant(call("c9", "bash", { command: "date" })), result("c9", "bash", "today"), assistant({ type: "text", text: "Done." })];
  const once = foldTurns([...first, ...second]).messages;
  const twice = foldTurns([...first, ...second, marker(), user("[seq 3] ui\nnext")]).messages;
  assert.deepEqual(twice.slice(0, once.length - second.length), once.slice(0, once.length - second.length));
  assert.deepEqual(twice.slice(0, once.length - second.length + 1).at(-1), second[0]);
});

test("the same messages fold the same way", () => {
  const messages = [...workingTurn(), marker(), user("next")];
  assert.deepEqual(foldTurns(messages), foldTurns(messages));
});
