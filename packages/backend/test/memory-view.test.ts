import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

import { openDatabase } from "../src/db.ts";
import { Memory } from "../src/memory.ts";
import { ActivityRecord } from "../src/record.ts";
import { MemoryView } from "../src/memory-view.ts";
import { tempDir } from "./support.ts";

function setup(t: Parameters<typeof tempDir>[0], options: { targetBytes?: number; ownerName?: string; ownerEmail?: string } = {}) {
  const dir = tempDir(t);
  const author = { name: "Example backend", email: "backend@example.com" };
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const now = () => Date.parse("2026-11-23T16:00:00Z");
  const timeZone = "Asia/Tokyo";
  return { dir, writer: new Memory(dir, author), view: new MemoryView(dir, db, { now, timeZone, ...options }),
    record: new ActivityRecord(db, { now, timeZone, sleepReportTimeoutMs: 60 * 60_000 }) };
}

it("keeps packed memory readable by the shared group and usable as a save base", async (t) => {
  const { view, writer, dir } = setup(t, { ownerEmail: "owner@example.com" });
  writeFileSync(join(dir, "notes.md"), "first\n");
  await writer.commit({ agent: "main", turnId: "first" });
  const base_head = (await view.overview()).head!;
  const umask = process.umask(0o077);
  try { await writer.maintain(Date.now()); } finally { process.umask(umask); }
  const packDir = join(dir, ".git", "objects", "pack");
  const pack = readdirSync(packDir).find((name) => name.endsWith(".pack"));
  assert.ok(pack);
  for (const name of [pack, pack.replace(/\.pack$/, ".idx")]) assert.ok(statSync(join(packDir, name)).mode & 0o040);
  const saved = await writer.save({ path: "notes.md", base_head, text: "second\n" }, view);
  assert.equal(saved.kind, "saved");
  if (saved.kind !== "saved") return;
  const diff = await view.diff(saved.id, "notes.md");
  assert.equal(diff.kind, "text");
  if (diff.kind === "text") assert.deepEqual(diff.hunks[0]?.lines.map(({ text }) => text), ["first", "second"]);
});

it("counts moves outside the page at their destination in the full day's total", async (t) => {
  const { view, dir } = setup(t);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  const input = ["commit refs/heads/main\ncommitter Bot <bot@example.com> 1767222000 +0000\ndata 4\nseed\nM 644 inline old.md\ndata 4\nnote\n"];
  for (let i = 0; i <= 50; i++) {
    input.push(`commit refs/heads/main\ncommitter Bot <bot@example.com> ${1767225600 + i} +0000\ndata 0\n${i === 0 ? "R old.md new.md" : `M 644 inline new.md\ndata ${String(i).length}\n${i}`}\n`);
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, input: input.join("") });
  const result = await view.changes({ tz: "UTC" });
  assert.deepEqual(result.days.map(({ changes, files, items }) => [changes, files, items.length]), [[51, 1, 50]]);
});

it("does not expose a commit reachable only through a merge's second parent", async (t) => {
  const { view, dir } = setup(t);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, input: [
    "commit refs/heads/main\nmark :1\ncommitter Bot <bot@example.com> 1767225600 +0000\ndata 0\n",
    "commit refs/heads/side\nmark :2\ncommitter Bot <bot@example.com> 1767225601 +0000\ndata 0\nfrom :1\nM 644 inline note.md\ndata 4\ntext\n",
    "commit refs/heads/main\ncommitter Bot <bot@example.com> 1767225602 +0000\ndata 0\nmerge :2\nM 644 inline note.md\ndata 4\ntext\n",
  ].join("\n") });
  const side = execFileSync("git", ["rev-parse", "side"], { cwd: dir, encoding: "utf8" }).trim();
  await assert.rejects(view.change(side), { status: 404 });
});

it("shows no memory before the first commit", async (t) => {
  const { view, dir } = setup(t);
  writeFileSync(join(dir, "draft.md"), "not committed\n");
  assert.equal((await view.overview()).head, null);
});

it("keeps the overview's version readable when the work tree and HEAD move on", async (t) => {
  const { view, writer, dir } = setup(t);
  writeFileSync(join(dir, "notes.md"), "first version\n");
  await writer.commit({ agent: "main", turnId: "first" });
  writeFileSync(join(dir, "notes.md"), "second version\n");
  const { head } = await view.overview();
  assert.ok(head);
  assert.equal((await view.file("notes.md")).text, "first version\n");
  await writer.commit({ agent: "main", turnId: "second" });
  assert.equal((await view.file("notes.md", head)).text, "first version\n");
});

it("reports a move as one file and numbers the changed lines against both versions", async (t) => {
  const { view, writer, dir } = setup(t);
  const unchanged = "A long enough line for Git to recognize a rename.\nSame context.\n";
  writeFileSync(join(dir, "old.md"), unchanged + "old\n");
  await writer.commit({ agent: "main", turnId: "first" });
  await view.overview(); // Exercise advancing a previously read HEAD.
  renameSync(join(dir, "old.md"), join(dir, "new.md"));
  writeFileSync(join(dir, "new.md"), unchanged + "new\n");
  await writer.commit({ agent: "main", turnId: "second" });
  const { head } = await view.overview();
  assert.ok(head);
  assert.deepEqual((await view.change(head)).files, [{ path: "new.md", from: "old.md", kind: "moved", added: 1, removed: 1 }]);
  const diff = await view.diff(head, "new.md");
  assert.equal(diff.kind, "text");
  if (diff.kind === "text") assert.deepEqual(diff.hunks[0]?.lines.slice(-2), [
    { kind: "removed", old_line: 3, text: "old" }, { kind: "added", new_line: 3, text: "new" },
  ]);
});

