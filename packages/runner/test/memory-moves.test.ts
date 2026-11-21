import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { MemoryMoves, repairMemoryReferences } from "../src/memory-moves.ts";

async function memory(t: TestContext, files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "memory-moves-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return root;
}

const noError = (error: unknown) => { throw error; };

test("Markdown links in diary and archive follow chained moves without changing surrounding Markdown", async (t) => {
  const root = await memory(t, {
    "topics/new name.md": "# Topic\n",
    "diary/today.md": "- [keep **this**](../old.md#section \"a title\")\r\n- ` [example](../old.md) `\r\n",
    "archive/month.md": "[the topic][topic]\n\n[topic]: <../staging.md?version=2> 'title'\n",
  });
  const moves = new MemoryMoves();
  moves.move("old.md", "staging.md");
  moves.move("staging.md", "topics/new name.md");
  const result = await repairMemoryReferences(root, moves, noError);
  assert.deepEqual(result.paths.sort(), ["archive/month.md", "diary/today.md"]);
  assert.equal(await readFile(join(root, "diary/today.md"), "utf8"), "- [keep **this**](../topics/new%20name.md#section \"a title\")\r\n- ` [example](../old.md) `\r\n");
  assert.equal(await readFile(join(root, "archive/month.md"), "utf8"), "[the topic][topic]\n\n[topic]: <../topics/new%20name.md?version=2> 'title'\n");
});

test("a moved page rebases relative links but keeps links already valid in the new directory", async (t) => {
  const root = await memory(t, {
    "new/note.md": "[stable](./local.md) [old sibling](sibling.md) [moved sibling](other.md)\n",
    "new/local.md": "", "old/local.md": "", "old/sibling.md": "", "topic.md": "",
  });
  const moves = new MemoryMoves();
  moves.move("old/note.md", "new/note.md");
  moves.move("old/other.md", "topic.md");
  await repairMemoryReferences(root, moves, noError);
  assert.equal(await readFile(join(root, "new/note.md"), "utf8"), "[stable](./local.md) [old sibling](../old/sibling.md) [moved sibling](../topic.md)\n");
});

test("links without a known local replacement keep their exact text", async (t) => {
  const body = "[external](https://example.com/old.md) [same page](#old.md) [missing](deleted.md) [reused](old.md)\n";
  const root = await memory(t, { "always.md": body, "old.md": "reused", "new.md": "moved" });
  const moves = new MemoryMoves();
  moves.move("old.md", "new.md");
  const result = await repairMemoryReferences(root, moves, noError);
  assert.deepEqual(result.paths, []);
  assert.equal(await readFile(join(root, "always.md"), "utf8"), body);
});

test("bare paths update only as whole paths in the prompt layer and index", async (t) => {
  const body = "`ops/old.md`、/memory/ops/old.md (./ops/old.md). ops/old.md.bak x/ops/old.md x-ops/old.md https://example.com/ops/old.md\n";
  const root = await memory(t, { "PURPOSE.md": body, "INDEX.md": body, "diary/today.md": body, "notes/new.md": "" });
  const moves = new MemoryMoves();
  moves.move("ops/old.md", "notes/new.md");
  await repairMemoryReferences(root, moves, noError);
  for (const path of ["PURPOSE.md", "INDEX.md"]) {
    assert.equal(await readFile(join(root, path), "utf8"), "`notes/new.md`、/memory/notes/new.md (./notes/new.md). ops/old.md.bak x/ops/old.md x-ops/old.md https://example.com/ops/old.md\n");
  }
  assert.equal(await readFile(join(root, "diary/today.md"), "utf8"), body);
});
