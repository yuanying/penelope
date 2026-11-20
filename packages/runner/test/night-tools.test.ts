import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { nightTools } from "../src/night-tools.ts";

async function workspace(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "night-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { memoryDir: join(root, "memory"), sourcesDir: join(root, "sources"), sessionDir: join(root, "main"), subAgentDir: join(root, "agents") };
  await Promise.all(Object.values(config).map((dir) => mkdir(dir)));
  return config;
}

async function invoke(tools: ToolDefinition[], name: string, args: object): Promise<string> {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing ${name}`);
  const result = await tool.execute("test", args, undefined, undefined, {} as ExtensionToolContext);
  return result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}

test("a verifier can page to the end of a long tool result on a single transcript line", async (t) => {
  const config = await workspace(t);
  const path = join(config.sessionDir, "today.jsonl");
  const evidence = "状態が変更されました。".repeat(5_000) + "END OF TOOL OUTPUT";
  await writeFile(path, `${JSON.stringify({
    type: "message", id: "6a761f60", parentId: null, timestamp: "2026-11-19T12:00:00.000Z",
    message: { role: "toolResult", toolName: "read", toolCallId: "one", content: [{ type: "text", text: evidence }], isError: false, timestamp: 1795089600000 },
  })}\n`);
  const tools = nightTools(config, [path]);
  let continuation = { offset: 1, column: 1 };
  let whole = "";
  for (let page = 0; page < 20; page++) {
    const result = await invoke(tools, "read", { path, ...continuation });
    const cursor = /\n\n\[Continue with offset=(\d+), column=(\d+)\]$/.exec(result);
    whole += cursor ? result.slice(0, cursor.index) : result;
    if (!cursor) break;
    continuation = { offset: Number(cursor[1]), column: Number(cursor[2]) };
  }
  assert.equal(JSON.parse(whole).message.content[0].text, evidence);
});

test("a transcript image does not use up the page before accompanying text", async (t) => {
  const config = await workspace(t);
  const path = join(config.sessionDir, "today.jsonl");
  const image = "AQID".repeat(16_000);
  await writeFile(path, `${JSON.stringify({
    type: "message", id: "6a761f60", parentId: null, timestamp: "2026-11-19T12:00:00.000Z",
    message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: image }, { type: "text", text: "caption after image" }], timestamp: 1795089600000 },
  })}\n`);
  const text = await invoke(nightTools(config, [path]), "read", { path });
  const content = JSON.parse(text).message.content;
  assert.equal(content[1].text, "caption after image");
  assert.ok(content[0].data.length < 100);
});

test("content search locates evidence in an authorized transcript without searching neighboring records", async (t) => {
  const config = await workspace(t);
  const path = join(config.sessionDir, "today.jsonl");
  const other = join(config.sessionDir, "other.jsonl");
  await writeFile(path, `{}\n${JSON.stringify({ text: "x".repeat(58_000) + " the evidence" })}\n`);
  await writeFile(other, "private evidence\n");
  const tools = nightTools(config, [path]);
  const matches = await invoke(tools, "grep", { path: config.sessionDir, pattern: "evidence" });
  assert.match(matches, /today\.jsonl:2:\d+:.*the evidence/);
  assert.doesNotMatch(matches, /private evidence/);
  await assert.rejects(invoke(tools, "grep", { path: other, pattern: "private evidence" }));
});

test("find searches nested memory files without crossing into the sources through symlinks", async (t) => {
  const config = await workspace(t);
  await mkdir(join(config.memoryDir, "diary"));
  await writeFile(join(config.memoryDir, "diary", "note.md"), "local");
  await writeFile(join(config.sourcesDir, "original.md"), "outside");
  await symlink(config.sourcesDir, join(config.memoryDir, "alias"));
  const tools = nightTools(config);
  assert.equal(await invoke(tools, "find", { pattern: "**/*.md" }), "diary/note.md");
  await assert.rejects(invoke(tools, "find", { path: config.sourcesDir, pattern: "**/*.md" }));
});
