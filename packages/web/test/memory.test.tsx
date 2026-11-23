import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { MemoryFileResponse, MemoryOverviewResponse, MemorySaveRequest } from "@penelope/contract";

import { App } from "../src/ui/App.tsx";
import { FakeBackend } from "./fake-backend.ts";

const id = "a".repeat(40);
const change = { id, at: "2026-11-23T04:00:00Z", writer: { kind: "owner" }, paths: ["one.md", "two.md"], files: 2, added: 2, removed: 0 };

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

it("reads a change's first file immediately but waits until another is opened to fetch its diff", async () => {
  const backend = new FakeBackend();
  const paths: string[] = [];
  window.history.replaceState(null, "", `/#/memory/changes/${id}`);
  render(<App fetch={(input, init) => {
    const url = new URL(String(input), "http://example.com");
    if (url.pathname === `/api/memory/changes/${id}`) return Promise.resolve(Response.json({ change, moves: [], files: change.paths.map((path) => ({ path, kind: "added", added: 1, removed: 0 })) }));
    if (url.pathname === `/api/memory/changes/${id}/diff`) {
      const path = url.searchParams.get("path")!;
      paths.push(path);
      return Promise.resolve(Response.json({ kind: "text", truncated: false, hunks: [{ old_start: 0, new_start: 1, lines: [{ kind: "added", new_line: 1, text: `内容 ${path}` }] }] }));
    }
    return backend.fetch(input, init);
  }} />);

  await screen.findByText("内容 one.md");
  assert.deepEqual(paths, ["one.md"]);
  await act(async () => screen.getByRole("button", { name: /two\.md/ }).click());
  await screen.findByText("内容 two.md");
  assert.deepEqual(paths, ["one.md", "two.md"]);
});

it("does not render raw HTML elements from a memory document", async () => {
  const backend = new FakeBackend();
  const file = { path: "notes.md", bytes: 70, always_read: false, reads: null, last_change: null };
  window.history.replaceState(null, "", "/#/memory/files/notes.md");
  const ui = render(<App fetch={(input, init) => {
    const url = new URL(String(input), "http://example.com");
    if (url.pathname === "/api/memory") return Promise.resolve(Response.json({
      head: id, can_edit: false, files: [file], broken_links: [], links_incomplete: false, last_night: null,
      always_read: { bytes: 0, target_bytes: 16384, file_limit_bytes: 65536, over_target_nights: [] },
    } satisfies MemoryOverviewResponse));
    if (url.pathname === "/api/memory/file") return Promise.resolve(Response.json({
      head: id, file, edit: null, history_count: 1, broken_links: [], kind: "markdown",
      text: "# 道具の控え\n\n<i id=raw-memory-html>本文</i>",
    } satisfies MemoryFileResponse));
    return backend.fetch(input, init);
  }} />);
  await screen.findByRole("heading", { name: "道具の控え" });
  assert.equal(ui.container.querySelector("#raw-memory-html"), null);
});

const editableFile: MemoryFileResponse = {
  head: id, file: { path: "notes.md", bytes: 6, always_read: false, reads: null, last_change: null },
  edit: { max_bytes: 1048576 }, history_count: 1, broken_links: [], kind: "markdown", text: "# 元\n",
};

function openEditableFile(canEdit: boolean, save: () => Response = () => Response.json({ kind: "unchanged", head: id })) {
  const backend = new FakeBackend();
  window.history.replaceState(null, "", "/#/memory/files/notes.md");
  render(<App fetch={(input, init) => {
    const url = new URL(String(input), "http://example.com");
    if (url.pathname === "/api/memory") return Promise.resolve(Response.json({ ...overview, can_edit: canEdit }));
    if (url.pathname === "/api/memory/file") return Promise.resolve(Response.json(editableFile));
    if (url.pathname === "/api/memory/save") return Promise.resolve(save());
    return backend.fetch(input, init);
  }} />);
}

it("keeps the owner's draft in the editor after a committed change conflicts", async () => {
  openEditableFile(true, () => Response.json({
    kind: "head_conflict", head: "b".repeat(40), exists: true, last_change: null,
    diff: { kind: "text", hunks: [], truncated: false },
  }, { status: 409 }));
  const edit = await screen.findByRole("button", { name: "直す" });
  await act(async () => edit.click());
  const draft = await screen.findByRole<HTMLInputElement>("textbox", { name: "元の文" });
  fireEvent.change(draft, { target: { value: "残しておきたい文" } });
  await act(async () => screen.getByRole("button", { name: "保存する" }).click());
  await screen.findByText("保存していません。直している間に、このファイルが書き換わりました。");
  assert.equal(screen.getByRole<HTMLInputElement>("textbox", { name: "元の文" }).value, "残しておきたい文");
});

it("does not resend a save on its own after a committed change conflicts", async () => {
  let saves = 0;
  openEditableFile(true, () => {
    saves++;
    return Response.json({ kind: "head_conflict", head: "b".repeat(40), exists: true, last_change: null, diff: { kind: "text", hunks: [], truncated: false } }, { status: 409 });
  });
  const edit = await screen.findByRole("button", { name: "直す" });
  await act(async () => edit.click());
  await act(async () => (await screen.findByRole("button", { name: "保存する" })).click());
  await screen.findByRole("button", { name: "自分の文で上書きする" });
  assert.equal(saves, 1);
});

it("offers no edit action when the deployment cannot edit memory", async () => {
  openEditableFile(false);
  await screen.findByRole("heading", { name: "元" });
  assert.equal(screen.queryByRole("button", { name: "直す" }), null);
});

