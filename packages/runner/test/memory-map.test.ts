import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { memoryMap } from "../src/memory-map.ts";
import { memorySnapshot } from "../src/night-memory.ts";

const today = "2026-11-21";

test("the map shows Markdown sections and local file links without copying the body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "topics"));
  await writeFile(join(root, "topics/index.md"), [
    "# Current", "body outside the map", "[live][topic] [missing](../gone.md#section)",
    "", "[topic]: ../topic%20name.md#section", "", "Next", "----", "```md", "# example", "[example](none.md)", "```", "",
  ].join("\n"));
  await writeFile(join(root, "topic name.md"), "# Detail\n");
  await writeFile(join(root, "unlinked.md"), "No links\n");
  const map = await memoryMap(root, await memorySnapshot(root), [], today);
  assert.match(map, /"topic name\.md",9,null,null,null,0,1/);
  assert.match(map, /"unlinked\.md",9,null,null,null,0,0/);
  assert.match(map, /"topics\/"\n\["index\.md",\d+,null,null,null,0,0,\[\["Current",6\],\["Next",6\]\],\["gone\.md"\],\["topic name\.md"\]\]/);
  assert.doesNotMatch(map, /body outside the map|none\.md|# example/);
});

test("the map counts each use of a reference and resolves its destination the same way as a repaired link", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.md"), "[TOPIC] [read][topic] ![topic][] [not a file](https://example.com/gone.md)\n\n[topic]: /memory/topic%20name.md&#35;section\n[unused]: missing.md\n");
  await writeFile(join(root, "topic name.md"), "# Topic\n");
  const map = await memoryMap(root, await memorySnapshot(root), [], today);
  assert.match(map, /"topic name\.md",8,null,null,null,0,3/);
  assert.doesNotMatch(map, /gone\.md|missing\.md/);
});

test("daytime commits advance the last change but not the last write by a night worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memory-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--quiet");
  for (const [day, subject, trailer] of [["01", "Old turn", ""], ["02", "Night turn", "Night-stage: curator"], ["03", "Day turn", ""]]) {
    await writeFile(join(root, "topic.md"), `# Topic ${day}\n`);
    git("add", "topic.md");
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
      "commit", "--quiet", "-m", subject!, ...(trailer ? ["-m", trailer] : [])], {
      cwd: root,
      env: { ...process.env, GIT_COMMITTER_DATE: `2026-11-${day}T23:30:00-02:00` },
    });
  }
  assert.match(await memoryMap(root, await memorySnapshot(root), [], today), /"topic\.md",11,"2026-11-04","2026-11-03"/);
});