it("searches for a literal, case-sensitive string and not work-tree text", async (t) => {
  const { view, writer, dir } = setup(t);
  const path = "日本語: と\n改行.md";
  writeFileSync(join(dir, path), "A.b\nxx a.b yy\naXb\n");
  await writer.commit({ agent: "main", turnId: "first" });
  writeFileSync(join(dir, path), "not committed: a.b\n");
  assert.deepEqual((await view.search("a.b")).files, [{ path, lines: [{ line: 2, text: "xx a.b yy" }] }]);
});

it("reports broken relative Markdown links, not examples in code or external URLs", async (t) => {
  const { view, writer, dir } = setup(t);
  writeFileSync(join(dir, "index.md"), "[ok](note.md#top)\n[missing][ref]\n\n[ref]: nowhere.md\n\n`[example](example.md)`\n[external](https://example.com/)\n");
  writeFileSync(join(dir, "note.md"), "# Top\n");
  await writer.commit({ agent: "main", turnId: "first" });
  assert.deepEqual((await view.overview()).broken_links, [{ path: "index.md", line: 2, destination: "nowhere.md" }]);
});

it("marks the search incomplete when a matching line is left out", async (t) => {
  const { view, writer, dir } = setup(t);
  writeFileSync(join(dir, "guide.md"), "match\n".repeat(101));
  await writer.commit({ agent: "main", turnId: "first" });
  const result = await view.search("match");
  assert.equal(result.files[0]?.lines.length, 100);
  assert.equal(result.truncated, true);
});

it("does not serve a committed symlink's target as a file", async (t) => {
  const { view, writer, dir } = setup(t);
  const outside = join(tempDir(t), "outside.md");
  writeFileSync(outside, "hidden content\n");
  symlinkSync(outside, join(dir, "link.md"));
  await writer.commit({ agent: "main", turnId: "first" });
  await assert.rejects(view.file("link.md"), { status: 404 });
});

it("classifies an avatar image by its signature, not its extension", async (t) => {
  const { view, writer, dir } = setup(t);
  mkdirSync(join(dir, "avatar"));
  writeFileSync(join(dir, "avatar", "picture.txt"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]));
  await writer.commit({ agent: "main", turnId: "first" });
  assert.equal((await view.image("avatar/picture.txt")).mime, "image/png");
});

it("groups nightly changes by the commit's night marker and resolves the weekly phases", async (t) => {
  const { view, writer, dir, record } = setup(t);
  for (const [id, stage] of [["r", "reflection"], ["c", "curator"], ["s", "curator"]] as const) {
    writeFileSync(join(dir, `${id}.md`), "one revision\n");
    await writer.commit({ agent: "main", turnId: id, night: { seq: 7, stage } });
  }
  writeFileSync(join(dir, "references.md"), "[note](s.md)\n");
  await writer.commitPaths(["references.md"], ["Runner: repair memory references", '"old.md" → "s.md"', "Night-stage: reference-repair\nNight: 7\nRepair-turn: s"]);
  const done = { result: "done" } as const;
  record.nightReported({ seq: 7, stages: { reflection: { ...done, turn_id: "r" }, verifier: done, session: done,
    curator: { ...done, turn_id: "s", review: { content: { ...done, turn_id: "c" }, structure: { ...done, turn_id: "s" } } } } });
  assert.deepEqual((await view.nightChanges("1")).map(({ writer }) => writer), [
    { kind: "night", stage: "reflection", night_id: "1", night_seq: 7 },
    { kind: "night", stage: "content", night_id: "1", night_seq: 7 },
    { kind: "night", stage: "structure", night_id: "1", night_seq: 7 },
    { kind: "system", operation: "reference_repair", night_id: "1", night_seq: 7 },
  ]);
});

it("measures the end of the night instead of the size left by daytime edits", async (t) => {
  const { view, writer, dir, record } = setup(t, { targetBytes: 4 });
  writeFileSync(join(dir, "always.md"), "past the limit\n");
  await writer.commit({ agent: "main", turnId: "r", night: { seq: 8, stage: "reflection" } });
  record.nightReported({ seq: 8 });
  view.reports.saveNightHead(8, await view.head());
  writeFileSync(join(dir, "always.md"), "x\n");
  await writer.commit({ agent: "main", turnId: "day" });
  assert.deepEqual((await view.overview()).always_read.over_target_nights, ["2026-11-24"]);
});

it("shows imported changes without guessing the writer from their free-form subject", async (t) => {
  const { dir, view } = setup(t, { ownerName: "Example Owner" });
  const older = new Memory(dir, { name: "昔のエージェント", email: "legacy@example.com" });
  writeFileSync(join(dir, "案内.md"), "hello\n");
  await older.commitPaths(["案内.md"], ["ping: 案内.md"]);
  assert.deepEqual((await view.changes({})).days.flatMap(({ items }) => items.map(({ writer }) => writer)), [{ kind: "unknown" }]);
});

it("compares the selected versions rather than summing intermediate edit churn", async (t) => {
  const { view, writer, dir } = setup(t);
  const path = "案内.md";
  writeFileSync(join(dir, path), "keep\n");
  await writer.commit({ agent: "main", turnId: "first" });
  const from = await view.head();
  writeFileSync(join(dir, path), "temporary\n");
  await writer.commit({ agent: "main", turnId: "second" });
  writeFileSync(join(dir, path), "keep\nfinal\n");
  await writer.commit({ agent: "main", turnId: "third" });
  const to = await view.head();
  assert.ok(from && to);
  const { changes, added, removed } = await view.compare(path, from, to);
  assert.deepEqual({ changes, added, removed }, { changes: 2, added: 1, removed: 0 });
});
