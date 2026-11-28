import assert from "node:assert/strict";
import { afterEach, it } from "node:test";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentStatus } from "@penelope/contract";

import { App } from "../src/ui/App.tsx";
import { FakeBackend } from "./fake-backend.ts";

const at = "2026-11-18T10:00:00.000Z";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

it("refreshes the main status and the list of open sub-agents without a stream", async () => {
  window.history.replaceState(null, "", "/#/status");
  const backend = new FakeBackend();
  let mood = "ひと休み";
  let agents = [{ agent: "reviewer", purpose: "記事を読む", state: "thinking", started_at: at, state_since: at }];
  render(<App fetch={async (input, init) => {
    if (input === "/api/status") return Response.json({ sleep: { state: "awake" }, sleepiness: 42, awake_seconds: 900, mood } satisfies AgentStatus);
    if (input === "/api/agents") return Response.json({ agents });
    return backend.fetch(input, init);
  }} />);
  assert.ok(await screen.findByText("ひと休み"));
  assert.ok(await screen.findByText("記事を読む"));
  mood = "次の仕事へ";
  agents = [];
  const refresh = screen.getByRole("button", { name: "読み直す" });
  await act(async () => fireEvent.click(refresh));
  assert.ok(await screen.findByText("次の仕事へ"));
  assert.equal(screen.queryByText("記事を読む"), null);
});

it("cancels a schedule in the personal page only after the owner confirms", async () => {
  const backend = new FakeBackend();
  const schedules = [{ id: "s-1", reason: "日次確認", cron: "0 10 * * *", next_at: at }];
  render(<App fetch={async (input, init) => {
    if (input === "/api/schedules") return Response.json({ schedules });
    if (input === "/api/schedules/s-1" && init?.method === "DELETE") {
      schedules.pop();
      return new Response(null, { status: 204 });
    }
    return backend.fetch(input, init);
  }} />);
  const page = await screen.findByRole("button", { name: "出来事と予約" });
  await act(async () => fireEvent.click(page));
  const cancel = await screen.findByRole("button", { name: "「日次確認」を取り消す" });
  await act(async () => fireEvent.click(cancel));
  const dialog = await screen.findByRole("alertdialog");
  assert.equal(schedules.length, 1);
  const confirm = within(dialog).getByRole("button", { name: "取り消す" });
  await act(async () => fireEvent.click(confirm));
  await waitFor(() => assert.equal(screen.queryByText("日次確認"), null));
  assert.deepEqual(schedules, []);
});
