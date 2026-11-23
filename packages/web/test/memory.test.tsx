import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

import { act, cleanup, render, screen } from "@testing-library/react";

import type { MemoryFileResponse, MemoryOverviewResponse } from "@penelope/contract";

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
      head: id, files: [file], broken_links: [], links_incomplete: false, last_night: null,
      always_read: { bytes: 0, target_bytes: 16384, file_limit_bytes: 65536, over_target_nights: [] },
    } satisfies MemoryOverviewResponse));
    if (url.pathname === "/api/memory/file") return Promise.resolve(Response.json({
      head: id, file, history_count: 1, broken_links: [], kind: "markdown",
      text: "# 道具の控え\n\n<i id=raw-memory-html>本文</i>",
    } satisfies MemoryFileResponse));
    return backend.fetch(input, init);
  }} />);
  await screen.findByRole("heading", { name: "道具の控え" });
  assert.equal(ui.container.querySelector("#raw-memory-html"), null);
});
