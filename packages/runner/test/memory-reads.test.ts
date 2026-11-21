import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

import { memoryMap } from "../src/memory-map.ts";
import { memoryReads } from "../src/memory-reads.ts";
import { memorySnapshot } from "../src/night-memory.ts";

test("a search contributes one date per found memory file without keeping the query or matches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-reads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const topic = join(root, "topic.md");
  await writeFile(topic, "an example\n");
  const timestamp = "2026-11-20T19:00:00.000Z";
  const entries = parseSessionEntries([
    { type: "session", version: 3, id: "session", cwd: tmpdir(), timestamp },
    { type: "message", id: "call", parentId: null, timestamp, message: { role: "assistant", content: [
      { type: "toolCall", id: "query", name: "bash", arguments: { command: `rg 'private query' ${root}` } },
    ] } },
    { type: "message", id: "result", parentId: "call", timestamp, message: { role: "toolResult", toolCallId: "query", toolName: "bash", isError: false,
      content: [{ type: "text", text: `${topic}:private match\n${topic}:another match\n${root}/not-a-file:another private match` }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n")).filter((entry) => entry.type !== "session");
  assert.deepEqual(await memoryReads(root, tmpdir(), entries, [], "2026-11-21"), [{ path: "topic.md", dates: ["2026-11-20"] }]);
});

test("the map keeps the last read but counts only the current day and previous 29 days", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-reads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "old.md"), "old\n");
  await writeFile(join(root, "recent.md"), "recent\n");
  const today = "2026-11-21";
  const reads = await memoryReads(root, tmpdir(), [], [
    { path: "old.md", dates: ["2026-10-01", "2026-10-22"] },
    { path: "recent.md", dates: ["2026-10-22", "2026-10-23", "2026-11-21", "2026-11-21"] },
  ], today);
  const map = await memoryMap(root, await memorySnapshot(root), reads, today);
  assert.match(map, /"old\.md",4,null,null,"2026-10-22",0,0/);
  assert.match(map, /"recent\.md",7,null,null,"2026-11-21",3,0/);
});
