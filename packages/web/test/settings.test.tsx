import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  const api = createApi(async () => Response.json(settings));
  render(<Settings api={api} onUnauthorized={() => assert.fail("Unexpected 401")} agentName="Iris" />);
  const model = await screen.findByRole("combobox", { name: "モデル" });
  fireEvent.change(model, { target: { value: "example/org/chat" } });
  const thinking = screen.getByRole("combobox", { name: "思考の深さ" });
  assert.deepEqual(within(thinking).getAllByRole("option").map((option) => option.textContent), ["オフ"]);
});
