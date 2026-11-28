import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanup, fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from "@testing-library/react";
import type { SettingsResponse } from "@penelope/contract";

import { createApi } from "../src/model/api.ts";
import { App } from "../src/ui/App.tsx";
import { Settings } from "../src/ui/Settings.tsx";

test("the personal page opens memory without loading conversation history", async (t) => {
  window.location.hash = "";
  const requested: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    requested.push(String(input));
    if (String(input) === "/api/agent") return Response.json({ name: "Iris" });
    if (String(input) === "/api/record/unseen") return Response.json({ unseen: 0 });
    return Response.json({}, { status: 404 });
  };
  render(<App fetch={fetch} />);
  t.after(cleanup);
  await waitFor(() => assert.ok(requested.some((path) => path.startsWith("/api/memory?"))));
  assert.ok(!requested.includes("/api/history"));
});

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