it("restores the older text against the current version read when the confirmation opens", async () => {
  const backend = new FakeBackend();
  const older = "b".repeat(40);
  const confirmationHead = "c".repeat(40);
  const oldText = "# 以前の本文\n";
  let currentHead = id;
  let request: MemorySaveRequest | undefined;
  window.history.replaceState(null, "", `/#/memory/history/notes.md?from=${older}&to=${id}`);
  render(<App fetch={(input, init) => {
    const url = new URL(String(input), "http://example.com");
    if (url.pathname === "/api/memory") return Promise.resolve(Response.json({ ...overview, can_edit: true }));
    if (url.pathname === "/api/memory/history") return Promise.resolve(Response.json({ head: id, changes: [change, { ...change, id: older, at: "2026-11-21T04:00:00Z" }] }));
    if (url.pathname === "/api/memory/compare") return Promise.resolve(Response.json({ from: older, to: id, changes: 1, added: 1, removed: 1, diff: { kind: "text", hunks: [], truncated: false } }));
    if (url.pathname === "/api/memory/file") {
      return Promise.resolve(Response.json(url.searchParams.get("head") === older ? { ...editableFile, head: older, text: oldText } : { ...editableFile, head: currentHead }));
    }
    if (url.pathname === "/api/memory/save") {
      request = JSON.parse(String(init?.body)) as MemorySaveRequest;
      return Promise.resolve(Response.json({ kind: "unchanged", head: confirmationHead }));
    }
    return backend.fetch(input, init);
  }} />);
  const revert = await screen.findByRole("button", { name: /の版に戻す$/ });
  currentHead = confirmationHead;
  await act(async () => revert.click());
  const confirm = await screen.findByRole("button", { name: "この版に戻す" });
  await act(async () => confirm.click());
  assert.deepEqual(request, { path: "notes.md", base_head: confirmationHead, text: oldText });
});

const overview: MemoryOverviewResponse = {
  head: id, can_edit: false, files: [], broken_links: [], links_incomplete: false, last_night: null,
  always_read: { bytes: 0, target_bytes: 16384, file_limit_bytes: 65536, over_target_nights: [] },
};

// The button once said it would show all that remained and showed eight; and pressing the last one dropped the focus.
it("says how many more files of a change it shows, and moves the focus to the first of them", async () => {
  const backend = new FakeBackend();
  const paths = Array.from({ length: 20 }, (_, i) => `f${String(i + 1).padStart(2, "0")}.md`);
  window.history.replaceState(null, "", `/#/memory/changes/${id}`);
  render(<App fetch={(input, init) => {
    const url = new URL(String(input), "http://example.com");
    if (url.pathname === `/api/memory/changes/${id}`) return Promise.resolve(Response.json({ change: { ...change, paths, files: 20 }, moves: [], files: paths.map((path) => ({ path, kind: "added", added: 1, removed: 0 })) }));
    if (url.pathname === `/api/memory/changes/${id}/diff`) return Promise.resolve(Response.json({ kind: "text", truncated: false, hunks: [] }));
    return backend.fetch(input, init);
  }} />);

  const more = await screen.findByRole("button", { name: "次の 8 ファイルを表示（残り 12）" });
  await act(async () => more.click());
  assert.equal(document.activeElement, screen.getByRole("button", { name: /f09\.md/ }));
  assert.ok(screen.getByRole("button", { name: "残りの 4 ファイルを表示" }));
});

// A read that failed left only a sentence: the page had to be loaded again.
it("reads a change again when asked after a failure", async () => {
  const backend = new FakeBackend();
  let failed = false;
  window.history.replaceState(null, "", `/#/memory/changes/${id}`);
  render(<App fetch={(input, init) => {
    const url = new URL(String(input), "http://example.com");
    if (url.pathname === `/api/memory/changes/${id}`) {
      if (!failed) { failed = true; return Promise.resolve(new Response(null, { status: 500 })); }
      return Promise.resolve(Response.json({ change, moves: [], files: [] }));
    }
    return backend.fetch(input, init);
  }} />);

  const again = await screen.findByRole("button", { name: "もう一度読み込む" });
  await act(async () => again.click());
  await screen.findByRole("heading", { name: "オーナー" });
});

// The way back from a night's change once said "turn".
it("names the night in the way back from a change opened from a night", async () => {
  const backend = new FakeBackend();
  window.history.replaceState(null, "", `/#/memory/changes/${id}?from=night/n-1`);
  render(<App fetch={(input, init) => {
    const url = new URL(String(input), "http://example.com");
    if (url.pathname === `/api/memory/changes/${id}`) return Promise.resolve(Response.json({ change, moves: [], files: [] }));
    return backend.fetch(input, init);
  }} />);

  await screen.findByRole("heading", { name: "オーナー" });
  const back = await screen.findByRole("link", { name: "活動の記録の夜へ戻る" });
  assert.equal(back.getAttribute("href"), "#/record/nights/n-1");
});

// The writer the list was narrowed to was lost on a reload.
it("narrows the list of changes to the writer in the address", async () => {
  const backend = new FakeBackend();
  const writers: Array<string | null> = [];
  window.history.replaceState(null, "", "/#/memory/changes?writer=night");
  render(<App fetch={(input, init) => {
    const url = new URL(String(input), "http://example.com");
    if (url.pathname === "/api/memory") return Promise.resolve(Response.json(overview));
    if (url.pathname === "/api/memory/changes") {
      writers.push(url.searchParams.get("writer"));
      return Promise.resolve(Response.json({ head: id, days: [] }));
    }
    return backend.fetch(input, init);
  }} />);

  await screen.findByText("変更はありません。");
  assert.deepEqual(writers, ["night"]);
  assert.equal(screen.getByRole("button", { name: "夜" }).getAttribute("aria-pressed"), "true");
});
