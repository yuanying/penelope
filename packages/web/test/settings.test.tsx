import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanup, fireEvent, render, screen, waitForElementToBeRemoved, within } from "@testing-library/react";
import type { SettingsResponse } from "@penelope/contract";

import { createApi } from "../src/model/api.ts";
import { Settings } from "../src/ui/Settings.tsx";

test("choosing another model makes only its supported thinking levels selectable", async (t) => {
  t.after(cleanup);
  const settings: SettingsResponse = {
    models: [
      { provider: "example", id: "reasoner", name: "Reasoner", context_window: 128000, thinking_levels: ["off", "high"] },
      { provider: "example", id: "org/chat", name: "Chat", context_window: 32000, thinking_levels: ["off"] },
    ],
    default: { model: "example/reasoner", thinking: "high" },
    selection: null,
  };
  const api = createApi(async (path) => Response.json(path === "/api/app/devices" ? { devices: [] } : settings));
  render(<Settings api={api} onUnauthorized={() => assert.fail("Unexpected 401")} agentName="Iris" />);
  const model = await screen.findByRole("combobox", { name: "モデル" });
  fireEvent.change(model, { target: { value: "example/org/chat" } });
  const thinking = screen.getByRole("combobox", { name: "思考の深さ" });
  assert.deepEqual(within(thinking).getAllByRole("option").map((option) => option.textContent), ["オフ"]);
});

test("removes the named iPhone from settings after the backend confirms revocation", async (t) => {
  t.after(cleanup);
  const api = createApi(async (path, init) => {
    if (path === "/api/app/devices") return Response.json({ devices: [
      { id: "device-1", name: "旅先の iPhone", created_at: "2026-11-26T00:00:00Z", expires_at: "2027-11-26T00:00:00Z" },
    ] });
    if (path === "/api/app/devices/device-1" && init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ models: [], selection: null, default: null } satisfies SettingsResponse);
  });
  render(<Settings api={api} onUnauthorized={() => assert.fail("Unexpected 401")} agentName="Iris" />);
  const revoke = await screen.findByRole("button", { name: "旅先の iPhone を失効" });
  fireEvent.click(revoke);
  const dialog = await screen.findByRole("alertdialog");
  const removed = waitForElementToBeRemoved(() => screen.queryByText("旅先の iPhone"));
  fireEvent.click(within(dialog).getByRole("button", { name: "失効" }));
  await removed;
});
